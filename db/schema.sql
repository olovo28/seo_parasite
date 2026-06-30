-- Схема БД системы автогенерации и публикации статей.
-- Применяется идемпотентно при каждом открытии БД (db/db.js).

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sites (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  name                      TEXT    NOT NULL,
  origin                    TEXT    NOT NULL,
  profile_name              TEXT    NOT NULL,          -- имя профиля Dolphin{anty}
  publish_interval_minutes  INTEGER NOT NULL DEFAULT 5,
  window_start              TEXT    NOT NULL DEFAULT '09:00',
  window_end                TEXT    NOT NULL DEFAULT '21:00',
  binom_param_article       TEXT    NOT NULL DEFAULT 's1',
  binom_param_link          TEXT    NOT NULL DEFAULT 's2',
  links_per_article         INTEGER NOT NULL DEFAULT 3,
  tags_per_article          INTEGER NOT NULL DEFAULT 3,
  daily_limit               INTEGER NOT NULL DEFAULT 0,    -- дневной лимит генерации (0 = без лимита)
  timezone                  TEXT    NOT NULL DEFAULT 'Europe/Vienna', -- часовой пояс окна публикации
  auto_delete               TEXT    NOT NULL DEFAULT 'window_end', -- авто-удаление: 'off' | 'window_end' | 'ttl_capped'
  auto_delete_hours         INTEGER NOT NULL DEFAULT 4,    -- для 'ttl_capped': через N часов после публикации (но ≤ конца окна)
  adapter                   TEXT    NOT NULL DEFAULT 'meinbezirk', -- адаптер сайта (lib/sites/*)
  active                    INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS claude_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT    NOT NULL,
  api_key       TEXT    NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_used_at  TEXT,                                  -- для ротации least-recently-used
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name          TEXT,                               -- имя промта (тип статьи)
  content       TEXT    NOT NULL,
  link_block    TEXT,                               -- авторский блок ссылок (BBCode)
  link_position TEXT,                               -- куда вставлять блок: start|1|2|3|end (по умолч. 1)
  tags          TEXT,                               -- теги через запятую (для article[tag_name_list])
  active        INTEGER NOT NULL DEFAULT 1,
  hidden        INTEGER NOT NULL DEFAULT 0,          -- скрыт из списков (мягкое удаление; статьи по нему не ломаются)
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tracking_id    TEXT    NOT NULL UNIQUE,              -- Binom subid статьи
  category       TEXT,                                 -- имя промта (для отображения/фильтра)
  tags           TEXT,                                 -- теги через запятую (для article[tag_name_list])
  title          TEXT    NOT NULL,
  body_html      TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','scheduled','published','failed')),
  scheduled_at   TEXT,
  published_at   TEXT,
  site_url       TEXT,                                  -- URL опубликованной статьи на сайте (для удаления/просмотра)
  delete_at      TEXT,                                  -- когда АВТО-удалить с сайта (планировщик); local wall-clock
  no_auto_delete INTEGER NOT NULL DEFAULT 0,            -- 1 = «не удалять»: не применять auto_delete сайта при публикации
  keyword        TEXT,                                  -- целевой SEO-ключ (если статья сгенерирована под ключ из базы) — для реестра + джойна с Binom
  rank_check_at  TEXT,                                  -- когда планировщику проверить позицию в Google (UTC; обычно +5 мин от публикации); NULL = не нужно
  site_deleted_at TEXT,                                 -- когда статья удалена С САЙТА (через Dolphin)
  generated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  claude_key_id  INTEGER REFERENCES claude_keys(id) ON DELETE SET NULL,
  account_id     INTEGER,                               -- аккаунт публикации статьи (НЕ FK: id держим висячим, чтобы детектить «владелец удалён» и не подменять чужим)
  error          TEXT
);

CREATE TABLE IF NOT EXISTS article_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  link_id     TEXT    NOT NULL,                        -- Binom subid конкретной ссылки
  anchor      TEXT    NOT NULL,
  base_url    TEXT    NOT NULL,
  final_url   TEXT    NOT NULL,                        -- base_url?{s1}={tracking_id}&{s2}={link_id}
  UNIQUE (article_id, link_id)
);

-- Журнал событий статьи (персистентный): generated/scheduled/published/site_deleted/… для истории на /articles/:id.
CREATE TABLE IF NOT EXISTS article_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id  INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  ts          TEXT    NOT NULL,                       -- UTC 'YYYY-MM-DD HH:MM:SS' (utcStamp)
  kind        TEXT    NOT NULL,                        -- generated|manual|scheduled|unscheduled|delete_at|publish|published|publish_failed|site_delete|site_deleted|site_delete_failed
  message     TEXT
);
CREATE INDEX IF NOT EXISTS idx_article_events ON article_events(article_id, id);

-- Снимки статистики статьи из Content-Cockpit (meinbezirk «Analyse und Benchmark»).
-- Хранятся ВО ВРЕМЕНИ (на каждый сбор — новая строка) → тренд/дельты. Кокпит показывает скользящее
-- окно, поэтому свою историю ведём сами. reason: daily | manual | pre-delete (перед снятием с сайта).
-- 1 статья = 1 целевой ключ (articles.keyword) → seo_views на статью = органика по ключу.
CREATE TABLE IF NOT EXISTS article_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id       INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  captured_at      TEXT    NOT NULL,                  -- UTC момент снимка (utcStamp)
  reason           TEXT,                              -- daily | manual | pre-delete
  total_views      INTEGER,                           -- всего просмотров (Aufrufe)
  seo_views        INTEGER,                           -- из поисковиков (Suchmaschine) — органика
  social_views     INTEGER,
  curated_views    INTEGER,                           -- кураторские блоки сайта (Kuratiert)
  newsletter_views INTEGER,
  qr_views         INTEGER,
  rest_views       INTEGER,                           -- Intern/Extern Rest (прочее)
  avg_time_on_page REAL,                              -- среднее время на странице, сек
  percentile       INTEGER,                           -- бенчмарк-перцентиль (0..99)
  raw_json         TEXT                               -- сырой cockpitData (на будущее: гистограмма/тренд)
);
CREATE INDEX IF NOT EXISTS idx_article_stats ON article_stats(article_id, id);

-- Снимки позиции статьи в Google по её целевому ключу, по странам DACH. Храним во времени → видно,
-- на какой позиции встали и как двигается (оценка эффективности промта). Источник: dolphin (свой скрапер
-- через прокси страны) или api (SERP API, фолбэк). position=NULL → не найдено в проверенной глубине.
CREATE TABLE IF NOT EXISTS article_ranks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id    INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  captured_at   TEXT    NOT NULL,                  -- UTC момент проверки (utcStamp)
  country       TEXT    NOT NULL,                  -- at | de | ch
  keyword       TEXT,                              -- ключ, по которому проверяли
  position      INTEGER,                           -- позиция в органике (1..N); NULL = не найдено
  url           TEXT,                              -- найденный URL нашего результата
  source        TEXT,                              -- dolphin | api
  checked_depth INTEGER,                           -- сколько результатов просмотрено
  error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_article_ranks ON article_ranks(article_id, id);

CREATE TABLE IF NOT EXISTS publish_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id    INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  attempted_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  ok            INTEGER NOT NULL,
  message       TEXT
);

CREATE INDEX IF NOT EXISTS idx_articles_status_sched ON articles(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_articles_site          ON articles(site_id);
CREATE INDEX IF NOT EXISTS idx_keys_enabled_used      ON claude_keys(enabled, last_used_at);

-- Фоновые задачи (генерация/публикация) для асинхронного UI.
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT    NOT NULL,                      -- generate | publish
  status      TEXT    NOT NULL DEFAULT 'running',    -- running | done | failed
  site_id     INTEGER,
  article_id  INTEGER,
  message     TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, updated_at);

-- Пошаговый журнал задач: переживает рестарт web и виден из любого процесса (раньше был только в памяти).
CREATE TABLE IF NOT EXISTS job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  INTEGER NOT NULL,
  ts      INTEGER NOT NULL,                            -- epoch ms (как было в in-memory)
  msg     TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

-- Батчи генерации (Batches API): хранят id батча Anthropic + контекст для сбора результатов.
CREATE TABLE IF NOT EXISTS batches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id       INTEGER NOT NULL,
  prompt_id     INTEGER NOT NULL,
  count         INTEGER NOT NULL,
  batch_id      TEXT    NOT NULL,                    -- id батча в Anthropic
  key_id        INTEGER,                             -- ключ, которым создан батч (им же забирать)
  max_tokens    INTEGER,                             -- с каким max_tokens отправлен (для корректного разбора при сборе)
  status        TEXT    NOT NULL DEFAULT 'submitted',-- submitted | collected
  summary       TEXT,                                -- JSON-итог сбора { persisted, errored, total, ids }
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  collected_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status, id);

-- Идемпотентность сбора батча: один (batch_id, custom_id) → одна статья. Повторный collect не дублирует
-- (раньше при обрыве посреди сбора повторный запуск переписывал ВСЕ succeeded-элементы заново).
CREATE TABLE IF NOT EXISTS batch_items (
  batch_id    TEXT    NOT NULL,
  custom_id   TEXT    NOT NULL,
  article_id  INTEGER,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (batch_id, custom_id)
);

-- Аккаунты публикации сайта: логин/пароль к сайту + СВОЯ прокси (несколько на сайт; выбираются при публикации).
CREATE TABLE IF NOT EXISTS site_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  username    TEXT    NOT NULL,
  password    TEXT    NOT NULL,
  proxy       TEXT,                                  -- строка прокси (parseProxy в lib/accounts.js)
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (site_id, username)
);

CREATE INDEX IF NOT EXISTS idx_site_accounts_site ON site_accounts(site_id, enabled);

-- ===== Регистрация аккаунтов на сайтах сети =====
-- Глобальный пул почтовых ящиков (общий ресурс сети). Провайдер выбирает драйвер lib/mail/*.
-- Правило сети: одна почта используется только на ОДНОМ сайте — реализуется через site_id
-- (NULL = свободна; как только регистрация стартовала, почта «лочится» за сайтом).
CREATE TABLE IF NOT EXISTS email_accounts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  provider           TEXT    NOT NULL DEFAULT 'gmx',  -- почтовый провайдер (lib/mail/*)
  email              TEXT    NOT NULL UNIQUE,
  password           TEXT    NOT NULL,
  proxy              TEXT,                             -- своя прокси (parseProxy в lib/accounts.js)
  country            TEXT,                             -- страна почты → из какого пула брать прокси (миграция ensureColumn)
  cookies            TEXT,                             -- сохранённая сессия почты (JSON CDP)
  cookies_updated_at TEXT,
  status             TEXT    NOT NULL DEFAULT 'new',   -- new | verified(вход ок) | used(зарегистрирован) | bad(вход не удался)
  site_id            INTEGER,                          -- на каком сайте использована (NULL = свободна) — правило уникальности
  enabled            INTEGER NOT NULL DEFAULT 1,
  notes              TEXT,
  phone              TEXT,                             -- номер, на который верифицировали ящик (5sim) — для созданных нами
  last_login_at      TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_accounts_free ON email_accounts(site_id, enabled);

-- Жизненный цикл регистрации (одна почта = одна регистрация).
CREATE TABLE IF NOT EXISTS site_registrations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  email_account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  identity         TEXT,                                -- JSON сгенерированной личности
  site_username    TEXT,                                -- логин аккаунта на сайте (обычно = email)
  site_password    TEXT,                                -- пароль аккаунта на сайте
  status           TEXT    NOT NULL DEFAULT 'pending',
                     -- pending | mail_login_failed | submitted | confirm_failed | awaiting_admin | approved | rejected | failed
  confirm_url      TEXT,                                -- ссылка подтверждения из письма
  next_check_at    TEXT,                                -- когда планировщику проверить одобрение (UTC)
  checks           INTEGER NOT NULL DEFAULT 0,          -- сколько раз проверяли одобрение
  account_id       INTEGER,                             -- созданный site_accounts.id после approved
  submitted_at     TEXT,                                -- когда пройден первый этап (форма+подтверждение → awaiting_admin), UTC
  approved_at      TEXT,                                -- когда обнаружено письмо-одобрение админом, UTC
  last_checked_at  TEXT,                                -- когда последний раз проверяли одобрение по IMAP, UTC
  error            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email_account_id)
);
CREATE INDEX IF NOT EXISTS idx_site_registrations ON site_registrations(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_site_registrations_site ON site_registrations(site_id, id);

-- Пул прокси для СОЗДАНИЯ ящиков (импорт из AT-1.txt). «Свободная» = не закреплена ни за одной почтой
-- (email_accounts.proxy). Контейнер не видит reference/ (.dockerignore) — поэтому пул живёт в БД.
CREATE TABLE IF NOT EXISTS proxies (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  url              TEXT    NOT NULL UNIQUE,   -- строка прокси (parseProxy): scheme://user:pass@host:port
  country          TEXT    NOT NULL DEFAULT 'at', -- страна пула (at/de/ch/…) — выдаётся под страну почты
  group_id         INTEGER,                    -- именованная группа прокси (proxy_groups) с назначением по видам работы
  last_assigned_at TEXT,                       -- когда последний раз выдана (ротация: реюз least-recently-used)
  notes            TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proxies_country ON proxies(country, last_assigned_at);

-- Именованные группы прокси: назначение по видам работы (publish|register|serp) + опц. привязка к сайтам.
CREATE TABLE IF NOT EXISTS proxy_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  purposes    TEXT    NOT NULL DEFAULT 'publish,register,serp', -- CSV из publish|register|serp
  site_ids    TEXT    NOT NULL DEFAULT '',                       -- CSV id сайтов; пусто = все сайты
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ===== Каталог площадок-кандидатов (parasite SEO discovery) =====
-- Доноры для публикации: внесли домен → ведём статус/метрики/заметки → пишем модули регистрации и
-- публикации → наблюдаем, переживут ли статьи модерацию. Принятый кандидат связывается с sites
-- (adopted_site_id) и получает адаптер (adapter, lib/sites/*). Источник кандидатов — footprint движка
-- (meinbezirk.at = PEIQ): база клиентов PEIQ + SERP по сигнатурам.
CREATE TABLE IF NOT EXISTS site_prospects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  domain            TEXT    NOT NULL UNIQUE,           -- голый домен (example.de), нижний регистр без www/схемы
  name              TEXT,                               -- название издания/площадки
  engine            TEXT    NOT NULL DEFAULT 'peiq',    -- движок/CMS (footprint): peiq | unknown | ...
  country           TEXT,                               -- de/at/ch/it...
  discovery_source  TEXT,                               -- как нашли: peiq-kunden | serp | sibling | manual
  authority         REAL,                               -- DR/DA/AS (из SEMrush; заполняется позже)
  traffic           INTEGER,                            -- орг. трафик/мес (из SEMrush; позже)
  score             REAL,                               -- наш сводный скор «мощность × пригодность» (computeScore)
  metrics_source    TEXT,                               -- откуда метрики: semrush | dataforseo | manual
  metrics_updated_at TEXT,                              -- когда обновляли метрики
  has_register      INTEGER,                            -- признак UGC (1/0/NULL=не проверено): есть форма регистрации
  has_ugc_form      INTEGER,                            -- 1/0/NULL: есть форма создания статьи (Leser-/Bürgerreporter)
  dofollow          INTEGER,                            -- 1/0/NULL: ссылки в теле статьи dofollow
  status            TEXT    NOT NULL DEFAULT 'new',
                      -- new | qualified | rejected | registering | publishing | testing | live | dead | paused
  reject_reason     TEXT,                               -- почему отклонён/мёртв
  adapter           TEXT,                               -- имя адаптера lib/sites/* (когда написан)
  adopted_site_id   INTEGER REFERENCES sites(id) ON DELETE SET NULL, -- связь с боевым сайтом после принятия
  url               TEXT,                               -- опц. конкретный URL (форма регистрации/пример статьи)
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_prospects_status ON site_prospects(status, id);

-- Журнал по кандидату: ручные комментарии + автозаписи смены статуса (хронология).
CREATE TABLE IF NOT EXISTS prospect_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prospect_id INTEGER NOT NULL REFERENCES site_prospects(id) ON DELETE CASCADE,
  ts          TEXT    NOT NULL DEFAULT (datetime('now')),
  kind        TEXT    NOT NULL DEFAULT 'note',          -- note | status | system
  text        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prospect_notes ON prospect_notes(prospect_id, id);

-- Глобальные настройки key-value (Dolphin API токен и пр.). Гидратируют process.env при старте.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== SEO-анализ ключей через SEMrush (модуль «Анализ») =====
-- Аккаунты SEMrush (триалы эфемерны): API-ключ для API-драйвера + email/пароль/прокси/cookies для UI-драйвера (Dolphin).
CREATE TABLE IF NOT EXISTS semrush_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  label             TEXT,
  email             TEXT,
  password          TEXT,
  api_key           TEXT,
  proxy             TEXT,                              -- для UI-драйвера через Dolphin (parseProxy)
  cookies           TEXT,                              -- сохранённая UI-сессия SEMrush (JSON)
  cookies_updated_at TEXT,
  units_balance     INTEGER,                           -- кэш остатка API-юнитов
  units_checked_at  TEXT,
  ui_limits         TEXT,                              -- кэш UI-лимитов (JSON: remaining_updates/max_updates/rows_count/trial)
  ui_limits_at      TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Прогон анализа: набор seed-слов × баз, источник, аккаунт, итог Claude.
CREATE TABLE IF NOT EXISTS kw_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  direction   TEXT,                                    -- напр. 'betting-DACH'
  source      TEXT NOT NULL DEFAULT 'api',             -- api | ui | auto
  seeds       TEXT,                                    -- JSON-массив seed-слов
  databases   TEXT,                                    -- JSON-массив баз (de/at/ch)
  account_id  INTEGER REFERENCES semrush_accounts(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'running',         -- running | done | failed
  units_used  INTEGER NOT NULL DEFAULT 0,
  analysis    TEXT,                                    -- шорт-лист/обоснование от Claude
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ключи прогона с метриками SEMrush + наш score.
CREATE TABLE IF NOT EXISTS kw_keywords (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES kw_runs(id) ON DELETE CASCADE,
  source      TEXT,                                    -- api | ui (откуда взят)
  database    TEXT,
  phrase      TEXT NOT NULL,
  volume      INTEGER,
  cpc         REAL,
  competition REAL,
  kd          REAL,                                    -- keyword difficulty %
  intent      TEXT,
  trend       TEXT,
  results     INTEGER,
  score       REAL,
  rejected    INTEGER NOT NULL DEFAULT 0,            -- 1 = отклонён (мусор/паразит); хранится, но не в выгрузке «хороших»
  reject_reason TEXT,                                 -- почему отклонён
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_id, database, phrase)
);
CREATE INDEX IF NOT EXISTS idx_kw_keywords_run ON kw_keywords(run_id, score);

-- Списки ключей (рабочие наборы): отбираем из результатов анализа, отрабатываем постепенно.
CREATE TABLE IF NOT EXISTS kw_lists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kw_list_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id     INTEGER NOT NULL REFERENCES kw_lists(id) ON DELETE CASCADE,
  phrase      TEXT NOT NULL,
  database    TEXT,
  volume      INTEGER,
  kd          REAL,
  intent      TEXT,
  cpc         REAL,
  score       REAL,
  status      TEXT NOT NULL DEFAULT 'new',            -- new | testing | winner | loser | skip
  article_id  INTEGER REFERENCES articles(id) ON DELETE SET NULL,
  notes       TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (list_id, phrase, database)
);
CREATE INDEX IF NOT EXISTS idx_kw_list_items ON kw_list_items(list_id, status);

