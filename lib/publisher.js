// Оркестрация публикации/удаления на сайте — НЕЙТРАЛЬНА к сайту.
// Поток: launchForAccount (профиль+прокси-гейт) → adapter.login → adapter.publish/deleteArticle → cleanup.
// Сайт-специфику (логин/форма/удаление/формат тела) делает адаптер (lib/sites/*); общий запуск — lib/browser.js.

import { launchForAccount, cleanupProfile, screenshotTo, captureCookies, restoreCookies } from './browser.js';
import { swapSiteAccountProxy } from './proxyPool.js';
import { parseProxy } from './accounts.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Выполнить операцию аккаунта с ЕГО прокси (sticky). Если прокси НЕ поднялась (e.proxyFailed) — подменить её на
// свободную из пула «Публикация» (≥24ч простоя, не занята другими аккаунтами/почтами) и повторить ОДИН раз.
// Без свободной замены — пробрасываем исходную ошибку (поведение как раньше). account.proxy при свапе обновляется.
export async function withProxySwap(db, account, runWithProxy, log = () => {}) {
  const first = account.proxy ? parseProxy(account.proxy) : null;
  try {
    return await runWithProxy(first);
  } catch (e) {
    if (!e || !e.proxyFailed) throw e;
    const url = swapSiteAccountProxy(db, account.id);
    if (!url) throw e;
    account.proxy = url;
    log(`Прокси аккаунта не поднялась — замена из пула «Публикация» (свободная, ≥24ч простоя): ${String(url).replace(/\/\/[^@/]*@/, '//***@')}; повтор.`);
    return await runWithProxy(parseProxy(url));
  }
}

// Вернуть рабочие cookies для HTTP: имеющиеся, иначе залогиниться по HTTP (с переносом старых cookies — согласия
// и пр.) и сохранить свежие через onCookies. Возвращает массив cookies или null (HTTP-логин невозможен/не удался).
async function httpCookiesOrLogin(adapter, { origin, username, password, cookies, proxy, onCookies, log }) {
  if (Array.isArray(cookies) && cookies.length) return cookies;
  if (!adapter.loginHttp) return null;
  const r = await adapter.loginHttp({ origin, username, password, cookies, proxy, log }).catch((e) => {
    log(`HTTP-логин не удался: ${e.message}`);
    return null;
  });
  if (r?.ok && r.cookies) {
    if (onCookies) onCookies(r.cookies);
    return r.cookies;
  }
  return null;
}

// Гарантировать залогиненную сессию. Быстрый путь: восстановить сохранённые cookies и проверить — если живы,
// логин пропускаем. Иначе обычный логин + сохранение свежей сессии (onCookies). Само-восстановление при протухании.
async function ensureLoggedIn({ page, adapter, origin, credentials, cookies, onCookies, log }) {
  if (Array.isArray(cookies) && cookies.length && adapter.isLoggedIn) {
    await restoreCookies(page, cookies);
    if (await adapter.isLoggedIn(page, { origin })) {
      log('Сессия восстановлена из сохранённых cookies — логин пропущен.');
      return;
    }
    log('Сохранённая сессия недействительна — выполняю обычный логин.');
  }
  await adapter.login(page, { origin, ...credentials, log });
  if (onCookies) {
    try {
      const fresh = await captureCookies(page);
      onCookies(fresh);
      log(`Сессия сохранена (${fresh.length} cookies) — следующий запуск без логина.`);
    } catch {
      // не критично — в худшем случае залогинимся снова
    }
  }
}

// Выполнить операцию (publish/delete) с авто-перелогином, если ВО ВРЕМЯ работы выкинуло из аккаунта.
// Адаптер кидает ошибку с .needLogin=true → логинимся заново, пересохраняем сессию и повторяем ОДИН раз.
async function withReauth(op, { page, adapter, origin, credentials, onCookies, log }) {
  try {
    return await op();
  } catch (e) {
    if (!e || !e.needLogin) throw e;
    log('Сессия отвалилась во время работы — перелогиниваюсь и повторяю…');
    await adapter.login(page, { origin, ...credentials, log });
    if (onCookies) {
      try {
        onCookies(await captureCookies(page));
      } catch {
        // не критично
      }
    }
    return await op();
  }
}

