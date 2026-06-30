// CLI сбора/просмотра статистики статей (Content-Cockpit «Analyse und Benchmark»).
// Сбор — реальные запросы к сайту через Dolphin (как публикация/удаление); запускает пользователь.
//
//   npm run stats -- --site 1            # собрать по всем опубликованным статьям сайта (через Dolphin)
//   npm run stats -- --article 123       # собрать по одной статье
//   npm run stats -- --site 1 --show     # показать агрегаты по ключам (без браузера, из БД)

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { collectStatsForSite, collectArticleStats, keywordStats } from '../lib/stats.js';

const { flags } = parseArgs();
const db = getDb();

if (flags.show) {
  const siteId = Number(flags.site);
  if (!siteId) {
    console.error('Для --show укажи --site N.');
    process.exit(1);
  }
  const rows = keywordStats(db, siteId);
  if (!rows.length) {
    console.log('Снимков статистики ещё нет.');
    process.exit(0);
  }
  console.log('поиск |  всего | статей | ключ');
  for (const r of rows) {
    console.log(`${String(r.seo_views || 0).padStart(5)} | ${String(r.total_views || 0).padStart(6)} | ${String(r.articles).padStart(6)} | ${r.keyword}`);
  }
  process.exit(0);
}

if (flags.article) {
  const s = await collectArticleStats(db, Number(flags.article), { reason: 'manual' });
  console.log(`OK: ${s.totalViews} просмотров (из поиска ${s.channels?.seo ?? 0}), перцентиль ${s.percentile ?? '-'}.`);
  process.exit(0);
}

if (flags.site) {
  const r = await collectStatsForSite(db, Number(flags.site), { reason: 'manual' });
  console.log(`Готово: собрано ${r.ok}, ошибок ${r.fail} из ${r.total}.`);
  process.exit(0);
}

console.log('Использование: npm run stats -- (--site N | --article N | --site N --show)');
