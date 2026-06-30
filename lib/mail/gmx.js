// Почтовый драйвер gmx.at (через Dolphin+puppeteer). Сайт-специфика почты — здесь.
// Вход двухшаговый (email → Weiter → пароль), иногда reCAPTCHA. Ящик рендерится в iframe
// thirdPartyFrame_mail (webmailer.gmx.net) — список писем/тело живут ВНУТРИ фрейма.
//
// ВНИМАНИЕ: точные селекторы списка писем/тела и стабильный входной URL подтверждаются
// диагностикой (scripts/diagnose-gmx.js) на живой почте — сохранённые reference/gmx.at_*.page
// были лишь оболочкой с пустым iframe. Селекторы ниже заданы наборами кандидатов и легко правятся.

import { screenshotTo } from '../browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Стабильная точка входа: переход сюда без сессии форсирует логин-флоу auth.gmx.net.
const ENTRY_URL = process.env.GMX_ENTRY_URL || 'https://www.gmx.net/';
const MAILBOX_URL = process.env.GMX_MAILBOX_URL || 'https://bap.navigator.gmx.net/mail';
// siteKey reCAPTCHA на странице входа (виден в коде страницы входа) — для сервиса-решателя.
const RECAPTCHA_SITEKEY = process.env.GMX_RECAPTCHA_SITEKEY || '6LeKN00rAAAAAI_EfKCvVDrPPyXihxkRmB6dIhKZ';

// Кандидаты селекторов (первый найденный — используется). Правятся по диагностике.
const SEL = {
  email: ['#email', 'input[name="username"]', 'input[type="email"]', '#freemailLoginUsername'],
  next: ['[data-testid="button-next"]', 'button[type="submit"]'],
  password: ['#password', 'input[name="password"]', 'input[type="password"]', '#freemailLoginPassword'],
  submit: ['[data-testid="button-login"]', '[data-testid="button-next"]', 'button[type="submit"]'],
};

// Принять баннер согласия GMX (permission-portal «ppp» в iframe core.html) — best-effort.
// Кнопка «Akzeptieren und weiter» лежит ВНУТРИ кросс-доменного iframe (dl.gmx.net/permission/...),
// поэтому опрашиваем ВСЕ фреймы. Совпадение по подстроке; ЯВНО исключаем платную подписку («Abo»).
async function acceptConsent(page, log = () => {}) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    for (const frame of [page, ...page.frames()]) {
      const clicked = await frame
        .evaluate(() => {
          const els = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
          const ok = els.find((e) => {
            const t = (e.textContent || e.value || '').trim().toLowerCase();
            if (!t || t.length > 40) return false;
            // не трогать: платную подписку и ссылки «настройки/управление/отклонить/zustimmungen(сущ.)»
            if (/abo|premium|kostenpflicht|fremdwerbung|einstellung|verwalt|ablehn|zustimmungen|mehr erfahren|details/.test(t)) return false;
            return /akzeptier|zustimmen|einverstanden|alle annehmen|accept all|accept/.test(t);
          });
          if (ok) {
            ok.click();
            return (ok.textContent || ok.value || '').trim().slice(0, 40);
          }
          return null;
        })
        .catch(() => null);
      if (clicked) {
        log(`Согласие принято: «${clicked}»`);
        return true;
      }
    }
    await sleep(500);
  }
  return false;
}

// Найти и заполнить первый существующий селектор из списка; вернуть true, если получилось.
async function typeFirst(page, selectors, value) {
  for (const s of selectors) {
    const el = await page.$(s);
    if (el) {
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.type(value, { delay: 25 });
      return s;
    }
  }
  return null;
}

async function clickFirst(page, selectors) {
  for (const s of selectors) {
    const ok = await page.evaluate((sel) => {
      const e = document.querySelector(sel);
      if (e) {
        e.click();
        return true;
      }
      return false;
    }, s);
    if (ok) return s;
  }
  return null;
}

// Кликнуть элемент по ТОЧНОМУ тексту (button/a/role=button). Возвращает текст или null.
async function clickByExactText(page, labels) {
  return page
    .evaluate((labs) => {
      const set = labs.map((l) => l.toLowerCase());
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el = els.find((e) => set.includes((e.textContent || '').trim().toLowerCase()));
      if (el) {
        el.click();
        return (el.textContent || '').trim().slice(0, 30);
      }
      return null;
    }, labels)
    .catch(() => null);
}

