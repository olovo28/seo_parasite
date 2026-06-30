// Адаптер сайта myheimat.de: логин, публикация, удаление, регистрация, формат тела.
// Та же CMS-платформа (PEIQ), что meinbezirk, но отдельный самостоятельный модуль. Спецификой myheimat
// форма регистрации — САМАЯ ПРОСТАЯ в семействе: БЕЗ типа пользователя, БЕЗ пола, БЕЗ выбора города,
// один обязательный чекбокс согласия (tos). Логин и форма публикации — идентичны meinbezirk (проверено
// структурным аудитом публичных страниц /login и /register). Свой домен писем подтверждения.
// Общий запуск профиля — в lib/browser.js, оркестрация — в lib/publisher.js / lib/registrar.js.

import { htmlToBBCode } from '../bbcode.js';
import { bbcodeToHtml } from '../linkblock.js';
import { screenshotTo } from '../browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Подавить consent-оверлеи (OneTrust/CleverPush + Sourcepoint «Ihre Privatsphäre…»): всплывают с
// задержкой, перекрывают форму и сбивают капчу. Клик «accept» + скрытие плашек стилем. Идемпотентно.
async function suppressOverlays(page) {
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

  await clickAcceptIn(page);
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
  await page.evaluate(() => {
    const sw = document.querySelector('.wysibb-toolbar-btn.mswitch');
    const lbl = sw && sw.querySelector('.modesw');
    if (sw && lbl && /bbcode/i.test(lbl.textContent)) sw.click();
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
    if (!page.url().includes('/login')) return;

    await page.waitForSelector('#username', { visible: true, timeout: 20000 });
    await suppressOverlays(page);
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

    await page.evaluate(() => {
      const r = document.querySelector('#remember_me');
      if (r && !r.checked) r.click();
    });
    await suppressOverlays(page);
    await Promise.all([
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

  throw new Error(`Логин не удался${lastFlash ? ': ' + lastFlash : ''}`);
}

// Проверить, активна ли сессия (после инжекта сохранённых cookies): открыть страницу только-для-залогиненных.
async function isLoggedIn(page, { origin } = {}) {
  try {
    await page.goto(`${origin}/a/article/new`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return !page.url().includes('/login');
  } catch {
    return false;
  }
}

const CATEGORY = '18'; // NOTE: id категории публикации может отличаться на myheimat — уточнить при первой публикации (форма за логином).

// Опубликовать статью. page — уже залогинен. article: { title, body_html, tags: [..] }.
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
    page.click('#article_publish'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
  ]);

  const stillOnNew = page.url().includes('/a/article/new');
  const flash = await page
    .evaluate(() => {
      const el = document.querySelector('.flashmessage-box, .callout.alert, .form-error:not(.hide)');
      return el ? el.innerText.trim().slice(0, 200) : null;
    })
    .catch(() => null);

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

// Удалить статью с сайта. POST /a/article/delete/{id} (XHR с куками сессии).
async function deleteArticle(page, { origin, siteArticleId, log = console.log } = {}) {
  await page.goto(`${origin}/a/article/new`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  if (page.url().includes('/login')) {
    const e = new Error('Сессия отвалилась — удаление невозможно (ушло на /login).');
    e.needLogin = true;
    throw e;
  }

  log(`Отправляю запрос на удаление (article ${siteArticleId})…`);
  const res = await page.evaluate(async (id) => {
    const r = await fetch('/a/article/delete/' + id, {
      method: 'POST',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
      redirect: 'manual',
    });
    return { status: r.status, type: r.type };
  }, siteArticleId);

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
const REGISTER_PATH = process.env.MYHEIMAT_REGISTER_PATH || '/register';

// Капча картинки иногда распознаётся неверно — оборачиваем в ретрай со свежей картинкой.
async function register(page, opts = {}) {
  const { solver, log = console.log } = opts;
  if (!solver?.solveImage) throw new Error('Для регистрации нужен сервис решения капч (настрой captcha в настройках).');
  const MAX = Number(process.env.REGISTER_CAPTCHA_TRIES || 3);
  let last = { ok: false, message: 'не выполнено' };
  for (let i = 1; i <= MAX; i++) {
    last = await attemptRegister(page, opts, i);
    if (last.ok || last.alreadyRegistered) return last;
    if (!last.captchaError) return last;
    log(`Капча не принята (попытка ${i}/${MAX})${i < MAX ? ' — пробую заново с новой капчей…' : ' — лимит попыток исчерпан.'}`);
  }
  return last;
}

// Одна попытка регистрации. Форма myheimat МИНИМАЛЬНА: имя/имя/фамилия, email, пароль×2, один чекбокс
// согласия (tos), капча. НЕТ выбора типа пользователя, пола и города (в отличие от meinbezirk) —
// поэтому соответствующие шаги опущены.
async function attemptRegister(page, { origin, identity, email, password, solver, log = console.log } = {}, attempt = 1) {
  await page.goto(`${origin}${REGISTER_PATH}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  await page.waitForSelector('#register_email', { timeout: 20000 });
  await dismissBanners(page);
  log('Открыта форма регистрации, заполняю…');

  await page.type('#register_name', identity.name, { delay: 15 });
  await page.type('#register_first_name', identity.first_name, { delay: 15 });
  await page.type('#register_last_name', identity.last_name, { delay: 15 });
  await page.type('#register_email', email, { delay: 15 });
  await page.type('#register_plain_password_first', password, { delay: 15 });
  await page.type('#register_plain_password_second', password, { delay: 15 });

  // Согласия: отмечаем ВСЕ обязательные чекбоксы согласия (на этой форме — только tos).
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('input[type="checkbox"][id^="register_confirm_legal_document"]')) {
      if (!c.checked) c.click();
    }
  });

  // Sourcepoint-модал перекрывает форму/сбивает капчу — гасим ДО чтения капчи.
  await sleep(2500);
  await dismissBanners(page);

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
  await dismissBanners(page);
  log('Отправляю форму регистрации…');
  await Promise.all([
    page.evaluate(() => document.querySelector('#register_submit')?.click()),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
  ]);
  await sleep(1000);

  const stillOnForm = !!(await page.$('#register_email'));
  const flash = await page
    .evaluate(() => {
      const seen = new Set();
      const parts = [];
      const sels = ['.alert-box', '.callout.alert', '.flashmessage-box', '.form-error', '.help-text.error', 'label.error', '[class*="error"]'];
      for (const sel of sels) {
        for (const el of document.querySelectorAll(sel)) {
          if (el.classList.contains('hide') || el.offsetParent === null) continue;
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
    if (/bereits verwendet|already (in use|registered|exists)|existiert bereits|bereits registriert/i.test(flash || '')) {
      return { ok: false, alreadyRegistered: true, message: `Почта уже зарегистрирована на сайте: ${flash}` };
    }
    const captchaErr = /captcha|zeichen|stimmt nicht überein|überein/i.test(flash || '');
    const shot = `register-fail-${Date.now()}.png`;
    if (!captchaErr) await screenshotTo(page, shot);
    return { ok: false, message: `Регистрация не отправлена${flash ? ': ' + flash : ' (остались на форме)'}.`, captchaError: captchaErr, screenshot: captchaErr ? undefined : shot };
  }
  return { ok: true, message: `Форма регистрации отправлена${flash ? ': ' + flash : ''}. Ждём письмо подтверждения.` };
}

// Письмо подтверждения регистрации. myheimat — немецкая площадка PEIQ (не сеть Regionalmedien Austria),
// поэтому матчим по бренду myheimat. NOTE: точный домен отправителя уточнить при первой регистрации.
const confirmationEmail = { fromMatch: /myheimat/i, subjectMatch: /(Best[äa]tig|Registrier|Aktivier|willkommen|E-?Mail)/i };

function extractConfirmUrl(links) {
  const arr = Array.isArray(links) ? links : [];
  return arr.find((u) => /myheimat/i.test(u) && /(confirm|activat|aktivier|bestaetig|best%C3%A4tig|registrier|token=|code=|hash=)/i.test(u)) || null;
}

async function confirmRegistration(page, { url, log = console.log } = {}) {
  if (!url) throw new Error('Нет ссылки подтверждения.');
  log('Перехожу по ссылке подтверждения из письма…');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await dismissBanners(page);
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 600)).catch(() => '');
  return { ok: true, message: `Ссылка подтверждена. ${text.replace(/\s+/g, ' ').slice(0, 200)}` };
}

const approvalEmail = { fromMatch: /myheimat/i, subjectMatch: /(freigeschalt|freigegeb|aktiviert|genehmigt|willkommen|best[äa]tigt|Community)/i };
function isApproved({ subject = '', text = '' } = {}) {
  return /(freigeschalt|freigegeb|aktiviert|genehmigt|kannst du|jetzt anmelden|willkommen)/i.test(`${subject}\n${text}`);
}

function parseSiteArticleId(url) {
  const m = String(url || '').match(/_a(\d+)/);
  return m ? m[1] : null;
}

function formatBody(html) {
  return htmlToBBCode(html || '');
}

function previewHtml(html) {
  return bbcodeToHtml(htmlToBBCode(html || ''));
}

export default {
  name: 'myheimat',
  label: 'myheimat.de',
  login,
  isLoggedIn,
  publish,
  deleteArticle,
  parseSiteArticleId,
  formatBody,
  previewHtml,
  register,
  confirmationEmail,
  extractConfirmUrl,
  confirmRegistration,
  approvalEmail,
  isApproved,
};
