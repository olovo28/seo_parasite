// Долгоживущий планировщик: раз в тик публикует статьи, которым подошло время
// (status='scheduled' и scheduled_at <= сейчас), у активных сайтов. Последовательно (профиль один).
// Расписание берётся из БД — переживает перезапуск.
//
//   npm run scheduler
//   (раскладку на день делает отдельно: npm run schedule -- --site X)

import { getDb } from './db/db.js';
import { publishArticleById, deleteArticlesGrouped } from './lib/publishArticle.js';
import { withTimeout } from './lib/jobs.js';
import { utcStamp, parseStamp } from './lib/time.js';
import { setSetting, getSetting } from './lib/settings.js';
import { dueApprovalChecks, dueWarmings } from './lib/registrations.js';
import { checkApproval, registerOnSite } from './lib/registrar.js';
import { warmVisit } from './lib/warming.js';
import { collectStatsForSite } from './lib/stats.js';
import { checkRanksForSite, checkArticleRank } from './lib/serp.js';
import { sweepOrphanProfiles } from './lib/browser.js';

const PUBLISH_TIMEOUT_MS = Number(process.env.PUBLISH_TIMEOUT_MS || 240000);
const DELETE_TIMEOUT_MS = Number(process.env.DELETE_TIMEOUT_MS || 480000); // удаление теперь включает rank-проверку + сбор статистики
const STATS_TIMEOUT_MS = Number(process.env.STATS_TIMEOUT_MS || 1800000); // сбор по всему сайту может быть долгим
const RANKS_TIMEOUT_MS = Number(process.env.RANKS_TIMEOUT_MS || 5400000); // позиции: статьи × 3 страны × ретраи × пагинация — долго
const RANK_ONE_TIMEOUT_MS = Number(process.env.RANK_ONE_TIMEOUT_MS || 300000); // проверка позиции ОДНОЙ статьи (DACH)
const BULK_CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 5); // авто-удаление: профилей параллельно (пул по аккаунтам)
const BULK_DELETE_DELAY_MS = Number(process.env.BULK_DELETE_DELAY_MS || 10000); // пауза между удалениями внутри аккаунта
const WARM_TIMEOUT_MS = Number(process.env.WARM_TIMEOUT_MS || 900000); // визит прогрева (browse 5–20 стр. с паузами) — до 15 мин
const WARM_MAX_PER_TICK = Number(process.env.WARM_MAX_PER_TICK || 2); // сколько прогревов за проход (тяжёлые — Dolphin)
const WARM_TICK_MS = Number(process.env.WARM_TICK_MS || 60000); // интервал дорожки прогрева (отдельно от публикации)
// Каждая дорожка — свой независимый интервал (ничто не блокирует публикацию). Профили Dolphin ограничены семафором (6).
const PUB_TICK_MS = Number(process.env.PUB_TICK_MS || 15000); // публикация — приоритет, часто
const RANK_TICK_MS = Number(process.env.RANK_TICK_MS || 60000); // проверка позиций (тяжёлая, капчи)
const DEL_TICK_MS = Number(process.env.DEL_TICK_MS || 60000); // авто-удаление
const APPR_TICK_MS = Number(process.env.APPR_TICK_MS || 120000); // проверки одобрения (IMAP)
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000); // независимый heartbeat (истинный liveness)
const MAX_PUBLISH_ATTEMPTS = Number(process.env.MAX_PUBLISH_ATTEMPTS || 3); // авто-ретрай публикации
const PUBLISH_RETRY_BACKOFF_MIN = Number(process.env.PUBLISH_RETRY_BACKOFF_MIN || 5); // пауза перед повтором, мин

const TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 30000);
const HEAVY_TICK_MS = Number(process.env.HEAVY_TICK_MS || 300000); // как часто проверять «пора ли» суточные джобы (сами гейтятся по дате)
const HEAVY_RETRY_BACKOFF_MS = Number(process.env.HEAVY_RETRY_BACKOFF_MS || 3600000); // при сбое суточной джобы — не чаще раза в час
const db = getDb();

