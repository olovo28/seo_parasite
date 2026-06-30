// Публикация/удаление статьи по id: резолв адаптера сайта + аккаунта, действие, обновление статуса/лога.
// Общая логика для cli/publish.js и scheduler.js (без дублей). Формат тела делает адаптер сайта.

import { publishArticleToSite, deleteArticleFromSite, deleteManyInSession, withProxySwap, deleteOneHttp } from './publisher.js';
import { getAdapter } from './sites/index.js';
import { resolvePublishAccount, getSiteAccountById, parseProxy, saveAccountCookies } from './accounts.js';
import { utcStamp, nextDailyOccurrence, parseStamp } from './time.js';
import { logArticleEvent } from './events.js';
import { saveStatsSnapshot } from './stats.js';

const RANK_CHECK_DELAY_MS = Number(process.env.RANK_CHECK_DELAY_MS || 5 * 60000); // через сколько после публикации проверять позицию
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Публикует статью articleId. accountId — выбранный аккаунт сайта (опц.; иначе дефолт/env).
// Возвращает { ok, message, screenshot? }. Обновляет articles.status и пишет в publish_log.
export async function publishArticleById(db, articleId, { accountId, onStep } = {}) {
  const step = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) throw new Error(`Статья ${articleId} не найдена.`);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(article.site_id);
  if (!site) throw new Error(`Сайт ${article.site_id} не найден.`);

  const log = db.prepare('INSERT INTO publish_log (article_id, ok, message) VALUES (?, ?, ?)');
  const markFailed = (msg) => {
    db.prepare("UPDATE articles SET status = 'failed', error = ? WHERE id = ?").run(msg, articleId);
    log.run(articleId, 0, msg);
  };

  const tags = (article.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (tags.length < 2) {
    const msg = `У статьи меньше 2 тегов (${tags.length}). Форма сайта требует ≥2.`;
    markFailed(msg);
    return { ok: false, message: msg };
  }

  let acc;
  let proxy;
  try {
    // Явный accountId (ручная публикация) важнее; иначе — пред-назначенный при раскладке article.account_id
    // (так планировщик публикует запланированной статьёй именно её аккаунтом, а не «первым включённым»).
    acc = resolvePublishAccount(db, site.id, accountId ?? article.account_id);
    proxy = acc.proxy ? parseProxy(acc.proxy) : null;
  } catch (e) {
    markFailed(e.message);
    return { ok: false, message: e.message };
  }

  step(`Публикация «${(article.title || '').slice(0, 60)}» — аккаунт ${acc.label}${proxy ? ' (своя прокси)' : ''}.`);

  try {
    const res = await withProxySwap(db, acc, (px) => publishArticleToSite({
      adapter: getAdapter(site.adapter),
      profileName: site.profile_name,
      origin: site.origin,
      credentials: { username: acc.username, password: acc.password },
      proxy: px,
      article: { title: article.title, body_html: article.body_html, tags },
      cookies: acc.cookies,
      onCookies: (c) => saveAccountCookies(db, acc.id, c),
      log: step,
    }), step);
    res.message = `[аккаунт ${acc.label}] ${res.message}`;
    log.run(articleId, res.ok ? 1 : 0, res.message);
    if (res.ok) {
      // Авто-удаление считаем ОТ МОМЕНТА ПУБЛИКАЦИИ (не от момента раскладки в черновике):
      //  window_end — к ближайшему закрытию окна; ttl_capped — через N часов, но не позже (окно − 5 мин).
      const tzs = site.timezone || 'Europe/Vienna';
      const nowEp = Date.now();
      let autoDeleteAt = null;
      if (article.no_auto_delete) {
        autoDeleteAt = null; // статья помечена «не удалять» — настройку сайта не применяем
      } else if (site.auto_delete === 'window_end' && site.window_end) {
        autoDeleteAt = utcStamp(new Date(nextDailyOccurrence(site.window_end, tzs, nowEp)));
      } else if (site.auto_delete === 'ttl_capped' && site.window_end) {
        const hrs = Number(site.auto_delete_hours) > 0 ? Number(site.auto_delete_hours) : 4;
        const ttlEp = nowEp + hrs * 3600000;
        const capEp = nextDailyOccurrence(site.window_end, tzs, nowEp) - 5 * 60000; // за 5 мин до закрытия смены
        autoDeleteAt = utcStamp(new Date(Math.min(ttlEp, capEp)));
      }
      // Сохраняем ранее заданный delete_at ТОЛЬКО если он в будущем (актуальный ручной выбор).
      // Просроченный (остался от раскладки на прошедший день, а публикация задержалась) — невалиден:
      // иначе статью удалит сразу после публикации. В этом случае берём пересчитанный от «сейчас».
      const existingEp = parseStamp(article.delete_at);
      const finalDeleteAt = existingEp != null && existingEp > nowEp ? article.delete_at : autoDeleteAt;
      // Проверку позиции в Google планируем через RANK_CHECK_DELAY_MS после публикации (только если есть ключ).
      const rankCheckAt = article.keyword ? utcStamp(new Date(nowEp + RANK_CHECK_DELAY_MS)) : null;
      // Запоминаем аккаунт публикации: удалять статью надо ИМЕННО им, а не дефолтным сайта.
      db.prepare("UPDATE articles SET status = 'published', published_at = ?, site_url = ?, delete_at = ?, account_id = ?, rank_check_at = ?, error = NULL WHERE id = ?")
        .run(utcStamp(), res.url || null, finalDeleteAt, acc.id ?? null, rankCheckAt, articleId);
      logArticleEvent(db, articleId, 'published', `Опубликована на сайте${res.url ? ': ' + res.url : ''}`);
    } else {
      db.prepare("UPDATE articles SET status = 'failed', error = ? WHERE id = ?").run(res.message, articleId);
      logArticleEvent(db, articleId, 'publish_failed', res.message);
    }
    return res;
  } catch (e) {
    markFailed(e.message);
    e.handled = true;
    throw e;
  }
}

