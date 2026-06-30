// Сохранить статью на сайте как черновик (ручной прогон одной статьи).
//
//   npm run publish -- --article 2
//
// Требует: открытое приложение Dolphin{anty}; профиль сайта; при необходимости —
// креды в .env (MEINBEZIRK_USER / MEINBEZIRK_PASS), если профиль не залогинен.

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { publishArticleById } from '../lib/publishArticle.js';

const { flags } = parseArgs();
const db = getDb();

const articleId = Number(flags.article);
if (!articleId) {
  console.error('Использование: publish --article <id>');
  process.exit(1);
}

const article = db.prepare('SELECT site_id FROM articles WHERE id = ?').get(articleId);
if (!article) {
  console.error(`Статья ${articleId} не найдена.`);
  process.exit(1);
}

console.log(`Сохраняю в черновик: статья id=${articleId}...`);

try {
  const res = await publishArticleById(db, articleId);
  if (res.ok) {
    console.log(`OK: ${res.message}`);
  } else {
    console.error(`Не сохранилось: ${res.message}${res.screenshot ? ` (скриншот: screenshots/${res.screenshot})` : ''}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`Ошибка: ${e.message}${e.screenshot ? ` (скриншот: screenshots/${e.screenshot})` : ''}`);
  process.exit(1);
}
