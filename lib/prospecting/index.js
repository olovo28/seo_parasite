// Оркестрация дискавери площадок: классификация кандидата с сохранением в БД и
// извлечение доменов из URL (страница клиентов PEIQ / сохранённая выдача SERP) → импорт кандидатов.
// Сеть инъектируема (fetchImpl) для тестов; парс-логика — в footprints.js/classify.js (чистая).

import { classifyDomain } from './classify.js';
import { extractDomains, buildDorks } from './footprints.js';
import { getProspect, updateProspect, addNote, setStatus, importProspects, computeScore } from '../prospects.js';
import { resolveSemrushAccount, setUnitsBalance } from '../semrushAccounts.js';
import { domainMetrics, unitsBalance } from '../research/api.js';

export { buildDorks, extractDomains } from './footprints.js';
export { classifyDomain, classifyHtml, detectEngine, detectUgc, detectDofollow } from './classify.js';

// Классифицировать кандидата по id и сохранить результат (движок, признаки UGC, dofollow) + заметку.
// Если найден PEIQ + UGC и статус был new → авто-перевод в qualified. Возвращает результат classifyDomain.
export async function runClassify(db, id, { fetchImpl, timeoutMs } = {}) {
  const p = getProspect(db, id);
  if (!p) throw new Error('Кандидат не найден.');
  const r = await classifyDomain(p.domain, { fetchImpl, timeoutMs });
  if (!r.ok) {
    addNote(db, id, `классификация: ошибка — ${r.error}`, 'system');
    return r;
  }
  updateProspect(db, id, {
    ...p,
    // Классификация авторитетна: если движок не определён — пишем 'unknown', а не оставляем импортный дефолт.
    engine: r.engine || 'unknown',
    has_register: r.has_register,
    has_ugc_form: r.has_ugc_form,
    dofollow: r.dofollow,
  });
  const fl = (v) => (v === 1 ? 'да' : v === 0 ? 'нет' : '—');
  const redir = r.redirected ? ` [редирект на ${r.redirectedTo}]` : '';
  addNote(
    db,
    id,
    `классификация: движок=${r.engine || 'не определён'} (скор ${r.engine_score}; ${r.hits.join(',') || '—'})${redir}; ` +
      `регистрация=${fl(r.has_register)}, форма=${fl(r.has_ugc_form)}, dofollow=${fl(r.dofollow)}; стр.=${r.fetched.join('+')}`,
    'system',
  );
  // Авто-qualify только для целевого движка на СВОЁМ домене (не мигрировавшем).
  if (p.status === 'new' && r.engine === 'peiq' && !r.redirected && r.has_register && r.has_ugc_form) {
    setStatus(db, id, 'qualified', 'авто: PEIQ + регистрация + форма');
  }
  return r;
}

// Базы SEMrush по стране кандидата (иначе fallback из аргумента).
const SEMRUSH_DBS = new Set(['de', 'at', 'ch', 'us', 'uk', 'fr', 'it', 'es', 'nl', 'pl', 'ru']);

// Обогатить метрики мощности кандидатов через SEMrush API (Authority Score + орг. трафик) → пересчёт скора.
// По умолчанию берёт кандидатов без метрик. fetcher(domain, dbCode) инъектируем для тестов (иначе SEMrush API).
// Возвращает { account, enriched, results, unitsLeft? }.
export async function enrichMetrics(db, { ids, database = 'de', limit = 1000, fetcher } = {}) {
  let key = null;
  let acc = null;
  if (!fetcher) {
    acc = resolveSemrushAccount(db); // бросит, если нет включённых аккаунтов
    if (!acc.api_key) throw new Error('У выбранного SEMrush-аккаунта нет API-ключа.');
    key = acc.api_key;
  }
  const fetchMetrics = fetcher || ((domain, dbCode) => domainMetrics({ key, domain, database: dbCode }));

  let targets;
  if (ids && ids.length) {
    targets = ids.map((id) => getProspect(db, id)).filter(Boolean);
  } else {
    targets = db.prepare('SELECT * FROM site_prospects WHERE metrics_updated_at IS NULL ORDER BY id').all().slice(0, limit);
  }

  const upd = db.prepare(
    "UPDATE site_prospects SET authority=?, traffic=?, score=?, metrics_source='semrush', metrics_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
  );
  const results = [];
  for (const p of targets) {
    const dbCode = SEMRUSH_DBS.has(p.country) ? p.country : database;
    const m = await fetchMetrics(p.domain, dbCode);
    const authority = m.authority ?? p.authority;
    const traffic = m.traffic ?? p.traffic;
    const score = computeScore({ authority, traffic, has_ugc_form: p.has_ugc_form, dofollow: p.dofollow });
    upd.run(authority, traffic, score, p.id);
    addNote(db, p.id, `метрики SEMrush(${dbCode}): AS=${m.authority ?? '—'}, трафик=${m.traffic ?? '—'}, реф.доменов=${m.ref_domains ?? '—'} → скор=${score}`, 'system');
    results.push({ id: p.id, domain: p.domain, authority, traffic, score });
  }

  let unitsLeft;
  if (key && acc) {
    try {
      const u = await unitsBalance(key);
      if (u != null) {
        setUnitsBalance(db, acc.id, u);
        unitsLeft = u;
      }
    } catch {
      /* баланс — best-effort */
    }
  }
  return { account: acc ? acc.label || acc.id : 'fake', enriched: results.length, results, unitsLeft };
}

// Скачать страницу-источник, извлечь домены и импортировать как кандидатов. fetchImpl инъектируем.
// Возвращает { ok, domains, ...importResult, error? }.
export async function discoverFromUrl(db, url, { fetchImpl, engine = 'peiq', country, discovery_source = 'serp', timeoutMs = 15000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let html;
  try {
    const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; site-prospector/1.0)' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, domains: [] };
    html = await res.text();
  } catch (e) {
    return { ok: false, error: e.message, domains: [] };
  } finally {
    clearTimeout(timer);
  }
  const domains = extractDomains(html);
  const imp = importProspects(db, domains.join('\n'), { engine, country, discovery_source });
  return { ok: true, domains, ...imp };
}
