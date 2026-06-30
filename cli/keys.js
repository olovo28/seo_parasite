// CLI управления API-ключами Claude (таблица claude_keys).
//
//   npm run keys -- add --label "key1" --key sk-ant-... [--notes "..."]
//   npm run keys -- list
//   npm run keys -- enable <id>
//   npm run keys -- disable <id>
//   npm run keys -- remove <id>

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';

const { _: [cmd, arg], flags } = parseArgs();
const db = getDb();

// Маскируем ключ при выводе, чтобы не светить секрет целиком.
function mask(key) {
  if (!key) return '';
  return key.length <= 12 ? key : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

function requireId(value) {
  const id = Number(value);
  if (!id) {
    console.error('Укажи числовой id.');
    process.exit(1);
  }
  return id;
}

switch (cmd) {
  case 'add': {
    if (!flags.label || !flags.key) {
      console.error('Нужны --label и --key.');
      process.exit(1);
    }
    const info = db
      .prepare('INSERT INTO claude_keys (label, api_key, notes) VALUES (?, ?, ?)')
      .run(flags.label, flags.key, flags.notes ?? null);
    console.log(`Ключ добавлен: id=${info.lastInsertRowid}, label="${flags.label}".`);
    break;
  }
  case 'list': {
    const rows = db.prepare('SELECT * FROM claude_keys ORDER BY id').all();
    if (rows.length === 0) {
      console.log('Ключей нет.');
      break;
    }
    for (const r of rows) {
      console.log(
        `id=${r.id}\t${r.enabled ? 'ON ' : 'OFF'}\t${mask(r.api_key)}\t"${r.label}"\tlast_used=${r.last_used_at ?? '-'}`,
      );
    }
    break;
  }
  case 'enable':
  case 'disable': {
    const id = requireId(arg);
    const res = db
      .prepare('UPDATE claude_keys SET enabled = ? WHERE id = ?')
      .run(cmd === 'enable' ? 1 : 0, id);
    console.log(res.changes ? `Ключ ${id}: ${cmd === 'enable' ? 'включён' : 'отключён'}.` : `Ключ ${id} не найден.`);
    break;
  }
  case 'remove': {
    const id = requireId(arg);
    const res = db.prepare('DELETE FROM claude_keys WHERE id = ?').run(id);
    console.log(res.changes ? `Ключ ${id} удалён.` : `Ключ ${id} не найден.`);
    break;
  }
  default:
    console.log('Команды: add --label --key [--notes] | list | enable <id> | disable <id> | remove <id>');
}
