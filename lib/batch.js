// Оркестрация генерации ПАЧКОЙ (Batches API, −50%). Транспорт — lib/claude.js,
// сборка/запись статьи — общие prepareGeneration/persistArticle из lib/generateArticle.js.
// Батч асинхронный (обычно <1ч): submit создаёт батч и пишет строку в `batches`;
// collect забирает результаты тем же ключом и кладёт статьи в БД.

import { buildArticleParams, parseArticleMessage, createArticleBatch, retrieveBatch, iterateBatchResults } from './claude.js';
import { prepareGeneration, persistArticle } from './generateArticle.js';
import { markKeyUsed } from './keys.js';

// Человекочитаемая причина неуспешного результата батча (errored/canceled/expired).
export function batchResultReason(result) {
  if (!result) return 'нет результата';
  if (result.type === 'succeeded') return 'ok';
  const err = result.error;
  const msg = err?.error?.message || err?.message || (typeof err === 'string' ? err : null);
  const type = err?.error?.type || err?.type || result.type;
  return msg ? `${type}: ${msg}` : String(type || result.type);
}

// Отправить пачку из `count` статей по промту. Возвращает { rowId, batchId, count }.
export async function submitArticleBatch(db, { siteId, promptId, count, maxTokens = 16000 }) {
  const n = Math.max(1, Number(count) || 1);
  const ctx = prepareGeneration(db, { siteId, promptId, extra: n });

  const requests = [];
  for (let i = 0; i < n; i++) {
    requests.push({ custom_id: `art-${i}`, params: buildArticleParams({ prompt: ctx.finalPrompt, maxTokens }) });
  }

  const batch = await createArticleBatch({ apiKey: ctx.key.api_key, requests });
  markKeyUsed(ctx.key.id);

  const info = db
    .prepare("INSERT INTO batches (site_id, prompt_id, count, batch_id, key_id, max_tokens, status) VALUES (?, ?, ?, ?, ?, ?, 'submitted')")
    .run(ctx.site.id, ctx.prompt.id, n, batch.id, ctx.key.id, maxTokens);

  return { rowId: info.lastInsertRowid, batchId: batch.id, count: n };
}

// Забрать результаты батча и записать статьи. Возвращает { persisted, errored, total, ids }
// или { pending: true, status } если батч ещё обрабатывается.
export async function collectArticleBatch(db, rowId) {
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(rowId);
  if (!row) throw new Error(`Батч #${rowId} не найден.`);
  if (row.status === 'collected') return { alreadyCollected: true, ...(JSON.parse(row.summary || '{}')) };

  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(row.site_id);
  const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(row.prompt_id);
  const key = db.prepare('SELECT * FROM claude_keys WHERE id = ?').get(row.key_id);
  if (!site || !prompt || !key) throw new Error('Нет сайта/промта/ключа для сбора батча.');

  const tags = String(prompt.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const linkBlock = prompt.link_block || '';

  const maxTokens = row.max_tokens || 16000; // с чем отправляли (для корректного разбора обрезки)
  const seenItem = db.prepare('SELECT article_id FROM batch_items WHERE batch_id = ? AND custom_id = ?');
  const markItem = db.prepare('INSERT OR IGNORE INTO batch_items (batch_id, custom_id, article_id) VALUES (?, ?, ?)');

  const batch = await retrieveBatch({ apiKey: key.api_key, batchId: row.batch_id });
  if (batch.processing_status !== 'ended') return { pending: true, status: batch.processing_status };

  let persisted = 0;
  let errored = 0;
  let total = 0;
  const ids = [];
  const items = []; // подробный лог: { custom_id, ok, article_id?, title?, reason? }
  for await (const { custom_id, result } of iterateBatchResults({ apiKey: key.api_key, batchId: row.batch_id })) {
    total++;
    if (result.type === 'succeeded') {
      // Идемпотентность: если этот элемент уже сохранён ранее (повторный сбор) — не дублируем статью.
      const prev = seenItem.get(row.batch_id, custom_id);
      if (prev) {
        ids.push(prev.article_id);
        persisted++;
        items.push({ custom_id, ok: true, article_id: prev.article_id, dedup: true });
        continue;
      }
      try {
        const article = parseArticleMessage(result.message, { maxTokens });
        const { id } = persistArticle(db, { site, prompt, keyId: key.id, tags, linkBlock, article });
        markItem.run(row.batch_id, custom_id, id); // пометить как обработанный (повторный сбор пропустит)
        ids.push(id);
        persisted++;
        items.push({ custom_id, ok: true, article_id: id, title: article.title });
      } catch (e) {
        errored++;
        items.push({ custom_id, ok: false, reason: 'запись/парсинг: ' + e.message });
      }
    } else {
      errored++;
      items.push({ custom_id, ok: false, reason: batchResultReason(result) });
    }
  }

  const summary = { persisted, errored, total, ids, items };
  db.prepare("UPDATE batches SET status='collected', summary=?, collected_at=datetime('now') WHERE id=?").run(JSON.stringify(summary), rowId);
  return summary;
}
