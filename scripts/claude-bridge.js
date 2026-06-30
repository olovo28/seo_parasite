// Хостовый мост к подписочному Claude CLI: HTTP-обёртка над `claude -p`.
// Нужен, чтобы Dockerized веб/генератор могли генерировать «в рамках тарифа» — контейнер не видит
// хостовый `claude`, поэтому ходит сюда по host.docker.internal, а мост уже спавнит CLI на хосте.
//
// Запуск на ХОСТЕ (где `claude` залогинен в подписку):
//   node scripts/claude-bridge.js            (порт 3737, слушает 0.0.0.0 — доступен контейнеру)
// В .env веба/генератора:  CLAUDE_CLI_URL=http://host.docker.internal:3737
// Опц. защита: CLAUDE_BRIDGE_TOKEN=<секрет> (тогда контейнер шлёт заголовок x-bridge-token).

import http from 'node:http';
import { generateArticleCli } from '../lib/claudeCli.js';

const PORT = Number(process.env.CLAUDE_BRIDGE_PORT || 3737);
const TOKEN = process.env.CLAUDE_BRIDGE_TOKEN || '';
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`[${ts()}] ${m}`);

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });

  if (req.method === 'POST' && req.url === '/generate') {
    if (TOKEN && req.headers['x-bridge-token'] !== TOKEN) return send(res, 401, { error: 'bad token' });
    let raw = '';
    req.on('data', (d) => {
      raw += d;
      if (raw.length > 2_000_000) req.destroy(); // защита от мусора
    });
    req.on('end', async () => {
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return send(res, 400, { error: 'invalid json' });
      }
      if (!body.prompt) return send(res, 400, { error: 'no prompt' });
      const model = body.model || 'claude-opus-4-8';
      const t0 = Date.now();
      log(`generate: модель ${model}, промт ${String(body.prompt).length} символов…`);
      try {
        // На хосте CLAUDE_CLI_URL не задан → generateArticleCli спавнит claude локально.
        const out = await generateArticleCli({ prompt: body.prompt, model });
        log(`готово за ${((Date.now() - t0) / 1000).toFixed(1)}с: «${(out.title || '').slice(0, 60)}».`);
        send(res, 200, out);
      } catch (e) {
        log(`ошибка: ${e.message}`);
        send(res, 500, { error: e.message });
      }
    });
    return;
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`Claude bridge слушает 0.0.0.0:${PORT}${TOKEN ? ' (с токеном)' : ''}. Для контейнера: CLAUDE_CLI_URL=http://host.docker.internal:${PORT}`);
});
