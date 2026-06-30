// CLI управления пулом почт (таблица email_accounts).
//
//   npm run emails -- list
//   npm run emails -- add --email a@gmx.at --password pw [--provider gmx] [--proxy host:port:u:p]
//   npm run emails -- import --file emails.txt   (строки "email:password[:host:port:u:p]")
//   npm run emails -- enable <id> | disable <id> | remove <id> | release <id>

import { readFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import { listEmailAccounts, addEmailAccount, importEmailAccounts, toggleEmailAccount, removeEmailAccount, releaseEmail } from '../lib/emailAccounts.js';

const { _: [cmd, arg], flags } = parseArgs();
const db = getDb();

function mask(v) {
  if (!v) return '';
  return v.length <= 3 ? '•••' : `${v.slice(0, 2)}•••${v.slice(-1)}`;
}
function requireId(v) {
  const id = Number(v);
  if (!id) {
    console.error('Укажи числовой id.');
    process.exit(1);
  }
  return id;
}

switch (cmd) {
  case 'list': {
    const rows = listEmailAccounts(db);
    if (!rows.length) {
      console.log('Почт нет.');
      break;
    }
    for (const r of rows) {
      console.log(`id=${r.id}\t${r.enabled ? 'ON ' : 'OFF'}\t${r.provider}\t${r.email}\t${mask(r.password)}\tстатус=${r.status}\tсайт=${r.site_id ?? '-'}\tпрокси=${(r.proxy || '-').split(':')[0]}`);
    }
    break;
  }
  case 'add': {
    if (!flags.email || !flags.password) {
      console.error('Нужны --email и --password.');
      process.exit(1);
    }
    addEmailAccount(db, { provider: flags.provider, email: flags.email, password: flags.password, proxy: flags.proxy, notes: flags.notes });
    console.log(`Почта ${flags.email} добавлена.`);
    break;
  }
  case 'import': {
    if (!flags.file) {
      console.error('Нужен --file <path> (строки "email:password[:host:port:u:p]").');
      process.exit(1);
    }
    const text = readFileSync(flags.file, 'utf8');
    const r = importEmailAccounts(db, text, { provider: flags.provider });
    console.log(`Импорт: добавлено ${r.added}, пропущено дублей ${r.skipped}, ошибок ${r.errors.length}.`);
    for (const e of r.errors) console.log(`  ! ${e}`);
    break;
  }
  case 'enable':
  case 'disable': {
    toggleEmailAccount(db, requireId(arg));
    console.log(`Почта ${arg}: переключена.`);
    break;
  }
  case 'release': {
    releaseEmail(db, requireId(arg));
    console.log(`Почта ${arg}: освобождена от сайта.`);
    break;
  }
  case 'remove': {
    removeEmailAccount(db, requireId(arg));
    console.log(`Почта ${arg}: удалена.`);
    break;
  }
  default:
    console.log('Команды: list | add --email --password [--provider --proxy --notes] | import --file | enable <id> | disable <id> | release <id> | remove <id>');
}
