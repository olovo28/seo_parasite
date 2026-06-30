// Каталог площадок-кандидатов для публикации (parasite SEO discovery).
// Жизненный цикл: внесли домен (new) → проверили годность (qualified) → пишем модули
// регистрации/публикации (registering/publishing) → наблюдаем выживаемость статей (testing) →
// рабочая (live) / мрёт (dead) / отклонён (rejected). Принятый кандидат связывается с sites.
// Источник кандидатов — footprint движка meinbezirk.at = PEIQ (см. lib/sites/meinbezirk.js).

// Статусы: code → { label (RU), badge (Tabler bg-*) }. Порядок = воронка.
export const PROSPECT_STATUSES = {
  new:         { label: 'новый',          badge: 'bg-secondary' },
  qualified:   { label: 'годится',        badge: 'bg-azure' },
  registering: { label: 'регистрация',    badge: 'bg-yellow' },
  publishing:  { label: 'публикация',     badge: 'bg-purple' },
  testing:     { label: 'тест выживания', badge: 'bg-orange' },
  live:        { label: 'рабочая',        badge: 'bg-green' },
  dead:        { label: 'мрёт',           badge: 'bg-red' },
  rejected:    { label: 'отклонён',       badge: 'bg-dark' },
  paused:      { label: 'пауза',          badge: 'bg-secondary' },
};

export const PROSPECT_ENGINES = ['peiq', 'wordpress', 'unknown'];
export const DISCOVERY_SOURCES = ['manual', 'peiq-kunden', 'serp', 'sibling'];

// Сводный скор «мощность × пригодность» (0..100). Идея: площадка ценна, только если на неё МОЖНО
// публиковать (UGC) И она мощная (authority/traffic) И ссылки рабочие (dofollow). Веса — настраиваемые.
// authority: шкала 0..100 (SEMrush Authority Score). traffic: орг./мес (лог-нормировка). null = «неизвестно».
export function computeScore(p = {}) {
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const auth = p.authority == null ? 0 : clamp01(Number(p.authority) / 100);
  const tr = p.traffic == null ? 0 : clamp01(Math.log10(Number(p.traffic) + 1) / 6); // 1e6/мес → ~1
  // Гейт публикации: без формы создания материала площадка почти бесполезна.
  const ugcGate = p.has_ugc_form === 1 ? 1 : 0.2;
  // dofollow: 1 — полный вес, 0 — ссылки nofollow (слабее), null — неизвестно (средне).
  const dofollowFactor = p.dofollow === 1 ? 1 : p.dofollow === 0 ? 0.3 : 0.7;
  const base = 0.65 * auth + 0.35 * tr; // мощность
  return Math.round(1000 * ugcGate * dofollowFactor * base) / 10; // 0..100, 1 знак
}

// Голый домен: убрать схему/путь/www, нижний регистр. Бросает при пустом.
export function normalizeDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) throw new Error('Пустой домен.');
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '');
  s = s.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  if (!s || !s.includes('.')) throw new Error(`Некорректный домен: ${raw}`);
  return s;
}

function touch(db, id) {
  db.prepare("UPDATE site_prospects SET updated_at = datetime('now') WHERE id = ?").run(id);
}

export function listProspects(db, { status, sort } = {}) {
  // sort: 'score' (по убыванию мощности, NULL в конец) | по умолчанию новизна (id DESC).
  const order = sort === 'score' ? 'score DESC NULLS LAST, id DESC' : 'id DESC';
  if (status && status !== 'all') {
    return db.prepare(`SELECT * FROM site_prospects WHERE status = ? ORDER BY ${order}`).all(status);
  }
  return db.prepare(`SELECT * FROM site_prospects ORDER BY ${order}`).all();
}

// Счётчики по статусам (+ all) — для фильтра-чипов в UI.
export function statusCounts(db) {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM site_prospects GROUP BY status').all();
  const out = { all: 0 };
  for (const k of Object.keys(PROSPECT_STATUSES)) out[k] = 0;
  for (const r of rows) {
    out[r.status] = r.c;
    out.all += r.c;
  }
  return out;
}

export function getProspect(db, id) {
  return db.prepare('SELECT * FROM site_prospects WHERE id = ?').get(id) || null;
}

export function getByDomain(db, domain) {
  return db.prepare('SELECT * FROM site_prospects WHERE domain = ?').get(normalizeDomain(domain)) || null;
}

