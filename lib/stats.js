// Сбор и агрегация статистики статей (Content-Cockpit). НЕЙТРАЛЬНО к сайту: формат витрины парсит
// адаптер (adapter.fetchArticleStats), здесь — оркестрация сессии, сохранение снимков и выборки для UI.
// Снимки храним во времени (article_stats) → тренд/дельты. 1 статья = 1 ключ → seo_views = органика ключа.

import { runInAccountSession } from './publisher.js';
import { getAdapter } from './sites/index.js';
import { getSiteAccountById, resolvePublishAccount, parseProxy, saveAccountCookies } from './accounts.js';
import { utcStamp } from './time.js';

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));

// Сохранить один снимок статистики статьи. stats — нормализованный объект адаптера.
export function saveStatsSnapshot(db, articleId, stats, { reason = 'manual' } = {}) {
  const ch = stats.channels || {};
  return db
    .prepare(
      `INSERT INTO article_stats
        (article_id, captured_at, reason, total_views, seo_views, social_views, curated_views, newsletter_views, qr_views, rest_views, avg_time_on_page, percentile, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      articleId,
      utcStamp(),
      reason,
      num(stats.totalViews),
      num(ch.seo),
      num(ch.social),
      num(ch.curated),
      num(ch.newsletter),
      num(ch.qr),
      num(ch.rest),
      num(stats.avgTimeOnPage),
      num(stats.percentile),
      stats.raw ? JSON.stringify(stats.raw) : null,
    ).lastInsertRowid;
}

// Резолв аккаунта-владельца статьи (им же публиковали → им же читать кокпит). Легаси без account_id — дефолт сайта.
function resolveOwnerAccount(db, article) {
  if (article.account_id) {
    const acc = getSiteAccountById(db, article.account_id);
    if (!acc) throw new Error('Аккаунт-владелец статьи удалён — статистику собрать нельзя.');
    return acc;
  }
  return resolvePublishAccount(db, article.site_id);
}

// Статьи сайта, для которых имеет смысл собирать статистику: опубликованы, ещё на сайте, с числовым id в URL.
export function statsCollectibleArticles(db, siteId) {
  return db
    .prepare(
      `SELECT * FROM articles
       WHERE site_id = ? AND status = 'published' AND site_deleted_at IS NULL AND site_url LIKE '%\\_a%' ESCAPE '\\'
       ORDER BY account_id, id`,
    )
    .all(siteId);
}

// Собрать статистику ОДНОЙ статьи (своя сессия). Возвращает нормализованный объект stats.
export async function collectArticleStats(db, articleId, { reason = 'manual', onStep } = {}) {
  const log = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const article = db.prepare('SELECT * FROM articles WHERE id = ?').get(articleId);
  if (!article) throw new Error(`Статья ${articleId} не найдена.`);
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(article.site_id);
  if (!site) throw new Error(`Сайт ${article.site_id} не найден.`);
  const adapter = getAdapter(site.adapter);
  if (!adapter.fetchArticleStats) throw new Error(`Адаптер «${site.adapter}» не умеет собирать статистику.`);
  const siteArticleId = adapter.parseSiteArticleId(article.site_url);
  if (!siteArticleId) throw new Error('У статьи нет URL на сайте — статистику собрать не из чего.');

  const acc = resolveOwnerAccount(db, article);
  const proxy = acc.proxy ? parseProxy(acc.proxy) : null;
  log(`Статистика «${(article.title || '').slice(0, 60)}» — аккаунт ${acc.label || acc.username}.`);

  return runInAccountSession(
    {
      adapter,
      profileName: site.profile_name,
      origin: site.origin,
      credentials: { username: acc.username, password: acc.password },
      proxy,
      cookies: acc.cookies,
      onCookies: (c) => saveAccountCookies(db, acc.id, c),
      log,
    },
    async (page) => {
      const stats = await adapter.fetchArticleStats(page, { origin: site.origin, siteArticleId, log });
      saveStatsSnapshot(db, articleId, stats, { reason });
      log(`#${articleId}: ${stats.totalViews} просмотров (из поиска ${stats.channels?.seo ?? 0}), перцентиль ${stats.percentile ?? '-'}.`);
      return stats;
    },
  );
}

