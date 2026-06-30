// Забрать результаты ранее отправленного батча и записать статьи в БД.
//
//   npm run batch-collect -- --id <rowId>

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { collectArticleBatch } from '../lib/batch.js';

const { flags } = parseArgs();
const db = getDb();

const rowId = Number(flags.id);
if (!rowId) {
  console.error('Использование: batch-collect --id <rowId>');
  process.exit(1);
}

try {
  const res = await collectArticleBatch(db, rowId);
  if (res.pending) {
    console.log(`Ещё обрабатывается (${res.status}). Попробуй позже.`);
  } else if (res.alreadyCollected) {
    console.log(`Уже собран ранее: записано ${res.persisted}, ошибок ${res.errored}.`);
  } else {
    console.log(`Готово: записано ${res.persisted}, ошибок ${res.errored}, всего ${res.total}. id: ${res.ids?.join(', ') || '-'}`);
  }
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