// Добавить кандидата. Возвращает id. Дубль домена → ошибка (UNIQUE).
export function addProspect(db, { domain, name, engine, country, discovery_source, url, status, notes } = {}) {
  const d = normalizeDomain(domain);
  const info = db
    .prepare(
      `INSERT INTO site_prospects (domain, name, engine, country, discovery_source, url, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      d,
      String(name || '').trim() || null,
      String(engine || 'peiq').trim() || 'peiq',
      String(country || '').trim().toLowerCase() || null,
      String(discovery_source || 'manual').trim() || 'manual',
      String(url || '').trim() || null,
      PROSPECT_STATUSES[status] ? status : 'new',
    );
  const id = info.lastInsertRowid;
  if (String(notes || '').trim()) addNote(db, id, notes, 'note');
  return id;
}

// Массовый импорт. Строки: "domain", "domain, Название", "domain | Название" (разделитель , или |).
// Дубли доменов пропускаются. Возвращает { added, skipped, errors }.
export function importProspects(db, text, { engine = 'peiq', country, discovery_source = 'manual' } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0;
  let skipped = 0;
  const errors = [];
  for (const line of lines) {
    const [rawDomain, ...rest] = line.split(/[|,]/);
    const name = rest.join(',').trim() || null;
    try {
      const d = normalizeDomain(rawDomain);
      if (getByDomain(db, d)) {
        skipped += 1;
        continue;
      }
      addProspect(db, { domain: d, name, engine, country, discovery_source });
      added += 1;
    } catch (e) {
      errors.push(`${line}: ${e.message}`);
    }
  }
  return { added, skipped, errors };
}

// Сменить статус (+ опц. причина) с автозаписью в журнал.
export function setStatus(db, id, status, reason) {
  if (!PROSPECT_STATUSES[status]) throw new Error(`Неизвестный статус: ${status}`);
  const cur = getProspect(db, id);
  if (!cur) throw new Error('Кандидат не найден.');
  db.prepare("UPDATE site_prospects SET status = ?, reject_reason = ?, updated_at = datetime('now') WHERE id = ?").run(
    status,
    String(reason || '').trim() || null,
    id,
  );
  const r = String(reason || '').trim();
  addNote(db, id, `статус: ${PROSPECT_STATUSES[cur.status].label} → ${PROSPECT_STATUSES[status].label}${r ? ` (${r})` : ''}`, 'status');
}

// Тристейт-флаг из формы: '' → NULL, '1' → 1, '0' → 0.
function triState(v) {
  if (v === '' || v === undefined || v === null) return null;
  return Number(v) ? 1 : 0;
}
function numOrNull(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Обновить поля кандидата (метрики/признаки/мета/привязки). Принимает «сырые» строки из формы.
export function updateProspect(db, id, f = {}) {
  const cur = getProspect(db, id);
  if (!cur) throw new Error('Кандидат не найден.');
  const next = {
    authority: numOrNull(f.authority),
    traffic: numOrNull(f.traffic),
    has_register: triState(f.has_register),
    has_ugc_form: triState(f.has_ugc_form),
    dofollow: triState(f.dofollow),
  };
  const score = computeScore(next); // пересчёт скора от свежих метрик/признаков
  db.prepare(
    `UPDATE site_prospects SET
       name = ?, engine = ?, country = ?, discovery_source = ?, url = ?,
       authority = ?, traffic = ?,
       has_register = ?, has_ugc_form = ?, dofollow = ?,
       score = ?,
       adapter = ?, adopted_site_id = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    String(f.name ?? cur.name ?? '').trim() || null,
    String(f.engine ?? cur.engine ?? 'peiq').trim() || 'peiq',
    String(f.country ?? cur.country ?? '').trim().toLowerCase() || null,
    String(f.discovery_source ?? cur.discovery_source ?? '').trim() || null,
    String(f.url ?? cur.url ?? '').trim() || null,
    next.authority,
    next.traffic,
    next.has_register,
    next.has_ugc_form,
    next.dofollow,
    score,
    String(f.adapter ?? cur.adapter ?? '').trim() || null,
    numOrNull(f.adopted_site_id),
    id,
  );
  touch(db, id);
}

export function addNote(db, id, text, kind = 'note') {
  const t = String(text || '').trim();
  if (!t) return;
  db.prepare('INSERT INTO prospect_notes (prospect_id, kind, text) VALUES (?, ?, ?)').run(id, kind, t);
}

export function getNotes(db, id) {
  return db.prepare('SELECT * FROM prospect_notes WHERE prospect_id = ? ORDER BY id DESC').all(id);
}

export function removeProspect(db, id) {
  db.prepare('DELETE FROM site_prospects WHERE id = ?').run(id); // prospect_notes — ON DELETE CASCADE
}

