// Оркестрация регистрации аккаунтов на сайтах — НЕЙТРАЛЬНА к сайту и почтовому провайдеру.
// Поток: проверка ящика по IMAP → профиль с прокси → adapter.register (форма+капча) →
// чтение письма подтверждения по IMAP → confirmRegistration → ожидание одобрения админом.
// Чтение почты — по IMAP ЧЕРЕЗ прокси аккаунта (GMX блокирует IMAP с чужого IP); браузер нужен
// только для формы регистрации и перехода по ссылке. Сайт-специфику делает адаптер (lib/sites/*),
// почту — провайдер (lib/mail/*), капчу регистрации — решатель (lib/captcha).

import { launchProfileWithProxy, cleanupProfile, screenshotTo, restoreCookies } from './browser.js';
import { humanBrowse } from './humanize.js';
import { getAdapter } from './sites/index.js';
import { getMailProvider } from './mail/index.js';
import { findEmailImap, verifyImap } from './mail/imap.js';
import { getSolver } from './captcha/index.js';
import { parseProxy, addSiteAccount } from './accounts.js';
import { generateIdentity, pickLocationForGeo } from './identity.js';
import { geolocateIp } from './geoip.js';
import { logRegEvent } from './regEvents.js';
import { utcStamp } from './time.js';
import { getEmailAccountById, lockEmailToSite, setEmailStatus, swapEmailProxy } from './emailAccounts.js';
import { createRegistration, getRegistration, getRegistrationByEmail, updateRegistration } from './registrations.js';

// Проверка одобрения админом: 4 раза в день (каждые 6 ч) в течение 30 дней → потом «не одобрено».
const APPROVAL_CHECK_INTERVAL_MS = Number(process.env.REGISTER_CHECK_INTERVAL_MS || 6 * 3600 * 1000); // 6 ч = 4 раза в день
export const MAX_APPROVAL_CHECKS = Number(process.env.REGISTER_MAX_CHECKS || 120); // 4/день × 30 дней
const APPROVAL_INTERVAL_LABEL = `${Math.round(APPROVAL_CHECK_INTERVAL_MS / 3600000)} ч`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSite(db, siteId) {
  const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteId);
  if (!s) throw new Error(`Сайт #${siteId} не найден.`);
  return s;
}

// Параметры IMAP-доступа к ящику (через прокси аккаунта).
function imapOpts(provider, emailAcc, proxy) {
  if (!provider.imap?.host) throw new Error(`Провайдер «${provider.name}» не задаёт IMAP-хост.`);
  return { host: provider.imap.host, port: provider.imap.port || 993, user: emailAcc.email, pass: emailAcc.password, proxy };
}

// Выполнить IMAP-операцию через прокси почты. Если прокси отказала на CONNECT (e.proxyError — напр. HTTP 503),
// один раз меняем прокси почты на свободную (никем не используемую) из пула и повторяем. fn(mail) → результат.
// Возвращает { result, proxy, mail, swapped } — обновлённые proxy/mail на случай продолжения работы вызывающим.
async function imapWithProxySwap(db, emailAcc, provider, fn, log = () => {}) {
  let proxy = parseProxy(emailAcc.proxy);
  let mail = imapOpts(provider, emailAcc, proxy);
  try {
    return { result: await fn(mail), proxy, proxyUrl: emailAcc.proxy, mail, swapped: false };
  } catch (e) {
    if (!e.proxyError) throw e;
    const newUrl = swapEmailProxy(db, emailAcc.id);
    if (!newUrl) {
      e.message = `${e.message} Свободных прокси в пуле нет — замену не выполнил.`;
      throw e;
    }
    proxy = parseProxy(newUrl);
    mail = imapOpts(provider, emailAcc, proxy);
    log(`Прокси отказала (${e.message}) — переключил почту на свободную прокси ${proxy.host}:${proxy.port} и повторяю…`);
    return { result: await fn(mail), proxy, proxyUrl: newUrl, mail, swapped: true };
  }
}

// Поллинг письма по IMAP до появления (или таймаут). match = { fromMatch, subjectMatch }.
async function pollImap(opts, match, { timeoutMs, pollMs = 10000, max = 30, log = () => {} }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const m = await findEmailImap({ ...opts, ...match, max });
      if (m) return m;
    } catch (e) {
      log(`IMAP: ${e.message}`);
    }
    await sleep(pollMs);
  }
  return null;
}

