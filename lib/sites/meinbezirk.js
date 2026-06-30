// Адаптер сайта meinbezirk.at: логин, публикация, удаление, формат тела (BBCode/WysiBB).
// Вся сайт-специфика (селекторы, баннеры, эндпоинты) — здесь. Общий запуск профиля — в lib/browser.js,
// оркестрация — в lib/publisher.js. Подключается через реестр lib/sites/index.js.

import { htmlToBBCode } from '../bbcode.js';
import { bbcodeToHtml } from '../linkblock.js';
import { screenshotTo } from '../browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Подавить оверлеи (cookie-баннер OneTrust + push-модал CleverPush): по диагностике они появляются
// с задержкой ~6–11с и перекрывают форму. Стратегия: best-effort клик «deny/accept» + СКРЫТИЕ плашек
// и backdrop стилем (мгновенно, без ожиданий) — чтобы не блокировали взаимодействие. Идемпотентно.
// Принять/скрыть consent-баннеры. Кроме OneTrust/CleverPush есть ОТДЕЛЬНЫЙ модал согласия
// «Ihre Privatsphäre ist uns wichtig» (Sourcepoint, кнопка «AKZEPTIEREN») — всплывает с задержкой,
// перекрывает форму и сбивает капчу. Его жмём по тексту кнопки, в т.ч. внутри iframe.
async function suppressOverlays(page) {
  // Клик по кнопке согласия по тексту (без «настроек/отклонить»). Используется в осн. документе и во фреймах.
  const clickAcceptIn = (frame) =>
    frame
      .evaluate(() => {
        const els = [...document.querySelectorAll('button, a, [role="button"], [title]')];
        const acc = els.find((b) => {
          const t = (b.textContent || b.title || '').trim().toLowerCase();
          if (!t || t.length > 30) return false;
          if (/einstellung|ablehn|verwalt|mehr|details/.test(t)) return false;
          return /^akzeptieren$|alle akzeptieren|alle annehmen|zustimmen|accept all|einverstanden|^akzeptieren/.test(t);
        });
        if (acc) {
          acc.click();
          return true;
        }
        return false;
      })
      .catch(() => false);

  await page
    .evaluate(() => {
      const clk = (s) => {
        const e = document.querySelector(s);
        if (e) e.click();
      };
      clk('#onetrust-accept-btn-handler');
      clk('#onetrust-reject-all-handler');
      clk('.cleverpush-confirm-btn-deny');
      let st = document.getElementById('bot-suppress');
      if (!st) {
        st = document.createElement('style');
        st.id = 'bot-suppress';
        (document.head || document.documentElement).appendChild(st);
      }
      st.textContent =
        '#onetrust-banner-sdk,#onetrust-consent-sdk,.onetrust-pc-dark-filter,.cleverpush-confirm,.cleverpush-backdrop,[id^="sp_message_container"],.sp_veil,.message-overlay{display:none!important;visibility:hidden!important}';
      for (const el of [document.documentElement, document.body]) {
        if (el) el.classList.remove('has-cleverpush-backdrop', 'has-cleverpush-backdrop-blur');
      }
    })
    .catch(() => {});

  await clickAcceptIn(page); // consent в основном документе
  for (const f of page.frames()) {
    const u = f.url() || '';
    if (/sourcepoint|sp-prod|consent|privacy|cmp|sp_message|myprivacy|message/i.test(u)) await clickAcceptIn(f);
  }
}

async function dismissBanners(page) {
  await suppressOverlays(page);
}

// Заполнить тело: переключить WysiBB в режим BBCode и вставить исходник в textarea.
async function setBody(page, bbcode) {
  await page.waitForSelector('#article_content_text', { timeout: 15000 });
  // Переключаем WysiBB в режим BBCode (как вручную кнопкой [bbcode]), чтобы WYSIWYG не
  // пересобирал контент, и кладём исходник прямо в textarea #article_content_text.
  await page.evaluate(() => {
    const sw = document.querySelector('.wysibb-toolbar-btn.mswitch');
    const lbl = sw && sw.querySelector('.modesw');
    if (sw && lbl && /bbcode/i.test(lbl.textContent)) sw.click(); // сейчас WYSIWYG → в BBCode
  });
  await sleep(300);
  await page.evaluate((bb) => {
    const ta = document.querySelector('#article_content_text');
    ta.value = bb;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }, bbcode);
}