async function waitFirst(page, selectors, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const s of selectors) {
      if (await page.$(s)) return s;
    }
    await sleep(300);
  }
  return null;
}

// Признак блокировки/reCAPTCHA на странице входа.
async function isBlocked(page) {
  return page
    .evaluate(() => /recaptcha|captcha|ungewöhnlich|unusual activity|blockiert|gesperrt/i.test(document.body?.innerText || '') || !!document.querySelector('iframe[src*="recaptcha"]'))
    .catch(() => false);
}

// Вход в почту. Гибрид: оркестратор сперва пробует cookie-сессию (isLoggedIn); сюда попадаем,
// если сессии нет. При reCAPTCHA — решаем через solver (если задан), иначе кидаем needLogin
// (оркестратор пометит mail_login_failed; пользователь один раз войдёт вручную и сохранит cookies).
async function login(page, { email, password, solver, proxy, log = console.log } = {}) {
  if (!email || !password) throw new Error('У почты нет email/пароля.');
  log(`Вход в почту (${email})…`);
  await page.goto(ENTRY_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Экран согласия GMX («ppp») перекрывает страницу — принимаем и ждём перехода на homepage.
  if (await acceptConsent(page, log)) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(1500);
  }
  await sleep(800);

  // На homepage gmx.at поля логина нет — есть кнопка «Login», открывающая auth-флоу (#email).
  if (!(await page.$(SEL.email[0]))) {
    const clicked = await clickByExactText(page, ['Login', 'Anmelden', 'Einloggen', 'E-Mail Login']);
    if (clicked) {
      log(`Клик по «${clicked}» — открываю форму входа…`);
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await sleep(1500);
      await acceptConsent(page, log); // на auth-странице может быть свой баннер
    }
  }

  const emailSel = await waitFirst(page, SEL.email, 20000);
  if (!emailSel) throw new Error('Не найдено поле email на странице входа gmx (проверь GMX_ENTRY_URL / диагностику).');
  await typeFirst(page, [emailSel], email);

  // Двухшаговый флоу: если поля пароля ещё нет — жмём «Weiter» и ждём его.
  if (!(await page.$(SEL.password[0]))) {
    await clickFirst(page, SEL.next);
    await sleep(1200);
  }
  // Шаг пароля: GMX показывает CaptchaFox; поле пароля появляется только после её прохождения.
  let passSel = await waitFirst(page, SEL.password, 8000);
  if (!passSel) {
    await solveGmxCaptcha(page, { solver, proxy, log });
    passSel = await waitFirst(page, SEL.password, 25000);
    if (!passSel) {
      const e = new Error('Поле пароля не появилось после CaptchaFox. Войди вручную и сохрани cookies сессии.');
      e.needLogin = true;
      throw e;
    }
  }
  await typeFirst(page, SEL.password, password);

  await Promise.all([
    clickFirst(page, SEL.submit),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
  ]);
  await sleep(2000);

  if (await isBlocked(page) || /auth\.gmx|\/login/i.test(page.url())) {
    const e = new Error('Вход в gmx не удался (reCAPTCHA/блок). Войди вручную и сохрани cookies сессии.');
    e.needLogin = true;
    throw e;
  }
  log('Почта: вход выполнен.');
}