// Зарегистрировать аккаунт на сайте по почте из пула. Возвращает { ok, registrationId, status, message }.
export async function registerOnSite(db, { siteId, emailAccountId, onStep } = {}) {
  const log = onStep || console.log;
  const site = getSite(db, siteId);
  const adapter = getAdapter(site.adapter);
  if (!adapter.register) throw new Error(`Адаптер «${site.adapter}» не поддерживает регистрацию.`);

  const emailAcc = getEmailAccountById(db, emailAccountId);
  if (!emailAcc) throw new Error(`Почта #${emailAccountId} не найдена.`);
  if (!emailAcc.proxy) throw new Error('У почты не задана прокси — запуск профиля без прокси запрещён.');
  if (emailAcc.site_id && Number(emailAcc.site_id) !== Number(siteId)) {
    throw new Error(`Почта ${emailAcc.email} уже закреплена за другим сайтом (#${emailAcc.site_id}) — повторное использование запрещено.`);
  }

  const provider = getMailProvider(emailAcc.provider);
  let proxy = parseProxy(emailAcc.proxy);
  let solver = getSolver(db, { proxy }); // 2captcha — через прокси аккаунта (прямой доступ может быть закрыт)
  let mail = imapOpts(provider, emailAcc, proxy);

  // Закрепляем почту за сайтом (правило уникальности). Идемпотентно: если уже за этим сайтом — ок.
  if (!emailAcc.site_id && !lockEmailToSite(db, emailAcc.id, siteId)) {
    throw new Error(`Почта ${emailAcc.email} перехвачена другим сайтом (гонка) — пропускаю.`);
  }

  // Резюмируем существующую регистрацию или создаём новую.
  let reg = getRegistrationByEmail(db, emailAcc.id);
  let identity;
  let sitePassword;
  if (reg && reg.status === 'approved') {
    return { ok: true, registrationId: reg.id, status: 'approved', message: 'Аккаунт уже одобрен.' };
  }
  if (reg && reg.identity) {
    identity = reg.identity;
    sitePassword = reg.site_password;
  } else {
    identity = generateIdentity();
    sitePassword = identity.password;
  }
  const siteUsername = emailAcc.email;
  if (!reg) {
    const id = createRegistration(db, { siteId, emailAccountId: emailAcc.id, identity, siteUsername, sitePassword });
    reg = getRegistration(db, id);
  } else {
    updateRegistration(db, reg.id, { identity, site_username: siteUsername, site_password: sitePassword, status: 'pending', error: null });
  }

  // 1) Проверяем доступ к ящику по IMAP (через прокси) — до запуска браузера.
  //    Если прокси отказала на CONNECT (напр. 503) — меняем её на свободную из пула и продолжаем с новой.
  try {
    const r = await imapWithProxySwap(db, emailAcc, provider, (m) => verifyImap(m), log);
    if (r.swapped) {
      proxy = r.proxy;
      mail = r.mail;
      solver = getSolver(db, { proxy }); // решатель капч тоже через новую прокси
    }
    setEmailStatus(db, emailAcc.id, 'verified');
    log('Почта доступна по IMAP.');
  } catch (e) {
    updateRegistration(db, reg.id, { status: 'mail_login_failed', error: e.message });
    setEmailStatus(db, emailAcc.id, 'bad');
    return { ok: false, registrationId: reg.id, status: 'mail_login_failed', message: `IMAP недоступен: ${e.message} (включён ли IMAP в ящике?).` };
  }

  let browser;
  let page;
  let ephemeralProfileId = null;
  try {
    log(`Создаю профиль с прокси ${proxy.host}:${proxy.port}…`);
    const launched = await launchProfileWithProxy({ proxy });
    browser = launched.browser;
    page = launched.page;
    ephemeralProfileId = launched.profileId;

    // 1.5) Подобрать регион (Bezirk) под exit-IP прокси — чтобы профиль «жил» там, откуда заходит (правдоподобнее
    //      для модерации). Геолоцируем уже известный внешний IP; на сбой — оставляем регион как был.
    try {
      const geo = await geolocateIp(launched.ip);
      const loc = geo && pickLocationForGeo(geo);
      if (loc && loc[0] !== identity.location) {
        identity = { ...identity, location: loc[0], location_label: loc[1] };
        updateRegistration(db, reg.id, { identity });
        log(`Регион под IP ${launched.ip} (${geo.city || '?'}, ${geo.regionName || '?'}): ${loc[1]}.`);
      } else if (geo && !loc) {
        log(`Геолокация IP: ${geo.regionName || '?'} — подходящего Bezirk нет, оставляю ${identity.location_label}.`);
      }
    } catch (e) {
      log(`Геолокацию региона пропускаю (${e.message}) — регион прежний.`);
    }

    // 1.7) Человеческий фактор: восстановить прогретую сессию (если прогревали) + полистать сайт перед формой —
    //      медленнее и правдоподобнее для анти-спама/модерации. Отключается REGISTER_HUMANIZE=0.
    if (process.env.REGISTER_HUMANIZE !== '0') {
      try {
        const warm = reg.warm_cookies ? JSON.parse(reg.warm_cookies) : null;
        if (warm?.length) {
          await restoreCookies(page, warm).catch(() => {});
          log('Восстановлена прогретая сессия (returning visitor).');
        }
      } catch { /* нет/битые куки прогрева */ }
      await humanBrowse(page, { origin: site.origin, minPages: Number(process.env.REGISTER_BROWSE_MIN || 5), maxPages: Number(process.env.REGISTER_BROWSE_MAX || 12), log }).catch((e) => log(`Обзор перед регистрацией пропущен: ${e.message}`));
    }

    // 2) Заполнить и отправить форму регистрации (капча картинки — через решатель).
    const sinceTs = Date.now();
    const r = await adapter.register(page, { origin: site.origin, identity, email: emailAcc.email, password: sitePassword, solver, log });
    if (!r.ok && !r.alreadyRegistered) {
      updateRegistration(db, reg.id, { status: 'failed', error: r.message });
      return { ok: false, registrationId: reg.id, status: 'failed', message: r.message };
    }
    if (r.alreadyRegistered) {
      // Аккаунт уже создан ранее (напр. в прошлом прогоне) — форму не шлём, доводим подтверждение из письма.
      log('Аккаунт уже зарегистрирован — ищу письмо подтверждения и довожу подтверждение…');
    }
    updateRegistration(db, reg.id, { status: 'submitted', error: null });
    logRegEvent(db, reg.id, 'submitted', 'Форма регистрации отправлена.');

    // 3) Письмо подтверждения (IMAP-поллинг) → ссылка → переход в браузере.
    log('Жду письмо подтверждения (IMAP)…');
    const msg = await pollImap(mail, adapter.confirmationEmail, { timeoutMs: Number(process.env.REGISTER_MAIL_TIMEOUT_MS || 180000), log });
    if (!msg) {
      updateRegistration(db, reg.id, { status: 'confirm_failed', error: 'Письмо подтверждения не пришло за отведённое время.' });
      return { ok: false, registrationId: reg.id, status: 'confirm_failed', message: 'Письмо подтверждения не пришло.' };
    }
    const confirmUrl = adapter.extractConfirmUrl(msg.links);
    if (!confirmUrl) {
      updateRegistration(db, reg.id, { status: 'confirm_failed', error: 'В письме не найдена ссылка подтверждения.' });
      return { ok: false, registrationId: reg.id, status: 'confirm_failed', message: 'Ссылка подтверждения не найдена в письме.' };
    }
    log(`Письмо найдено («${msg.subject.slice(0, 50)}»), перехожу по ссылке подтверждения…`);
    await adapter.confirmRegistration(page, { origin: site.origin, url: confirmUrl, log });

    // 4) Ожидаем одобрения админом — ставим проверку планировщику через сутки.
    updateRegistration(db, reg.id, { status: 'awaiting_admin', confirm_url: confirmUrl, submitted_at: reg.submitted_at || utcStamp(), next_check_at: utcStamp(new Date(Date.now() + APPROVAL_CHECK_INTERVAL_MS)), error: null });
    logRegEvent(db, reg.id, 'awaiting_admin', 'Почта подтверждена — ожидаем одобрения администратором.');
    setEmailStatus(db, emailAcc.id, 'used');
    log('Регистрация отправлена и подтверждена. Ожидаем одобрение администратором.');
    return { ok: true, registrationId: reg.id, status: 'awaiting_admin', message: 'Подтверждено. Ожидаем одобрение админом (проверка через сутки).' };
  } catch (e) {
    if (page) {
      const shot = `register-error-${Date.now()}.png`;
      await screenshotTo(page, shot);
      e.screenshot = shot;
    }
    updateRegistration(db, reg.id, { status: 'failed', error: e.message });
    logRegEvent(db, reg.id, 'failed', `Сбой регистрации: ${e.message}`);
    throw e;
  } finally {
    await cleanupProfile(browser, ephemeralProfileId);
  }
}

