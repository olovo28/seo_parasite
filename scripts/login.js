// Запуск Profile 6 «с чистого листа», вход на meinbezirk.at и чтение заголовков черновиков.
// Чистый старт — общий lib/browser.js; логин — адаптер сайта lib/sites/meinbezirk.js (тот же, что у публикатора).
//
// Запуск из корня проекта (приложение Dolphin{anty} открыто):
//   node --env-file=.env scripts/login.js

import { launchProfileClean } from '../lib/browser.js';
import meinbezirk from '../lib/sites/meinbezirk.js';

const PROFILE_NAME = 'Profile 6';
const ORIGIN = 'https://www.meinbezirk.at';
const USERNAME = process.env.MEINBEZIRK_USER || 'maikgoevop@gmx.net';
const PASSWORD = process.env.MEINBEZIRK_PASS || 'JYrBs9qMYzp';

// Перейти в "Meine Beitragsentwürfe" и прочитать заголовки черновиков.
async function readDraftTitles(page) {
  const draftHref = await page.evaluate(() => {
    const links = [...document.querySelectorAll('a[role="menuitem"], a')];
    const link = links.find((a) => a.textContent.trim() === 'Meine Beitragsentwürfe');
    return link ? link.getAttribute('href') : null;
  });
  if (!draftHref) throw new Error('Ссылка "Meine Beitragsentwürfe" не найдена на странице.');

  const url = new URL(draftHref, ORIGIN).href;
  console.log(`Перехожу в черновики: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page
    .waitForSelector('article.content-card h3.content-card-headline', { timeout: 15000 })
    .catch(() => {}); // черновиков может не быть

  return page.evaluate(() =>
    [...document.querySelectorAll('article.content-card h3.content-card-headline a')].map((a) =>
      a.textContent.trim(),
    ),
  );
}

async function main() {
  console.log(`Готовлю "${PROFILE_NAME}" с чистого листа...`);
  const { browser, page, ip, proxyHost } = await launchProfileClean(PROFILE_NAME);
  console.log(`Прокси OK: ${proxyHost}, внешний IP ${ip}.`);

  try {
    await meinbezirk.login(page, { origin: ORIGIN, username: USERNAME, password: PASSWORD });
    console.log(`Вход выполнен. Текущий URL: ${page.url()}`);

    const titles = await readDraftTitles(page);
    console.log(`\nНайдено черновиков: ${titles.length}`);
    titles.forEach((t, i) => console.log(`${i + 1}. ${t}`));
  } finally {
    browser.disconnect();
  }
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