// Опубликовать статью на сайте через адаптер. article: { title, body_html, tags: [..] }.
// Возвращает { ok, message, url?, screenshot? }.
export async function publishArticleToSite({ adapter, profileName, origin, credentials, proxy, article, cookies, onCookies, log = console.log }) {
  // HTTP-first: публикуем без Dolphin, если адаптер умеет (cookies есть или можно залогиниться по HTTP).
  if (adapter.publishHttp && proxy?.host && ((Array.isArray(cookies) && cookies.length) || adapter.loginHttp)) {
    try {
      let cks = Array.isArray(cookies) && cookies.length ? cookies : await httpCookiesOrLogin(adapter, { origin, ...credentials, cookies, proxy, onCookies, log });
      if (cks) {
        let r;
        try {
          r = await adapter.publishHttp({ origin, article, cookies: cks, proxy, log });
        } catch (e) {
          if (!e.needLogin) throw e;
          r = { needLogin: true };
        }
        if (r?.needLogin && adapter.loginHttp) {
          log('HTTP-сессия истекла — логинюсь по HTTP и повторяю публикацию…');
          const fresh = await adapter.loginHttp({ origin, ...credentials, cookies: cks, proxy, log }).catch(() => null);
          if (fresh?.ok) {
            if (onCookies) onCookies(fresh.cookies);
            r = await adapter.publishHttp({ origin, article, cookies: fresh.cookies, proxy, log });
          }
        }
        if (r?.ok) return r;
        if (r && !r.needLogin) return r; // обычная ошибка валидации — отдаём как есть, Dolphin не нужен
      }
    } catch (e) {
      log(`HTTP-публикация: ${e.message} — через профиль Dolphin.`);
    }
  }
  let browser;
  let page;
  let ephemeralProfileId = null;
  try {
    const launched = await launchForAccount({ profileName, proxy, action: 'публикация', log });
    browser = launched.browser;
    page = launched.page;
    ephemeralProfileId = launched.ephemeralProfileId;

    await ensureLoggedIn({ page, adapter, origin, credentials, cookies, onCookies, log });
    log('Авторизация выполнена.');

    return await withReauth(() => adapter.publish(page, { origin, article, log }), { page, adapter, origin, credentials, onCookies, log });
  } catch (e) {
    if (page) {
      const shot = `publish-error-${Date.now()}.png`;
      await screenshotTo(page, shot);
      e.screenshot = shot;
    }
    throw e;
  } finally {
    await cleanupProfile(browser, ephemeralProfileId);
  }
}

// Открыть залогиненную сессию аккаунта и выполнить произвольную работу fn(page) (напр. сбор статистики
// по нескольким статьям в одной сессии). Профиль/прокси-гейт/логин/cleanup — как при публикации.
export async function runInAccountSession({ adapter, profileName, origin, credentials, proxy, cookies, onCookies, log = console.log }, fn) {
  let browser;
  let page;
  let ephemeralProfileId = null;
  try {
    const launched = await launchForAccount({ profileName, proxy, action: 'статистика', log });
    browser = launched.browser;
    page = launched.page;
    ephemeralProfileId = launched.ephemeralProfileId;

    await ensureLoggedIn({ page, adapter, origin, credentials, cookies, onCookies, log });
    log('Авторизация выполнена.');
    const result = await fn(page);
    // Пересохраняем cookies после сессии — фиксируем в т.ч. согласие кокпита (Google Charts «immer laden»),
    // которое сервер читает из cookie: следующий сбор пойдёт без гейта согласий. Best-effort.
    if (onCookies) {
      try {
        onCookies(await captureCookies(page));
      } catch {
        // не критично — в худшем случае согласие подтвердится снова на следующем сборе
      }
    }
    return result;
  } finally {
    await cleanupProfile(browser, ephemeralProfileId);
  }
}

// Удалить ОДНУ статью в УЖЕ открытой залогиненной сессии (page). Сначала best-effort сбор статистики
// (пока статья на сайте), затем удаление с авто-перелогином (withReauth). Возвращает { ok, message }.
async function deleteOneInSession({ page, adapter, origin, credentials, onCookies, siteArticleId, onStats, log = console.log }) {
  if (onStats && adapter.fetchArticleStats) {
    try {
      const stats = await adapter.fetchArticleStats(page, { origin, siteArticleId, log });
      onStats(stats);
      log('Статистика собрана перед удалением.');
    } catch (e) {
      log(`Статистику перед удалением собрать не удалось: ${e.message} (продолжаю удаление).`);
    }
  }
  return withReauth(() => adapter.deleteArticle(page, { origin, siteArticleId, log }), { page, adapter, origin, credentials, onCookies, log });
}