// Удалить статью С САЙТА по id нашей БД. siteArticleId берём из articles.site_url (..._a<ID>).
// accountId — аккаунт сайта (по умолч. — дефолтный). При успехе: site_deleted_at + запись в publish_log.
export async function deleteArticleFromSiteById(db, articleId, { accountId, onStep } = {}) {
  const step = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) throw new Error(`Статья ${articleId} не найдена.`);
  if (article.status !== 'published') throw new Error('Удалять с сайта можно только опубликованную статью.');
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(article.site_id);
  if (!site) throw new Error(`Сайт ${article.site_id} не найден.`);
  const adapter = getAdapter(site.adapter);
  const siteArticleId = adapter.parseSiteArticleId(article.site_url);
  if (!siteArticleId) throw new Error('В БД нет URL опубликованной статьи на сайте — нечего удалять.');

  const log = db.prepare('INSERT INTO publish_log (article_id, ok, message) VALUES (?, ?, ?)');
  let acc;
  let proxy;
  try {
    // Удаляем статью аккаунтом-ВЛАДЕЛЬЦЕМ (под которым она опубликована), а не дефолтным сайта.
    // Если владелец удалён из site_accounts — удалять нельзя (чужой аккаунт чужую статью не снимет).
    if (article.account_id) {
      acc = getSiteAccountById(db, article.account_id);
      if (!acc) {
        const msg = 'Статья опубликована под аккаунтом, которого больше нет — удалить с сайта нельзя. Перенеси в архив (она ушла вместе с аккаунтом) или удали из БД.';
        db.prepare('UPDATE articles SET delete_at = NULL WHERE id = ?').run(articleId); // не зацикливать авто-удаление
        log.run(articleId, 0, msg);
        logArticleEvent(db, articleId, 'site_delete_failed', msg);
        return { ok: false, message: msg, ownerGone: true };
      }
    } else {
      // Легаси-статья без записанного аккаунта: явный accountId или дефолт сайта (как раньше).
      acc = resolvePublishAccount(db, site.id, accountId);
    }
    proxy = acc.proxy ? parseProxy(acc.proxy) : null;
  } catch (e) {
    log.run(articleId, 0, e.message);
    return { ok: false, message: e.message };
  }

  try {
    const res = await withProxySwap(db, acc, (px) => deleteArticleFromSite({
      adapter,
      profileName: site.profile_name,
      origin: site.origin,
      credentials: { username: acc.username, password: acc.password },
      proxy: px,
      siteArticleId,
      cookies: acc.cookies,
      onCookies: (c) => saveAccountCookies(db, acc.id, c),
      // Перед удалением выгружаем финальную статистику (в той же сессии) — best-effort.
      onStats: (stats) => {
        try {
          saveStatsSnapshot(db, articleId, stats, { reason: 'pre-delete' });
          logArticleEvent(db, articleId, 'stats', `Статистика перед удалением: ${stats.totalViews} просмотров (из поиска ${stats.channels?.seo ?? 0})`);
        } catch (e) {
          step(`Не удалось сохранить статистику перед удалением: ${e.message}`);
        }
      },
      log: step,
    }), step);
    res.message = `[аккаунт ${acc.label}] ${res.message}`;
    log.run(articleId, res.ok ? 1 : 0, res.message);
    if (res.ok) {
      db.prepare('UPDATE articles SET site_deleted_at = ? WHERE id = ?').run(utcStamp(), articleId);
      logArticleEvent(db, articleId, 'site_deleted', `Удалена с сайта (article ${siteArticleId})`);
    } else {
      logArticleEvent(db, articleId, 'site_delete_failed', res.message);
    }
    return res;
  } catch (e) {
    log.run(articleId, 0, e.message);
    e.handled = true;
    throw e;
  }
}

