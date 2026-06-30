// Раскладка черновиков сайта на день: draft → scheduled по окну/интервалу (через lib/schedule.js).
//
//   npm run schedule -- --site 1 [--date 2026-06-19] [--dry]

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { scheduleDay } from '../lib/schedule.js';
import { fmtInTz } from '../lib/time.js';

const { flags } = parseArgs();
const db = getDb();

const siteId = Number(flags.site);
if (!siteId) {
  console.error('Использование: schedule --site <id> [--date YYYY-MM-DD] [--dry]');
  process.exit(1);
}

try {
  if (flags.dry) {
    const r = scheduleDay(db, siteId, flags.date, { dry: true });
    console.log(`[dry] дата ${r.date} (зона ${r.tz}), окно ${r.window} → слотов ${r.slots}, доступно ${r.totalDrafts}.`);
    process.exit(0);
  }
  const r = scheduleDay(db, siteId, flags.date);
  console.log(`Запланировано ${r.assigned.length} на ${r.date} (зона ${r.tz}, слотов ${r.slots}, доступно черновиков ${r.totalDrafts}).`);
  for (const a of r.assigned) console.log(`  ${fmtInTz(a.when, r.tz)} (время сайта) -> id=${a.id} "${(a.title || '').slice(0, 50)}"`);
  if (r.totalDrafts > r.slots) console.warn(`Внимание: ${r.totalDrafts - r.slots} черновиков не влезли в окно — перенеси на другой день или уменьши интервал.`);
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