// HTTP-версия deleteOneInSession (БЕЗ браузера): стата перед удалением (best-effort) + удаление. needLogin → фолбэк.
export async function deleteOneHttp({ adapter, origin, cookies, proxy, siteArticleId, onStats, log = console.log }) {
  if (onStats && adapter.fetchArticleStatsHttp) {
    try {
      onStats(await adapter.fetchArticleStatsHttp({ origin, siteArticleId, cookies, proxy, log }));
      log('Статистика собрана перед удалением (HTTP).');
    } catch (e) {
      if (e.needLogin) throw e;
      log(`Статистику перед удалением (HTTP) не собрал: ${e.message} (продолжаю удаление).`);
    }
  }
  return adapter.deleteArticleHttp({ origin, siteArticleId, cookies, proxy, log });
}

// Удалить ОДНУ статью с сайта (одноразовый профиль на статью). Возвращает { ok, message, screenshot? }.
export async function deleteArticleFromSite({ adapter, profileName, origin, credentials, proxy, siteArticleId, cookies, onCookies, onStats, log = console.log }) {
  // HTTP-first: удаление без Dolphin, если адаптер умеет (cookies есть или можно залогиниться по HTTP).
  if (adapter.deleteArticleHttp && proxy?.host && ((Array.isArray(cookies) && cookies.length) || adapter.loginHttp)) {
    try {
      const cks = Array.isArray(cookies) && cookies.length ? cookies : await httpCookiesOrLogin(adapter, { origin, ...credentials, cookies, proxy, onCookies, log });
      if (cks) {
        try {
          return await deleteOneHttp({ adapter, origin, cookies: cks, proxy, siteArticleId, onStats, log });
        } catch (e) {
          if (!e.needLogin) throw e;
          if (adapter.loginHttp) {
            log('HTTP-сессия истекла — логинюсь по HTTP и повторяю удаление…');
            const fresh = await adapter.loginHttp({ origin, ...credentials, cookies: cks, proxy, log }).catch(() => null);
            if (fresh?.ok) {
              if (onCookies) onCookies(fresh.cookies);
              return await deleteOneHttp({ adapter, origin, cookies: fresh.cookies, proxy, siteArticleId, onStats, log });
            }
          }
          throw e; // не залогинились по HTTP — падаем на Dolphin
        }
      }
    } catch (e) {
      log(`HTTP-удаление: ${e.message} — через профиль Dolphin.`);
    }
  }
  let browser;
  let page;
  let ephemeralProfileId = null;
  try {
    const launched = await launchForAccount({ profileName, proxy, action: 'удаление', log });
    browser = launched.browser;
    page = launched.page;
    ephemeralProfileId = launched.ephemeralProfileId;

    await ensureLoggedIn({ page, adapter, origin, credentials, cookies, onCookies, log });
    log('Авторизация выполнена.');
    return await deleteOneInSession({ page, adapter, origin, credentials, onCookies, siteArticleId, onStats, log });
  } catch (e) {
    if (page) {
      const shot = `site-delete-error-${Date.now()}.png`;
      await screenshotTo(page, shot);
      e.screenshot = shot;
    }
    throw e;
  } finally {
    await cleanupProfile(browser, ephemeralProfileId);
  }
}

// Удалить МНОГО статей ОДНОГО аккаунта в ОДНОЙ сессии (один профиль на пачку, а не на статью).
// items: [{ siteArticleId, onStats? , ...ref }]. Между удалениями — пауза delayMs (анти-паттерн на сайте).
// onResult(item, { ok, message }) — для записи результата в БД вызывающим. Сессия/профиль закрываются в конце.
// DB-агностично: всё через колбэки. Сбой одной статьи не прерывает остальные.
export async function deleteManyInSession({ adapter, profileName, origin, credentials, proxy, cookies, onCookies, items, delayMs = 10000, shouldStop = () => false, onResult, log = console.log }) {
  return runInAccountSession({ adapter, profileName, origin, credentials, proxy, cookies, onCookies, log }, async (page) => {
    for (let i = 0; i < items.length; i++) {
      if (shouldStop()) { log('Остановка запрошена — прерываю удаление в этом аккаунте.'); break; }
      const it = items[i];
      let res;
      try {
        res = await deleteOneInSession({ page, adapter, origin, credentials, onCookies, siteArticleId: it.siteArticleId, onStats: it.onStats, log });
      } catch (e) {
        res = { ok: false, message: e.message };
      }
      if (onResult) onResult(it, res);
      if (i < items.length - 1) await sleep(delayMs); // пауза между удалениями внутри аккаунта
    }
  });
}
