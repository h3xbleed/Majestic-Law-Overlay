/* Majestic Law overlay — логика палитры. Без фреймворков: мгновенный старт в Tauri. */
'use strict';
const LS = window.LawSearch;
const CFG = window.ML_CONFIG || {};
const IS_TAURI = !!window.__TAURI__;
const dataCache = new Map(); // server -> {arts, docs, scrapedAt} для сравнения серверов

const SERVERS = ['Atlanta','Boston','Chicago','Dallas','Denver','Detroit','Houston','Las Vegas','Los Angeles','Memphis','Miami','New York','Orlando','Phoenix','Portland','San Diego','San Francisco','Seattle','Washington'];
const FILTERS = [
  {key: '',      label: 'Все'},
  {key: 'ук',    label: 'УК',  re: /уголовн/i},
  {key: 'ак',    label: 'АК',  re: /административн/i},
  {key: 'дк',    label: 'ДК',  re: /дорожн/i},
  {key: 'пк',    label: 'ПК',  re: /процессуальн/i},
  {key: 'ск',    label: 'СК',  re: /судебн/i},
  {key: 'конст', label: 'Конституция', re: /конституц/i},
  {key: 'зак',   label: 'Законы', re: /^закон/i},
];

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const tauriWin = () => window.__TAURI__ && window.__TAURI__.window.getCurrentWindow();

const state = {
  server: localStorage.getItem('ml.server') || 'Detroit',
  filter: 0,
  index: null,
  articles: [],
  docs: [],
  results: [],
  sel: 0,
  view: 'docs', // docs | doc | list | article
  openDoc: null,
};

/* история навигации (кнопки ←/→, Alt+стрелки, кросс-ссылки) */
const hist = {stack: [], pos: -1};
function snap(type, extra) { return Object.assign({type, filter: state.filter, q: $('q').value.trim()}, extra); }
function pushHist(s) {
  const cur = hist.stack[hist.pos];
  // поисковый ввод не спамит историю: search заменяет search, docs заменяет docs
  if (cur && cur.type === s.type && (s.type === 'search' || s.type === 'docs')) hist.stack[hist.pos] = s;
  else { hist.stack.length = hist.pos + 1; hist.stack.push(s); hist.pos++; }
  updateNav();
}
function goHist(d) {
  const p = hist.pos + d;
  if (p < 0 || p >= hist.stack.length) return;
  hist.pos = p;
  applyHist(hist.stack[p]);
  updateNav();
}
function applyHist(s) {
  state.filter = s.filter;
  $('q').value = s.q || '';
  renderFilters();
  if (s.type === 'docs') renderDocs();
  else if (s.type === 'search') doSearch();
  else if (s.type === 'doc') { const d = state.docs.find(x => x.id === s.docId); d ? renderDoc(d) : renderDocs(); }
  else if (s.type === 'article') { const a = state.articles.find(x => x.id === s.artId); a ? renderArticle(a) : renderDocs(); }
  else if (s.type === 'compare') { const a = state.articles.find(x => x.id === s.artId); a ? renderCompare(a) : renderDocs(); }
}
function updateNav() {
  $('navBack').disabled = hist.pos <= 0;
  $('navFwd').disabled = hist.pos >= hist.stack.length - 1;
}

/* данные */
// мини-обёртка над IndexedDB для кэша свежей базы (автообновление)
const idb = {
  open: () => new Promise((ok, err) => {
    const r = indexedDB.open('ml-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('servers');
    r.onsuccess = () => ok(r.result); r.onerror = () => err(r.error);
  }),
  async get(k) { const db = await this.open(); return new Promise(ok => { const r = db.transaction('servers').objectStore('servers').get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); }); },
  async set(k, v) { const db = await this.open(); return new Promise(ok => { const t = db.transaction('servers', 'readwrite'); t.objectStore('servers').put(v, k); t.oncomplete = () => ok(); }); },
};