// Добавить теги в selectize (печатаем тег + Enter на каждый).
async function setTags(page, tags) {
  const sel = '#article_tag_name_list-selectized';
  await page.waitForSelector(sel, { timeout: 10000 });
  for (const t of tags) {
    await page.click(sel);
    await page.type(sel, t, { delay: 30 });
    await page.keyboard.press('Enter');
    await sleep(150);
  }
}

// Надёжный логин: N попыток, очистка/проверка полей, чтение flash-сообщения сайта.
async function login(page, { origin, username, password, maxAttempts = 3, log = console.log } = {}) {
  if (!username || !password) throw new Error('Не заданы креды сайта (username/password аккаунта).');
  const loginUrl = `${origin}/login`;
  log(`Вход на сайт (${username})…`);
  let lastFlash = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!page.url().includes('/login')) return; // уже залогинены — сайт увёл с /login

    await page.waitForSelector('#username', { visible: true, timeout: 20000 });
    await suppressOverlays(page); // скрыть cookie/push-плашки, чтобы не перекрывали форму
    await page.evaluate(() => {
      const u = document.querySelector('#username');
      const p = document.querySelector('#password');
      if (u) u.value = '';
      if (p) p.value = '';
    });
    await page.type('#username', username, { delay: 25 });
    await page.type('#password', password, { delay: 25 });

    const vals = await page.evaluate(() => ({
      u: document.querySelector('#username')?.value ?? '',
      p: document.querySelector('#password')?.value ?? '',
    }));
    if (vals.u !== username || vals.p !== password) {
      lastFlash = 'поля заполнились некорректно';
      await sleep(400);
      continue;
    }

    // «angemeldet bleiben» — даёт долгоживущий remember-me cookie (дольше переживает перезапуски профиля)
    await page.evaluate(() => {
      const r = document.querySelector('#remember_me');
      if (r && !r.checked) r.click();
    });
    await suppressOverlays(page); // на случай поздно всплывшего CleverPush-модала
    await Promise.all([
      // прямой клик по элементу — мимо backdrop/оверлея (page.click мог бы попасть в плашку)
      page.evaluate(() => document.querySelector('#_submit')?.click()),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    ]);
    if (!page.url().includes('/login')) return;

    lastFlash = await page
      .evaluate(() => {
        const el = document.querySelector('.flashmessage-box, .callout');
        return el ? el.innerText.trim().slice(0, 200) : null;
      })
      .catch(() => null);
  }

  const e = new Error(`Логин не удался${lastFlash ? ': ' + lastFlash : ''}`);
  // Бан аккаунта сайтом («Ihr Account wurde gesperrt») — не транзиентная ошибка: помечаем, чтобы
  // оркестратор отключил аккаунт и больше его не дёргал (публикация/удаление/статистика).
  if (/gesperrt|account.*(blocked|disabled|suspend)/i.test(lastFlash || '')) e.banned = true;
  throw e;
}