// Раз в UTC-сутки собираем статистику по всем активным сайтам (snapshot во времени). Гейт — settings.
// Дату «сделано» ставим ТОЛЬКО при полном успехе; при сбое ретраим, но не чаще HEAVY_RETRY_BACKOFF_MS.
async function maybeDailyStats(nowUtc) {
  const today = nowUtc.slice(0, 10); // YYYY-MM-DD (UTC)
  if (getSetting(db, 'stats_last_collect_date') === today) return;
  const lastAttempt = parseStamp(getSetting(db, 'stats_last_attempt_at'));
  if (lastAttempt != null && Date.now() - lastAttempt < HEAVY_RETRY_BACKOFF_MS) return; // недавно пробовали — ждём бэкофф
  setSetting(db, 'stats_last_attempt_at', nowUtc);
  const sites = db.prepare('SELECT id, name FROM sites WHERE active = 1').all();
  if (!sites.length) return;
  console.log(`[${nowUtc}] ежедневный сбор статистики по ${sites.length} сайтам…`);
  let hadError = false;
  for (const s of sites) {
    try {
      const r = await withTimeout(collectStatsForSite(db, s.id, { reason: 'daily' }), STATS_TIMEOUT_MS, 'сбор статистики');
      if (r.skipped) console.log(`  · stats site=${s.id}: адаптер без статистики — пропуск`);
      else console.log(`  ✓ stats site=${s.id}: собрано ${r.ok}, ошибок ${r.fail} из ${r.total}`);
    } catch (e) {
      hadError = true;
      console.error(`  ✗ stats site=${s.id}: ${e.message}`);
    }
  }
  if (!hadError) setSetting(db, 'stats_last_collect_date', today); // «сделано» только при полном успехе
  setSetting(db, 'stats_last_summary', `${nowUtc}: сбор статистики ${hadError ? 'с ошибками (ретрай позже)' : 'выполнен'}`);
}

// Раз в UTC-сутки проверяем позиции статей в Google (DACH). Гейт ставим при полном успехе; при сбое — ретрай с бэкоффом.
async function maybeDailyRanks(nowUtc) {
  const today = nowUtc.slice(0, 10);
  if (getSetting(db, 'ranks_last_collect_date') === today) return;
  const lastAttempt = parseStamp(getSetting(db, 'ranks_last_attempt_at'));
  if (lastAttempt != null && Date.now() - lastAttempt < HEAVY_RETRY_BACKOFF_MS) return;
  setSetting(db, 'ranks_last_attempt_at', nowUtc);
  const sites = db.prepare('SELECT id, name FROM sites WHERE active = 1').all();
  if (!sites.length) return;
  console.log(`[${nowUtc}] ежедневная проверка позиций (DACH) по ${sites.length} сайтам…`);
  let hadError = false;
  for (const s of sites) {
    try {
      const r = await withTimeout(checkRanksForSite(db, s.id, { reason: 'daily' }), RANKS_TIMEOUT_MS, 'проверка позиций');
      console.log(`  ✓ ranks site=${s.id}: в топе ${r.found ?? r.ok}, не на 1-й стр. ${r.notFound ?? '-'}, ошибок ${r.fail}`);
    } catch (e) {
      hadError = true;
      console.error(`  ✗ ranks site=${s.id}: ${e.message}`);
    }
  }
  if (!hadError) setSetting(db, 'ranks_last_collect_date', today);
  setSetting(db, 'ranks_last_summary', `${nowUtc}: проверка позиций ${hadError ? 'с ошибками (ретрай позже)' : 'выполнена'}`);
}

const dueStmt = db.prepare(`
  SELECT a.id FROM articles a
  JOIN sites s ON s.id = a.site_id
  WHERE a.status = 'scheduled' AND a.scheduled_at IS NOT NULL AND a.scheduled_at <= ? AND s.active = 1
  ORDER BY a.scheduled_at, a.id
`);

// Статьи, которым подошло время проверки позиции в Google (через 5 мин после публикации; ещё на сайте).
const dueRankStmt = db.prepare(`
  SELECT a.id FROM articles a
  JOIN sites s ON s.id = a.site_id
  WHERE a.status = 'published' AND a.site_deleted_at IS NULL AND a.rank_check_at IS NOT NULL AND a.rank_check_at <= ? AND s.active = 1
  ORDER BY a.rank_check_at, a.id
`);
const clearRankCheck = db.prepare('UPDATE articles SET rank_check_at = NULL WHERE id = ?');

// Статьи, которым подошло время АВТО-удаления с сайта (опубликованы, ещё не сняты).
const dueDeleteStmt = db.prepare(`
  SELECT a.id FROM articles a
  JOIN sites s ON s.id = a.site_id
  WHERE a.status = 'published' AND a.site_deleted_at IS NULL AND a.delete_at IS NOT NULL AND a.delete_at <= ? AND s.active = 1
  ORDER BY a.delete_at, a.id
`);

// Авто-ретрай публикации: attempts+1; пока < MAX — оставить scheduled и отложить на backoff (dueStmt подхватит), иначе failed.
const retryPublish = db.prepare(`
  UPDATE articles SET
    publish_attempts = publish_attempts + 1,
    status       = CASE WHEN publish_attempts + 1 < @max THEN 'scheduled' ELSE 'failed' END,
    scheduled_at = CASE WHEN publish_attempts + 1 < @max THEN datetime('now', '+' || @backoff || ' minutes') ELSE scheduled_at END,
    error        = @err
  WHERE id = @id AND status = 'scheduled'
`);

