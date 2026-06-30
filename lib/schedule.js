// Раскладка черновиков сайта на день: draft → scheduled по окну/интервалу.
// Сбрасывает не-опубликованные в draft и раскладывает заново. Общая для CLI и веба.
// Окно сайта (window_start/end) трактуется в ЧАСОВОМ ПОЯСЕ САЙТА (не машины) → результат одинаков
// в docker (UTC) и на хосте (Екб). Слоты считаются тем же механизмом, что ручная раскладка (distribute.js).

import { utcStamp, zonedToEpoch, epochToZoned } from './time.js';
import { computeSlotEpochs } from './distribute.js';

export function scheduleDay(db, siteId, date, { dry = false } = {}) {
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error(`Сайт ${siteId} не найден.`);
  const tz = site.timezone || 'Europe/Vienna';
  date = date || epochToZoned(Date.now(), tz).date; // «сегодня» — в зоне сайта, не машины

  // Окно [window_start, window_end] этой даты в зоне сайта → epoch; nowEpoch не даёт раскладывать «в прошлое»
  // (просроченные слоты иначе опубликовались бы залпом).
  const startEpoch = zonedToEpoch(date, site.window_start, tz);
  let endEpoch = zonedToEpoch(date, site.window_end, tz);
  if (endEpoch <= startEpoch) {
    // Окно через полночь (напр. 21:00–08:50): конец — на следующий день (как ручная раскладка в UI).
    const nextDate = epochToZoned(startEpoch + 86400000, tz).date;
    endEpoch = zonedToEpoch(nextDate, site.window_end, tz);
  }
  const slots = computeSlotEpochs({
    startEpoch,
    endEpoch,
    mode: 'interval',
    intervalMin: site.publish_interval_minutes,
    nowEpoch: Date.now(),
  }).map((ep) => utcStamp(new Date(ep))); // храним в UTC

  if (dry) {
    const totalDrafts = db.prepare("SELECT COUNT(*) c FROM articles WHERE site_id = ? AND status IN ('draft','scheduled')").get(siteId).c;
    return { date, tz, window: `${site.window_start}-${site.window_end}`, slots: slots.length, assigned: [], totalDrafts };
  }

  const result = db.transaction(() => {
    db.prepare("UPDATE articles SET status = 'draft', scheduled_at = NULL WHERE site_id = ? AND status IN ('draft','scheduled')").run(siteId);
    const drafts = db.prepare("SELECT id, title FROM articles WHERE site_id = ? AND status = 'draft' ORDER BY id").all(siteId);
    const n = Math.min(drafts.length, slots.length);
    const upd = db.prepare("UPDATE articles SET status = 'scheduled', scheduled_at = ? WHERE id = ?");
    const assigned = [];
    for (let i = 0; i < n; i++) {
      upd.run(slots[i], drafts[i].id);
      assigned.push({ when: slots[i], id: drafts[i].id, title: drafts[i].title });
    }
    return { assigned, totalDrafts: drafts.length };
  })();

  return { date, tz, window: `${site.window_start}-${site.window_end}`, slots: slots.length, ...result };
}
