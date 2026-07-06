// Поисковый движок по законам Majestic. Zero-dependency, работает в Node и браузере (Tauri/web).
// Слои: точный номер → префикс номера → инвертированный индекс со стеммингом →
//       префиксы слов → нечёткость по триграммам (опечатки) + алиасы/теги + ранжирование по полям.
'use strict';

// нормализация и лёгкий русский стеммер
const norm = s => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9.$\s-]/g, ' ');
const SUFFIXES = [
  'иями', 'ями', 'ами', 'иях', 'иям',
  'ость', 'ости', 'остью', 'ение', 'ения', 'ению', 'ением', 'ении',
  'ыми', 'ими', 'его', 'ого', 'ему', 'ому', 'ых', 'их', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие',
  'ой', 'ей', 'ий', 'ый', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ую', 'юю',
  'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й'
].sort((a, b) => b.length - a.length);
function stem(w) {
  if (w.length <= 3 || /^\d/.test(w)) return w;
  for (const suf of SUFFIXES) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) return w.slice(0, w.length - suf.length);
  }
  return w;
}
const tokenize = s => norm(s).split(/[\s]+/).filter(w => w && w !== '-');
const STOP = new Set(['и','в','во','на','по','с','со','к','ко','о','об','обо','от','до','за','из','у','не','ни','без','при','для','или','а','но','же','то','как','что','это','его','ее','их','тот','этот','все','всех','также','либо','быть','может','лицо','лица','лицу','который','которая','которые','иной','иная','иные','настоящего','настоящему','кодекса','кодексу','статья','статьи','закона','закону','штата','san','andreas','андреас']);

// триграммы для нечёткости
const trigrams = w => {
  const p = '  ' + w + ' ';
  const out = new Set();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
};
const dice = (a, b) => {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
};

// юридический тезаурус: игрок ищет «ограбление», кодекс говорит «грабёж/разбой».
// Слова в естественной форме — стеммируются тем же стеммером, что и запрос/индекс.
const SYN_GROUPS = [
  ['ограбление', 'грабеж', 'разбой', 'налет'],
  ['кража', 'хищение', 'воровство'],
  ['убийство', 'мокруха'],
  ['похищение', 'киднеппинг', 'захват'],
  ['оружие', 'ствол', 'пушка', 'травмат'],
  ['наркотики', 'травка', 'нарко'],
  ['машина', 'автомобиль', 'авто', 'транспорт'],
  ['пьяный', 'опьянение', 'нетрезвый', 'алкоголь'],
  ['взятка', 'подкуп', 'коррупция'],
  ['документ', 'удостоверение', 'паспорт'],
  ['митинг', 'собрание', 'демонстрация', 'пикет'],
  ['телефон', 'мобильный'],
  ['штраф', 'взыскание'],
  ['арест', 'задержание'],
  ['маска', 'балаклава'],
].map(g => [...new Set(g.map(stem))]);
const SYN = new Map();
for (const g of SYN_GROUPS) for (const w of g) SYN.set(w, g.filter(x => x !== w));

// аббревиатуры документов: «ук 6.3», «дк скорость»
const DOC_ABBR = {
  'ук': /уголовн/i, 'ак': /административн/i, 'коап': /административн/i,
  'дк': /дорожн/i, 'пдд': /дорожн/i, 'пк': /процессуальн/i,
  'ск': /судебн/i, 'тк': /трудов/i, 'вк': /воздушн/i,
  'кэ': /этик/i, 'конституция': /конституц/i
};
// порядок важности документов для голых номеров («6.3» — скорее УК, чем Воздушный)
const DOC_PRIORITY = [/уголовн/i, /административн/i, /дорожн/i, /процессуальн/i, /конституц/i];

const FIELD_W = { title: 6, tags: 5, chapter: 2.5, doc: 2, text: 1 };

// построение индекса
// articles: [{id, num, title, tags, text, doc, docType, chapter, section, sanctions, url}]
function buildIndex(articles) {
  const inv = new Map();      // stem -> Map(articleIdx -> score)
  const stems = new Map();    // stem -> trigram set (для fuzzy)
  const byNum = new Map();    // "6.3" -> [idx]
  const add = (st, idx, w) => {
    let m = inv.get(st);
    if (!m) inv.set(st, m = new Map());
    m.set(idx, (m.get(idx) || 0) + w);
    if (!stems.has(st)) stems.set(st, trigrams(st));
  };
  articles.forEach((a, idx) => {
    if (a.num) {
      const num = String(a.num);
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num).push(idx);
    }
    const fields = {
      title: a.title || '', tags: (a.tags || []).join(' '),
      chapter: a.chapter || '', doc: a.doc || '', text: (a.text || '').slice(0, 1500)
    };
    for (const [field, content] of Object.entries(fields)) {
      const seen = new Map();
      for (const tok of tokenize(content)) {
        if (STOP.has(tok) || tok.length < 2) continue; // предлоги и однобуквенные — не индексируем
        const st = stem(tok);
        seen.set(st, (seen.get(st) || 0) + 1);
      }
      for (const [st, tf] of seen) add(st, idx, FIELD_W[field] * (1 + Math.log(tf)));
    }
    // приоритет документа (для ранжирования голых номеров и общего тай-брейка)
    a._prio = DOC_PRIORITY.findIndex(re => re.test(a.doc || ''));
    if (a._prio === -1) a._prio = DOC_PRIORITY.length;
  });
  return { articles, inv, stems, byNum };
}

