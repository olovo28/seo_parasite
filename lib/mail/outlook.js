// Драйвер Outlook/Hotmail (Microsoft) — КАРКАС, регистрация ещё не реализована.
// Регистрация существенно сложнее United Internet: FunCaptcha/Arkose («нажми и держи»), часто телефон,
// сильный анти-бот, многошаговая форма signup.live.com. Нужен решатель FunCaptcha (2captcha поддерживает,
// добавить в lib/captcha/*) + живая доводка формы. Делается отдельной фазой. IMAP-чтение — стандартное.

export default {
  name: 'outlook',
  label: 'Outlook/Hotmail',
  imap: { host: process.env.OUTLOOK_IMAP_HOST || 'outlook.office365.com', port: 993 },
  signup: async () => {
    throw new Error('Outlook: драйвер регистрации ещё не реализован (нужен решатель FunCaptcha/Arkose + живая доводка signup.live.com). Запланирован отдельной фазой.');
  },
};
