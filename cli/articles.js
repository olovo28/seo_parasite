// Инспекция статей и их ссылок (для приёмки и отладки).
//
//   npm run articles -- list [--site 1] [--status draft] [--limit 20]
//   npm run articles -- show <id>

import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';

const { _: [cmd, arg], flags } = parseArgs();
const db = getDb();

switch (cmd) {
  case 'list': {
    const where = [];
    const params = {};
    if (flags.site) { where.push('site_id = @site'); params.site = Number(flags.site); }
    if (flags.status) { where.push('status = @status'); params.status = flags.status; }
    const sql =
      'SELECT id, site_id, status, title, tracking_id, scheduled_at, published_at, generated_at FROM articles' +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY id DESC LIMIT ${Number(flags.limit ?? 30)}`;
    const rows = db.prepare(sql).all(params);
    if (rows.length === 0) {
      console.log('Статей нет.');
      break;
    }
    for (const r of rows) {
      const title = r.title.length > 50 ? `${r.title.slice(0, 50)}…` : r.title;
      console.log(
        `id=${r.id}\tsite=${r.site_id}\t${r.status.padEnd(9)}\t${r.tracking_id}\tsched=${r.scheduled_at ?? '-'}\t"${title}"`,
      );
    }
    break;
  }
  case 'show': {
    const id = Number(arg);
    if (!id) { console.error('Укажи id статьи.'); process.exit(1); }
    const a = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);
    if (!a) { console.error(`Статья ${id} не найдена.`); process.exit(1); }
    console.log('--- Статья ---');
    for (const k of ['id', 'site_id', 'tracking_id', 'category', 'tags', 'status', 'claude_key_id', 'scheduled_at', 'published_at', 'generated_at', 'error']) {
      console.log(`${k}: ${a[k] ?? '-'}`);
    }
    console.log(`title: ${a.title}`);
    console.log(`body_html (${a.body_html.length} симв.):`);
    console.log(a.body_html.length > 800 ? `${a.body_html.slice(0, 800)}\n…[обрезано]` : a.body_html);

    const links = db.prepare('SELECT * FROM article_links WHERE article_id = ? ORDER BY id').all(id);
    console.log(`\n--- Ссылки (${links.length}) ---`);
    for (const l of links) {
      console.log(`link_id=${l.link_id}\t"${l.anchor}"\t${l.final_url}`);
    }
    break;
  }
  default:
    console.log('Команды: list [--site X] [--status S] [--limit N] | show <id>');
}