// Проверить, активна ли сессия (после инжекта сохранённых cookies): открыть страницу только-для-залогиненных
// (форма новой статьи) — незалогиненного meinbezirk перебрасывает на /login.
async function isLoggedIn(page, { origin } = {}) {
  try {
    await page.goto(`${origin}/a/article/new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return !page.url().includes('/login');
  } catch {
    return false;
  }
}

const CATEGORY = '18'; // Regionauten-Community

// Опубликовать статью. page — уже залогинен. article: { title, body_html, tags: [..] }.
// Возвращает { ok, message, url?, screenshot? }.
async function publish(page, { origin, article, log = console.log } = {}) {
  await page.goto(`${origin}/a/article/new`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  if (page.url().includes('/login')) throw new Error('После логина форма всё равно ушла на /login.');
  log('Открыта форма публикации.');

  await page.waitForSelector('#article_title', { timeout: 20000 });
  await page.type('#article_title', article.title, { delay: 20 });
  await page.select('#article_category', CATEGORY).catch(() => {});
  log('Заполняю тело (BBCode) и теги…');
  await setBody(page, htmlToBBCode(article.body_html));
  await setTags(page, article.tags ?? []);

  await sleep(500);
  log('Отправляю форму (Veröffentlichen)…');
  await Promise.all([
    page.click('#article_publish'), // «Veröffentlichen & anzeigen» — реальная публикация на сайте
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
  ]);

  const stillOnNew = page.url().includes('/a/article/new');
  const flash = await page
    .evaluate(() => {
      const el = document.querySelector('.flashmessage-box, .callout.alert, .form-error:not(.hide)');
      return el ? el.innerText.trim().slice(0, 200) : null;
    })
    .catch(() => null);

  // Вылет из аккаунта во время отправки: сайт увёл на /login — это НЕ успех (иначе вернули бы ложный ok).
  if (page.url().includes('/login')) {
    const e = new Error('Во время публикации выбросило на /login — сессия истекла.');
    e.needLogin = true;
    throw e;
  }
  if (stillOnNew) {
    const shot = `publish-fail-${Date.now()}.png`;
    await screenshotTo(page, shot);
    return { ok: false, message: `Остались на форме создания. ${flash ? 'Сообщение: ' + flash : 'Возможна ошибка валидации.'}`, screenshot: shot };
  }
  return { ok: true, message: `Опубликовано на сайте. URL: ${page.url()}${flash ? ' | ' + flash : ''}`, url: page.url() };
}

// Удалить статью с сайта. page — уже залогинен. POST /a/article/delete/{id} (XHR с куками сессии).
async function deleteArticle(page, { origin, siteArticleId, log = console.log } = {}) {
  // Открываем ЗАЩИЩЁННУЮ страницу (форма новой статьи): незалогиненного уведёт на /login — так детектим вылет
  // (главная страница доступна и без логина, поэтому проверять на ней бесполезно).
  await page.goto(`${origin}/a/article/new`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  if (page.url().includes('/login')) {
    const e = new Error('Сессия отвалилась — удаление невозможно (ушло на /login).');
    e.needLogin = true;
    throw e;
  }

  log(`Отправляю запрос на удаление (article ${siteArticleId})…`);
  const res = await page.evaluate(async (id) => {
    // redirect:'manual' — если сервер редиректит на /login (нет сессии), это опознаётся (type='opaqueredirect'),
    // а не «проглатывается» как ложный 200 после перехода на страницу логина.
    const r = await fetch('/a/article/delete/' + id, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
      redirect: 'manual',
    });
    return { status: r.status, type: r.type };
  }, siteArticleId);

  // Вылет из аккаунта: редирект на логин или 401/403 — НЕ считаем удалённым.
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    const e = new Error(`Удаление отклонено — нет сессии (HTTP ${res.status}/${res.type}).`);
    e.needLogin = true;
    throw e;
  }
  if (res.status === 204 || res.status === 200) {
    return { ok: true, message: `Удалено с сайта (HTTP ${res.status}, article ${siteArticleId}).` };
  }
  const shot = `site-delete-fail-${Date.now()}.png`;
  await screenshotTo(page, shot);
  return { ok: false, message: `Сайт ответил HTTP ${res.status} на удаление ${siteArticleId} (нет прав / уже удалена?).`, screenshot: shot };
}

// ===== Регистрация аккаунта =====
// Путь страницы регистрации. ВНИМАНИЕ: в reference форма POST'ит на свой же URL без явного action —
// точный путь подтвердить диагностикой/живым прогоном (env REGISTER_PATH переопределяет).
const REGISTER_PATH = process.env.MEINBEZIRK_REGISTER_PATH || '/register';

// Решатель капч ошибается на части картинок («Code stimmt nicht überein») — поэтому регистрацию
// оборачиваем в ретрай: при неверной капче берём свежую картинку (новая форма) и пробуем снова.
async function register(page, opts = {}) {
  const { solver, log = console.log } = opts;
  if (!solver?.solveImage) throw new Error('Для регистрации нужен сервис решения капч (настрой captcha в настройках).');
  const MAX = Number(process.env.REGISTER_CAPTCHA_TRIES || 3);
  let last = { ok: false, message: 'не выполнено' };
  for (let i = 1; i <= MAX; i++) {
    last = await attemptRegister(page, opts, i);
    if (last.ok || last.alreadyRegistered) return last;
    if (!last.captchaError) return last; // не капча — повторять смысла нет
    log(`Капча не принята (попытка ${i}/${MAX})${i < MAX ? ' — пробую заново с новой капчей…' : ' — лимит попыток исчерпан.'}`);
  }
  return last;
}

// Одна попытка регистрации: заполнить форму, решить капчу, отправить. identity — из lib/identity.js;
// email — почта; password — пароль БУДУЩЕГО аккаунта на сайте (НЕ пароль почты).
async function attemptRegister(page, { origin, identity, email, password, solver, log = console.log } = {}, attempt = 1) {
  await page.goto(`${origin}${REGISTER_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  await page.waitForSelector('#register_email', { timeout: 20000 });
  await dismissBanners(page);
  log('Открыта форма регистрации, заполняю…');

  // Тип пользователя — физлицо.
  await page.evaluate(() => document.querySelector('#register_user_type_0')?.click());
  await page.type('#register_name', identity.name, { delay: 15 });
  await page.type('#register_first_name', identity.first_name, { delay: 15 });
  await page.type('#register_last_name', identity.last_name, { delay: 15 });
  // Пол — radio по value.
  await page.evaluate((g) => {
    const el = document.querySelector(`input[name="register[meta_gender]"][value="${g}"]`);
    if (el) el.click();
  }, identity.gender);
  await page.type('#register_email', email, { delay: 15 });
  await page.type('#register_plain_password_first', password, { delay: 15 });
  await page.type('#register_plain_password_second', password, { delay: 15 });
  await page.select('#register_location', String(identity.location)).catch(() => {});
  // Согласие с AGB.
  await page.evaluate(() => {
    const c = document.querySelector('#register_confirm_legal_document_tos');
    if (c && !c.checked) c.click();
  });

  // Consent-модал «Ihre Privatsphäre…» (Sourcepoint) всплывает с задержкой и перекрывает форму/сбивает капчу.
  // Даём ему появиться и гасим ДО чтения капчи — иначе капча будет отклонена и форма останется на месте.
  await sleep(2500);
  await dismissBanners(page);

  // Капча: берём base64 картинки → сервис → поле (читаем ПОСЛЕ гашения модала, чтобы не протухла).
  log('Решаю капчу…');
  const img = await page.evaluate(() => {
    const el = document.querySelector('img.captcha_image, #register_captcha ~ img, img[title="captcha"]');
    return el ? el.src : null;
  });
  if (!img) throw new Error('Не найдена картинка капчи на форме регистрации.');
  const answer = await solver.solveImage(img);
  if (!answer) throw new Error('Сервис не вернул решение капчи.');
  await page.type('#register_captcha', String(answer).trim(), { delay: 25 });

  await sleep(400);
  await dismissBanners(page); // на случай повторного всплытия модала прямо перед сабмитом
  log('Отправляю форму регистрации…');
  await Promise.all([
    page.evaluate(() => document.querySelector('#register_submit')?.click()),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
  ]);
  await sleep(1000);

  // Успех: форму увело со страницы регистрации / появилось сообщение об отправке письма.
  const stillOnForm = !!(await page.$('#register_email'));
  // Собираем КОНКРЕТНЫЙ текст ошибки: глобальная плашка + ошибки отдельных полей (видимые).
  const flash = await page
    .evaluate(() => {
      const seen = new Set();
      const parts = [];
      const sels = ['.alert-box', '.callout.alert', '.flashmessage-box', '.form-error', '.help-text.error', 'label.error', '[class*="error"]'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.classList.contains('hide') || el.offsetParent === null) continue; // только видимые
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t && t.length < 200 && !seen.has(t)) {
            seen.add(t);
            parts.push(t);
          }
        }
      }
      return parts.join(' | ').slice(0, 400) || null;
    })
    .catch(() => null);

  if (stillOnForm) {
    // Почта уже зарегистрирована (аккаунт создан ранее) — это НЕ обычная ошибка: форму слать не надо,
    // нужно лишь довести подтверждение из письма. Оркестратор обработает alreadyRegistered отдельно.
    if (/bereits verwendet|already (in use|registered|exists)|existiert bereits|bereits registriert/i.test(flash || '')) {
      return { ok: false, alreadyRegistered: true, message: `Почта уже зарегистрирована на сайте: ${flash}` };
    }
    const captchaErr = /captcha|zeichen|stimmt nicht überein|überein/i.test(flash || '');
    const shot = `register-fail-${Date.now()}.png`;
    if (!captchaErr) await screenshotTo(page, shot); // на капчу скрин не плодим (будет ретрай)
    return { ok: false, message: `Регистрация не отправлена${flash ? ': ' + flash : ' (остались на форме)'}.`, captchaError: captchaErr, screenshot: captchaErr ? undefined : shot };
  }
  return { ok: true, message: `Форма регистрации отправлена${flash ? ': ' + flash : ''}. Ждём письмо подтверждения.` };
}

