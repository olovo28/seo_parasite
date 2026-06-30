// Авторский блок ссылок (BBCode): валидация, превью, подстановка Binom-параметров.
// Пользователь сам пишет блок (бренды/описания/эмодзи/порядок); система добавляет в каждый
// URL Binom-параметры s1 (статья) и s2 (порядковый номер ссылки в блоке).

function appendParams(url, params) {
  const [base, hash = ''] = String(url).split('#');
  const sep = base.includes('?') ? '&' : '?';
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return base + sep + qs + (hash ? '#' + hash : '');
}

// Вставить Binom-параметры в каждый [urlnt=URL] блока. s2 = порядковый номер (1..N).
// Возвращает { block, links: [{ link_id, anchor, base_url, final_url }] }.
export function injectBinomLinks(block, { articleParam = 's1', linkParam = 's2', trackingId } = {}) {
  let i = 0;
  const links = [];
  const out = String(block || '').replace(/\[urlnt=([^\]]+)\]([\s\S]*?)\[\/urlnt\]/g, (_m, url, anchor) => {
    i += 1;
    const final = appendParams(url.trim(), { [articleParam]: trackingId, [linkParam]: String(i) });
    links.push({
      link_id: String(i),
      anchor: anchor.replace(/\[[^\]]*\]/g, '').trim(), // анкор без вложенных тегов
      base_url: url.trim(),
      final_url: final,
    });
    return `[urlnt=${final}]${anchor}[/urlnt]`;
  });
  return { block: out, links };
}

// Извлечь ТЕКСТОВЫЕ бонус-фразы из блока ссылок (без URL/BBCode) — для подстановки в промт ({{OFFERS}}),
// чтобы Claude вплёл реальные офферы в начало статьи (под сниппет Google). Ссылку заменяем её анкором,
// прочие теги вырезаем. Каждый [*]…[/*] — один оффер.
export function offerPhrasesFromBlock(block) {
  const text = String(block || '');
  const items = [...text.matchAll(/\[\*\]([\s\S]*?)\[\/\*\]/g)].map((m) => m[1]);
  const src = items.length ? items : text ? [text] : [];
  return src
    .map((s) =>
      s
        .replace(/\[urlnt=[^\]]+\]([\s\S]*?)\[\/urlnt\]/g, '$1') // ссылка → её анкор (бренд)
        .replace(/\[[^\]]*\]/g, '') // остальные BBCode-теги долой
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

// Проверка баланса BBCode-тегов. Возвращает { ok, issues:[..], urls:[..] }.
export function validateBlock(block) {
  const text = String(block || '');
  const issues = [];
  for (const t of ['list', 'b', 'u', 'i', 'h2', 'quote']) {
    const open = (text.match(new RegExp(`\\[${t}\\]`, 'g')) || []).length;
    const close = (text.match(new RegExp(`\\[/${t}\\]`, 'g')) || []).length;
    if (open !== close) issues.push(`[${t}] — открыт ${open}, закрыт ${close}`);
  }
  const urlOpen = (text.match(/\[urlnt=[^\]]+\]/g) || []).length;
  const urlClose = (text.match(/\[\/urlnt\]/g) || []).length;
  if (urlOpen !== urlClose) issues.push(`[urlnt] — открыт ${urlOpen}, закрыт ${urlClose}`);
  const starOpen = (text.match(/\[\*\]/g) || []).length;
  const starClose = (text.match(/\[\/\*\]/g) || []).length;
  if (starOpen !== starClose) issues.push(`[*] — открыт ${starOpen}, закрыт ${starClose}`);
  const urls = [...text.matchAll(/\[urlnt=([^\]]+)\]/g)].map((m) => m[1].trim());
  return { ok: issues.length === 0, issues, urls };
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Грубое превью BBCode → HTML (только для глаза в админке).
export function bbcodeToHtml(block) {
  let h = escHtml(block || '');
  h = h.replace(/\[h2\]([\s\S]*?)\[\/h2\]/g, '<h4>$1</h4>');
  h = h.replace(/\[list\]([\s\S]*?)\[\/list\]/g, (_m, inner) => '<ul>' + inner.replace(/\[\*\]([\s\S]*?)\[\/\*\]/g, '<li>$1</li>') + '</ul>');
  h = h.replace(/\[b\]([\s\S]*?)\[\/b\]/g, '<b>$1</b>');
  h = h.replace(/\[u\]([\s\S]*?)\[\/u\]/g, '<u>$1</u>');
  h = h.replace(/\[i\]([\s\S]*?)\[\/i\]/g, '<i>$1</i>');
  h = h.replace(/\[urlnt=([^\]]+)\]([\s\S]*?)\[\/urlnt\]/g, '<a href="$1" target="_blank" rel="noopener">$2</a>');
  return h.replace(/\n/g, '<br>');
}

// Вставить блок в HTML-тело по позиции относительно заголовков <h1..6>.
// pos: 'start' — в начало; 'end' (или нет заголовков) — в конец;
//      K (число) — перед (K+1)-м заголовком (т.е. после K-й секции).
export function insertLinkBlock(html, block, pos) {
  if (!block) return html;
  if (pos === 'start') return `${block}\n${html}`;
  if (pos === 'end' || pos == null) return `${html}\n${block}`;
  const k = Number(pos);
  if (!Number.isFinite(k)) return `${html}\n${block}`;
  const idx = [];
  const re = /<h[1-6][\s/>]/gi;
  let m;
  while ((m = re.exec(html))) idx.push(m.index);
  if (k < idx.length) {
    const at = idx[k];
    return html.slice(0, at) + block + '\n' + html.slice(at);
  }
  return `${html}\n${block}`;
}

// Вставить ОДИН И ТОТ ЖЕ блок в НЕСКОЛЬКО позиций (дублирование в большой статье).
// positions — массив значений как у insertLinkBlock ('start' | 'end' | число K). Дедуп.
// Числовые позиции вставляем «с конца», чтобы вставки не сдвигали смещения заголовков.
export function insertLinkBlockMulti(html, block, positions) {
  if (!block) return html;
  const list = (Array.isArray(positions) ? positions : [positions])
    .map((p) => (p === 'start' || p === 'end' ? p : String(Number(p))))
    .filter((p) => p === 'start' || p === 'end' || /^\d+$/.test(p));
  const uniq = [...new Set(list)];
  if (!uniq.length) return html;
  // смещения заголовков
  const idx = [];
  const re = /<h[1-6][\s/>]/gi;
  let m;
  while ((m = re.exec(html))) idx.push(m.index);
  let prependStart = false;
  let appendEnd = false;
  const offsets = [];
  for (const p of uniq) {
    if (p === 'start') prependStart = true;
    else if (p === 'end') appendEnd = true;
    else {
      const k = Number(p);
      if (k < idx.length) offsets.push(idx[k]);
      else appendEnd = true; // позиция за пределами заголовков → в конец
    }
  }
  let out = html;
  for (const at of [...new Set(offsets)].sort((a, b) => b - a)) out = out.slice(0, at) + block + '\n' + out.slice(at);
  if (prependStart) out = `${block}\n${out}`;
  if (appendEnd) out = `${out}\n${block}`;
  return out;
}