async function fetchServerData(server) {
  // приоритет: кэш обновлений → вшитая база → dev-путь
  const cached = await idb.get(server).catch(() => null);
  let d = null;
  let resp = await fetch(`data/${encodeURIComponent(server)}.json`).catch(() => null);
  if (!resp || !resp.ok) resp = await fetch(`../_enriched/${encodeURIComponent(server)}.json`).catch(() => null);
  if (resp && resp.ok) d = await resp.json();
  if (cached && (!d || (cached.scraped_at || '') > (d.scraped_at || ''))) d = cached;
  if (!d) throw new Error('нет данных для ' + server);
  return d;
}

function unpackData(d) {
  const arts = [], docs = [];
  for (const doc of d.documents) {
    const entry = {id: doc.id, title: doc.title, type: doc.type, section: doc.section, url: doc.url, count: doc.article_count, articles: []};
    for (const ch of doc.chapters) for (const a of ch.articles) {
      const art = {
        id: doc.id + ':' + a.num, num: a.num,
        title: a.title || '', tags: a.tags || [], jur: a.jur || null,
        text: a.text, doc: doc.title, docType: doc.type, docId: doc.id,
        chapter: (ch.title || '').trim(), section: doc.section,
        sanctions: a.sanctions || null, flags: a.flags || null, url: doc.url,
      };
      arts.push(art);
      entry.articles.push(art);
    }
    if (entry.articles.length) docs.push(entry);
  }
  return {arts, docs, scrapedAt: (d.scraped_at || '').slice(0, 10)};
}

// фоновая проверка обновлений базы; молчит, пока CFG.remoteDb пуст
async function checkRemoteUpdate(server) {
  if (!CFG.remoteDb) return;
  try {
    const idx = await (await fetch(CFG.remoteDb + '/index.json', {cache: 'no-store'})).json();
    const entry = (idx.servers || []).find(s => s.server === server);
    if (!entry || (entry.scraped_at || '').slice(0, 10) <= (state.scrapedAt || '')) return;
    const fresh = await (await fetch(`${CFG.remoteDb}/${encodeURIComponent(server)}.json`)).json();
    await idb.set(server, fresh);
    const pill = $('freshness');
    pill.textContent = 'обновление готово — клик';
    pill.style.cursor = 'pointer';
    pill.classList.add('stale');
    pill.onclick = () => { pill.onclick = null; pill.style.cursor = ''; loadServer(server); };
  } catch (e) { /* оффлайн или репо ещё не создан */ }
}

async function loadServer(server) {
  $('searchStats').textContent = 'загрузка…';
  const d = await fetchServerData(server);
  const {arts, docs, scrapedAt} = unpackData(d);
  dataCache.set(server, {arts, docs, scrapedAt});
  state.articles = arts;
  state.docs = docs;
  state.index = LS.buildIndex(arts);
  state.scrapedAt = scrapedAt;
  $('freshness').textContent = 'база ' + (scrapedAt ? scrapedAt.split('-').reverse().join('.') : '?');
  $('freshness').classList.toggle('stale', !!scrapedAt && (Date.now() - new Date(scrapedAt)) / 864e5 > 14);
  hist.stack = []; hist.pos = -1;
  // дип-линк вида #/s/<Server>/<docId>/<num> открывает статью сразу
  const dl = parseHash();
  if (dl && dl.server === server && dl.artId) {
    const a = state.articles.find(x => x.id === dl.artId);
    if (a) { pushHist(snap('docs')); navigate({article: a}); }
    else navigate();
  } else navigate();
  checkRemoteUpdate(server);
}

