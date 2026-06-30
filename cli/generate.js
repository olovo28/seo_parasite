// Генерация одной статьи: активный промт сайта → Claude → запись в articles (draft).
// При --category встраивается блок ссылок из пула (по метке {{LINKS}}) и подбираются теги.
//
//   npm run generate -- --site 1 [--prompt <id>] [--max-tokens 16000] [--backend api|cli]
//   --backend cli — генерация через подписочный Claude CLI (в рамках тарифа, без API-ключа).
//                   Запускать на ХОСТЕ, где `claude` залогинен в подписку.

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { generateArticleForSite } from '../lib/generateArticle.js';
import { withTimeout } from '../lib/jobs.js';

const { flags } = parseArgs();
const db = getDb();

const siteId = Number(flags.site);
if (!siteId) {
  console.error('Использование: generate --site <id> [--prompt <promptId>] [--max-tokens N] [--backend api|cli]');
  process.exit(1);
}

const backend = flags.backend === 'cli' ? 'cli' : 'api';

console.log(
  `Генерирую статью для сайта ${siteId}${flags.prompt ? ` (промт ${flags.prompt})` : ' (активный промт)'} ` +
    `(модель ${process.env.CLAUDE_MODEL || 'claude-opus-4-8'}, ${backend === 'cli' ? 'подписка/CLI' : 'API'})...`,
);

try {
  const r = await withTimeout(
    generateArticleForSite(db, {
      siteId,
      promptId: flags.prompt ? Number(flags.prompt) : undefined,
      maxTokens: Number(flags['max-tokens'] ?? 16000),
      backend,
    }),
    Number(process.env.GENERATE_JOB_TIMEOUT_MS || 360000),
    'генерация',
  );
  for (const w of r.warnings) console.warn('Внимание: ' + w);
  const u = r.usage ?? {};
  console.log(`Статья создана: id=${r.id}, "${r.title}". Ссылок: ${r.linkCount}. Теги: ${r.tags.join(', ') || '-'}.`);
  console.log(`Токены: in=${u.input_tokens ?? '?'}, out=${u.output_tokens ?? '?'}. Посмотреть: npm run articles -- show ${r.id}`);
} catch (e) {
  console.error(`Ошибка: ${e.message}`);
  process.exit(1);
}