// Проверить, одобрил ли админ учётную запись (письмо-одобрение по IMAP). БЕЗ браузера/Dolphin.
// Возвращает { ok, status, message }.
export async function checkApproval(db, { registrationId, onStep } = {}) {
  const log = onStep || console.log;
  const reg = getRegistration(db, registrationId);
  if (!reg) throw new Error(`Регистрация #${registrationId} не найдена.`);
  const emailAcc = getEmailAccountById(db, reg.email_account_id);
  if (!emailAcc) throw new Error('Почта регистрации удалена.');
  const site = getSite(db, reg.site_id);
  const adapter = getAdapter(site.adapter);
  const provider = getMailProvider(emailAcc.provider);

  updateRegistration(db, reg.id, { last_checked_at: utcStamp() }); // фиксируем факт IMAP-проверки

  let msg = null;
  let proxyUrl = emailAcc.proxy; // прокси, которой удалось прочитать ящик (может смениться при отказе)
  try {
    // Если прокси отказала на CONNECT (напр. 503) — меняем её на свободную из пула и повторяем чтение.
    const r = await imapWithProxySwap(db, emailAcc, provider, (m) => findEmailImap({ ...m, ...adapter.approvalEmail }), log);
    msg = r.result;
    proxyUrl = r.proxyUrl;
  } catch (e) {
    // временная ошибка IMAP — не считаем «не одобрено», просто перенесём проверку
    updateRegistration(db, reg.id, { next_check_at: utcStamp(new Date(Date.now() + APPROVAL_CHECK_INTERVAL_MS)), error: `IMAP: ${e.message}` });
    return { ok: false, status: 'awaiting_admin', message: `IMAP недоступен: ${e.message}. Перенёс проверку на ${APPROVAL_INTERVAL_LABEL}.` };
  }

  const approved = msg && (adapter.isApproved ? adapter.isApproved(msg) : true);
  if (approved) {
    addSiteAccount(db, reg.site_id, { username: reg.site_username || emailAcc.email, password: reg.site_password, proxy: proxyUrl, label: `auto:${emailAcc.email}` });
    const acc = db.prepare('SELECT id FROM site_accounts WHERE site_id = ? AND username = ?').get(reg.site_id, reg.site_username || emailAcc.email);
    updateRegistration(db, reg.id, { status: 'approved', account_id: acc?.id || null, approved_at: utcStamp(), error: null });
    logRegEvent(db, reg.id, 'approved', 'Одобрено администратором — создан аккаунт публикации.');
    setEmailStatus(db, emailAcc.id, 'used');
    log('Учётная запись одобрена — создан аккаунт публикации.');
    return { ok: true, status: 'approved', message: 'Одобрено — аккаунт публикации создан.' };
  }

  const checks = (reg.checks || 0) + 1;
  if (checks >= MAX_APPROVAL_CHECKS) {
    updateRegistration(db, reg.id, { status: 'failed', checks, error: `Не одобрено за ${checks} проверок (~30 дней).` });
    logRegEvent(db, reg.id, 'failed', `Не одобрено за ${checks} проверок (~30 дней) — остановлено.`);
    return { ok: false, status: 'failed', message: `Не одобрено за ${checks} проверок (~30 дней) — остановлено.` };
  }
  updateRegistration(db, reg.id, { checks, next_check_at: utcStamp(new Date(Date.now() + APPROVAL_CHECK_INTERVAL_MS)) });
  logRegEvent(db, reg.id, 'approval_check', `Проверка ${checks}/${MAX_APPROVAL_CHECKS}: письма об одобрении ещё нет.`);
  return { ok: false, status: 'awaiting_admin', message: `Письма об одобрении ещё нет (проверка ${checks}/${MAX_APPROVAL_CHECKS}). Следующая через ${APPROVAL_INTERVAL_LABEL}.` };
}