// Разбор числа метрики: "55", "55.4", "1.2K", "3,4M", "12,345" → число (K/M/B-суффиксы, разделители тысяч).
export function parseMetricNum(s) {
  if (s == null) return null;
  let t = String(s).trim().toLowerCase().replace(/\s+/g, '');
  if (!t || t === '-' || t === 'n/a') return null;
  const mult = /k$/.test(t) ? 1e3 : /m$/.test(t) ? 1e6 : /b$/.test(t) ? 1e9 : 1;
  t = t.replace(/[kmb]$/, '');
  if (mult > 1) t = t.replace(/,/g, '.'); // "3,4M" → 3.4M
  else t = t.replace(/,/g, ''); // "12,345" → 12345 (разделитель тысяч)
  const n = parseFloat(t.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n * mult : null;
}

// Импорт метрик из CSV/вставки (SEMrush bulk-экспорт и т.п.). Обновляет authority/traffic существующих
// кандидатов по домену, пересчитывает score. Колонки — по заголовку (domain/authority/traffic) или по
// порядку [domain, authority, traffic]. Возвращает { updated, unmatched, errors }.
export function importMetrics(db, text, { source = 'manual' } = {}) {
  const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!rows.length) return { updated: 0, unmatched: 0, errors: [] };
  const delim = rows[0].includes('\t') ? '\t' : rows[0].includes(';') ? ';' : ',';
  const split = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));

  let idx = { domain: 0, authority: 1, traffic: 2 };
  let start = 0;
  const first = split(rows[0]).map((c) => c.toLowerCase());
  const isHeader = first.some((c) => /domain|url|сайт|authority|traffic|трафик|rank|visits|\bas\b/i.test(c)) && !/^\d/.test(first[1] || '');
  if (isHeader) {
    const find = (re, def) => {
      const i = first.findIndex((c) => re.test(c));
      return i >= 0 ? i : def;
    };
    idx = {
      domain: find(/domain|url|сайт/i, 0),
      authority: find(/authority|\bas\b|domain rank|^rank$|\bdr\b|\bda\b/i, 1),
      traffic: find(/organic|traffic|трафик|visits/i, 2),
    };
    start = 1;
  }

  let updated = 0;
  let unmatched = 0;
  const errors = [];
  for (let i = start; i < rows.length; i++) {
    const cells = split(rows[i]);
    try {
      const d = normalizeDomain(cells[idx.domain]);
      const p = getByDomain(db, d);
      if (!p) {
        unmatched += 1;
        continue;
      }
      const authority = parseMetricNum(cells[idx.authority]) ?? p.authority;
      const trafRaw = parseMetricNum(cells[idx.traffic]);
      const traffic = trafRaw == null ? p.traffic : Math.round(trafRaw);
      const score = computeScore({ authority, traffic, has_ugc_form: p.has_ugc_form, dofollow: p.dofollow });
      db.prepare(
        "UPDATE site_prospects SET authority=?, traffic=?, score=?, metrics_source=?, metrics_updated_at=datetime('now'), updated_at=datetime('now') WHERE id=?",
      ).run(authority, traffic, score, source, p.id);
      updated += 1;
    } catch (e) {
      errors.push(`${rows[i]}: ${e.message}`);
    }
  }
  return { updated, unmatched, errors };
}

// Пересчитать score у всех кандидатов (после деплоя/изменения весов). Возвращает число обновлённых.
export function recomputeScores(db) {
  const rows = db.prepare('SELECT * FROM site_prospects').all();
  const upd = db.prepare('UPDATE site_prospects SET score=? WHERE id=?');
  let n = 0;
  for (const p of rows) {
    upd.run(computeScore(p), p.id);
    n += 1;
  }
  return n;
}

// Сид найденных PEIQ-кандидатов (идемпотентно: дубли доменов пропускаются).
// meinbezirk.at — эталон (live). Остальные — на том же движке PEIQ, к проверке.
export function seedProspects(db) {
  const seed = [
    { domain: 'meinbezirk.at', name: 'MeinBezirk (Regionalmedien Austria)', country: 'at', status: 'live', discovery_source: 'manual' },
    { domain: 'myheimat.de', name: 'myHeimat', country: 'de', status: 'new', discovery_source: 'peiq-kunden' },
    { domain: 'lokalkompass.de', name: 'Lokalkompass (WVW/ORA)', country: 'de', status: 'new', discovery_source: 'peiq-kunden' },
    { domain: 'mein-suedhessen.de', name: 'Mein Südhessen (Rhein Main Verlag)', country: 'de', status: 'new', discovery_source: 'peiq-kunden' },
  ];
  let added = 0;
  for (const s of seed) {
    if (getByDomain(db, s.domain)) continue;
    addProspect(db, { engine: 'peiq', ...s });
    added += 1;
  }
  return added;
}
