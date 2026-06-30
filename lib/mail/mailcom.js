// Драйвер mail.com (United Internet — тот же движок, что GMX/web.de). Английская форма, много доменов;
// по умолчанию домен mail.com. Отличия: свой signupUrl и IMAP-хост. Точные URL/селекторы — подтвердить
// живым прогоном (env переопределяет).

import { signup as uiSignup, enableImap as uiEnableImap } from './gmx.js';

const SIGNUP_URL = process.env.MAILCOM_SIGNUP_URL || 'https://signup.mail.com/';
const IMAP_SETTINGS_URL = process.env.MAILCOM_IMAP_SETTINGS_URL || 'https://account.mail.com/account/security/pop-imap';

export default {
  name: 'mailcom',
  label: 'mail.com',
  signup: (page, opts = {}) => uiSignup(page, { ...opts, domain: process.env.MAILCOM_SIGNUP_DOMAIN || 'mail.com', signupUrl: SIGNUP_URL, providerLabel: 'mail.com' }),
  enableImap: (page, opts = {}) => uiEnableImap(page, { ...opts, settingsUrl: IMAP_SETTINGS_URL }),
  imap: { host: process.env.MAILCOM_IMAP_HOST || 'imap.mail.com', port: 993 },
};
