// Генерация статьи через Claude API (Anthropic SDK).
//
// Два транспорта поверх ОДНОЙ логики:
//   - реалтайм: messages.stream(...).finalMessage()  — этап 2;
//   - батч:     messages.batches.*  (−50%, пачка на день) — этап 6.
// Общее: buildArticleParams() (тело запроса) и parseArticleMessage() (разбор ответа).
// Структурированный вывод (output_config.format json_schema) — строгий JSON без парсинга «на глаз».

import Anthropic from '@anthropic-ai/sdk';
import { generateArticleCli } from './claudeCli.js';

export const DEFAULT_MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

const GEN_TIMEOUT_MS = Number(process.env.GENERATE_TIMEOUT_MS || 300000); // дедлайн на одну генерацию (по нему abort'им стрим)
const GEN_RETRIES = Number(process.env.GENERATE_RETRIES || 1); // ретраи ТОЛЬКО транзиентных сбоев (overloaded/сеть/5xx)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Транзиентная ли ошибка (стоит ретраить): 429/5xx/overloaded/обрыв сети. НЕ ретраим логические
// (refusal, обрезка по max_tokens, битый JSON) и аборт по таймауту.
function isTransientApiError(e) {
  if (!e || e.__timeout || e.name === 'AbortError') return false;
  const status = e.status ?? e.statusCode;
  if (status && (status === 429 || status >= 500)) return true;
  return /overloaded|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|terminated|network/i.test(e.message || '');
}

const ARTICLE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Заголовок статьи' },
    body_html: { type: 'string', description: 'Тело статьи в виде HTML (без обёртки <html>/<body>)' },
  },
  required: ['title', 'body_html'],
  additionalProperties: false,
};

// Тело запроса к Messages API. Одинаково для стриминга и для батча (нестриминговый объект).
export function buildArticleParams({ prompt, model = DEFAULT_MODEL, maxTokens = 16000 }) {
  return {
    model,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: ARTICLE_SCHEMA },
    },
    messages: [{ role: 'user', content: prompt }],
  };
}

// Разбор ответа модели в { title, body_html, usage, model }.
// Бросает понятную ошибку при refusal / обрезке по max_tokens / битом JSON.
export function parseArticleMessage(message, { maxTokens = 16000 } = {}) {
  if (message.stop_reason === 'refusal') {
    const cat = message.stop_details?.category ?? 'неизвестно';
    throw new Error(`Claude отклонил запрос (refusal, категория: ${cat}).`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Ответ обрезан по max_tokens (${maxTokens}) — увеличь maxTokens.`);
  }

  const textBlock = message.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('В ответе нет текстового блока с JSON.');

  let data;
  try {
    data = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error(`Не удалось распарсить JSON ответа: ${e.message}`);
  }
  if (!data.title || !data.body_html) {
    throw new Error('В ответе отсутствует title или body_html.');
  }

  return { title: data.title, body_html: data.body_html, usage: message.usage, model: message.model };
}

// Реалтайм-генерация одной статьи. Возвращает { title, body_html, usage, model }.
// backend: 'api' (Anthropic SDK, платно) | 'cli' (подписочный claude CLI, в рамках тарифа).
// Стриминг + .finalMessage() — против HTTP-таймаутов на длинных ответах.
export async function generateArticle({ apiKey, prompt, model = DEFAULT_MODEL, maxTokens = 16000, backend = 'api', timeoutMs = GEN_TIMEOUT_MS, retries = GEN_RETRIES }) {
  if (backend === 'cli') return generateArticleCli({ prompt, model });
  const client = new Anthropic({ apiKey });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs); // дедлайн → abort стрима (освобождаем HTTP-соединение)
    try {
      const stream = client.messages.stream(buildArticleParams({ prompt, model, maxTokens }), { signal: controller.signal });
      const message = await stream.finalMessage();
      return parseArticleMessage(message, { maxTokens });
    } catch (e) {
      if (controller.signal.aborted) {
        const te = new Error(`Генерация: таймаут ${Math.round(timeoutMs / 1000)}с (стрим прерван)`);
        te.__timeout = true;
        throw te; // таймаут не ретраим
      }
      lastErr = e;
      if (!isTransientApiError(e) || attempt === retries) throw e; // логическую ошибку/последнюю попытку — наружу
      await sleep(2000 * (attempt + 1)); // бэкофф перед ретраем транзиентного сбоя
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ── Транспорт батчей (Batches API) ──────────────────────────────────────────
// requests: [{ custom_id, params }], params = buildArticleParams(...). Возвращает объект батча (id, processing_status).
export async function createArticleBatch({ apiKey, requests }) {
  const client = new Anthropic({ apiKey });
  return client.messages.batches.create({ requests });
}

// Статус/метаданные батча (processing_status: 'in_progress' | 'ended' | ...).
export async function retrieveBatch({ apiKey, batchId }) {
  const client = new Anthropic({ apiKey });
  return client.messages.batches.retrieve(batchId);
}

// Async-генератор результатов батча: yield { custom_id, result }.
// result.type: 'succeeded' | 'errored' | 'canceled' | 'expired'; на succeeded — result.message.
// Результаты приходят в произвольном порядке — наверху ключуем по custom_id.
export async function* iterateBatchResults({ apiKey, batchId }) {
  const client = new Anthropic({ apiKey });
  for await (const item of await client.messages.batches.results(batchId)) {
    yield { custom_id: item.custom_id, result: item.result };
  }
}
