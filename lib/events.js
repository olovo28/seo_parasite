// Персистентный журнал событий статьи (таблица article_events) — история на /articles/:id.
// Высокоуровневые вехи (generated/scheduled/published/site_deleted/…); детальные шаги задачи — в lib/jobs.js.

import { utcStamp } from './time.js';

// Записать событие. Не бросает — журнал не должен ломать основной поток.
export function logArticleEvent(db, articleId, kind, message = '') {
  if (!articleId) return;
  try {
    db.prepare('INSERT INTO article_events (article_id, ts, kind, message) VALUES (?, ?, ?, ?)').run(
      articleId,
      utcStamp(),
      kind,
      String(message).slice(0, 500),
    );
  } catch {
    // таблица могла ещё не примениться/гонка — игнорируем
  }
}

// События статьи по порядку. { ts (UTC), kind, message }.
export function getArticleEvents(db, articleId) {
  try {
    return db.prepare('SELECT ts, kind, message FROM article_events WHERE article_id = ? ORDER BY id').all(articleId);
  } catch {
    return [];
  }
}