// Описание письма подтверждения регистрации (для поиска в почте).
const confirmationEmail = { fromMatch: /meinbezirk|regionalmedien/i, subjectMatch: /(Best[äa]tig|Registrier|Aktivier|willkommen|E-?Mail)/i };

// Выбрать из ссылок письма ссылку активации.
function extractConfirmUrl(links) {
  const arr = Array.isArray(links) ? links : [];
  return (
    arr.find((u) => /meinbezirk|regionalmedien/i.test(u) && /(confirm|activat|aktivier|bestaetig|best%C3%A4tig|registrier|token=|code=|hash=)/i.test(u)) || null
  );
}

// Перейти по ссылке подтверждения. Возвращает { ok, message }.
async function confirmRegistration(page, { url, log = console.log } = {}) {
  if (!url) throw new Error('Нет ссылки подтверждения.');
  log('Перехожу по ссылке подтверждения из письма…');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 600)).catch(() => '');
  return { ok: true, message: `Ссылка подтверждена. ${text.replace(/\s+/g, ' ').slice(0, 200)}` };
}

// Описание письма об одобрении админом + детект «одобрено».
const approvalEmail = { fromMatch: /meinbezirk|regionalmedien/i, subjectMatch: /(freigeschalt|freigegeb|aktiviert|genehmigt|willkommen|best[äa]tigt|Community)/i };
function isApproved({ subject = '', text = '' } = {}) {
  return /(freigeschalt|freigegeb|aktiviert|genehmigt|kannst du|jetzt anmelden|willkommen)/i.test(`${subject}\n${text}`);
}