/* дип-линки: #/s/<Server>/<docId>/<num> */
function parseHash() {
  const m = location.hash.match(/^#\/s\/([^/]+)\/(\d+)\/([\d.]+)$/);
  return m ? {server: decodeURIComponent(m[1]), artId: m[2] + ':' + m[3]} : null;
}
function articleHash(a) {
  return `#/s/${encodeURIComponent(state.server)}/${a.docId}/${a.num}`;
}

/* отображение санкций */
const fmtMoney = n => n >= 1000 ? (n / 1000) + 'к$' : n + '$';
function sanChips(s) {
  if (!s) return [];
  const out = [];
  if (s.fine_max !== undefined) out.push(['san-fine', s.fine_min !== undefined && s.fine_min !== s.fine_max ? `${fmtMoney(s.fine_min)}–${fmtMoney(s.fine_max)}` : fmtMoney(s.fine_max)]);
  if (s.prison_max !== undefined) out.push(['san-prison', `${s.prison_min ? s.prison_min + '–' : ''}${s.prison_max} ${s.prison_unit === 'месяц' ? 'мес' : (s.prison_unit === 'минут' ? 'мин' : 'лет')}`]);
  if (s.wanted_stars) out.push(['san-stars', '★'.repeat(Math.min(s.wanted_stars, 5))]);
  if (s.bail !== undefined) out.push(['san-bail', 'залог ' + fmtMoney(s.bail)]);
  else if (s.bail_denied) out.push(['san-bail', 'без залога']);
  if (s.license_revoke) out.push(['san-lic', 'права']);
  if (s.life_sentence) out.push(['san-prison', 'пожизненно']);
  if (s.death_penalty) out.push(['san-prison', 'высшая мера']);
  return out;
}
const DOC_SHORT = [
  [/уголовн/i, 'УК'], [/административн/i, 'АК'], [/дорожн/i, 'ДК'], [/процессуальн/i, 'ПК'],
  [/судебн.*кодекс|кодекс.*судебн/i, 'СК'], [/трудов/i, 'ТК'], [/воздушн/i, 'ВК'],
  [/этик/i, 'КЭ'], [/конституц/i, 'КОНСТ'],
];
const docShort = t => (DOC_SHORT.find(([re]) => re.test(t)) || [null, null])[1] || t.replace(/закон\s*/i, '').slice(0, 26);
const docBadge = t => (DOC_SHORT.find(([re]) => re.test(t)) || [null, null])[1] || 'ЗАКОН';

/* навигация (единая точка входа, пишет историю) */
function navigate(target) {
  // target: undefined → по строке поиска; {doc} | {article}
  if (target && target.doc) { pushHist(snap('doc', {docId: target.doc.id})); renderDoc(target.doc); return; }
  if (target && target.article) { pushHist(snap('article', {artId: target.article.id})); renderArticle(target.article); return; }
  const q = $('q').value.trim();
  if (q) { pushHist(snap('search')); doSearch(); }
  else { pushHist(snap('docs')); renderDocs(); }
}

/* рендеры (историю НЕ трогают) */
function enterAnim(node) {
  node.classList.remove('enter');
  void node.offsetWidth;
  node.classList.add('enter');
}
function stagger(ul) {
  [...ul.children].slice(0, 12).forEach((li, i) => li.style.animationDelay = (i * 11) + 'ms');
}

function doSearch() {
  const q = $('q').value.trim();
  const f = FILTERS[state.filter];
  const t0 = performance.now();
  let res = LS.search(state.index, q, {limit: 60});
  if (f.re) res = res.filter(a => f.re.test(a.doc));
  res = res.slice(0, 40);
  state.results = res;
  state.sel = 0;
  state.view = 'list';
  $('searchStats').textContent = `${res.length} · ${(performance.now() - t0).toFixed(1)}ms`;
  const ul = $('results');
  ul.textContent = '';
  ul.classList.remove('in-doc');
  $('empty').hidden = res.length > 0;
  showPane('results');
  res.forEach((a, i) => ul.append(articleRow(a, i)));
  stagger(ul); enterAnim(ul);
  $('meta').textContent = `${state.server} · ${state.articles.length} статей`;
}

function renderDocs() {
  const f = FILTERS[state.filter];
  const docs = state.docs
    .filter(d => !f.re || f.re.test(d.title))
    .sort((a, b) => {
      const pa = a.type === 'конституция' ? 0 : a.type === 'кодекс' ? 1 : 2;
      const pb = b.type === 'конституция' ? 0 : b.type === 'кодекс' ? 1 : 2;
      return pa - pb || a.title.localeCompare(b.title, 'ru');
    });
  state.results = docs;
  state.sel = 0;
  state.view = 'docs';
  $('searchStats').textContent = `${docs.length} документов`;
  const ul = $('results');
  ul.textContent = '';
  ul.classList.remove('in-doc');
  $('empty').hidden = docs.length > 0;
  showPane('results');
  docs.forEach((d, i) => {
    const li = el('li', 'row row-doc' + (i === state.sel ? ' sel' : ''));
    li.dataset.idx = i;
    li.append(el('span', 'r-num', docBadge(d.title)));
    const mid = el('div', 'r-mid');
    mid.append(el('div', 'r-title', d.title));
    mid.append(el('div', 'r-doc', d.section + ' · ' + d.count + ' ст.'));
    li.append(mid);
    const right = el('div', 'r-san');
    right.append(el('span', 'san-bail', String(d.count)));
    li.append(right);
    li.addEventListener('click', () => navigate({doc: d}));
    li.addEventListener('mousemove', () => { if (state.sel !== i) { state.sel = i; markSel(); } });
    ul.append(li);
  });
  stagger(ul); enterAnim(ul);
  $('meta').textContent = `${state.server} · ${state.articles.length} статей · ${state.docs.length} док.`;
}

function renderDoc(d) {
  state.openDoc = d;
  state.view = 'doc';
  state.results = d.articles;
  state.sel = 0;
  $('searchStats').textContent = d.count + ' ст.';
  const ul = $('results');
  ul.textContent = '';
  ul.classList.add('in-doc');
  $('empty').hidden = true;
  showPane('results');
  const head = el('li', 'doc-head');
  const back = el('button', 'a-back');
  back.append(el('kbd', 'key', 'Esc'), document.createTextNode('оглавление'));
  back.addEventListener('click', () => goHist(-1));
  head.append(back, el('span', 'doc-head-t', d.title));
  ul.append(head);
  let lastCh = null;
  d.articles.forEach((a, i) => {
    if (a.chapter !== lastCh && a.chapter) {
      lastCh = a.chapter;
      ul.append(el('li', 'ch-head', a.chapter));
    }
    ul.append(articleRow(a, i));
  });
  enterAnim(ul);
  markSel();
}

function articleRow(a, i) {
  const li = el('li', 'row' + (i === state.sel ? ' sel' : ''));
  li.dataset.idx = i;
  li.append(el('span', 'r-num', a.num));
  const mid = el('div', 'r-mid');
  mid.append(el('div', 'r-title', a.title || a.text.slice(0, 80)));
  mid.append(el('div', 'r-doc', docShort(a.doc) + (a.chapter ? ' · ' + a.chapter : '')));
  li.append(mid);
  const san = el('div', 'r-san');
  for (const [cls, txt] of sanChips(a.sanctions).slice(0, 4)) san.append(el('span', cls, txt));
  li.append(san);
  li.addEventListener('click', () => { state.sel = i; navigate({article: a}); });
  li.addEventListener('mousemove', () => { if (state.sel !== i) { state.sel = i; markSel(); } });
  return li;
}

function markSel() {
  const rows = [...$('results').querySelectorAll('.row')];
  rows.forEach(li => li.classList.toggle('sel', +li.dataset.idx === state.sel));
  const selRow = rows.find(li => li.classList.contains('sel'));
  if (selRow) selRow.scrollIntoView({block: 'nearest'});
}

/* статья */
const SAN_LABEL = {'san-fine': 'Штраф', 'san-prison': 'Срок', 'san-stars': 'Розыск', 'san-bail': 'Залог', 'san-lic': 'Лишение'};
function renderArticle(a) {
  state.view = 'article';
  state.currentArticle = a;
  const art = $('article');
  art.textContent = '';

  const head = el('div', 'a-head');
  const back = el('button', 'a-back');
  back.append(el('kbd', 'key', 'Esc'), document.createTextNode('назад'));
  back.addEventListener('click', () => goHist(-1));
  head.append(back, el('span', 'a-num', a.num));
  const titles = el('div', 'a-titles');
  titles.append(el('div', 'a-title', a.title || 'Статья ' + a.num));
  titles.append(el('div', 'a-crumb', `${state.server} · ${a.doc}${a.chapter ? ' · ' + a.chapter : ''}`));
  head.append(titles);
  // сравнить эту статью на всех серверах
  const cmp = el('button', 'a-link');
  cmp.title = 'Сравнить на всех серверах';
  cmp.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 4.5h8m0 0L7.5 2M10 4.5 7.5 7M12 9.5H4m0 0L6.5 7M4 9.5 6.5 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  cmp.addEventListener('click', () => openCompare(a));
  head.append(cmp);
  // поделиться ссылкой (в вебе — всегда; в оверлее — если задан shareBase)
  const shareBase = IS_TAURI ? CFG.shareBase : location.origin + location.pathname;
  if (shareBase) {
    const share = el('button', 'a-link');
    share.title = 'Скопировать ссылку на статью';
    share.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="3.5" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/><circle cx="10.5" cy="3.2" r="1.8" stroke="currentColor" stroke-width="1.2"/><circle cx="10.5" cy="10.8" r="1.8" stroke="currentColor" stroke-width="1.2"/><path d="M5.2 6.2 8.8 4M5.2 7.8 8.8 10" stroke="currentColor" stroke-width="1.2"/></svg>';
    share.addEventListener('click', () => {
      navigator.clipboard.writeText(shareBase + articleHash(a));
      share.style.color = 'var(--ok)';
      setTimeout(() => share.style.color = '', 700);
    });
    head.append(share);
  }
  const link = el('a', 'a-link');
  link.href = a.url; link.target = '_blank'; link.title = 'Открыть на форуме';
  link.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 2.5H2.5v9h9V8.5M8 2h4m0 0v4m0-4L6.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  head.append(link);
  art.append(head);
  if (!IS_TAURI) history.replaceState(null, '', articleHash(a)); // адресная строка = дип-линк

  const chips = sanChips(a.sanctions);
  if (chips.length) {
    const wrap = el('div', 'a-sanctions');
    for (const [cls, txt] of chips) {
      const c = el('div', 'san-card c-' + cls.replace('san-', ''));
      c.append(el('b', null, txt.replace(/^залог /, '')), el('span', null, SAN_LABEL[cls] || ''));
      wrap.append(c);
    }
    art.append(wrap);
  }
  if (a.flags || a.jur) {
    const fl = el('div', 'a-flags');
    for (const f of a.flags || []) fl.append(el('span', 'pill', f));
    if (a.jur) fl.append(el('span', 'pill', a.jur));
    art.append(fl);
  }

  // текст с кликабельными перекрёстными ссылками на статьи этого же документа
  const sameDoc = state.docs.find(dd => dd.id === a.docId);
  const resolve = num => sameDoc && sameDoc.articles.find(x => x.num === num);
  const text = el('div', 'a-text');
  const safe = a.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const xr = (pre, num) => (num !== a.num && resolve(num))
    ? `${pre}<a class="xref" data-num="${num}" title="Перейти к ст. ${num}">${num}</a>`
    : `${pre}<span class="hl-num">${num}</span>`;
  text.innerHTML = safe
    .replace(/(Наказание:[^\n]*)/g, '<span class="hl-pen">$1</span>')
    // «статьёй 5», «ст. 12.8» — слово + номер (в т.ч. одиночный)
    .replace(/(стать[яеиью][а-яё]*\s+|ст\.\s*)(\d+(?:\.\d+)*)(?=[\s.,;)])/gi, (m, pre, num) => xr(pre, num))
    // голые составные номера: «12.8.1», «6.2»
    .replace(/(^|\s)(\d+(?:\.\d+)+)(?=[\s.,;)])/g, (m, pre, num) => xr(pre, num));
  text.addEventListener('click', (e) => {
    const x = e.target.closest('.xref');
    if (!x) return;
    const tgt = resolve(x.dataset.num);
    if (tgt) navigate({article: tgt});
  });
  art.append(text);

  if (a.tags && a.tags.length) {
    const tw = el('div', 'a-tags');
    for (const t of a.tags) tw.append(el('span', 'tag', t));
    art.append(tw);
  }
  showPane('article');
  enterAnim(art);
  art.scrollTop = 0;
  $('q').focus();
}

