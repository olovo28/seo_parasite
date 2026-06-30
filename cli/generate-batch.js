// Генерация статей ПАЧКОЙ через Batches API (−50%). ПЛАТНО — только с разрешения.
//
//   npm run generate-batch -- --site 1 --count 50 [--prompt 2] [--wait] [--max-tokens 16000]
//
// Без --wait: отправляет батч и печатает rowId (собрать позже: npm run batch-collect -- --id <rowId>).
// С --wait: опрашивает и забирает результаты (батч обычно <1ч).

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { submitArticleBatch, collectArticleBatch } from '../lib/batch.js';

const { flags } = parseArgs();
const db = getDb();

const siteId = Number(flags.site);
const count = Number(flags.count);
if (!siteId || !count) {
  console.error('Использование: generate-batch --site <id> --count <N> [--prompt <id>] [--wait] [--max-tokens N]');
  process.exit(1);
}

try {
  const r = await submitArticleBatch(db, {
    siteId,
    promptId: flags.prompt ? Number(flags.prompt) : undefined,
    count,
    maxTokens: Number(flags['max-tokens'] ?? 16000),
  });
  console.log(`Батч отправлен: rowId=${r.rowId}, batchId=${r.batchId}, статей=${r.count}.`);

  if (flags.wait) {
    console.log('Жду завершения (опрос каждые 30с)...');
    for (;;) {
      const res = await collectArticleBatch(db, r.rowId);
      if (res.pending) {
        process.stdout.write(`  ещё обрабатывается (${res.status})...\n`);
        await new Promise((s) => setTimeout(s, 30000));
        continue;
      }
      console.log(`Готово: записано ${res.persisted}, ошибок ${res.errored}, всего ${res.total}. id: ${res.ids?.join(', ') || '-'}`);
      break;
    }
  } else {
    console.log(`Собрать результаты позже: npm run batch-collect -- --id ${r.rowId}`);
  }
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
