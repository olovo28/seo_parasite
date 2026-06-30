// Списки ключей: рабочие наборы для постепенной отработки (генерация статей под ключи + статусы).

export const ITEM_STATUSES = ['new', 'testing', 'winner', 'loser', 'skip'];

export function createList(db, name, notes) {
  const n = String(name || '').trim() || 'Список';
  return db.prepare('INSERT INTO kw_lists (name, notes) VALUES (?, ?)').run(n, String(notes || '').trim() || null).lastInsertRowid;
}

export function removeList(db, id) {
  db.prepare('DELETE FROM kw_lists WHERE id = ?').run(id);
}

export function getList(db, id) {
  return db.prepare('SELECT * FROM kw_lists WHERE id = ?').get(id);
}

// Списки с разбивкой по статусам (для обзора).
export function listLists(db) {
  return db
    .prepare(
      `SELECT l.*,
        (SELECT COUNT(*) FROM kw_list_items i WHERE i.list_id = l.id) items,
        (SELECT COUNT(*) FROM kw_list_items i WHERE i.list_id = l.id AND i.status='new') c_new,
        (SELECT COUNT(*) FROM kw_list_items i WHERE i.list_id = l.id AND i.status='testing') c_testing,
        (SELECT COUNT(*) FROM kw_list_items i WHERE i.list_id = l.id AND i.status='winner') c_winner,
        (SELECT COUNT(*) FROM kw_list_items i WHERE i.list_id = l.id AND i.status='loser') c_loser
       FROM kw_lists l ORDER BY l.id DESC`,
    )
    .all();
}

export function listItems(db, listId, status) {
  if (status && ITEM_STATUSES.includes(status)) {
    return db.prepare('SELECT * FROM kw_list_items WHERE list_id = ? AND status = ? ORDER BY score DESC').all(listId, status);
  }
  return db.prepare('SELECT * FROM kw_list_items WHERE list_id = ? ORDER BY score DESC').all(listId);
}

export function getItem(db, id) {
  return db.prepare('SELECT * FROM kw_list_items WHERE id = ?').get(id);
}

// Элементы списка с метриками + последним снимком трафика и позициями (AT/DE/CH) — для таблицы выбора в генерации.
// Трафик/позиции есть у ключей, по которым УЖЕ есть статья (article_id) — ориентир «пора ли перегенерить и снова лезть в топ».
export function listItemsWithStats(db, listId, { limit = 2000 } = {}) {
  return db
    .prepare(
      `WITH ls AS (
         SELECT s.article_id, s.seo_views, s.total_views, s.percentile
         FROM article_stats s
         JOIN (SELECT article_id, MAX(id) mid FROM article_stats GROUP BY article_id) m ON m.mid = s.id
       )
       SELECT i.id, i.phrase, i.database, i.volume, i.kd, i.cpc, i.intent, i.score, i.status, i.article_id,
              ls.seo_views, ls.total_views, ls.percentile,
              (SELECT position FROM article_ranks r WHERE r.article_id = i.article_id AND r.country='at' ORDER BY r.id DESC LIMIT 1) AS rank_at,
              (SELECT position FROM article_ranks r WHERE r.article_id = i.article_id AND r.country='de' ORDER BY r.id DESC LIMIT 1) AS rank_de,
              (SELECT position FROM article_ranks r WHERE r.article_id = i.article_id AND r.country='ch' ORDER BY r.id DESC LIMIT 1) AS rank_ch
       FROM kw_list_items i
       LEFT JOIN ls ON ls.article_id = i.article_id
       WHERE i.list_id = ?
       ORDER BY i.score DESC, i.id
       LIMIT ?`,
    )
    .all(listId, limit);
}

// Добавить ключи (по id из kw_keywords) в список. Дедуп по UNIQUE(list_id, phrase, database). Возвращает число добавленных.
export function addKeywordsToList(db, listId, kwIds) {
  const ins = db.prepare('INSERT OR IGNORE INTO kw_list_items (list_id, phrase, database, volume, kd, intent, cpc, score) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const get = db.prepare('SELECT phrase, database, volume, kd, intent, cpc, score FROM kw_keywords WHERE id = ?');
  let n = 0;
  const tx = db.transaction((ids) => {
    for (const id of ids) {
      const r = get.get(id);
      if (!r) continue;
      n += ins.run(listId, r.phrase, r.database, r.volume, r.kd, r.intent, r.cpc, r.score).changes;
    }
  });
  tx(kwIds.map(Number).filter(Boolean));
  return n;
}

// Добавить ключи вручную: текст, где 1 строка = 1 ключ. Дедуп по UNIQUE(list_id, phrase, database).
// У ручных ключей нет базы/метрик → database='' (пустая строка, НЕ NULL: в SQLite NULL≠NULL, и UNIQUE бы не сработал).
// Возвращает { added, total } — добавлено новых / сколько непустых уникальных строк распознано.
export function addManualKeywordsToList(db, listId, text) {
  const seen = new Set();
  const phrases = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue; // дедуп в пределах вставки (без учёта регистра)
    seen.add(key);
    phrases.push(p);
  }
  const ins = db.prepare("INSERT OR IGNORE INTO kw_list_items (list_id, phrase, database) VALUES (?, ?, '')");
  let added = 0;
  const tx = db.transaction((arr) => {
    for (const p of arr) added += ins.run(listId, p).changes;
  });
  tx(phrases);
  return { added, total: phrases.length };
}

export function setItemStatus(db, itemId, status) {
  if (!ITEM_STATUSES.includes(status)) return;
  db.prepare('UPDATE kw_list_items SET status = ? WHERE id = ?').run(status, itemId);
}

export function linkItemArticle(db, itemId, articleId) {
  db.prepare("UPDATE kw_list_items SET article_id = ?, status = 'testing' WHERE id = ?").run(articleId, itemId);
}

export function removeItem(db, id) {
  db.prepare('DELETE FROM kw_list_items WHERE id = ?').run(id);
}
