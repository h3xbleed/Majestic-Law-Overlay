// форматирование текста статьи: подпункты, примечания, наказания.
// используется палитрой и пином; та же логика продублирована в генераторе веб-страниц (build-web.js).
(function () {
  'use strict';
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // Разбор ведущего маркера строки. Покрывает все форматы из базы:
  //   Часть N / ч. N / Пункт N / п. N        → уровень «part»  (структурный)
  //   N) / А) / (А) / (N) / Подпункт N        → уровень «item»  (пункт)
  //   N.N) / N.N.N)                           → уровень «sub»   (вложенный пункт)
  //   - – •                                   → уровень «dash»  (перечисление)
  // Возвращает {mk, rest, tier} или null.
  function parseMarker(line) {
    const t = line.replace(/^[\s*]+/, '');
    let m;
    if ((m = t.match(/^((?:Часть|Пункт|Подпункт)\s+\d+(?:\.\d+)?|[чп]\.\s*\d+(?:\.\d+)?)[.):]?\s*(.*)$/i))) {
      const isSub = /подпункт/i.test(m[1]);
      return { mk: m[1].replace(/\s+/g, ' '), rest: m[2], tier: isSub ? 'sub-item' : 'sub-part' };
    }
    if ((m = t.match(/^(\d+\.\d+(?:\.\d+)?[.)])\s*(.*)$/)))       return { mk: m[1], rest: m[2], tier: 'sub-two' };
    if ((m = t.match(/^(\d{1,2}[.)])\s+(.*)$/)))                 return { mk: m[1], rest: m[2], tier: 'sub-item' };
    if ((m = t.match(/^(\d{1,2}[.)])\s*$/)))                     return { mk: m[1], rest: '',   tier: 'sub-item' };
    if ((m = t.match(/^(\([а-яёa-z0-9]{1,3}\))\s*(.*)$/i)))      return { mk: m[1], rest: m[2], tier: 'sub-item' };
    if ((m = t.match(/^([а-яёa-z]\))\s+(.*)$/i)))               return { mk: m[1], rest: m[2], tier: 'sub-item' };
    if ((m = t.match(/^([а-яёa-z]\))\s*$/i)))                   return { mk: m[1], rest: '',   tier: 'sub-item' };
    if ((m = t.match(/^([-–—•])\s+(.*)$/)))                      return { mk: '–',  rest: m[2], tier: 'sub-dash' };
    return null;
  }

  // подготовка строк: чистка markdown-решёток, склейка одиноких маркеров, схлопывание дублей
  const stripHash = s => s.replace(/(^|\s)#{1,6}(?=\s|$)/g, '$1');
  function normLines(raw) {
    const src = raw.split('\n').map(stripHash);
    const out = [];
    for (let i = 0; i < src.length; i++) {
      let l = src[i];
      const mk = parseMarker(l);
      // маркер без текста на своей строке — подтянуть следующую строку, если она не маркер
      if (mk && !mk.rest.trim()) {
        let j = i + 1;
        while (j < src.length && !src[j].trim()) j++;
        if (j < src.length && !parseMarker(src[j])) { l = l.trim() + ' ' + src[j].trim(); i = j; }
      }
      if (out.length && l.trim() && l.trim() === out[out.length - 1].trim()) continue; // дубль подряд
      out.push(l);
    }
    return out;
  }

  // opts.xr — колбэк для кликабельных отсылок (только в палитре)
  window.formatLawText = function (raw, opts) {
    const inline = s => {
      s = s.replace(/(Наказание:[^\n]*)/g, '<span class="hl-pen">$1</span>');
      if (opts && opts.xr) {
        s = s.replace(/(стать[яеиью][а-яё]*\s+|ст\.\s*)(\d+(?:\.\d+)*)(?=[\s.,;)])/gi, (m, p, n) => opts.xr(p, n))
             .replace(/(^|\s)(\d+(?:\.\d+)+)(?=[\s.,;)])/g, (m, p, n) => opts.xr(p, n));
      } else {
        s = s.replace(/(^|\s)(\d+(?:\.\d+)+)(?=[\s.,;)])/g, '$1<span class="hl-num">$2</span>');
      }
      return s;
    };
    const out = [];
    let buf = [];
    const flush = () => { if (buf.length) { out.push(inline(esc(buf.join('\n')))); buf = []; } };
    for (const line of normLines(raw)) {
      let m, mk;
      if ((m = line.match(/^\s*\*{0,3}(Примечание|Исключение|Важно)\s*[:.](.*)$/i))) {
        flush();
        out.push(`<span class="a-note"><b>${m[1]}</b>: ${inline(esc(m[2].replace(/\*+$/, '').trim()))}</span>`);
      } else if ((mk = parseMarker(line)) && mk.rest.trim()) {
        flush();
        out.push(`<span class="sub ${mk.tier}"><i class="sub-m">${esc(mk.mk)}</i><span>${inline(esc(mk.rest))}</span></span>`);
      } else {
        buf.push(line);
      }
    }
    flush();
    return out.join('');
  };
})();
