// Генерация статьи через локальный Claude CLI (подписка Max), а не через платный API-ключ.
// Используется, когда нужно генерировать «в рамках тарифа»: `claude -p` авторизуется
// сессией Claude Code (OAuth-подписка), вызовы Messages API при этом не оплачиваются.
//
// Запускается ТАМ, где `claude` залогинен в подписку — на ХОСТЕ (Windows). В Docker напрямую
// недоступно (контейнер не видит хостовый CLI) — для веба используется хостовый мост.
//
// Контракт ответа тот же, что у API-пути: { title, body_html } строгим JSON.

import { spawn } from 'node:child_process';
import os from 'node:os';

// На Windows реальный бинарь — claude.exe (spawn без shell ищет по PATH по точному имени).
export const CLI_BIN = process.env.CLAUDE_CLI_BIN || (process.platform === 'win32' ? 'claude.exe' : 'claude');

// Системный промт фиксирует выходной контракт (как json_schema в API-пути): только {title, body_html}.
const SYSTEM_PROMPT =
  'Du bist ein Artikel-Generator. Befolge die Anweisung des Nutzers und gib das Ergebnis ' +
  'AUSSCHLIESSLICH als ein einziges gueltiges JSON-Objekt zurueck — ohne Markdown-Codeblock, ' +
  'ohne Text davor oder danach. Schema: {"title": string (Artikelueberschrift), ' +
  '"body_html": string (Artikeltext als HTML, ohne <html>/<body>-Wrapper)}.';

// Вырезать JSON-объект из текста ответа: снять возможную обёртку ```json ... ``` или взять {...}.
function extractJsonObject(text) {
  let t = String(text || '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    // запасной вариант: первый '{' … последний '}'
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
    throw new Error('Не удалось распарсить JSON из ответа claude CLI.');
  }
}

// Запустить `claude -p` с промтом через stdin (длинный промт не влезает в argv).
// Возвращает разобранную JSON-обёртку CLI ({ result, is_error, subtype, usage, ... }).
function runClaudeCli({ prompt, model, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--system-prompt', SYSTEM_PROMPT,
      '--allowedTools', '', // чистая генерация — без инструментов
    ];
    // cwd = временная папка: чтобы CLI не подхватывал проектный CLAUDE.md/настройки как контекст.
    // Без shell: промт уходит в stdin (не в argv), инъекций нет; CLI_BIN резолвится по PATH.
    const child = spawn(CLI_BIN, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish(reject, new Error(`claude CLI не ответил за ${Math.round(timeoutMs / 1000)}с.`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) =>
      finish(reject, new Error(`Не удалось запустить claude CLI (${CLI_BIN}): ${e.message}. Установлен ли Claude Code и в PATH?`)),
    );
    child.on('close', (code) => {
      if (code !== 0) {
        return finish(reject, new Error(`claude CLI завершился с кодом ${code}: ${(stderr || stdout || '').slice(0, 300)}`));
      }
      let env;
      try {
        env = JSON.parse(stdout);
      } catch {
        return finish(reject, new Error(`claude CLI вернул не-JSON: ${stdout.slice(0, 300)}`));
      }
      finish(resolve, env);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Запрос к хостовому мосту (scripts/claude-bridge.js) — используется из Docker, где
// локального `claude` нет. CLAUDE_CLI_URL, напр. http://host.docker.internal:3737.
async function generateViaBridge(url, { prompt, model, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    const headers = { 'content-type': 'application/json' };
    if (process.env.CLAUDE_BRIDGE_TOKEN) headers['x-bridge-token'] = process.env.CLAUDE_BRIDGE_TOKEN;
    res = await fetch(url.replace(/\/$/, '') + '/generate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, model }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(
      e.name === 'AbortError'
        ? `Хостовый мост claude не ответил за ${Math.round(timeoutMs / 1000)}с (${url}).`
        : `Не достучаться до хостового моста claude (${url}): ${e.message}. Запущен ли scripts/claude-bridge.js на хосте?`,
    );
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Хостовый мост claude: ${res.status} ${data.error || ''}`.trim());
  if (!data.title || !data.body_html) throw new Error('Хостовый мост claude вернул ответ без title/body_html.');
  return { title: data.title, body_html: data.body_html, usage: data.usage || {}, model: data.model || model };
}

// Сгенерировать статью через подписочный CLI. Возвращает { title, body_html, usage, model }.
// Если задан CLAUDE_CLI_URL — идём через хостовый мост (мы внутри Docker); иначе спавним claude локально.
export async function generateArticleCli({ prompt, model = 'claude-opus-4-8', timeoutMs = 240000 } = {}) {
  const bridge = process.env.CLAUDE_CLI_URL;
  if (bridge) return generateViaBridge(bridge, { prompt, model, timeoutMs });
  const env = await runClaudeCli({ prompt, model, timeoutMs });
  if (env.is_error || env.subtype === 'error_max_turns' || env.subtype === 'error_during_execution') {
    throw new Error(`claude CLI: ошибка (${env.subtype || 'is_error'}). ${(env.result || '').slice(0, 200)}`);
  }
  const data = extractJsonObject(env.result);
  if (!data.title || !data.body_html) throw new Error('В ответе claude CLI нет title или body_html.');
  // usage из CLI-обёртки приводим к виду API (input_tokens/output_tokens).
  const u = env.usage || {};
  return {
    title: data.title,
    body_html: data.body_html,
    usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens },
    model,
  };
}
