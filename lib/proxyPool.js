// Пул прокси по СТРАНАМ (таблица proxies) + ИМЕНОВАННЫЕ ГРУППЫ (proxy_groups) с назначением по видам работы.
// Группа задаёт: purposes (publish|register|serp) + site_ids (подмножество сайтов; пусто = все). Прокси входит в группу
// (proxies.group_id). Выдача (assignProxy) фильтрует по назначению/сайту/стране, ротация — least-recently-used (реюз ~12ч).

import { parseProxy } from './accounts.js';

// Виды работы (назначение группы прокси). Ключ → подпись для UI.
export const PROXY_PURPOSES = [
  ['publish', 'Публикация'],
  ['register', 'Регистрация'],
  ['serp', 'Позиции'],
];
const VALID_PURPOSES = PROXY_PURPOSES.map(([k]) => k);

function normPurposes(p) {
  const set = new Set((Array.isArray(p) ? p : String(p || '').split(',')).map((s) => String(s).trim()).filter(Boolean));
  return VALID_PURPOSES.filter((v) => set.has(v)).join(',');
}
function normSiteIds(s) {
  return [...new Set((Array.isArray(s) ? s : String(s || '').split(',')).map((x) => Number(x)).filter(Boolean))].join(',');
}

// ── Группы ───────────────────────────────────────────────────────────────────
export function listGroups(db) {
  return db
    .prepare('SELECT g.*, (SELECT COUNT(*) FROM proxies p WHERE p.group_id = g.id) cnt FROM proxy_groups g ORDER BY g.id')
    .all();
}
export function getGroup(db, id) {
  return db.prepare('SELECT * FROM proxy_groups WHERE id = ?').get(id);
}
export function createGroup(db, { name, purposes, siteIds } = {}) {
  const nm = String(name || '').trim() || 'Группа';
  return db
    .prepare('INSERT INTO proxy_groups (name, purposes, site_ids) VALUES (?, ?, ?)')
    .run(nm, normPurposes(purposes), normSiteIds(siteIds)).lastInsertRowid;
}
export function updateGroup(db, id, { name, purposes, siteIds } = {}) {
  db.prepare('UPDATE proxy_groups SET name = ?, purposes = ?, site_ids = ? WHERE id = ?')
    .run(String(name || '').trim() || 'Группа', normPurposes(purposes), normSiteIds(siteIds), id);
}
// Удалить группу: прокси НЕ трогаем, только отвязываем (group_id = NULL).
export function deleteGroup(db, id) {
  db.prepare('UPDATE proxies SET group_id = NULL WHERE group_id = ?').run(id);
  db.prepare('DELETE FROM proxy_groups WHERE id = ?').run(id);
}

// ── Импорт / список прокси ─────────────────────────────────────────────────────
// Импорт строк прокси (по одной в строке) в пул страны, опц. сразу в группу. INSERT OR IGNORE (дубли по url).
export function importProxies(db, text, { country = 'at', groupId = null } = {}) {
  const c = String(country || 'at').trim().toLowerCase();
  const gid = groupId ? Number(groupId) : null;
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0;
  let skipped = 0;
  const errors = [];
  const ins = db.prepare('INSERT OR IGNORE INTO proxies (url, country, group_id) VALUES (?, ?, ?)');
  const upd = db.prepare('UPDATE proxies SET country = ?, group_id = COALESCE(?, group_id) WHERE url = ?');
  for (const line of lines) {
    try {
      parseProxy(line);
      const r = ins.run(line, c, gid);
      if (r.changes) added += 1;
      else {
        upd.run(c, gid, line);
        skipped += 1;
      }
    } catch (e) {
      errors.push(`${line.slice(0, 40)}: ${e.message}`);
    }
  }
  return { added, skipped, errors, country: c };
}

// Переназначить прокси (по id) в группу (или отвязать groupId=null).
export function setProxiesGroup(db, ids, groupId) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Boolean);
  if (!list.length) return 0;
  const gid = groupId ? Number(groupId) : null;
  const stmt = db.prepare('UPDATE proxies SET group_id = ? WHERE id = ?');
  let n = 0;
  const tx = db.transaction((arr) => { for (const id of arr) n += stmt.run(gid, id).changes; });
  tx(list);
  return n;
}

export function removeProxy(db, id) {
  db.prepare('DELETE FROM proxies WHERE id = ?').run(Number(id));
}

export function listProxies(db, { limit = 1000 } = {}) {
  return db
    .prepare(
      `SELECT p.*, g.name group_name, g.purposes group_purposes, g.site_ids group_site_ids
       FROM proxies p LEFT JOIN proxy_groups g ON g.id = p.group_id
       ORDER BY (p.group_id IS NULL), p.group_id, p.id LIMIT ?`,
    )
    .all(limit);
}

// ── Выдача ─────────────────────────────────────────────────────────────────────
// Подобрать одну прокси по фильтрам. purpose/siteId опциональны (null = без фильтра, обратная совместимость).
// excludeAssignedEmails — исключить прокси, уже закреплённые за почтой (для свободной замены).
function pickProxy(db, { country, purpose = null, siteId = null, excludeAssignedEmails = false } = {}) {
  const where = ['p.country = @country'];
  const params = { country };
  if (purpose) {
    where.push("(',' || COALESCE(g.purposes,'') || ',') LIKE @purpose");
    params.purpose = `%,${purpose},%`;
  }
  if (siteId != null) {
    // группа без привязки к сайтам (site_ids пусто/NULL) = все сайты; иначе siteId должен входить
    where.push("(g.site_ids IS NULL OR g.site_ids = '' OR (',' || g.site_ids || ',') LIKE @site)");
    params.site = `%,${Number(siteId)},%`;
  }
  if (excludeAssignedEmails) where.push('p.url NOT IN (SELECT proxy FROM email_accounts WHERE proxy IS NOT NULL)');
  const sql = `SELECT p.id, p.url FROM proxies p LEFT JOIN proxy_groups g ON g.id = p.group_id
    WHERE ${where.join(' AND ')}
    ORDER BY (p.last_assigned_at IS NOT NULL), p.last_assigned_at ASC, RANDOM() LIMIT 1`;
  return db.prepare(sql).get(params);
}

// Выдать прокси из пула: LRU; опц. фильтр по назначению (purpose) и сайту (siteId). Помечает выдачу. null — если нет.
export function assignProxy(db, { country = 'at', purpose = null, siteId = null } = {}) {
  const c = String(country || 'at').trim().toLowerCase();
  const row = pickProxy(db, { country: c, purpose, siteId });
  if (!row) return null;
  db.prepare("UPDATE proxies SET last_assigned_at = datetime('now') WHERE id = ?").run(row.id);
  return row.url;
}

// Выдать прокси, которую сейчас не использует никто (не закреплена за почтой) — для замены протухшей. LRU + помечает.
export function assignUnusedProxy(db, { country = 'at', purpose = null, siteId = null } = {}) {
  const c = String(country || 'at').trim().toLowerCase();
  const row = pickProxy(db, { country: c, purpose, siteId, excludeAssignedEmails: true });
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
