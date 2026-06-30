// CLI управления сайтами (таблица sites).
//
//   npm run sites -- add --name meinbezirk --origin https://www.meinbezirk.at --profile "Profile 6" \
//                        [--interval 5 --window-start 09:00 --window-end 21:00 --binom-article s1 --binom-link s2]
//   npm run sites -- list
//   npm run sites -- set-interval <id> <minutes>
//   npm run sites -- set-window <id> <start> <end>
//   npm run sites -- enable <id>
//   npm run sites -- disable <id>

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';

const { _: [cmd, a1, a2, a3], flags } = parseArgs();
const db = getDb();

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
    if (!flags.name || !flags.origin || !flags.profile) {
      console.error('Нужны --name, --origin, --profile.');
      process.exit(1);
    }
    const info = db
      .prepare(`
        INSERT INTO sites (name, origin, profile_name, publish_interval_minutes,
                           window_start, window_end, binom_param_article, binom_param_link)
        VALUES (@name, @origin, @profile, @interval, @ws, @we, @ba, @bl)
      `)
      .run({
        name: flags.name,
        origin: flags.origin,
        profile: flags.profile,
        interval: Number(flags.interval ?? 5),
        ws: flags['window-start'] ?? '09:00',
        we: flags['window-end'] ?? '21:00',
        ba: flags['binom-article'] ?? 's1',
        bl: flags['binom-link'] ?? 's2',
      });
    console.log(`Сайт добавлен: id=${info.lastInsertRowid}, "${flags.name}".`);
    break;
  }
  case 'list': {
    const rows = db.prepare('SELECT * FROM sites ORDER BY id').all();
    if (rows.length === 0) {
      console.log('Сайтов нет.');
      break;
    }
    for (const r of rows) {
      console.log(
        `id=${r.id}\t${r.active ? 'ON ' : 'OFF'}\t"${r.name}"\t${r.origin}\tprofile="${r.profile_name}"` +
          `\tинтервал=${r.publish_interval_minutes}м\tокно=${r.window_start}-${r.window_end}` +
          `\tbinom=${r.binom_param_article}/${r.binom_param_link}`,
      );
    }
    break;
  }
  case 'set-interval': {
    const id = requireId(a1);
    const min = Number(a2);
    if (!min) {
      console.error('Использование: set-interval <id> <minutes>');
      process.exit(1);
    }
    const res = db.prepare('UPDATE sites SET publish_interval_minutes = ? WHERE id = ?').run(min, id);
    console.log(res.changes ? `Сайт ${id}: интервал ${min} мин.` : `Сайт ${id} не найден.`);
    break;
  }
  case 'set-window': {
    const id = requireId(a1);
    if (!a2 || !a3) {
      console.error('Использование: set-window <id> <start> <end>');
      process.exit(1);
    }
    const res = db.prepare('UPDATE sites SET window_start = ?, window_end = ? WHERE id = ?').run(a2, a3, id);
    console.log(res.changes ? `Сайт ${id}: окно ${a2}-${a3}.` : `Сайт ${id} не найден.`);
    break;
  }
  case 'enable':
  case 'disable': {
    const id = requireId(a1);
    const res = db.prepare('UPDATE sites SET active = ? WHERE id = ?').run(cmd === 'enable' ? 1 : 0, id);
    console.log(res.changes ? `Сайт ${id}: ${cmd === 'enable' ? 'включён' : 'отключён'}.` : `Сайт ${id} не найден.`);
    break;
  }
  default:
    console.log(
      'Команды: add --name --origin --profile [--interval --window-start --window-end --binom-article --binom-link] | ' +
        'list | set-interval <id> <min> | set-window <id> <start> <end> | enable <id> | disable <id>',
    );
}