// Простой пул: гонит worker по элементам с лимитом одновременных.
async function runPool(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

// Массовое снятие с сайта: группируем по аккаунту (ОДИН профиль на аккаунт, а не на статью),
// до `concurrency` аккаунтов параллельно; внутри аккаунта — последовательно с паузой `delayMs`.
// Перед каждым удалением собираем статистику (reason='pre-delete'). DB-обновления — здесь. { total, ok, fail }.
export async function deleteArticlesGrouped(db, articleIds, { concurrency = 5, delayMs = 10000, clearDeleteAtOnFail = false, shouldStop = () => false, onStep } = {}) {
  const step = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const logp = db.prepare('INSERT INTO publish_log (article_id, ok, message) VALUES (?, ?, ?)');
  // Авто-удаление (планировщик) передаёт true: при ошибке снимаем delete_at, чтобы не дёргать каждый тик.
  const clearDel = db.prepare('UPDATE articles SET delete_at = NULL WHERE id = ? AND site_deleted_at IS NULL');
  const onFail = (articleId) => {
    if (clearDeleteAtOnFail) clearDel.run(articleId);
  };
  const groups = new Map(); // key=`${siteId}:${accId}` -> { acc, site, adapter, items:[{articleId, siteArticleId}] }
  let ok = 0;
  let fail = 0;
  let stopped = false;

  for (const id of articleIds) {
    const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!article) { step(`#${id}: не найдена — пропуск`); continue; }
    if (article.status !== 'published') { step(`#${id}: не опубликована — пропуск`); continue; }
    if (article.site_deleted_at) { step(`#${id}: уже снята с сайта — пропуск`); continue; }
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(article.site_id);
    if (!site) { step(`#${id}: сайт не найден — пропуск`); continue; }
    const adapter = getAdapter(site.adapter);
    const siteArticleId = adapter.parseSiteArticleId(article.site_url);
    if (!siteArticleId) {
      const msg = 'В БД нет URL на сайте — нечего удалять.';
      logp.run(id, 0, msg);
      logArticleEvent(db, id, 'site_delete_failed', msg);
      fail += 1;
      continue;
    }
    let acc;
    if (article.account_id) {
      acc = getSiteAccountById(db, article.account_id);
      if (!acc) {
        const msg = 'Аккаунт-владелец удалён — снять с сайта нельзя.';
        db.prepare('UPDATE articles SET delete_at = NULL WHERE id = ?').run(id); // не зацикливать авто-удаление
        logp.run(id, 0, msg);
        logArticleEvent(db, id, 'site_delete_failed', msg);
        fail += 1;
        continue;
      }
    } else {
      try {
        acc = resolvePublishAccount(db, site.id);
      } catch (e) {
        logp.run(id, 0, e.message);
        fail += 1;
        continue;
      }
    }
    const key = `${site.id}:${acc.id}`;
    if (!groups.has(key)) groups.set(key, { acc, site, adapter, items: [] });
    groups.get(key).items.push({ articleId: id, siteArticleId });
  }

  const groupArr = [...groups.values()];
  step(`К удалению: ${groupArr.reduce((n, g) => n + g.items.length, 0)} статей в ${groupArr.length} аккаунтах (до ${concurrency} профилей параллельно, пауза ${Math.round(delayMs / 1000)}с).`);

  await runPool(groupArr, concurrency, async (g) => {
    if (shouldStop()) { stopped = true; return; } // остановка запрошена — этот аккаунт не начинаем
    const accName = g.acc.label || g.acc.username;
    const proxy = g.acc.proxy ? parseProxy(g.acc.proxy) : null;
    const cookies = g.acc.cookies;
    const items = g.items.map((it) => ({
      ...it,
      onStats: (stats) => {
        try {
          saveStatsSnapshot(db, it.articleId, stats, { reason: 'pre-delete' });
          logArticleEvent(db, it.articleId, 'stats', `Статистика перед удалением: ${stats.totalViews} просмотров (из поиска ${stats.channels?.seo ?? 0})`);
        } catch (e) {
          step(`[${accName}] #${it.articleId}: статистику не сохранил: ${e.message}`);
        }
      },
    }));
    // Общий обработчик результата удаления (HTTP и браузер) — пишет в БД/журнал и считает ok/fail.
    const handleResult = (it, res) => {
      logp.run(it.articleId, res.ok ? 1 : 0, `[аккаунт ${accName}] ${res.message}`);
      if (res.ok) {
        db.prepare('UPDATE articles SET site_deleted_at = ? WHERE id = ?').run(utcStamp(), it.articleId);
        logArticleEvent(db, it.articleId, 'site_deleted', `Удалена с сайта (article ${it.siteArticleId})`);
        ok += 1;
        step(`✓ #${it.articleId} [${accName}]: снято`);
      } else {
        logArticleEvent(db, it.articleId, 'site_delete_failed', res.message);
        onFail(it.articleId);
        fail += 1;
        step(`✗ #${it.articleId} [${accName}]: ${res.message}`);
      }
    };

    // HTTP-first: удаляем что можем без профиля Dolphin; при истёкшей сессии (needLogin) — оставшиеся через профиль.
    let browserItems = items;
    if (g.adapter.deleteArticleHttp && cookies && proxy) {
      step(`[${accName}] ${items.length} статей — удаляю по HTTP (без профиля)…`);
      const rest = [];
      let dead = false;
      for (let i = 0; i < items.length; i++) {
        if (shouldStop()) { stopped = true; break; }
        const it = items[i];
        if (dead) { rest.push(it); continue; }
        try {
          handleResult(it, await deleteOneHttp({ adapter: g.adapter, origin: g.site.origin, cookies, proxy, siteArticleId: it.siteArticleId, onStats: it.onStats, log: step }));
        } catch (e) {
          if (e.needLogin) { dead = true; rest.push(it); }
          else handleResult(it, { ok: false, message: e.message });
        }
        if (!dead && i < items.length - 1 && delayMs) await sleep(delayMs); // пауза между HTTP-удалениями (анти-паттерн)
      }
      if (!rest.length || shouldStop()) return; // всё снято по HTTP (или остановка)
      step(`[${accName}] HTTP-сессия истекла — добиваю ${rest.length} через профиль…`);
      browserItems = rest;
    }

    // Фолбэк через Dolphin (один профиль на аккаунт) для оставшихся.
    step(`[${accName}] ${browserItems.length} статей — поднимаю профиль…`);
    try {
      await withProxySwap(db, g.acc, (px) => deleteManyInSession({
        adapter: g.adapter,
        profileName: g.site.profile_name,
        origin: g.site.origin,
        credentials: { username: g.acc.username, password: g.acc.password },
        proxy: px,
        cookies: g.acc.cookies,
        onCookies: (c) => saveAccountCookies(db, g.acc.id, c),
        items: browserItems,
        delayMs,
        shouldStop,
        log: step,
        onResult: handleResult,
      }), step);
    } catch (e) {
      // сессия/профиль не поднялись даже с ретраями → оставшиеся статьи аккаунта в ошибку
      step(`[${accName}] сессия не поднялась: ${e.message}`);
      for (const it of browserItems) {
        logp.run(it.articleId, 0, `[аккаунт ${accName}] ${e.message}`);
        logArticleEvent(db, it.articleId, 'site_delete_failed', e.message);
        onFail(it.articleId);
        fail += 1;
      }
    }
  });

  if (shouldStop()) stopped = true;
  step(`Готово: снято ${ok}, ошибок ${fail} из ${articleIds.length}${stopped ? ' (остановлено)' : ''}.`);
  return { total: articleIds.length, ok, fail, stopped };
}