// поиск
function search(index, query, opts = {}) {
  const limit = opts.limit || 10;
  const { articles, inv, stems, byNum } = index;
  const scores = new Map(); // idx -> score
  const bump = (idx, s) => scores.set(idx, (scores.get(idx) || 0) + s);

  const toks = tokenize(query);
  if (!toks.length) return [];

  // 1) фильтр по документу («ук», «дк»...) и номера
  let docFilter = null;
  const words = [];
  const nums = [];
  for (const t of toks) {
    if (DOC_ABBR[t]) { docFilter = DOC_ABBR[t]; continue; }
    if (/^\d+(\.\d+)*\.?$/.test(t)) { nums.push(t.replace(/\.$/, '')); continue; }
    if (STOP.has(t)) continue; // предлоги и юридический шум не участвуют в ранжировании
    words.push(stem(t));
  }

  // 2) номера: точное совпадение >> префикс («6.» найдёт 6.1–6.9)
  for (const n of nums) {
    for (const [num, idxs] of byNum) {
      if (num === n) idxs.forEach(i => bump(i, 100));
      else if (num.startsWith(n + '.')) idxs.forEach(i => bump(i, 30));
    }
  }

  // 3) слова: точный стем → префикс → триграммная нечёткость
  const perWordHits = [];
  for (const w of words) {
    const hits = new Map(); // idx -> score
    const collect = (st, mult) => {
      const m = inv.get(st);
      if (m) for (const [idx, s] of m) hits.set(idx, Math.max(hits.get(idx) || 0, s * mult));
    };
    collect(w, 1);
    for (const syn of SYN.get(w) || []) collect(syn, 0.9); // тезаурус
    if (!hits.size || w.length >= 4) {
      for (const st of inv.keys()) {
        if (st === w) continue;
        if (st.length >= 3 && w.length >= 3 && (st.startsWith(w) || w.startsWith(st)) && Math.abs(st.length - w.length) <= 3) collect(st, 0.6);
        else if (w.length >= 4 && st.length >= 5 && st.includes(w)) collect(st, 0.5); // «пьян» → «опьянени»
      }
    }
    if (!hits.size && w.length >= 4) { // опечатки
      const qt = trigrams(w);
      let best = [];
      for (const [st, tg] of stems) {
        const d = dice(qt, tg);
        if (d >= 0.45) best.push([st, d]);
      }
      best.sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([st, d]) => collect(st, 0.5 * d));
    }
    perWordHits.push(hits);
  }
  // объединение: сумма + пропорциональный бонус за покрытие всех слов
  // (не плоская константа: иначе два слабых text-матча перевешивают сильный title-матч)
  const covered = new Map();
  for (const hits of perWordHits) {
    for (const [idx, s] of hits) {
      bump(idx, s);
      covered.set(idx, (covered.get(idx) || 0) + 1);
    }
  }
  if (words.length > 1) {
    for (const [idx, c] of covered) if (c === words.length) scores.set(idx, scores.get(idx) * 1.6);
  }

  // мягкий приоритет кодексов над законами при любом запросе
  for (const [idx, s0] of scores) scores.set(idx, s0 * (1 + Math.max(0, 5 - articles[idx]._prio) * 0.04));

  // 4) фильтр по документу и тай-брейки
  let results = [...scores.entries()];
  if (docFilter) results = results.filter(([idx]) => docFilter.test(articles[idx].doc || ''));
  results.sort((a, b) => {
    const d = b[1] - a[1];
    if (Math.abs(d) > 0.01) return d;
    return articles[a[0]]._prio - articles[b[0]]._prio; // при равенстве — УК выше
  });
  // лёгкий буст приоритетных кодексов при голых номерах
  if (nums.length && !words.length) {
    results.sort((a, b) => {
      const sa = a[1] - articles[a[0]]._prio * 2, sb = b[1] - articles[b[0]]._prio * 2;
      return sb - sa;
    });
  }
  return results.slice(0, limit).map(([idx, score]) => ({ score: +score.toFixed(1), ...articles[idx] }));
}

// загрузка статей из _enriched или _normalized
function loadServer(rootDir, server) {
  const fs = require('fs'), path = require('path');
  const tryDirs = ['_enriched', '_normalized'];
  for (const dir of tryDirs) {
    const f = path.join(rootDir, dir, server + '.json');
    if (fs.existsSync(f)) {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const arts = [];
      for (const doc of d.documents) for (const ch of doc.chapters) for (const a of ch.articles) {
        arts.push({
          id: doc.id + ':' + a.num, num: a.num,
          title: a.title || '', tags: a.tags || [], jur: a.jur || null,
          text: a.text, doc: doc.title, docType: doc.type,
          chapter: (ch.title || '').trim(), section: doc.section,
          sanctions: a.sanctions || null, flags: a.flags || null, url: doc.url
        });
      }
      return { source: dir, articles: arts };
    }
  }
  throw new Error('нет данных для сервера ' + server);
}

const API = { buildIndex, search, loadServer, stem, tokenize };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.LawSearch = API;
