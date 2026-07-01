// Драйвер GMX.ch — тот же GMX (общий движок и IMAP-хост imap.gmx.net), отличается домен адреса.
import { signup as uiSignup, enableImap as uiEnableImap } from './gmx.js';

const SIGNUP_URL = process.env.GMXCH_SIGNUP_URL || 'https://registrierung.gmx.net/?defaultCountry=CH';

export default {
  name: 'gmxch',
  label: 'GMX.ch',
  signup: (page, opts = {}) => uiSignup(page, { ...opts, domain: 'gmx.ch', signupUrl: SIGNUP_URL, providerLabel: 'GMX.ch' }),
  enableImap: uiEnableImap,
  imap: { host: process.env.GMX_IMAP_HOST || 'imap.gmx.net', port: 993 },
};
