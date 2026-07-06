// форматирование текста статьи: подпункты, примечания, наказания.
// используется палитрой и пином; та же логика продублирована в генераторе веб-страниц.
(function () {
  'use strict';
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

  // маркер списка + текст на одной строке
  const SUB_RE = /^\s*(ч\.\s*\d+(?:\.\d+)?|п\.\s*\d+(?:\.\d+)?|\([а-яa-z0-9]{1,3}\)|[а-яa-z]\)|\d{1,2}[.)]|[-–•])\s+(.+)$/i;
  // одинокий маркер на своей строке (текст на следующей): «1)», «а)», «(б)»
  const LONE_RE = /^\s*(\d{1,2}[.)]|[а-яa-z]\)|\([а-яa-z0-9]{1,3}\))\s*$/i;
  const MARK_START = /^\s*(ч\.|п\.|\d{1,2}[.)]|[а-яa-z]\)|[-–•]|\()/i;
  const subTier = mk => /^[чп]\./i.test(mk) ? 'sub-part' : (/^[-–•]/.test(mk) ? 'sub-dash' : 'sub-item');

  // подготовка строк: склейка одиноких маркеров с их текстом + схлопывание дублей подряд
  function normLines(raw) {
    const src = raw.split('\n');
    const lines = [];
    for (let i = 0; i < src.length; i++) {
      let l = src[i];
      if (LONE_RE.test(l)) {
        let j = i + 1;
        while (j < src.length && !src[j].trim()) j++;
        // склеиваем, только если следующая строка — обычный текст (не новый маркер)
        if (j < src.length && !MARK_START.test(src[j])) { l = l.trim() + ' ' + src[j].trim(); i = j; }
      }
      if (lines.length && l.trim() && l.trim() === lines[lines.length - 1].trim()) continue;
      lines.push(l);
    }
    return lines;
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
    const lines = normLines(raw);
    for (const line of lines) {
      let m;
      if ((m = line.match(/^\s*\*{0,3}(Примечание|Исключение|Важно)\s*[:.](.*)$/i))) {
        flush();
        out.push(`<span class="a-note"><b>${m[1]}</b>: ${inline(esc(m[2].replace(/\*+$/, '').trim()))}</span>`);
      } else if ((m = line.match(SUB_RE))) {
        flush();
        out.push(`<span class="sub ${subTier(m[1])}"><i class="sub-m">${esc(m[1])}</i><span>${inline(esc(m[2]))}</span></span>`);
      } else {
        buf.push(line);
      }
    }
    flush();
    return out.join('');
  };
})();
