// форматирование текста статьи: подпункты, примечания, наказания.
// используется палитрой и пином; та же логика продублирована в генераторе веб-страниц.
(function () {
  'use strict';
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

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
    for (const line of raw.split('\n')) {
      let m;
      if ((m = line.match(/^\s*\*{0,3}(Примечание|Исключение|Важно)\s*[:.](.*)$/i))) {
        flush();
        out.push(`<span class="a-note"><b>${m[1]}</b>: ${inline(esc(m[2].replace(/\*+$/, '').trim()))}</span>`);
      } else if ((m = line.match(/^\s*([а-яa-z]\)|\d{1,2}[.)]|[-–•])\s+(.+)$/i))) {
        flush();
        out.push(`<span class="sub"><i class="sub-m">${esc(m[1])}</i><span>${inline(esc(m[2]))}</span></span>`);
      } else {
        buf.push(line);
      }
    }
    flush();
    return out.join('');
  };
})();
