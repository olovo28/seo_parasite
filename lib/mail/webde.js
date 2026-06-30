// Драйвер web.de (United Internet — тот же холдинг и тот же движок регистрации, что GMX: общая форма
// registrierung.*, CaptchaFox, телефон через 5sim, IMAP). Отличия от GMX: домен @web.de, свой signupUrl
// и IMAP-хост. Селекторы формы общие с GMX; точные URL — подтвердить живым прогоном (env переопределяет).

import { signup as uiSignup, enableImap as uiEnableImap } from './gmx.js';

const SIGNUP_URL = process.env.WEBDE_SIGNUP_URL || 'https://registrierung.web.de/?defaultCountry=AT';
const IMAP_SETTINGS_URL = process.env.WEBDE_IMAP_SETTINGS_URL || 'https://account.web.de/account/security/pop-imap';

export default {
  name: 'webde',
  label: 'web.de',
  signup: (page, opts = {}) => uiSignup(page, { ...opts, domain: process.env.WEBDE_SIGNUP_DOMAIN || 'web.de', signupUrl: SIGNUP_URL, providerLabel: 'web.de' }),
  enableImap: (page, opts = {}) => uiEnableImap(page, { ...opts, settingsUrl: IMAP_SETTINGS_URL }),
  imap: { host: process.env.WEBDE_IMAP_HOST || 'imap.web.de', port: 993 },
};