/* сравнение статьи между серверами */
const normCmp = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
function openCompare(a) {
  pushHist(snap('compare', {artId: a.id}));
  renderCompare(a);
}
function renderCompare(a) {
  state.view = 'compare';
  const art = $('article');
  art.textContent = '';
  const head = el('div', 'a-head');
  const back = el('button', 'a-back');
  back.append(el('kbd', 'key', 'Esc'), document.createTextNode('назад'));
  back.addEventListener('click', () => goHist(-1));
  head.append(back, el('span', 'a-num', a.num));
  const titles = el('div', 'a-titles');
  titles.append(el('div', 'a-title', a.title || 'Статья ' + a.num));
  titles.append(el('div', 'a-crumb', docShort(a.doc) + ' ст. ' + a.num + ' · сравнение по серверам'));
  head.append(titles);
  art.append(head);
  const list = el('div', 'cmp-list');
  art.append(list);
  showPane('article');
  enterAnim(art);
  art.scrollTop = 0;

  const short = docShort(a.doc);
  const myText = normCmp(a.text);
  for (const srv of SERVERS) {
    const row = el('div', 'cmp-row');
    row.append(el('div', 'cmp-srv', srv));
    const body = el('div', 'cmp-body');
    body.append(el('span', 'cmp-wait', '…'));
    row.append(body);
    list.append(row);
    (async () => {
      try {
        let cache = dataCache.get(srv);
        if (!cache) { cache = unpackData(await fetchServerData(srv)); dataCache.set(srv, cache); }
        const m = cache.arts.find(x => docShort(x.doc) === short && x.num === a.num);
        body.textContent = '';
        if (!m) { body.append(el('span', 'cmp-none', 'нет такой статьи')); row.classList.add('none'); return; }
        const san = el('div', 'r-san');
        for (const [cls, txt] of sanChips(m.sanctions).slice(0, 5)) san.append(el('span', cls, txt));
        if (!san.children.length) san.append(el('span', 'san-bail', 'без санкций'));
        body.append(san);
        const same = normCmp(m.text) === myText;
        body.append(el('span', 'cmp-mark' + (same ? ' same' : ''), same ? 'совпадает' : 'отличается'));
        if (srv === state.server) row.classList.add('cur');
        row.classList.add('ok');
        row.addEventListener('click', () => {
          const t = row.querySelector('.cmp-text');
          if (t) { t.remove(); return; }
          row.append(el('div', 'cmp-text', m.text));
        });
      } catch (e) {
        body.textContent = '';
        body.append(el('span', 'cmp-none', 'не загрузился'));
      }
    })();
  }
}

