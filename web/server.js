// Веб-админка (Fastify, серверный рендер + htmx). Переиспользует db/ и lib/ напрямую.
// Этап 8: пока каркас — авторизация по паролю + дашборд. CRUD-страницы добавляются далее.
//
//   локально:  npm run web
//   в docker:  сервис web (см. docker-compose.yml)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { getDb } from '../db/db.js';
import { loginPage, dashboardPage } from './views.js';
import { registerRoutes } from './routes.js';
import { reapRunningJobs, reapStuckJobs, cleanupOldJobLogs } from '../lib/jobs.js';
import { sweepOrphanProfiles } from '../lib/browser.js';

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please-set-a-long-random-secret';

const app = Fastify({ logger: true });

// Локальный инструмент: НЕ роняем процесс из-за необработанной ошибки фоновой задачи (балк-операции) или
// внешнего сбоя — логируем и продолжаем. Без этого один reject (напр. SQLITE_BUSY) валит всю админку.
process.on('unhandledRejection', (e) => app.log.error({ err: e }, 'unhandledRejection'));
process.on('uncaughtException', (e) => app.log.error({ err: e }, 'uncaughtException'));
await app.register(cookie, { secret: SESSION_SECRET });
await app.register(formbody);

// Статика темы Tabler — отдаём прямо из node_modules (vendoring, без CDN/рантайм-зависимости).
const here = path.dirname(fileURLToPath(import.meta.url));
const nm = path.join(here, '..', 'node_modules', '@tabler');
await app.register(fastifyStatic, { root: path.join(nm, 'core', 'dist'), prefix: '/static/tabler/' });
await app.register(fastifyStatic, { root: path.join(nm, 'icons-webfont', 'dist'), prefix: '/static/icons/', decorateReply: false });

function isAuthed(req) {
  const raw = req.cookies?.auth;
  if (!raw) return false;
  const r = req.unsignCookie(raw);
  return r.valid && r.value === 'ok';
}

// Гард авторизации (кроме /login, /health).
app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/health' || req.url.startsWith('/login') || req.url.startsWith('/static')) return;
  if (!isAuthed(req)) return reply.redirect('/login');
});

app.get('/health', async () => ({ ok: true }));

app.get('/login', async (req, reply) => reply.type('text/html').send(loginPage()));

app.post('/login', async (req, reply) => {
  if ((req.body?.password || '') === ADMIN_PASSWORD) {
    reply.setCookie('auth', 'ok', {
      signed: true,
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
    });
    return reply.redirect('/');
  }
  return reply.type('text/html').send(loginPage('Неверный пароль'));
});

app.post('/logout', async (req, reply) => {
  reply.clearCookie('auth', { path: '/' });
  return reply.redirect('/login');
});

app.get('/', async (req, reply) => {
  const db = getDb();
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM articles GROUP BY status').all();
  const sitesCount = db.prepare('SELECT COUNT(*) c FROM sites').get().c;
  const siteList = db.prepare('SELECT id, name, origin, active FROM sites ORDER BY id').all();
  const keys = db.prepare('SELECT COUNT(*) c FROM claude_keys WHERE enabled = 1').get().c;
  const prompts = db.prepare('SELECT COUNT(*) c FROM prompts').get().c;
  const log = db.prepare('SELECT * FROM publish_log ORDER BY id DESC LIMIT 10').all();
  reply.type('text/html').send(dashboardPage({ byStatus, sitesCount, keys, prompts, log, siteList }));
});

// CRUD-роуты разделов.
await registerRoutes(app);

// Помечаем задачи, зависшие в running после прошлого запуска.
const reaped = reapRunningJobs();
if (reaped) app.log.info(`Помечено прерванных задач (running→failed): ${reaped}`);
cleanupOldJobLogs(); // подчистить журналы давно завершённых задач (>7 дней)

// Периодический reaper: задача 'running' без активности (updated_at) дольше N мин → failed (зависла, но процесс жив).
const JOB_STUCK_MIN = Number(process.env.JOB_STUCK_MINUTES || 20);
setInterval(() => {
  try {
    const n = reapStuckJobs(JOB_STUCK_MIN);
    if (n) app.log.warn(`Reaper: помечено зависших задач (running→failed): ${n}`);
  } catch (e) {
    app.log.warn(`Reaper задач: ${e.message}`);
  }
}, 5 * 60000).unref();

// Подчистить осиротевшие одноразовые профили Dolphin от упавших прошлых процессов (best-effort, не блокируем старт).
sweepOrphanProfiles({ log: (m) => app.log.info(m) }).catch((e) => app.log.warn(`Sweep профилей: ${e.message}`));

app.listen({ host: '0.0.0.0', port: PORT }).then(() => {
  app.log.info(`Админка на http://localhost:${PORT}`);
});
