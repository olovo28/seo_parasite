// Оркестрация СОЗДАНИЯ почтовых ящиков (нейтральна к провайдеру). Поток: свободная прокси из пула →
// одноразовый профиль Dolphin → provider.signup (форма + CaptchaFox + SMS) → (опц.) enableImap →
// запись нового ящика в пул email_accounts. Создавать строго последовательно (один профиль за раз).

import { launchProfileWithProxy, cleanupProfile } from './browser.js';
import { getMailProvider } from './mail/index.js';
import { getSolver } from './captcha/index.js';
import { getSmsProvider } from './sms/index.js';
import { assignProxy } from './proxyPool.js';
import { parseProxy } from './accounts.js';
import { generateIdentity } from './identity.js';

// Создать один ящик. Возвращает { ok, email, message }.
export async function createMailbox(db, { provider = 'gmx', enableImapAfter = true, onStep } = {}) {
  const log = onStep || console.log;
  const mailProvider = getMailProvider(provider);
  if (!mailProvider.signup) throw new Error(`Провайдер «${provider}» не умеет регистрировать ящики.`);

  const solver = getSolver(db);
  const smsProvider = getSmsProvider(db);
  if (!solver?.solveCaptchaFox) throw new Error('Не настроен сервис капч (CaptchaFox) — задай в настройках.');
  if (!smsProvider) throw new Error('Не настроен SMS-сервис (5sim) — задай в настройках.');

  const proxyUrl = assignProxy(db, { country: process.env.GMX_PROXY_COUNTRY || 'at' });
  if (!proxyUrl) throw new Error('В пуле нет прокси нужной страны (загрузи список прокси на странице «Почты»).');
  const proxy = parseProxy(proxyUrl);
  const identity = generateIdentity();

  let browser;
  let ephemeralProfileId = null;
  try {
    log(`Создаю профиль с прокси ${proxy.host}:${proxy.port}…`);
    const launched = await launchProfileWithProxy({ proxy });
    browser = launched.browser;
    ephemeralProfileId = launched.profileId;
    const page = launched.page;

    const res = await mailProvider.signup(page, { identity, solver, smsProvider, proxy, log });
    if (!res.ok) return { ok: false, email: res.email, message: res.message };

    // Включаем IMAP (чтобы потом читать письма по IMAP) — best-effort.
    if (enableImapAfter && mailProvider.enableImap) {
      try {
        await mailProvider.enableImap(page, { log });
      } catch (e) {
        log(`IMAP включить не удалось автоматически: ${e.message}`);
      }
    }

    // Записываем ящик в пул (свободен, прокси закрепляется за ним).
    db.prepare("INSERT OR IGNORE INTO email_accounts (provider, email, password, proxy, phone, status) VALUES (?, ?, ?, ?, ?, 'verified')")
      .run(provider, res.email, res.password, proxyUrl, res.phone || null);
    log(`Ящик ${res.email} создан и добавлен в пул.`);
    return { ok: true, email: res.email, message: res.message };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    await cleanupProfile(browser, ephemeralProfileId);
  }
}