// Собрать статистику по всем подходящим статьям сайта. Группируем по аккаунту-владельцу → одна сессия на
// аккаунт, проход по его статьям (cookie-сессия переиспользуется). Возвращает { total, ok, fail }.
export async function collectStatsForSite(db, siteId, { reason = 'daily', onStep } = {}) {
  const log = (m) => {
    console.log(m);
    if (onStep) onStep(m);
  };
  const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!site) throw new Error(`Сайт ${siteId} не найден.`);
  const adapter = getAdapter(site.adapter);
  // Сайт без поддержки статистики (другой движок) — не ошибка, а штатный пропуск (чтобы не шуметь в логах ежедневно).
  if (!adapter.fetchArticleStats) {
    log(`Адаптер «${site.adapter}» не умеет собирать статистику — пропуск.`);
    return { total: 0, ok: 0, fail: 0, skipped: true };
  }

  const articles = statsCollectibleArticles(db, siteId);
  if (!articles.length) {
    log('Подходящих статей (опубликованы и на сайте) нет — нечего собирать.');
    return { total: 0, ok: 0, fail: 0 };
  }

  // Сгруппировать по аккаунту-владельцу.
  const byAccount = new Map();
  for (const a of articles) {
    const key = a.account_id || 0;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(a);
  }

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const [, group] of byAccount) {
    let acc;
    try {
      acc = resolveOwnerAccount(db, group[0]);
    } catch (e) {
      fail += group.length;
      log(`Пропускаю ${group.length} статей: ${e.message}`);
      continue;
    }
    // Отключённый (в т.ч. ранее забаненный) аккаунт не трогаем — иначе впустую поднимаем профиль/прокси.
    if (!acc.enabled) {
      skipped += group.length;
      log(`Аккаунт ${acc.label || acc.username} отключён — пропуск ${group.length} статей.`);
      continue;
    }
    const proxy = acc.proxy ? parseProxy(acc.proxy) : null;
    log(`Аккаунт ${acc.label || acc.username}: статей ${group.length}.`);
    try {
      await runInAccountSession(
        {
          adapter,
          profileName: site.profile_name,
          origin: site.origin,
          credentials: { username: acc.username, password: acc.password },
          proxy,
          cookies: acc.cookies,
          onCookies: (c) => saveAccountCookies(db, acc.id, c),
          log,
        },
        async (page) => {
          for (const a of group) {
            const siteArticleId = adapter.parseSiteArticleId(a.site_url);
            if (!siteArticleId) {
              fail += 1;
              continue;
            }
            try {
              const stats = await adapter.fetchArticleStats(page, { origin: site.origin, siteArticleId, log });
              saveStatsSnapshot(db, a.id, stats, { reason });
              ok += 1;
            } catch (e) {
              fail += 1;
              log(`#${a.id}: сбой статистики — ${e.message}`);
            }
          }
        },
      );
    } catch (e) {
      // не удалось даже залогиниться/запустить профиль — все статьи аккаунта в fail
      fail += group.length;
      if (e.banned) {
        // Бан аккаунта сайтом → отключаем, чтобы следующие сборы его не дёргали.
        db.prepare('UPDATE site_accounts SET enabled = 0 WHERE id = ?').run(acc.id);
        log(`Аккаунт ${acc.label || acc.username} ЗАБАНЕН сайтом — отключил его (статьи по нему больше не собираем).`);
      } else {
        log(`Аккаунт ${acc.label || acc.username}: сессия не поднялась — ${e.message}`);
      }
    }
  }
  log(`Готово: собрано ${ok}, ошибок ${fail}${skipped ? `, пропущено ${skipped}` : ''} из ${articles.length}.`);
  return { total: articles.length, ok, fail, skipped };
}

// Последний снимок статьи (или null).
export function articleLatestStats(db, articleId) {
  return db.prepare('SELECT * FROM article_stats WHERE article_id = ? ORDER BY id DESC LIMIT 1').get(articleId);
}

// Агрегация по ключам сайта (последний снимок на статью). Возвращает строки для UI.
export function keywordStats(db, siteId) {
  return db
    .prepare(
      `WITH latest AS (
         SELECT s.* FROM article_stats s
         JOIN (SELECT article_id, MAX(id) mid FROM article_stats GROUP BY article_id) m ON m.mid = s.id
       )
       SELECT a.keyword,
              COUNT(*) articles,
              SUM(CASE WHEN a.status='published' AND a.site_deleted_at IS NULL THEN 1 ELSE 0 END) live,
              SUM(CASE WHEN a.site_deleted_at IS NOT NULL THEN 1 ELSE 0 END) archived,
              SUM(COALESCE(l.total_views, 0)) total_views,
              SUM(COALESCE(l.seo_views, 0))   seo_views,
              MAX(l.percentile)               best_percentile,
              MAX(l.captured_at)              last_captured
       FROM articles a
       LEFT JOIN latest l ON l.article_id = a.id
       WHERE a.site_id = ? AND a.keyword IS NOT NULL AND a.keyword <> ''
       GROUP BY a.keyword
       ORDER BY seo_views DESC, total_views DESC, a.keyword`,
    )
    .all(siteId);
}

// Статьи сайта с последним снимком (для таблицы «по статьям»).
export function articleStatsRows(db, siteId) {
  return db
    .prepare(
      `WITH latest AS (
         SELECT s.* FROM article_stats s
         JOIN (SELECT article_id, MAX(id) mid FROM article_stats GROUP BY article_id) m ON m.mid = s.id
       )
       SELECT a.id, a.title, a.keyword, a.status, a.site_url, a.site_deleted_at,
              l.total_views, l.seo_views, l.social_views, l.curated_views, l.newsletter_views, l.qr_views, l.rest_views,
              l.avg_time_on_page, l.percentile, l.captured_at
       FROM articles a
       LEFT JOIN latest l ON l.article_id = a.id
       WHERE a.site_id = ? AND (l.id IS NOT NULL OR (a.status='published'))
       ORDER BY COALESCE(l.seo_views,0) DESC, COALESCE(l.total_views,0) DESC, a.id DESC`,
    )
    .all(siteId);
}