function showPane(which) {
  $('results').hidden = which !== 'results';
  $('article').hidden = which !== 'article';
  if (which === 'article') $('empty').hidden = true;
}

/* фильтры */
function renderFilters() {
  const nav = $('filters');
  nav.textContent = '';
  FILTERS.forEach((f, i) => {
    const b = el('button', 'chip' + (i === state.filter ? ' on' : ''), f.label);
    b.addEventListener('click', () => { state.filter = i; renderFilters(); navigate(); });
    nav.append(b);
  });
}

/* выбор сервера (кастомный дропдаун) */
const dd = $('serverDD'), ddMenu = $('serverMenu');
function buildServerMenu() {
  ddMenu.textContent = '';
  for (const s of SERVERS) {
    const it = el('button', 'sm-item' + (s === state.server ? ' on' : ''), s);
    it.addEventListener('click', () => {
      closeMenu();
      if (s === state.server) return;
      state.server = s;
      localStorage.setItem('ml.server', s);
      $('serverName').textContent = s;
      loadServer(s);
    });
    ddMenu.append(it);
  }
}
function openMenu() {
  buildServerMenu();
  ddMenu.hidden = false;
  dd.classList.add('open');
  const on = ddMenu.querySelector('.sm-item.on');
  if (on) on.scrollIntoView({block: 'center'});
}
function closeMenu() { ddMenu.hidden = true; dd.classList.remove('open'); }
$('serverBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  ddMenu.hidden ? openMenu() : closeMenu();
});
document.addEventListener('click', (e) => { if (!dd.contains(e.target)) closeMenu(); });

