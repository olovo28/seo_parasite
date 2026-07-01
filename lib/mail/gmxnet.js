// Драйвер GMX.net — тот же GMX (общий движок и IMAP-хост imap.gmx.net), отличается домен адреса.
import { signup as uiSignup, enableImap as uiEnableImap } from './gmx.js';

const SIGNUP_URL = process.env.GMXNET_SIGNUP_URL || 'https://registrierung.gmx.net/?defaultCountry=DE';

export default {
  name: 'gmxnet',
  label: 'GMX.net',
  signup: (page, opts = {}) => uiSignup(page, { ...opts, domain: 'gmx.net', signupUrl: SIGNUP_URL, providerLabel: 'GMX.net' }),
  enableImap: uiEnableImap,
  imap: { host: process.env.GMX_IMAP_HOST || 'imap.gmx.net', port: 993 },
};
