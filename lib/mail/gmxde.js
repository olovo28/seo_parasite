// Драйвер GMX.de — тот же GMX (движок регистрации и IMAP-хост общие: imap.gmx.net), отличается только домен адреса.
import { signup as uiSignup, enableImap as uiEnableImap } from './gmx.js';

const SIGNUP_URL = process.env.GMXDE_SIGNUP_URL || 'https://registrierung.gmx.net/?defaultCountry=DE';

export default {
  name: 'gmxde',
  label: 'GMX.de',
  signup: (page, opts = {}) => uiSignup(page, { ...opts, domain: 'gmx.de', signupUrl: SIGNUP_URL, providerLabel: 'GMX.de' }),
  enableImap: uiEnableImap,
  imap: { host: process.env.GMX_IMAP_HOST || 'imap.gmx.net', port: 993 },
};
