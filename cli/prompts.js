// CLI управления промтами сайтов (таблица prompts). У сайта активен один промт.
//
//   npm run prompts -- set --site 1 --content "Напиши статью про..."
//   npm run prompts -- set --site 1 --file path/to/prompt.txt
//   npm run prompts -- list --site 1
//   npm run prompts -- activate <id>

import { readFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';

const { _: [cmd, arg], flags } = parseArgs();
const db = getDb();

function requireId(value, what = 'id') {
  const id = Number(value);
  if (!id) {
    console.error(`Укажи числовой ${what}.`);
    process.exit(1);
  }
  return id;
}

switch (cmd) {
  case 'set': {
    const siteId = requireId(flags.site, '--site');
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(siteId)) {
      console.error(`Сайт ${siteId} не найден.`);
      process.exit(1);
    }
    let content = flags.content;
    if (flags.file) content = readFileSync(flags.file, 'utf8');
    if (!content) {
      console.error('Нужен --content "..." или --file path.');
      process.exit(1);
    }
    const id = db.transaction(() => {
      db.prepare('UPDATE prompts SET active = 0 WHERE site_id = ?').run(siteId);
      return db
        .prepare('INSERT INTO prompts (site_id, content, active) VALUES (?, ?, 1)')
        .run(siteId, content).lastInsertRowid;
    })();
    console.log(`Промт сохранён и активирован: id=${id}, site=${siteId}.`);
    break;
  }
  case 'list': {
    const siteId = requireId(flags.site, '--site');
    const rows = db.prepare('SELECT * FROM prompts WHERE site_id = ? ORDER BY id').all(siteId);
    if (rows.length === 0) {
      console.log(`У сайта ${siteId} промтов нет.`);
      break;
    }
    for (const r of rows) {
      const preview = r.content.replace(/\s+/g, ' ').slice(0, 70);
      console.log(`id=${r.id}\t${r.active ? 'ACTIVE  ' : 'inactive'}\t${r.created_at}\t"${preview}${r.content.length > 70 ? '…' : ''}"`);
    }
    break;
  }
  case 'activate': {
    const id = requireId(arg);
    const row = db.prepare('SELECT site_id FROM prompts WHERE id = ?').get(id);
    if (!row) {
      console.error(`Промт ${id} не найден.`);
      process.exit(1);
    }
    db.transaction(() => {
      db.prepare('UPDATE prompts SET active = 0 WHERE site_id = ?').run(row.site_id);
      db.prepare('UPDATE prompts SET active = 1 WHERE id = ?').run(id);
    })();
    console.log(`Промт ${id} активирован (site=${row.site_id}).`);
    break;
  }
  default:
    console.log('Команды: set --site X (--content "..." | --file path) | list --site X | activate <id>');
}