// Пройти CaptchaFox на шаге пароля. Сначала «oneClick» — клик по чекбоксу виджета (с реальным
// фингерпринтом Dolphin + резидентным IP часто проходит). Если не прошло — решаем через сервис.
async function solveGmxCaptcha(page, { solver, proxy, log = () => {} } = {}) {
  const hasPassword = async () => !!(await page.$('#password')) || !!(await page.$('input[type="password"]'));

  // 1) oneClick: ЧЕЛОВЕКОПОДОБНЫЙ клик по чекбоксу — CaptchaFox анализирует движение мыши,
  // поэтому двигаем курсор к элементу шагами, а не дёргаем element.click(). На резидентном IP
  // с реальным фингерпринтом Dolphin это часто проходит без сервиса.
  const box = await page
    .evaluate(() => {
      const cb = document.querySelector('#cf-pulse [role="checkbox"], .cf-checkbox, [role="checkbox"]');
      if (!cb) return null;
      cb.scrollIntoView({ block: 'center' });
      const r = cb.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })
    .catch(() => null);
  if (box) {
    log('CaptchaFox: человекоподобный клик по виджету (oneClick)…');
    await page.mouse.move(box.x - 60, box.y - 30);
    await sleep(140);
    await page.mouse.move(box.x - 12, box.y - 6, { steps: 10 });
    await sleep(110);
    await page.mouse.move(box.x, box.y, { steps: 6 });
    await sleep(180);
    await page.mouse.click(box.x, box.y, { delay: 60 });
    await sleep(7000);
    if (await hasPassword()) {
      log('CaptchaFox пройдена кликом.');
      return;
    }
  }

  // 2) Фолбэк: решить через сервис (CaptchaFoxTask) и вставить токен.
  if (!solver?.solveCaptchaFox) {
    const e = new Error('CaptchaFox на входе: простой клик не прошёл, а сервис CaptchaFox не настроен.');
    e.needLogin = true;
    throw e;
  }
  const siteKey = await page.evaluate(() => {
    const m = (document.documentElement.innerHTML || '').match(/sk_[A-Za-z0-9]+/);
    return m ? m[0] : null;
  });
  if (!siteKey) throw new Error('Не найден sitekey CaptchaFox на странице.');
  const userAgent = await page.evaluate(() => navigator.userAgent);
  log(`CaptchaFox: решаю через сервис (sitekey ${siteKey.slice(0, 12)}…)…`);
  const token = await solver.solveCaptchaFox({ siteKey, pageUrl: page.url(), userAgent, proxy });
  // Инъекция токена: скрытое поле виджета + возможные JS-колбэки (best-effort).
  await page.evaluate((t) => {
    for (const sel of ['input[name="cf-captcha-response"]', 'textarea[name="cf-captcha-response"]', 'input[name="captchafox"]', '#cf-captcha-response']) {
      const el = document.querySelector(sel);
      if (el) {
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    try {
      if (window.captchafox && typeof window.captchafox.setResponse === 'function') window.captchafox.setResponse(t);
    } catch {}
    try {
      if (typeof window.cfCallback === 'function') window.cfCallback(t);
    } catch {}
  }, token);
  await sleep(3000);
}

// Сессия жива? Открываем ящик; незалогиненного уводит на auth.gmx.net/login.
async function isLoggedIn(page, _opts = {}) {
  try {
    await page.goto(MAILBOX_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500);
    if (/auth\.gmx|\/login/i.test(page.url())) return false;
    // ящик доступен, если есть фрейм webmailer
    return !!(await getInboxFrame(page));
  } catch {
    return false;
  }
}

// Фрейм почтового веб-клиента (webmailer.gmx.net) — список писем/тело живут в нём.
async function getInboxFrame(page) {
  for (let i = 0; i < 20; i++) {
    const frame = page.frames().find((f) => /webmailer\.gmx|webde|mail/i.test(f.url() || '') && f !== page.mainFrame());
    if (frame) return frame;
    // по имени iframe (thirdPartyFrame_mail)
    const byName = page.frames().find((f) => (f.name && /thirdPartyFrame_mail|mail/i.test(f.name())) && f !== page.mainFrame());
    if (byName) return byName;
    await sleep(500);
  }
  return null;
}

// Открыть ящик и вернуть фрейм веб-клиента.
async function openInbox(page, { log = console.log } = {}) {
  if (!/navigator|webmailer|mail/i.test(page.url())) {
    await page.goto(MAILBOX_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  const frame = await getInboxFrame(page);
  if (!frame) throw new Error('Не найден фрейм почтового клиента (webmailer). Проверь сессию/диагностику.');
  log('Ящик открыт.');
  return frame;
}

// Найти письмо по отправителю/теме (поллинг). Возвращает { subject, from, links, html } или null по таймауту.
// Селекторы списка/тела — наборы кандидатов; уточняются диагностикой.
async function findEmail(page, { fromMatch, subjectMatch, timeoutMs = 120000, pollMs = 5000, log = console.log } = {}) {
  const frame = await openInbox(page, { log });
  const deadline = Date.now() + timeoutMs;
  const fromRe = fromMatch ? new RegExp(fromMatch.source || fromMatch, fromMatch.flags || 'i') : null;
  const subjRe = subjectMatch ? new RegExp(subjectMatch.source || subjectMatch, subjectMatch.flags || 'i') : null;

  while (Date.now() < deadline) {
    // Список писем: ищем строки и сопоставляем текст с from/subject.
    const match = await frame
      .evaluate(
        (fromSrc, subjSrc) => {
          const fromR = fromSrc ? new RegExp(fromSrc, 'i') : null;
          const subjR = subjSrc ? new RegExp(subjSrc, 'i') : null;
          const rows = [...document.querySelectorAll('[class*="mail-list"] [class*="row"], [role="row"], li[class*="mail"], .message-list-item, [data-testid*="mail-list"] li')];
          for (let i = 0; i < rows.length; i++) {
            const txt = (rows[i].innerText || '').trim();
            if (!txt) continue;
            if ((fromR ? fromR.test(txt) : true) && (subjR ? subjR.test(txt) : true)) {
              rows[i].setAttribute('data-bot-target', '1');
              return { index: i, text: txt.slice(0, 200) };
            }
          }
          return null;
        },
        fromRe ? fromRe.source : null,
        subjRe ? subjRe.source : null,
      )
      .catch(() => null);

    if (match) {
      log(`Найдено письмо: ${match.text}`);
      await frame.evaluate(() => {
        const el = document.querySelector('[data-bot-target="1"]');
        if (el) el.click();
      });
      await sleep(2500);
      return readOpenEmail(page, frame, log);
    }

    // Обновить список (кнопка «обновить» best-effort) и подождать.
    await frame
      .evaluate(() => {
        const r = document.querySelector('[data-testid*="refresh"], [title*="ktualisier"], [aria-label*="ktualisier"]');
        if (r) r.click();
      })
      .catch(() => {});
    await sleep(pollMs);
  }
  return null;
}

// Прочитать открытое письмо: тело может быть в фрейме предпросмотра. Собрать ссылки/HTML/тему.
async function readOpenEmail(page, listFrame, log = console.log) {
  // Тело письма часто в отдельном фрейме (iframe предпросмотра). Берём фрейм с наибольшим числом ссылок.
  let best = null;
  let bestCount = -1;
  for (const f of page.frames()) {
    const info = await f
      .evaluate(() => ({
        links: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /^https?:/i.test(h)),
        html: document.body ? document.body.innerHTML.slice(0, 5000) : '',
        text: document.body ? (document.body.innerText || '').slice(0, 4000) : '',
      }))
      .catch(() => null);
    if (info && info.links.length > bestCount) {
      best = info;
      bestCount = info.links.length;
    }
  }
  // Тема — из фрейма списка/предпросмотра (best-effort).
  const subject = await listFrame
    .evaluate(() => {
      const el = document.querySelector('[class*="subject"], h1, h2, [data-testid*="subject"]');
      return el ? (el.innerText || '').trim().slice(0, 200) : '';
    })
    .catch(() => '');
  return { subject, from: '', links: best?.links || [], html: best?.html || '', text: best?.text || '' };
}

// ===== Регистрация нового ящика GMX =====
const SIGNUP_URL = process.env.GMX_SIGNUP_URL || 'https://registrierung.gmx.net/?defaultCountry=AT';

// Универсальное прохождение CaptchaFox (человекоподобный клик + токен сервиса). Без login-специфики.
async function passCaptchaFox(page, { solver, proxy, log = () => {} } = {}) {
  const box = await page
    .evaluate(() => {
      const cb = document.querySelector('#cf-pulse [role="checkbox"], .cf-checkbox, [role="checkbox"]');
      if (!cb || cb.offsetParent === null) return null;
      cb.scrollIntoView({ block: 'center' });
      const r = cb.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })
    .catch(() => null);
  if (!box) return false; // виджета нет/не виден
  log('CaptchaFox: человекоподобный клик…');
  await page.mouse.move(box.x - 60, box.y - 30);
  await sleep(140);
  await page.mouse.move(box.x - 12, box.y - 6, { steps: 10 });
  await sleep(110);
  await page.mouse.move(box.x, box.y, { steps: 6 });
  await sleep(180);
  await page.mouse.click(box.x, box.y, { delay: 60 });
  await sleep(5000);
  if (solver?.solveCaptchaFox) {
    const siteKey = await page.evaluate(() => (document.documentElement.innerHTML || '').match(/sk_[A-Za-z0-9]+/)?.[0] || null);
    if (siteKey) {
      const userAgent = await page.evaluate(() => navigator.userAgent);
      log(`CaptchaFox: сервис (sitekey ${siteKey.slice(0, 12)}…)…`);
      const token = await solver.solveCaptchaFox({ siteKey, pageUrl: page.url(), userAgent, proxy });
      await page.evaluate((t) => {
        for (const s of ['input[name="cf-captcha-response"]', 'textarea[name="cf-captcha-response"]', 'input[name="captchafox"]', '#cf-captcha-response']) {
          const el = document.querySelector(s);
          if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        try { if (window.captchafox?.setResponse) window.captchafox.setResponse(t); } catch {}
        try { if (typeof window.cfCallback === 'function') window.cfCallback(t); } catch {}
      }, token);
      await sleep(2500);
    }
  }
  return true;
}

// Что видно на текущем шаге формы (поля распознаём по атрибутам — устойчиво к точным id).
async function detectStep(page) {
  return page
    .evaluate(() => {
      const vis = (el) => el && el.offsetParent !== null && !el.disabled;
      const inputs = [...document.querySelectorAll('input')].filter(vis);
      const pick = (re) => inputs.find((i) => re.test(`${i.name} ${i.id} ${i.getAttribute('data-testid') || ''} ${i.placeholder || ''} ${i.type}`));
      const sel = (el) => (el ? (el.id ? `#${el.id}` : `[data-testid="${el.getAttribute('data-testid')}"]`) : null);
      const pwInputs = inputs.filter((i) => i.type === 'password');
      const email = pick(/wunsch|desired|email|e-mail|adresse|localpart|username|benutzer/i);
      const phone = inputs.find((i) => /phone|mobil|tel|rufnummer|handy/i.test(`${i.name} ${i.id} ${i.getAttribute('data-testid') || ''} ${i.placeholder || ''}`));
      const code = inputs.find((i) => {
        const ctx = `${i.name} ${i.id} ${i.getAttribute('data-testid') || ''} ${i.placeholder || ''}`;
        if (/postal|plz/i.test(ctx)) return false; // postalCode — не код из SMS
        return /sms|tan|otp|verifizier|best[äa]tigungscode|\bcode\b/i.test(ctx);
      });
      const hasName = !!document.querySelector('#firstName, [data-testid="firstName-input"]');
      const success = /erfolgreich|willkommen|fertig|gl[üu]ckwunsch|eingerichtet/i.test(document.body.innerText || '') && !inputs.length;
      const failed = /Registrierung fehlgeschlagen/i.test(document.body.innerText || '') || /hilfe\.gmx|help\.gmx/i.test(location.href);
      const errorText = (document.querySelector('[class*="error"]:not(.hide), [data-testid*="error"]')?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return {
        hasName,
        emailSel: email && email.type !== 'password' ? sel(email) : null,
        pwSels: pwInputs.map(sel),
        phoneSel: sel(phone),
        codeSel: sel(code),
        success,
        failed,
        errorText,
        inputCount: inputs.length,
        sig: inputs.map((i) => i.id || i.name || i.type).join(','),
        fields: inputs.map((i) => ({ id: i.id, name: i.name, type: i.type, dt: i.getAttribute('data-testid'), ph: i.placeholder })),
      };
    })
    .catch(() => ({}));
}

async function clickNext(page) {
  return page
    .evaluate(() => {
      const b = document.querySelector('[data-testid="next-button"]')
        || [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].find((x) => /weiter|konto erstellen|registrieren|fortfahren|absenden|best[äa]tigen|continue|next/i.test((x.textContent || x.value || '').trim()));
      if (b && !b.disabled) { b.click(); return (b.textContent || b.value || 'next').trim().slice(0, 24); }
      return null;
    })
    .catch(() => null);
}

// Создать ящик GMX. identity — из lib/identity.js; smsProvider — драйвер 5sim; solver — CaptchaFox.
// Возвращает { ok, email, password, phone, message }.
async function signup(page, { identity, solver, smsProvider, proxy, domain = process.env.GMX_SIGNUP_DOMAIN || 'gmx.at', signupUrl = SIGNUP_URL, providerLabel = 'GMX', log = console.log } = {}) {
  if (!solver?.solveCaptchaFox) throw new Error(`Для регистрации ${providerLabel} нужен сервис CaptchaFox (2captcha).`);
  if (!smsProvider) throw new Error(`Для регистрации ${providerLabel} нужен SMS-сервис (5sim).`);
  // Надёжный ввод в React-поле: фокус → выделить всё (Ctrl+A) → удалить → впечатать заново.
  // (clickCount:3 в этих полях не очищает — из-за этого значения дублировались при повторном заходе на шаг.)
  const type = async (selOrId, val) => {
    const el = await page.$(selOrId);
    if (!el) return false;
    await el.click().catch(() => {});
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    await el.type(String(val), { delay: 45 });
    return true;
  };

  await page.goto(signupUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptConsent(page, log);
  await sleep(2000);
  await acceptConsent(page, log);
  await page.waitForSelector('#firstName, [data-testid="firstName-input"]', { timeout: 30000 });

  const chosen = { email: null, phone: null, order: null };
  let emailIdx = 0;
  let nameDone = false;
  let prevSig = '';
  let smsRented = false;

  try {
    for (let step = 1; step <= 12; step++) {
      await acceptConsent(page, log);
      const s = await detectStep(page);
      if (s.success) { log('Регистрация GMX завершена.'); break; }
      if (s.failed) throw new Error('GMX отклонил регистрацию (анти-фрод «Registrierung fehlgeschlagen»). Подсказка GMX: другой IP / без VPN / виртуальный номер.');
      log(`signup шаг ${step}: inputs=${s.inputCount} email=${!!s.emailSel} pw=${(s.pwSels || []).length} phone=${!!s.phoneSel} code=${!!s.codeSel}${s.errorText ? ' err="' + s.errorText + '"' : ''}`);
      log(`  поля: ${JSON.stringify(s.fields || [])}`);

      // Шаг имени/даты рождения (один раз).
      if (s.hasName && !nameDone) {
        await type('#firstName', identity.first_name);
        await type('#lastName', identity.last_name);
        await type('#birthDay', identity.birth.day);
        await type('#birthMonth', identity.birth.month);
        await type('#birthYear', identity.birth.year);
        nameDone = true;
      }

      // Пол (радио FEMALE/MALE/OTHER) + адрес (PLZ/город/улица) — если есть на текущем шаге.
      await page
        .evaluate((g) => {
          const id = g === 'female' ? 'FEMALE' : g === 'male' ? 'MALE' : 'OTHER';
          const el = document.querySelector('#' + id) || document.querySelector(`input[name="gender"][value="${id}"]`);
          if (el && !el.checked) el.click();
        }, identity.gender)
        .catch(() => {});
      await type('#postalCode', identity.address.plz);
      await type('#city', identity.address.city);
      await type('#street', identity.address.street);

      // Шаг желаемого email — перебираем кандидаты логина; домен выбираем gmx.at если есть селектор.
      if (s.emailSel) {
        const cand = identity.loginCandidates[emailIdx] || `${identity.loginCandidates[0]}${Math.floor(Math.random() * 900 + 100)}`;
        await type(s.emailSel, cand);
        await page.evaluate((dom) => {
          for (const el of document.querySelectorAll('select')) {
            const o = [...el.options].find((x) => (x.value + x.textContent).includes(dom));
            if (o) { el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        }, domain);
        chosen.email = `${cand}@${domain}`;
        emailIdx += 1;
        await sleep(1500);
      }

      // Шаг пароля.
      if (s.pwSels && s.pwSels.length) {
        for (const ps of s.pwSels) await type(ps, identity.password);
      }

      // Шаг телефона — арендуем номер и пробуем разные форматы на ОДНОМ номере (не жжём номера).
      if (s.phoneSel) {
        if (!chosen.phone) {
          log('Арендую номер (5sim)…');
          const r = await smsProvider.rentNumber();
          chosen.phone = r.phone;
          chosen.order = r.id;
          smsRented = true;
          log(`Номер: ${r.phone} (заказ ${r.id}).`);
        }
        const digits = String(chosen.phone).replace(/\D/g, '');
        const nsn = digits.replace(/^43/, ''); // национальный значимый номер (без кода страны 43)
        // В поле УЖЕ стоит префикс +43 → вводим только nsn БЕЗ ведущего нуля. Остальное — фолбэк.
        const cands = [nsn, `0${nsn}`, `+43${nsn}`, `+${digits}`];
        let advanced = false;
        for (const c of cands) {
          await page.$eval(s.phoneSel, (el) => { el.value = ''; }).catch(() => {});
          await type(s.phoneSel, c);
          await passCaptchaFox(page, { solver, proxy, log });
          const btn = await clickNext(page);
          log(`Телефон формат "${c}" → кнопка «${btn || '—'}»`);
          await sleep(3500);
          const a = await detectStep(page);
          if (!/ung[üu]ltig|invalid|telefon|nummer/i.test(a.errorText || '') && a.sig !== s.sig) { advanced = true; break; }
          log(`  формат "${c}" не принят (${a.errorText || 'нет продвижения'}).`);
        }
        if (!advanced) throw new Error('Телефон отклонён во всех форматах (см. лог).');
        prevSig = s.sig;
        continue; // на следующий шаг (код из SMS)
      }

      // Шаг кода из SMS.
      if (s.codeSel && chosen.order) {
        log('Жду код из SMS…');
        const code = await smsProvider.getCode(chosen.order);
        log(`Код получен: ${code}`);
        await type(s.codeSel, code);
      }

      await passCaptchaFox(page, { solver, proxy, log });
      // ждём, пока кнопка «дальше» станет активной (после капчи/валидации); в середине — ещё попытка капчи
      let btn = null;
      for (let w = 0; w < 12 && !btn; w++) {
        btn = await clickNext(page);
        if (btn) break;
        if (w === 5) await passCaptchaFox(page, { solver, proxy, log });
        await sleep(1000);
      }
      log(`signup шаг ${step}: кнопка «${btn || '—'}»`);
      await sleep(4000);

      const after = await detectStep(page);
      if (after.success) { log('Регистрация GMX завершена.'); break; }
      // не продвинулись и нет новых полей — пробуем ещё раз капчу, иначе стоп
      if (after.sig === s.sig && after.sig === prevSig) {
        if (after.errorText) throw new Error(`GMX signup застрял: ${after.errorText}`);
        throw new Error('GMX signup застрял (форма не продвигается).');
      }
      prevSig = s.sig;
    }

    if (!chosen.email) throw new Error('Не удалось выбрать email на форме (см. лог шагов).');
    if (smsRented && chosen.order) await smsProvider.finish(chosen.order).catch(() => {});
    return { ok: true, email: chosen.email, password: identity.password, phone: chosen.phone, message: `Ящик ${chosen.email} создан.` };
  } catch (e) {
    if (smsRented && chosen.order) await smsProvider.cancel(chosen.order).catch(() => {});
    await screenshotTo(page, `gmx-signup-fail-${Date.now()}.png`).catch(() => {});
    return { ok: false, email: chosen.email, message: e.message };
  }
}

// Включить IMAP в настройках ящика (после создания) — чтобы дальше читать письма по IMAP.
// Точные селекторы страницы настроек добиваются на живом прогоне; здесь best-effort по тексту.
async function enableImap(page, { settingsUrl = process.env.GMX_IMAP_SETTINGS_URL || 'https://account.gmx.net/account/security/pop-imap', log = console.log } = {}) {
  await page.goto(settingsUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await acceptConsent(page, log);
  const done = await page
    .evaluate(() => {
      const cb = [...document.querySelectorAll('input[type="checkbox"]')].find((c) => /imap|pop/i.test(`${c.name} ${c.id} ${c.getAttribute('aria-label') || ''}`));
      if (cb && !cb.checked) cb.click();
      const save = [...document.querySelectorAll('button')].find((b) => /speichern|save/i.test(b.textContent || ''));
      if (save) save.click();
      return !!cb;
    })
    .catch(() => false);
  await sleep(1500);
  log(done ? 'IMAP включён (best-effort).' : 'Не нашёл переключатель IMAP — включи вручную (или уточним селекторы).');
  return done;
}

// Движок регистрации United Internet (GMX/web.de/mail.com — общая форма registrierung.*). Переиспользуется
// тонкими драйверами webde.js/mailcom.js: тот же signup/enableImap, отличаются signupUrl/domain/IMAP-хост.
export { signup, enableImap };

export default {
  name: 'gmx',
  label: 'GMX.at',
  signup,
  enableImap,
  // IMAP-доступ к почте (чтение писем) — основной путь. GMX блокирует IMAP с чужого IP,
  // поэтому подключаемся через прокси аккаунта (см. lib/mail/imap.js). IMAP должен быть включён в ящике.
  imap: { host: process.env.GMX_IMAP_HOST || 'imap.gmx.net', port: 993 },
  // Браузерный вход (login/openInbox/findEmail) — устаревший путь чтения через webmailer (shadow DOM),
  // оставлен как запасной; основной поток использует IMAP.
  login,
  isLoggedIn,
  openInbox,
  findEmail,
};