// Дорожки НЕЗАВИСИМЫ: у каждой свой флаг и свой интервал. Все запуски Dolphin идут через общий семафор (лимит 6),
// поэтому параллельные дорожки не перегружают браузер, а БД (better-sqlite3) синхронна → гонок нет.
// Публикация ИЗОЛИРОВАНА и приоритетна — её больше ничто не блокирует (ни ранг-капчи, ни удаление, ни прогрев).

// --- Публикация созревших scheduled (в основном HTTP; на сбой — авто-ретрай, кроме таймаута) ---
let pubRunning = false;
async function publishTick() {
  if (pubRunning) return;
  pubRunning = true;
  try {
    const now = utcStamp();
    const due = dueStmt.all(now);
    if (!due.length) return;
    console.log(`[${now}] к публикации: ${due.length}`);
    setSetting(db, 'scheduler_last_summary', `${now}: публикую ${due.length}`);
    for (const { id } of due) {
      try {
        const res = await withTimeout(publishArticleById(db, id), PUBLISH_TIMEOUT_MS, 'публикация');
        console.log(res.ok ? `  ✓ pub id=${id}: ${res.message}` : `  ✗ pub id=${id}: ${res.message}`);
      } catch (e) {
        console.error(`  ✗ pub id=${id}: ${e.message}`);
        if (/таймаут/i.test(e.message)) {
          // Таймаут неоднозначен (могла реально опубликоваться на сайте) — НЕ ретраим, помечаем failed с пометкой.
          db.prepare("UPDATE articles SET status = 'failed', error = ? WHERE id = ? AND status = 'scheduled'")
            .run(`${e.message} — возможно, статья опубликована на сайте; проверьте вручную (автоповтор отключён)`, id);
        } else {
          // Прочие сбои — авто-ретрай: attempts+1; <MAX → отложить на backoff (dueStmt подхватит), иначе failed.
          retryPublish.run({ id, err: e.message, max: MAX_PUBLISH_ATTEMPTS, backoff: String(PUBLISH_RETRY_BACKOFF_MIN) });
        }
      }
    }
  } finally {
    pubRunning = false;
  }
}

// --- Проверка позиции в Google после публикации (rank_check_at). Тяжёлая (капчи) — своя дорожка. ---
let rankRunning = false;
async function rankTick() {
  if (rankRunning) return;
  rankRunning = true;
  try {
    const now = utcStamp();
    const dueRank = dueRankStmt.all(now);
    if (!dueRank.length) return;
    console.log(`[${now}] проверок позиции: ${dueRank.length}`);
    for (const { id } of dueRank) {
      try {
        const r = await withTimeout(checkArticleRank(db, id), RANK_ONE_TIMEOUT_MS, 'проверка позиции');
        console.log(`  ✓ rank id=${id}: ${r.map((x) => `${x.country.toUpperCase()}:${x.position ? '#' + x.position : '—'}`).join(' ')}`);
      } catch (e) {
        console.error(`  ✗ rank id=${id}: ${e.message}`);
      } finally {
        clearRankCheck.run(id); // один раз: больше не дёргаем (финальную позицию снимем перед удалением)
      }
    }
  } finally {
    rankRunning = false;
  }
}

// --- Авто-удаление с сайта. Своя дорожка (пул по аккаунтам). ---
let delRunning = false;
async function deleteTick() {
  if (delRunning) return;
  delRunning = true;
  try {
    const now = utcStamp();
    const dueDel = dueDeleteStmt.all(now);
    if (!dueDel.length) return;
    console.log(`[${now}] к удалению с сайта: ${dueDel.length} (пул по аккаунтам, до ${BULK_CONCURRENCY} профилей)`);
    try {
      const r = await deleteArticlesGrouped(db, dueDel.map((x) => x.id), { concurrency: BULK_CONCURRENCY, delayMs: BULK_DELETE_DELAY_MS, clearDeleteAtOnFail: true });
      console.log(`  удаление: снято ${r.ok}, ошибок ${r.fail} из ${r.total}`);
    } catch (e) {
      console.error(`  ✗ удаление (пул): ${e.message}`);
    }
  } finally {
    delRunning = false;
  }
}

// --- Проверки одобрения регистраций (IMAP). Своя дорожка. ---
let apprRunning = false;
async function approvalTick() {
  if (apprRunning) return;
  apprRunning = true;
  try {
    const now = utcStamp();
    const dueReg = dueApprovalChecks(db, now);
    if (!dueReg.length) return;
    console.log(`[${now}] проверок одобрения регистраций: ${dueReg.length}`);
    for (const { id } of dueReg) {
      try {
        const res = await withTimeout(checkApproval(db, { registrationId: id }), PUBLISH_TIMEOUT_MS, 'проверка одобрения');
        console.log(`  ${res.ok ? '✓' : '·'} reg id=${id}: ${res.message}`);
      } catch (e) {
        console.error(`  ✗ reg id=${id}: ${e.message}`);
        db.prepare("UPDATE site_registrations SET next_check_at = datetime('now','+6 hours'), error = ? WHERE id = ? AND status = 'awaiting_admin'").run(e.message, id);
      }
    }
  } finally {
    apprRunning = false;
  }
}

