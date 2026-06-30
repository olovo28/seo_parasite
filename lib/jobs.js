// Фоновые задачи для асинхронного UI (генерация/публикация не висят в HTTP-запросе).

import { getDb } from '../db/db.js';

export function createJob(type, { siteId = null } = {}) {
  return getDb().prepare("INSERT INTO jobs (type, status, site_id) VALUES (?, 'running', ?)").run(type, siteId).lastInsertRowid;
}

export function finishJob(id, { ok, articleId = null, message = '' } = {}) {
  getDb()
    .prepare("UPDATE jobs SET status = ?, article_id = ?, message = ?, updated_at = datetime('now') WHERE id = ?")
    .run(ok ? 'done' : 'failed', articleId, message, id);
  logJob(id, `${ok ? 'Готово' : 'Ошибка'}: ${message || (ok ? 'готово' : 'ошибка')}`);
}

export function getJob(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

// Пошаговый журнал задачи — в БД (переживает рестарт, виден из любого процесса). Каждый шаг также двигает
// jobs.updated_at (heartbeat) → reaper по updated_at не убьёт живую задачу. Prepared-statements кэшируем.
let _insLog;
let _hbJob;
let _selLog;
function logStmts() {
  const db = getDb();
  _insLog ||= db.prepare('INSERT INTO job_logs (job_id, ts, msg) VALUES (?, ?, ?)');
  _hbJob ||= db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?");
  _selLog ||= db.prepare('SELECT ts, msg FROM job_logs WHERE job_id = ? ORDER BY id');
  return { _insLog, _hbJob, _selLog };
}
export function logJob(id, msg) {
  if (id == null) return;
  const key = Number(id);
  const { _insLog: ins, _hbJob: hb } = logStmts();
  ins.run(key, Date.now(), String(msg).slice(0, 400));
  hb.run(key); // heartbeat: задача жива (для reapStuckJobs)
}
export function getJobLog(id) {
  return logStmts()._selLog.all(Number(id));
}

// Пометить «зависшие» running-задачи (от прошлого процесса) как failed — вызывать при старте веба.
export function reapRunningJobs() {
  return getDb()
    .prepare("UPDATE jobs SET status = 'failed', message = 'прервано перезапуском', updated_at = datetime('now') WHERE status = 'running'")
    .run().changes;
}

// Периодический reaper: задача в 'running' без активности (updated_at) дольше staleMinutes → 'failed'.
// Безопасно благодаря heartbeat в logJob: живая задача обновляет updated_at на каждом шаге.
export function reapStuckJobs(staleMinutes = 20) {
  return getDb()
    .prepare("UPDATE jobs SET status = 'failed', message = 'зависла (нет активности) — снято reaper-ом', updated_at = datetime('now') WHERE status = 'running' AND updated_at < datetime('now', ?)")
    .run(`-${staleMinutes} minutes`).changes;
}

// Чистка журналов завершённых задач старше N дней (чтобы таблица не росла бесконечно).
export function cleanupOldJobLogs(days = 7) {
  return getDb()
    .prepare("DELETE FROM job_logs WHERE job_id IN (SELECT id FROM jobs WHERE status != 'running' AND updated_at < datetime('now', ?))")
    .run(`-${days} days`).changes;
}

// Гонка промиса с таймаутом. На таймаут — reject (фоновая работа может ещё доживать,
// но job/тик планировщика не зависнут навсегда).
export function withTimeout(promise, ms, label = 'операция') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label}: таймаут ${Math.round(ms / 1000)}с`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
