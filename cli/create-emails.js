// CLI создания почтовых ящиков (ЖИВОЙ прогон — запускает пользователь). Строго последовательно.
//
//   npm run create-emails -- --count 3 [--provider gmx]
//
// Требует: открытый Dolphin, прокси-пул (импорт AT-1.txt), настроенные captcha + SMS-сервис.

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { createMailbox } from '../lib/mailRegistrar.js';
import { proxyPoolStats } from '../lib/proxyPool.js';

const { flags } = parseArgs();
const db = getDb();
const count = Number(flags.count || 1);
const provider = flags.provider || 'gmx';
const log = (m) => console.log('  ' + m);

const st = proxyPoolStats(db);
console.log(`Прокси-пул: ${st.map((s) => `${s.country}=${s.total}`).join(', ') || 'пуст'}. Создаю ${count} ящик(ов) [${provider}].`);
let ok = 0;
for (let i = 1; i <= count; i++) {
  console.log(`\n— ящик ${i}/${count} —`);
  try {
    const r = await createMailbox(db, { provider, onStep: log });
    console.log(r.ok ? `OK: ${r.email}` : `✗ ${r.message}`);
    if (r.ok) ok += 1;
  } catch (e) {
    console.error(`✗ ошибка: ${e.message}`);
  }
}
console.log(`\nИтог: успешно ${ok}/${count}.`);
process.exit(0);
