// Глобальные настройки (key-value в БД): Dolphin API токен и др. Гидратируют process.env,
// чтобы dolphin.js/claude.js (читающие env) работали без .env — токен задаётся в админке.

export const KNOWN_SETTINGS = {
  dolphin_api_token: {
    env: 'DOLPHIN_API_TOKEN',
    label: 'Dolphin API токен',
    hint: 'Нужен для запуска профилей Dolphin при публикации. Берётся отсюда или из .env (env имеет приоритет).',
  },
  captcha_provider: {
    env: 'CAPTCHA_PROVIDER',
    label: 'Сервис решения капч',
    hint: 'Провайдер решения капч для регистрации (напр. twocaptcha). Пусто = решение капч отключено.',
  },
  captcha_api_key: {
    env: 'CAPTCHA_API_KEY',
    label: 'Ключ сервиса капч',
    hint: 'API-ключ выбранного сервиса (2captcha-совместимого). Нужен баланс на счету сервиса.',
  },
  sms_provider: {
    env: 'SMS_PROVIDER',
    label: 'SMS-сервис (приём кодов)',
    hint: 'Провайдер виртуальных номеров для регистрации ящиков (напр. fivesim). Пусто = создание ящиков выключено.',
  },
  sms_api_key: {
    env: 'SMS_API_KEY',
    label: 'Ключ SMS-сервиса',
    hint: 'API-ключ (для 5sim — Bearer-токен). Нужен баланс на счету сервиса.',
  },
  serp_captcha_provider: {
    env: 'SERP_CAPTCHA_PROVIDER',
    label: 'Решатель капчи для SERP',
    hint: 'Сервис решения reCAPTCHA для капчи Google /sorry при проверке позиций (напр. yescaptcha). Пусто = берётся общий «Сервис решения капч».',
  },
  serp_captcha_api_key: {
    env: 'SERP_CAPTCHA_API_KEY',
    label: 'Ключ решателя капчи для SERP',
    hint: 'API-ключ сервиса для SERP-капчи (YesCaptcha и т.п.). Отдельный от ключа регистрации, чтобы не менять рабочую связку.',
  },
  serp_login: {
    env: 'SERP_LOGIN',
    label: 'SERP API — логин (DataForSEO)',
    hint: 'Логин DataForSEO для фолбэк-проверки позиций в Google, когда свой скрапер заблокирован. Пусто = фолбэк выключен.',
  },
  serp_password: {
    env: 'SERP_PASSWORD',
    label: 'SERP API — пароль (DataForSEO)',
    hint: 'Пароль DataForSEO (Basic-аутентификация). Нужен баланс на счету сервиса.',
  },
};

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
  ).run(key, value);
}

// Заполнить process.env известными настройками из БД (env приоритетнее: если уже задан — не трогаем).
export function applySettingsToEnv(db) {
  for (const [key, def] of Object.entries(KNOWN_SETTINGS)) {
    if (process.env[def.env]) continue;
    const v = getSetting(db, key);
    if (v) process.env[def.env] = v;
  }
}