/* кнопки окна и навигации */
$('navBack').addEventListener('click', () => goHist(-1));
$('navFwd').addEventListener('click', () => goHist(1));
$('btnMin').addEventListener('click', () => { const w = tauriWin(); if (w) w.minimize(); });
$('btnClose').addEventListener('click', () => {
  const w = tauriWin();
  if (w) w.hide();
  else { // демо в браузере: мягко спрятать и вернуть
    const p = $('palette');
    p.style.transition = 'opacity 140ms ease, transform 140ms ease';
    p.style.opacity = '0'; p.style.transform = 'translateX(-50%) translateY(-8px)';
    setTimeout(() => { p.style.opacity = ''; p.style.transform = ''; p.style.transition = ''; }, 900);
  }
});

/* пиновка статьи (Ctrl+P): мини-окно поверх экрана */
let pinN = 0;
function pinArticle(a) {
  if (!a || !window.__TAURI__) return;
  const key = 'ml.pin.' + Date.now();
  localStorage.setItem(key, JSON.stringify({num: a.num, title: a.title, text: a.text, chips: sanChips(a.sanctions)}));
  const {WebviewWindow} = window.__TAURI__.webviewWindow;
  new WebviewWindow('pin-' + Date.now(), {
    url: 'pin.html?k=' + encodeURIComponent(key),
    width: 380, height: 300,
    x: 40 + (pinN % 4) * 30, y: 90 + (pinN % 4) * 30,
    decorations: false, transparent: true, alwaysOnTop: true,
    skipTaskbar: true, resizable: true, shadow: false,
    title: 'Пин ' + a.num,
  });
  pinN++;
}