// Числовой id статьи на сайте из URL вида ..._a8702469.
function parseSiteArticleId(url) {
  const m = String(url || '').match(/_a(\d+)/);
  return m ? m[1] : null;
}

// ===== Статистика (Content-Cockpit «Analyse und Benchmark») =====
// Страница /cockpit/contentcockpit/article/{id} — СЕРВЕРНЫЙ рендер: все данные зашиты в инлайн-скрипт
// `const cockpitData = {...}` (SVG-графики рисуются из него уже на клиенте). Поэтому достаточно
// прочитать HTML по сессии владельца и распарсить этот объект — без SVG/headless-рендера.
// Каналы (ключи periodStats) сводим к нашим: seo=поиск, social, curated, newsletter, qr, rest.
const COCKPIT_CHANNEL_MAP = { seo: 'seo', social: 'social', intern_kuratiert: 'curated', newsletter: 'newsletter', qr: 'qr', intern_rest: 'rest', extern_rest: 'rest', rest: 'rest' };

// Бенчмарк-перцентиль: percentilesbucket.values = { "60.01": порог_просмотров, ... }.
// Наш перцентиль = наибольший порог-перцентиль, чьё значение ≤ нашим просмотрам.
function cockpitPercentile(bucket, totalViews) {
  const values = bucket && bucket.values;
  if (!values || typeof values !== 'object') return null;
  let best = 0;
  for (const [k, v] of Object.entries(values)) {
    if ((Number(v) || 0) <= totalViews) {
      const p = Math.floor(parseFloat(k));
      if (p > best) best = p;
    }
  }
  return best;
}

// Выдрать и нормализовать cockpitData из HTML страницы кокпита. Бросает понятную ошибку, если не найден
// (нет доступа / не та страница / сессия истекла → .needLogin для авто-перелогина выше).
export function parseCockpitStats(html) {
  const m = String(html || '').match(/const\s+cockpitData\s*=\s*(\{[\s\S]*?\})\s*;\s*(?:const\s+cockpitHistogramStartTs|<\/script>)/);
  if (!m) {
    const e = new Error('На странице кокпита не найден cockpitData (нет доступа / не та страница / сессия истекла).');
    if (/\/login|id="username"|name="_username"/.test(html || '')) e.needLogin = true;
    throw e;
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`cockpitData не распарсился: ${e.message}`);
  }
  const total = Number(data?.totalcount?.totalcount ?? data?.histogram?.total ?? 0) || 0;
  const channels = { seo: 0, social: 0, curated: 0, newsletter: 0, qr: 0, rest: 0 };
  for (const it of data?.histogram?.periodStats || []) {
    const key = COCKPIT_CHANNEL_MAP[it.key] || 'rest';
    channels[key] += Number(it.count) || 0;
  }
  const avg = data?.totalcount?.avgTimeOnPage;
  return {
    totalViews: total,
    avgTimeOnPage: avg != null ? Number(avg) : null,
    percentile: cockpitPercentile(data?.percentilesbucket, total),
    interval: data?.histogram?.interval || null,
    channels,
    raw: data,
  };
}