// Отдельная дорожка ПРОГРЕВА (свой флаг) — визиты браузером/Dolphin и пост-регистрация ДОЛГИЕ (минуты, капча),
// поэтому НЕ должны блокировать публикацию/удаление в основном тике. Публикация — приоритет.
let warmRunning = false;
async function warmingTick() {
  if (warmRunning) return; // не пересекаемся сами с собой; Dolphin-нагрузку общий семафор (6) балансирует
  warmRunning = true;
  try {
    const now = utcStamp();
    const dueWarm = dueWarmings(db, now);
    if (!dueWarm.length) return;
    console.log(`[${now}] визитов прогрева: ${dueWarm.length} (до ${WARM_MAX_PER_TICK} за проход)`);
    for (const { id } of dueWarm.slice(0, WARM_MAX_PER_TICK)) {
      try {
        const res = await withTimeout(warmVisit(db, { registrationId: id }), WARM_TIMEOUT_MS, 'визит прогрева');
        console.log(`  ✓ warm reg=${id}: визит ${res.visits}/${res.target}${res.done ? ' — прогрев завершён' : ''}`);
        if (res.done) {
          const reg = db.prepare('SELECT site_id, email_account_id FROM site_registrations WHERE id = ?').get(id);
          try {
            const r2 = await withTimeout(registerOnSite(db, { siteId: reg.site_id, emailAccountId: reg.email_account_id }), PUBLISH_TIMEOUT_MS, 'регистрация после прогрева');
            console.log(`  ✓ reg-after-warm reg=${id}: ${r2.status} — ${r2.message}`);
          } catch (e) {
            console.error(`  ✗ reg-after-warm reg=${id}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`  ✗ warm reg=${id}: ${e.message}`);
        db.prepare("UPDATE site_registrations SET next_warm_at = datetime('now','+3 hours'), error = ? WHERE id = ? AND status = 'warming'").run(e.message, id);
      }
    }
  } catch (e) {
    console.error('Ошибка warming-тика:', e.message);
  } finally {
    warmRunning = false;
  }
}

// Отдельная «тяжёлая» дорожка: суточные сбор статистики/позиций. Свой флаг — не блокирует основной тик
// (публикация/удаление/проверки идут параллельно, пока эти джобы ждут сеть/Dolphin). Сами гейтятся по дате.
let heavyRunning = false;
async function heavyTick() {
  if (heavyRunning) return;
  heavyRunning = true;
  try {
    const now = utcStamp();
    await maybeDailyStats(now);
    await maybeDailyRanks(now);
  } catch (e) {
    console.error('Ошибка heavy-тика:', e.message);
  } finally {
    heavyRunning = false;
  }
}

// Не роняем долгоживущий планировщик из-за необработанной ошибки — логируем и продолжаем.
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));

console.log(`Планировщик запущен (дорожки: публикация ${PUB_TICK_MS / 1000}с / позиции / удаление / одобрение / прогрев + heartbeat ${HEARTBEAT_MS / 1000}с). Ctrl+C для остановки.`);
// Подчистить осиротевшие одноразовые профили Dolphin (best-effort, не блокируем старт).
sweepOrphanProfiles().catch((e) => console.error('Sweep профилей:', e.message));

// Независимый heartbeat — пишем liveness ВСЕГДА (event loop свободен на await даже во время долгой капчи).
// Бейдж «не отвечает» теперь = процесс мёртв/заблокирован, а не «занят долгой операцией».
const heartbeat = () => {
  try {
    setSetting(db, 'scheduler_last_tick', utcStamp());
  } catch (e) {
    console.error('heartbeat:', e.message);
  }
};
heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);

// Каждая дорожка — свой независимый интервал (ничто не блокирует публикацию; профили ограничены семафором).
const runTrack = (fn, name) => fn().catch((e) => console.error(`Ошибка дорожки «${name}»:`, e.message));
runTrack(publishTick, 'публикация');
setInterval(() => runTrack(publishTick, 'публикация'), PUB_TICK_MS);
setInterval(() => runTrack(rankTick, 'позиции'), RANK_TICK_MS);
setInterval(() => runTrack(deleteTick, 'удаление'), DEL_TICK_MS);
setInterval(() => runTrack(approvalTick, 'одобрение'), APPR_TICK_MS);
setInterval(() => runTrack(warmingTick, 'прогрев'), WARM_TICK_MS);
heavyTick();
setInterval(heavyTick, HEAVY_TICK_MS);
