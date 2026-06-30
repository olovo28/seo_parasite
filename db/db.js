// Обёртка better-sqlite3: открытие БД, прагмы, идемпотентное применение схемы.
//
// Путь к файлу БД: DB_PATH из окружения, иначе data/app.db в корне проекта.
// Файл БД и каталог data/ — в .gitignore.

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applySettingsToEnv } from '../lib/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

export const DB_PATH = process.env.DB_PATH
  ? (process.env.DB_PATH.match(/^([A-Za-z]:[\\/]|[\\/])/) ? process.env.DB_PATH : join(ROOT, process.env.DB_PATH))
  : join(ROOT, 'data', 'app.db');

let _db;

// Добавить колонку, если её ещё нет (для БД, созданных по старой схеме).
function ensureColumn(db, table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch (e) {
      // web и scheduler могут стартовать одновременно и оба добавлять колонку — гонка ок
      if (!/duplicate column/i.test(e.message)) throw e;
    }
  }
}

// Идемпотентные миграции для уже существующих БД.
function migrate(db) {
  ensureColumn(db, 'articles', 'category', 'TEXT');
  ensureColumn(db, 'articles', 'tags', 'TEXT');
  ensureColumn(db, 'sites', 'links_per_article', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'sites', 'tags_per_article', 'INTEGER NOT NULL DEFAULT 3');
  ensureColumn(db, 'prompts', 'name', 'TEXT');
  ensureColumn(db, 'prompts', 'link_block', 'TEXT');
  ensureColumn(db, 'prompts', 'tags', 'TEXT');
  ensureColumn(db, 'prompts', 'link_position', 'TEXT');
  ensureColumn(db, 'sites', 'daily_limit', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'sites', 'timezone', "TEXT NOT NULL DEFAULT 'Europe/Vienna'");
  ensureColumn(db, 'articles', 'site_deleted_at', 'TEXT');
  ensureColumn(db, 'articles', 'site_url', 'TEXT');
  ensureColumn(db, 'articles', 'delete_at', 'TEXT');
  ensureColumn(db, 'sites', 'auto_delete', "TEXT NOT NULL DEFAULT 'window_end'");
  ensureColumn(db, 'sites', 'adapter', "TEXT NOT NULL DEFAULT 'meinbezirk'");
  ensureColumn(db, 'sites', 'auto_delete_hours', 'INTEGER NOT NULL DEFAULT 4');
  ensureColumn(db, 'prompts', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'articles', 'no_auto_delete', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'site_accounts', 'cookies', 'TEXT'); // сохранённая сессия сайта (JSON cookies) — чтобы не логиниться каждый раз
  ensureColumn(db, 'site_accounts', 'cookies_updated_at', 'TEXT');
  ensureColumn(db, 'kw_keywords', 'rejected', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'kw_keywords', 'reject_reason', 'TEXT');
  ensureColumn(db, 'semrush_accounts', 'ui_limits', 'TEXT');
  ensureColumn(db, 'semrush_accounts', 'ui_limits_at', 'TEXT');
  ensureColumn(db, 'articles', 'keyword', 'TEXT');
  ensureColumn(db, 'articles', 'rank_check_at', 'TEXT'); // когда проверить позицию в Google (+5 мин от публикации)
  ensureColumn(db, 'articles', 'account_id', 'INTEGER'); // аккаунт публикации статьи (без FK: висячий id → детект «владелец удалён», удалять её именно им)
  ensureColumn(db, 'site_registrations', 'submitted_at', 'TEXT'); // время первого этапа регистрации (→ awaiting_admin)
  ensureColumn(db, 'site_registrations', 'approved_at', 'TEXT');  // время обнаружения одобрения админом
  ensureColumn(db, 'site_registrations', 'last_checked_at', 'TEXT'); // время последней IMAP-проверки одобрения
  ensureColumn(db, 'email_accounts', 'phone', 'TEXT'); // номер верификации (для созданных нами ящиков)
  ensureColumn(db, 'email_accounts', 'country', 'TEXT'); // страна почты → из какого пула брать прокси
  ensureColumn(db, 'proxies', 'country', "TEXT NOT NULL DEFAULT 'at'"); // страна пула прокси
  ensureColumn(db, 'proxies', 'last_assigned_at', 'TEXT'); // ротация: когда прокси последний раз выдавалась
  ensureColumn(db, 'site_prospects', 'score', 'REAL'); // сводный скор «мощность × пригодность»
  ensureColumn(db, 'site_prospects', 'metrics_source', 'TEXT'); // источник метрик (semrush/dataforseo/manual)
  ensureColumn(db, 'site_prospects', 'metrics_updated_at', 'TEXT');
  ensureColumn(db, 'batches', 'max_tokens', 'INTEGER'); // с каким max_tokens отправлен батч (для разбора при сборе)
  ensureColumn(db, 'proxies', 'group_id', 'INTEGER'); // именованная группа прокси (назначение по видам работы)
  // Легаси-прокси раскладываем по СТРАНАМ в авто-группы «Импорт <C>» (все назначения/сайты) — сохраняем гео-разделение
  // исходных списков; поведение выдачи не меняется, пока пользователь не перенастроит. Также расщепляем старую
  // единую группу «Без назначения (импорт)», если осталась от прежней миграции. Идемпотентно.
  {
    const oldG = db.prepare('SELECT id FROM proxy_groups WHERE name = ?').get('Без назначения (импорт)');
    const oldId = oldG ? oldG.id : -1;
    const need = db.prepare('SELECT DISTINCT country FROM proxies WHERE group_id IS NULL OR group_id = ?').all(oldId);
    if (need.length) {
      const ensureCountryGroup = (c) => {
        const nm = 'Импорт ' + String(c || 'at').toUpperCase();
        let g = db.prepare('SELECT id FROM proxy_groups WHERE name = ?').get(nm);
        if (!g) {
          const r = db.prepare("INSERT INTO proxy_groups (name, purposes, site_ids) VALUES (?, 'publish,register,serp', '')").run(nm);
          g = { id: r.lastInsertRowid };
        }
        return g.id;
      };
      const assign = db.prepare('UPDATE proxies SET group_id = ? WHERE country = ? AND (group_id IS NULL OR group_id = ?)');
      for (const { country } of need) assign.run(ensureCountryGroup(country), country, oldId);
      // старую единую группу удаляем, если опустела после расщепления
      if (oldG && !db.prepare('SELECT COUNT(*) c FROM proxies WHERE group_id = ?').get(oldG.id).c) {
        db.prepare('DELETE FROM proxy_groups WHERE id = ?').run(oldG.id);
      }
    }
  }

  // Индексы под горячие запросы (после ensureColumn — колонки гарантированно существуют). IF NOT EXISTS — идемпотентно.
  // Тик планировщика каждые 30с фильтрует по (status, delete_at) и (status, rank_check_at); архив остаётся status='published',
  // поэтому без индекса множество растёт и сканируется целиком. latestRanks на /stats группирует по (article_id, country).
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_delete ON articles(status, delete_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_articles_rankcheck ON articles(status, rank_check_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_article_ranks_latest ON article_ranks(article_id, country, id)');
  // Бэкофилл site_url для уже опубликованных (где пусто) — берём URL из последнего успешного publish_log.
  db.exec(`UPDATE articles SET site_url = (
      SELECT substr(pl.message, instr(pl.message, 'https://'))
      FROM publish_log pl
      WHERE pl.article_id = articles.id AND pl.ok = 1 AND instr(pl.message, 'https://') > 0
      ORDER BY pl.id DESC LIMIT 1)
    WHERE status = 'published' AND (site_url IS NULL OR site_url = '')
      AND EXISTS (SELECT 1 FROM publish_log pl WHERE pl.article_id = articles.id AND pl.ok = 1 AND instr(pl.message, 'https://') > 0)`);

  // Чистка ошибочной таблицы прошлой итерации (заменена на site_accounts: логин/пароль + прокси).
  db.exec('DROP TABLE IF EXISTS site_profiles');
}

// Вернуть singleton-подключение к БД (схема + миграции применяются при первом вызове).
export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000'); // несколько сервисов/контейнеров делят один файл БД
  db.pragma('synchronous = NORMAL'); // под WAL безопасно и дешевле FULL: меньше fsync, короче write-лок (web+scheduler делят файл)
  db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  migrate(db);
  applySettingsToEnv(db); // глобальные настройки из БД → process.env (env приоритетнее)
  _db = db;
  return db;
}