// Принять согласия, закрывающие аналитику кокпита: (1) Sourcepoint-модал приватности (AKZEPTIEREN,
// в т.ч. во фрейме) — уже умеет suppressOverlays; (2) ОТДЕЛЬНОЕ согласие на загрузку Google Charts
// («Die nachfolgende Analyse-Sicht enthält … Google Charts … immer zu laden» → кнопка «laden»).
// До согласий сервер НЕ кладёт cockpitData в страницу. Клик ищем по тексту; best-effort (.catch).
async function acceptCockpitConsent(page) {
  await dismissBanners(page).catch(() => {}); // Sourcepoint/OneTrust «AKZEPTIEREN»
  return page
    .evaluate(() => {
      const els = [...document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')];
      const m = els.find((b) => {
        const t = (b.textContent || b.value || '').trim().toLowerCase();
        if (!t || t.length > 60) return false;
        return /google charts|charts.*lad|immer.*lad|analyse.*lad|^laden$|laden$/.test(t);
      });
      if (m) {
        m.click();
        return (m.textContent || m.value || '').trim().slice(0, 60);
      }
      return null;
    })
    .catch(() => null);
}

// Прочитать статистику статьи (page уже залогинен сессией владельца). Возвращает нормализованный объект
// (см. parseCockpitStats). Открываем кокпит НАВИГАЦИЕЙ; аналитика закрыта согласиями (Sourcepoint +
// загрузка Google Charts) — проходим их, затем ждём появления cockpitData в DOM (waitForFunction
// переживает навигацию от клика согласия).
async function fetchArticleStats(page, { origin, siteArticleId, log = console.log } = {}) {
  if (!siteArticleId) throw new Error('Нет siteArticleId — неоткуда брать статистику.');
  const url = `${origin}/cockpit/contentcockpit/article/${siteArticleId}`;
  log(`Открываю статистику кокпита (article ${siteArticleId})…`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const hasData = () =>
    page
      .waitForFunction(() => document.documentElement.outerHTML.includes('cockpitData'), { timeout: 12000 })
      .then(() => true)
      .catch(() => false);

  let ready = await hasData();
  for (let attempt = 1; attempt <= 3 && !ready; attempt++) {
    if (page.url().includes('/login')) {
      const e = new Error('Кокпит увёл на /login — сессия истекла.');
      e.needLogin = true;
      throw e;
    }
    const clicked = await acceptCockpitConsent(page);
    if (clicked) log(`Согласие кокпита принято («${clicked}»)…`);
    ready = await hasData();
  }

  const html = await page.content();
  try {
    return parseCockpitStats(html);
  } catch (e) {
    // Диагностика на случай «нет cockpitData»: заголовок, кандидаты-кнопки и скрин.
    if (!e.needLogin) {
      const title = await page.title().catch(() => '');
      const buttons = await page
        .evaluate(() =>
          [...document.querySelectorAll('button, a, [role="button"]')]
            .map((b) => (b.textContent || b.value || '').replace(/\s+/g, ' ').trim())
            .filter((t) => t && t.length < 50)
            .slice(0, 25),
        )
        .catch(() => []);
      const shot = `cockpit-nostats-${Date.now()}.png`;
      await screenshotTo(page, shot).catch(() => {});
      e.message = `${e.message} [страница: «${(title || '').slice(0, 60)}», url: ${page.url()}, кнопки: ${JSON.stringify(buttons)}, скрин: ${shot}]`;
    }
    throw e;
  }
}

// Тело статьи в формате сайта (BBCode) — для показа исходника в админке.
function formatBody(html) {
  return htmlToBBCode(html || '');
}

// HTML-превью «как выглядит» (BBCode → HTML) для админки.
function previewHtml(html) {
  return bbcodeToHtml(htmlToBBCode(html || ''));
}

export default {
  name: 'meinbezirk',
  label: 'meinbezirk.at',
  login,
  isLoggedIn,
  publish,
  deleteArticle,
  parseSiteArticleId,
  fetchArticleStats,
  formatBody,
  previewHtml,
  // регистрация аккаунтов (capability — опциональна для адаптеров)
  register,
  confirmationEmail,
  extractConfirmUrl,
  confirmRegistration,
  approvalEmail,
  isApproved,
};