/* клавиатура */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'p' || e.key === 'з')) {
    e.preventDefault();
    const a = state.view === 'article' ? state.currentArticle : state.results[state.sel];
    if (a && a.text) pinArticle(a);
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goHist(-1); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goHist(1); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (state.view === 'article') return;
    const d = e.key === 'ArrowDown' ? 1 : -1;
    state.sel = Math.max(0, Math.min(state.results.length - 1, state.sel + d));
    markSel();
  } else if (e.key === 'Enter') {
    if (state.view === 'docs') navigate({doc: state.results[state.sel]});
    else if (state.view === 'list' || state.view === 'doc') navigate({article: state.results[state.sel]});
  } else if (e.key === 'Escape') {
    e.preventDefault();
    if (!ddMenu.hidden) { closeMenu(); return; }
    if (hist.pos > 0) { goHist(-1); return; }
    if ($('q').value) { $('q').value = ''; navigate(); return; }
    const w = tauriWin();
    if (w) w.hide();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    state.filter = (state.filter + (e.shiftKey ? FILTERS.length - 1 : 1)) % FILTERS.length;
    renderFilters();
    navigate();
  }
});

/* init */
let debTimer;
$('q').addEventListener('input', () => { clearTimeout(debTimer); debTimer = setTimeout(() => navigate(), 25); });

if (window.__TAURI__) document.body.classList.add('tauri');
$('serverName').textContent = state.server;
renderFilters();
loadServer(state.server);
$('q').focus();
