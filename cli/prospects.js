// CLI каталога площадок-кандидатов (таблица site_prospects).
//
//   npm run prospects -- list [--status new]
//   npm run prospects -- add --domain myheimat.de [--name myHeimat] [--engine peiq] [--country de] [--source peiq-kunden]
//   npm run prospects -- import --file domains.txt [--engine peiq] [--country de] [--source peiq-kunden]
//   npm run prospects -- status <id> <status> [--reason "..."]
//   npm run prospects -- note <id> --text "комментарий"
//   npm run prospects -- seed          (внести найденные PEIQ-кандидаты)
//   npm run prospects -- remove <id>
//   npm run prospects -- classify <id>             (скачать сайт → движок/UGC/dofollow)
//   npm run prospects -- classify-new [--limit 20] (классифицировать все new)
//   npm run prospects -- discover --url <u> [--country de]  (страница-источник → домены → импорт)
//   npm run prospects -- dorks [--seed "site:.at"]

import { readFileSync } from 'node:fs';
import { getDb } from '../db/db.js';
import { parseArgs } from '../lib/args.js';
import {
  PROSPECT_STATUSES,
  listProspects,
  addProspect,
  importProspects,
  importMetrics,
  recomputeScores,
  setStatus,
  addNote,
  removeProspect,
  seedProspects,
} from '../lib/prospects.js';
import { runClassify, discoverFromUrl, buildDorks, enrichMetrics } from '../lib/prospecting/index.js';

const { _: [cmd, arg, arg2], flags } = parseArgs();
const db = getDb();

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
    const rows = listProspects(db, { status: flags.status, sort: flags.sort });
    if (!rows.length) {
      console.log('Кандидатов нет.');
      break;
    }
    for (const r of rows) {
      const st = PROSPECT_STATUSES[r.status]?.label || r.status;
      console.log(
        `id=${r.id}\tскор=${r.score ?? '-'}\t${r.domain}\t[${r.engine}/${r.country || '-'}]\t${st}\tDR=${r.authority ?? '-'}\tтрафик=${r.traffic ?? '-'}\tUGC=${r.has_ugc_form ?? '?'}\t${r.name || ''}`,
      );
    }
    break;
  }
  case 'add': {
    if (!flags.domain) {
      console.error('Нужен --domain.');
      process.exit(1);
    }
    const id = addProspect(db, { domain: flags.domain, name: flags.name, engine: flags.engine, country: flags.country, discovery_source: flags.source });
    console.log(`Добавлен кандидат #${id}: ${flags.domain}`);
    break;
  }
  case 'import': {
    if (!flags.file) {
      console.error('Нужен --file <path> (по строке: домен[, Название]).');
      process.exit(1);
    }
    const text = readFileSync(flags.file, 'utf8');
    const r = importProspects(db, text, { engine: flags.engine, country: flags.country, discovery_source: flags.source });
    console.log(`Импорт: добавлено ${r.added}, дублей ${r.skipped}, ошибок ${r.errors.length}.`);
    for (const e of r.errors) console.log(`  ! ${e}`);
    break;
  }
  case 'status': {
    const id = requireId(arg);
    if (!arg2) {
      console.error(`Укажи статус: ${Object.keys(PROSPECT_STATUSES).join(' | ')}`);
      process.exit(1);
    }
    setStatus(db, id, arg2, flags.reason);
    console.log(`#${id}: статус → ${arg2}`);
    break;
  }
  case 'note': {
    const id = requireId(arg);
    if (!flags.text) {
      console.error('Нужен --text "...".');
      process.exit(1);
    }
    addNote(db, id, flags.text, 'note');
    console.log(`#${id}: заметка добавлена.`);
    break;
  }
  case 'seed': {
    const n = seedProspects(db);
    console.log(`Засеяно новых: ${n}.`);
    break;
  }
  case 'remove': {
    const id = requireId(arg);
    removeProspect(db, id);
    console.log(`#${id}: удалён.`);
    break;
  }
  case 'classify': {
    const id = requireId(arg);
    const r = await runClassify(db, id);
    if (r.ok) console.log(`#${id} ${r.domain}: движок=${r.engine || 'не PEIQ'}, рег=${r.has_register}, форма=${r.has_ugc_form}, dofollow=${r.dofollow}`);
    else console.log(`#${id}: классификация не удалась — ${r.error}`);
    break;
  }
  case 'classify-new': {
    const limit = Number(flags.limit) || 1000;
    const rows = listProspects(db, { status: 'new' }).slice(0, limit);
    console.log(`Классифицирую ${rows.length} кандидатов (status=new)…`);
    let ok = 0;
    for (const p of rows) {
      const r = await runClassify(db, p.id);
      if (r.ok) ok += 1;
      console.log(`  #${p.id} ${p.domain}: ${r.ok ? `движок=${r.engine || 'не PEIQ'}, рег=${r.has_register}, форма=${r.has_ugc_form}, dofollow=${r.dofollow}` : 'ошибка: ' + r.error}`);
    }
    console.log(`Готово: успешно ${ok}/${rows.length}.`);
    break;
  }
  case 'discover': {
    if (!flags.url) {
      console.error('Нужен --url <страница-источник>.');
      process.exit(1);
    }
    const r = await discoverFromUrl(db, flags.url, { country: flags.country });
    if (r.ok) console.log(`Найдено доменов ${r.domains.length}, добавлено ${r.added}, дублей ${r.skipped}.`);
    else console.log(`Дискавери не удалась: ${r.error}`);
    break;
  }
  case 'dorks': {
    for (const q of buildDorks(flags.seed || '')) console.log(q);
    break;
  }
  case 'import-metrics': {
    if (!flags.file) {
      console.error('Нужен --file <csv> (колонки domain, authority, traffic — по заголовку или порядку).');
      process.exit(1);
    }
    const text = readFileSync(flags.file, 'utf8');
    const r = importMetrics(db, text, { source: flags.source || 'semrush' });
    console.log(`Метрики: обновлено ${r.updated}, не найдено в базе ${r.unmatched}, ошибок ${r.errors.length}.`);
    for (const e of r.errors) console.log(`  ! ${e}`);
    break;
  }
  case 'rescore': {
    console.log(`Пересчитан скор у ${recomputeScores(db)} кандидатов.`);
    break;
  }
  case 'enrich-metrics': {
    const ids = arg ? [Number(arg)] : undefined; // enrich-metrics <id> — один; иначе все без метрик
    const r = await enrichMetrics(db, { ids, database: flags.database || 'de', limit: Number(flags.limit) || 1000 });
    console.log(`SEMrush[${r.account}]: обогащено ${r.enriched}${r.unitsLeft != null ? `, юнитов осталось ${r.unitsLeft}` : ''}.`);
    for (const x of r.results) console.log(`  ${x.domain}: AS=${x.authority ?? '—'} трафик=${x.traffic ?? '—'} → скор=${x.score}`);
    break;
  }
  default:
    console.log(
      'Команды: list [--status] | add --domain [--name --engine --country --source] | import --file [--engine --country --source] | status <id> <status> [--reason] | note <id> --text | seed | remove <id> | classify <id> | classify-new [--limit] | discover --url [--country] | dorks [--seed] | import-metrics --file [--source] | rescore | enrich-metrics [<id>] [--database de --limit N]',
    );
}
