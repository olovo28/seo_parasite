// Пул прокси по СТРАНАМ (таблица proxies). Резидентные ротационные: одну прокси можно переиспользовать
// после простоя (~12ч), поэтому выдаём по принципу least-recently-used (давно не выданная — первой).
// Импорт целых списков с указанием страны; при загрузке почт прокси берётся из пула нужной страны.

import { parseProxy } from './accounts.js';

// Импорт строк прокси (по одной в строке) в пул заданной страны. INSERT OR IGNORE (дубли по url пропускаем).
export function importProxies(db, text, { country = 'at' } = {}) {
  const c = String(country || 'at').trim().toLowerCase();
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0;
  let skipped = 0;
  const errors = [];
  const ins = db.prepare('INSERT OR IGNORE INTO proxies (url, country) VALUES (?, ?)');
  const upd = db.prepare('UPDATE proxies SET country = ? WHERE url = ?'); // если уже есть — обновим страну
  for (const line of lines) {
    try {
      parseProxy(line);
      const r = ins.run(line, c);
      if (r.changes) added += 1;
      else {
        upd.run(c, line);
        skipped += 1;
      }
    } catch (e) {
      errors.push(`${line.slice(0, 40)}: ${e.message}`);
    }
  }
  return { added, skipped, errors, country: c };
}

// Выдать прокси из пула страны: least-recently-used (никогда-не-выданные первыми, затем самые старые).
// Помечает выдачу (last_assigned_at = now). Возвращает url или null, если пул страны пуст.
export function assignProxy(db, { country = 'at' } = {}) {
  const c = String(country || 'at').trim().toLowerCase();
  const row = db
    .prepare('SELECT id, url FROM proxies WHERE country = ? ORDER BY (last_assigned_at IS NOT NULL), last_assigned_at ASC, RANDOM() LIMIT 1')
    .get(c);
  if (!row) return null;
  db.prepare("UPDATE proxies SET last_assigned_at = datetime('now') WHERE id = ?").run(row.id);
  return row.url;
}

// Выдать прокси, которую СЕЙЧАС не использует никто (не закреплена ни за одной почтой email_accounts.proxy).
// Нужна для замены протухшей прокси (напр. IMAP CONNECT 503) на гарантированно чужую. LRU + помечает выдачу.
// Возвращает url или null, если свободных прокси страны нет.
export function assignUnusedProxy(db, { country = 'at' } = {}) {
  const c = String(country || 'at').trim().toLowerCase();
  const row = db
    .prepare(
      `SELECT id, url FROM proxies
       WHERE country = ?
         AND url NOT IN (SELECT proxy FROM email_accounts WHERE proxy IS NOT NULL)
       ORDER BY (last_assigned_at IS NOT NULL), last_assigned_at ASC, RANDOM() LIMIT 1`,
    )
    .get(c);
  if (!row) return null;
  db.prepare("UPDATE proxies SET last_assigned_at = datetime('now') WHERE id = ?").run(row.id);
  return row.url;
}

// Статистика пула по странам: [{ country, total, used_recently }]. used_recently — выдано за последние 12ч.
export function proxyPoolStats(db) {
  return db
    .prepare(
      `SELECT country,
              COUNT(*) total,
              SUM(CASE WHEN last_assigned_at IS NOT NULL AND last_assigned_at > datetime('now','-12 hours') THEN 1 ELSE 0 END) used_recently
       FROM proxies GROUP BY country ORDER BY country`,
    )
    .all();
}

// Список стран, для которых есть прокси (для выпадающих списков).
export function proxyCountries(db) {
  return db.prepare('SELECT DISTINCT country FROM proxies ORDER BY country').all().map((r) => r.country);
}

export function listProxies(db, { limit = 50 } = {}) {
  return db.prepare('SELECT * FROM proxies ORDER BY id LIMIT ?').all(limit);
}
