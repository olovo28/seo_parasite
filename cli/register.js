// CLI запуска регистрации аккаунтов на сайте (ЖИВОЙ прогон — запускает пользователь).
//
//   npm run register -- --site 1 --email 5         (одна почта по id)
//   npm run register -- --site 1 --count 3         (N свободных почт пула)
//   npm run register -- --check <registrationId>   (проверить одобрение админом)
//
// Требует: открытый Dolphin{anty}, прокси у почты, настроенный сервис капч.
// ВНИМАНИЕ: реальные действия на боевом сайте. Сначала проверь на ОДНОЙ почте.

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { freeEmailAccounts } from '../lib/emailAccounts.js';
import { registerOnSite, checkApproval } from '../lib/registrar.js';

const { flags } = parseArgs();
const db = getDb();
const log = (m) => console.log(`  ${m}`);

if (flags.check) {
  const res = await checkApproval(db, { registrationId: Number(flags.check), onStep: log });
  console.log(`${res.ok ? 'OK' : '·'}: ${res.message}`);
  process.exit(res.ok ? 0 : 0);
}

const siteId = Number(flags.site);
if (!siteId) {
  console.error('Использование: register --site <id> [--email <id> | --count <N>] | --check <regId>');
  process.exit(1);
}

let emailIds = [];
if (flags.email) {
  emailIds = [Number(flags.email)];
} else {
  const count = Number(flags.count || 1);
  emailIds = freeEmailAccounts(db).slice(0, count).map((e) => e.id);
  if (!emailIds.length) {
    console.error('Нет свободных почт в пуле (добавь через npm run emails -- import).');
    process.exit(1);
  }
}

console.log(`Регистрация на сайте #${siteId}: ${emailIds.length} почт(ы).`);
let okN = 0;
for (const id of emailIds) {
  console.log(`\n— почта #${id} —`);
  try {
    const res = await registerOnSite(db, { siteId, emailAccountId: id, onStep: log });
    console.log(`${res.ok ? 'OK' : '✗'} [${res.status}]: ${res.message}`);
    if (res.ok) okN++;
  } catch (e) {
    console.error(`✗ ошибка: ${e.message}${e.screenshot ? ` (screenshots/${e.screenshot})` : ''}`);
  }
}
console.log(`\nИтог: успешно ${okN}/${emailIds.length}.`);
