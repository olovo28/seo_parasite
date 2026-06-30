// API-драйвер SEMrush (классический Standard API, api.semrush.com). Ответ — CSV через ';'.
// Юниты тратятся по строкам отчёта — поэтому экономно: дешёвое обнаружение + точечный Keyword Difficulty.

const BASE = 'https://api.semrush.com/';

// Код экспорт-колонки SEMrush → наше поле + парсер значения.
const COL = {
  Ph: ['phrase', (v) => v],
  Nq: ['volume', (v) => intOrNull(v)],
  Cp: ['cpc', (v) => floatOrNull(v)],
  Co: ['competition', (v) => floatOrNull(v)],
  Nr: ['results', (v) => intOrNull(v)],
  Td: ['trend', (v) => v || null],
  Kd: ['kd', (v) => floatOrNull(v)],
  In: ['intent', (v) => v || null],
};

// Примерная цена строки по типу отчёта (для оценки расхода юнитов / гейта «мало юнитов»).
export const UNIT_COST = { phrase_fullsearch: 20, phrase_related: 40, phrase_this: 10, phrase_kdi: 50 };

function intOrNull(v) {
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function floatOrNull(v) {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

async function fetchT(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Распарсить CSV-ответ SEMrush в массив объектов. cols — коды колонок в ПОРЯДКЕ запроса (позиционный маппинг,
// не полагаемся на имена в шапке). Первая строка — заголовок, отбрасываем.
export function parseSemrushCsv(text, cols) {
  const out = [];
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.length);
  if (lines.length <= 1) return out;
  for (const line of lines.slice(1)) {
    const parts = line.split(';');
    const row = {};
    cols.forEach((code, i) => {
      const def = COL[code];
      if (def) row[def[0]] = def[1](parts[i] ?? '');
    });
    if (row.phrase) out.push(row);
  }
  return out;
}

// Низкоуровневый вызов отчёта. Возвращает { rows, count, error }.
async function report({ key, type, phrase, database, cols, limit }) {
  const params = new URLSearchParams({ type, key, phrase, database, export_columns: cols.join(','), display_limit: String(limit || 100) });
  let text;
  try {
    const res = await fetchT(`${BASE}?${params}`, 30000);
    text = await res.text();
  } catch (e) {
    return { rows: [], count: 0, error: `сеть: ${e.message}` };
  }
  const head = String(text).slice(0, 200).trim();
  if (/^ERROR\s+\d+/i.test(head)) {
    // напр. "ERROR 50 :: NOTHING FOUND" — не ошибка, просто пусто
    if (/NOTHING FOUND/i.test(head)) return { rows: [], count: 0 };
    return { rows: [], count: 0, error: head.split('\n')[0] };
  }
  const rows = parseSemrushCsv(text, cols);
  return { rows, count: rows.length };
}

// Обнаружение ключей по seed (Broad Match) — массово, со средней ценой.
export function discoverKeywords({ key, phrase, database, limit = 100 }) {
  return report({ key, type: 'phrase_fullsearch', phrase, database, limit, cols: ['Ph', 'Nq', 'Cp', 'Co', 'Nr', 'Td', 'In'] }).then((r) => ({ ...r, type: 'phrase_fullsearch' }));
}

// Реальный Keyword Difficulty по списку фраз (дорого — только по шорт-листу). phrase — до ~100 через ';'.
export function keywordDifficulty({ key, phrases, database }) {
  const phrase = phrases.join(';');
  return report({ key, type: 'phrase_kdi', phrase, database, limit: phrases.length, cols: ['Ph', 'Kd'] }).then((r) => ({ ...r, type: 'phrase_kdi' }));
}

// Обзор одной фразы.
export function keywordOverview({ key, phrase, database }) {
  return report({ key, type: 'phrase_this', phrase, database, limit: 1, cols: ['Ph', 'Nq', 'Cp', 'Co', 'Nr', 'Td', 'In'] }).then((r) => ({ ...r, type: 'phrase_this' }));
}

// ===== Метрики ДОМЕНА (для скоринга площадок) =====
// Domain Overview (type=domain_ranks): запрашиваем колонки в порядке Dn,Rk,Or,Ot — парсим позиционно.
export function parseDomainRanks(text) {
  const head = String(text || '').slice(0, 200).trim();
  if (/^ERROR/i.test(head)) return { rank: null, organic_keywords: null, traffic: null, error: head.split('\n')[0] };
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.length);
  if (lines.length <= 1) return { rank: null, organic_keywords: null, traffic: null };
  const c = lines[1].split(';');
  return { rank: intOrNull(c[1]), organic_keywords: intOrNull(c[2]), traffic: intOrNull(c[3]) };
}

// Backlinks Overview (type=backlinks_overview): колонки ascore,total,domains_num.
export function parseBacklinksOverview(text) {
  const head = String(text || '').slice(0, 200).trim();
  if (/^ERROR/i.test(head)) return { authority: null, backlinks: null, ref_domains: null, error: head.split('\n')[0] };
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.length);
  if (lines.length <= 1) return { authority: null, backlinks: null, ref_domains: null };
  const c = lines[1].split(';');
  return { authority: intOrNull(c[0]), backlinks: intOrNull(c[1]), ref_domains: intOrNull(c[2]) };
}

// Метрики домена: Authority Score (backlinks_overview) + орг. трафик/ключи/ранк (domain_ranks).
// fetchImpl инъектируем для тестов. database — региональная база SEMrush (de/at/ch/...).
export async function domainMetrics({ key, domain, database = 'de', fetchImpl } = {}) {
  const doFetch = fetchImpl || ((url) => fetchT(url, 30000));
  const overviewUrl = `${BASE}?${new URLSearchParams({ type: 'domain_ranks', key, domain, database, export_columns: 'Dn,Rk,Or,Ot' })}`;
  const backlinksUrl = `https://api.semrush.com/analytics/v1/?${new URLSearchParams({ key, type: 'backlinks_overview', target: domain, target_type: 'root_domain', export_columns: 'ascore,total,domains_num' })}`;
  const text = async (url) => {
    try {
      const res = await doFetch(url);
      return await res.text();
    } catch (e) {
      return `ERROR :: ${e.message}`;
    }
  };
  const [ov, bl] = await Promise.all([text(overviewUrl).then(parseDomainRanks), text(backlinksUrl).then(parseBacklinksOverview)]);
  return { authority: bl.authority, traffic: ov.traffic, rank: ov.rank, organic_keywords: ov.organic_keywords, backlinks: bl.backlinks, ref_domains: bl.ref_domains };
}

// Остаток API-юнитов аккаунта (число) или null.
export async function unitsBalance(key) {
  try {
    const res = await fetchT(`https://www.semrush.com/users/countapiunits.html?key=${encodeURIComponent(key)}`, 15000);
    const txt = (await res.text()).trim();
    const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
