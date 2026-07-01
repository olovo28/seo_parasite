// Персистентный журнал событий регистрации/прогрева (таблица registration_events) — история на /registrations/:id
// и «недавняя активность регистраций» на /scheduler. Аналог lib/events.js для статей.

import { utcStamp } from './time.js';

// Записать событие. Не бросает — журнал не должен ломать основной поток.
export function logRegEvent(db, registrationId, kind, message = '') {
  if (!registrationId) return;
  try {
    db.prepare('INSERT INTO registration_events (registration_id, ts, kind, message) VALUES (?, ?, ?, ?)').run(
      registrationId,
      utcStamp(),
      kind,
      String(message).slice(0, 500),
    );
  } catch {
    // таблица могла ещё не примениться/гонка — игнорируем
  }
}

// События одной регистрации по порядку. { ts (UTC), kind, message }.
export function getRegEvents(db, registrationId) {
  try {
    return db.prepare('SELECT ts, kind, message FROM registration_events WHERE registration_id = ? ORDER BY id').all(registrationId);
  } catch {
    return [];
  }
}

// Недавние события по всем регистрациям (для дашборда). { ts, kind, message, registration_id, email, site_name }.
export function recentRegEvents(db, limit = 30) {
  try {
    return db
      .prepare(
        `SELECT ev.ts, ev.kind, ev.message, ev.registration_id, e.email, s.name AS site_name
         FROM registration_events ev
         JOIN site_registrations r ON r.id = ev.registration_id
         JOIN email_accounts e ON e.id = r.email_account_id
         JOIN sites s ON s.id = r.site_id
         ORDER BY ev.id DESC LIMIT ?`,
      )
      .all(limit);
  } catch {
    return [];
  }
}
