# CLAUDE.md

Рекомендации для Claude Code при работе с этим репозиторием.

**Проект — система автогенерации и публикации статей:** промт + ключ → **Claude API** → статья → публикация на **meinbezirk.at** по расписанию через **Dolphin{anty}+puppeteer**, с трекингом ссылок в **Binom**. Генерация и публикация **разделены во времени** и связаны только через SQLite.

---

## ВАЖНЫЕ ПРАВИЛА

- **Всегда отвечай на русском языке.**
- **Не оставляй следов авторства ИИ.** Никаких упоминаний Claude/AI/Anthropic в коде, комментариях, коммитах, PR — в т.ч. строк `Co-Authored-By: Claude` и «Generated with Claude Code». Коммиты и текст — нейтральные, как от обычного разработчика.
- **Никаких эмодзи — нигде** (UI, тексты кнопок/заголовков, комментарии, коммиты). Для иконок используй вшитый флэт-набор **Tabler Icons**: `<i class="ti ti-NAME"></i>` (через `@tabler/icons-webfont`, отдаётся по `/static/icons/`). Подбирай осмысленную иконку (как Material). Список имён — на tabler.io/icons.
- **Генерация через Claude API платная.** НЕ запускай `npm run generate` / батчи (реальные вызовы API) без явного разрешения. Логику проверяй детерминированно (импорт модулей, `node -e` на чистых функциях, `npm test`).
- **НЕ публикуй и НЕ удаляй статьи на боевом сайте без явного разрешения.** Публикация (`#article_publish`) и удаление (`POST /a/article/delete/{id}`) — реальные действия. Тестируй на ОДНОЙ статье. **Живые прогоны запускает пользователь.**
- **Профиль Dolphin запускать ТОЛЬКО с рабочей прокси.** `lib/browser.js` это проверяет (прокси настроена + внешний IP отвечает); не обходи проверку.
- **Секреты не коммить.** Ключи Claude — в БД (`claude_keys`), токен Dolphin и пароль аккаунтов — в `.env`/`site_accounts`. Файл БД (`data/`), `.env`, `diagnostics/` — в `.gitignore`.
- **Все команды — из корня проекта.** Git: не коммить без запроса; перед коммитом проверяй, что секреты и `data/` не в индексе.
- **Проверка изменений:** `npm test` должен оставаться зелёным; UI — смоук HTTP-запросом; после правок кода в Docker — пересборка `docker compose up -d --build web scheduler`.

---

## Обзор и архитектура

```
[Генератор]  ──пишет статьи──▶  [SQLite]  ──читает по расписанию──▶  [Публикатор]
 Claude API                     sites, claude_keys, prompts,         puppeteer + Dolphin{anty}
 (реалтайм + Batches)            site_accounts, articles,             → meinbezirk.at /a/article/new
                                 article_links, article_events,             ▲
                                 publish_log, jobs, settings        [Планировщик scheduler.js]
                                                                    раскладка draft→scheduled +
                                                                    публикация по времени + автоудаление
```

- **Язык/рантайм:** Node.js, ESM (`"type": "module"`). Контейнеры — UTC.
- **Хранилище:** SQLite через `better-sqlite3` (один файл `data/app.db`, WAL, синхронный).
- **Генерация:** `@anthropic-ai/sdk`, модель по умолчанию `claude-opus-4-8`, структурированный вывод (json_schema) + стриминг; релизный путь — Batches API (−50%, общий код, иной транспорт).
- **Публикация:** `puppeteer-core` поверх профилей Dolphin{anty} (Remote+Local API).
- **Веб-админка:** Fastify v5, серверный рендер (template literals), тема Tabler (Bootstrap 5.3, вшита локально через `@fastify/static`), signed-cookie авторизация.

## Канон времени (КРИТИЧНО)

Все времена статей хранятся в **UTC**, отображаются в **часовом поясе сайта**. `lib/time.js`:
- `utcStamp(d?)` — запись текущего/заданного момента в UTC-строку.
- `parseStamp(s)` — UTC-строка → epoch (мс).
- `fmtInTz(s, tz)` — UTC → строка во времени сайта (для UI).
- `zonedToEpoch(date, time, tz)` / `epochToZoned(ep, tz)` — конверсия ввода/вывода с учётом DST.
- `nextDailyOccurrence(hhmm, tz, fromEpoch?)` — ближайшее наступление времени суток (для окна/удаления).

Контейнер живёт в UTC — канон от TZ процесса не зависит. НЕ храни локальное wall-clock.

## Команды

```
npm run web                                   # веб-админка (:3000)
npm run scheduler                             # тик публикации/удаления (в Docker — отдельный сервис)
npm run generate -- --site 1 [--category ..]  # генерация (ПЛАТНО — только с разрешения)
npm run generate-batch -- --site 1 --count K  # Batches (ПЛАТНО)
npm run sites|keys|prompts|articles -- ...     # CLI управления
npm run profiles | login | start-profile      # операции с Dolphin (scripts/)
```
Нужен `.env` с `DOLPHIN_API_TOKEN` (см. `.env.example`).

## Docker / деплой

Dolphin{anty} — на ХОСТЕ (Windows). Node-код — в Docker: один образ, сервисы `web`/`scheduler`/`generator`, общий том `appdata` (`/data/app.db`), `restart: unless-stopped`.
- `docker compose up -d --build web scheduler` — пересобрать+поднять (после правок кода).
- Контейнеры ходят к Dolphin на хосте через `host.docker.internal` (`DOLPHIN_HOST` + `extra_hosts`). Связка проверена вживую (Local API на `0.0.0.0:3001`, puppeteer из контейнера цепляется к браузеру хоста; `dolphin.js` резолвит host→IP для CDP).
- Автозапуск после ребута: Docker Desktop → «Start on login» (разово, GUI); стек поднимется сам. Отдельная Windows-служба для scheduler НЕ нужна.

## Структура

```
db/        schema.sql (DDL), db.js (обёртка + идемпотентные миграции ensureColumn)
lib/       dolphin.js (профили/puppeteer), browser.js (запуск профиля+прокси-гейт, cookie-хелперы),
           sites/ (адаптеры: meinbezirk.js + index.js-реестр), claude.js (генерация),
           keys.js (ротация LRU), linkblock.js (блок ссылок+Binom), bbcode.js (HTML→BBCode),
           accounts.js (аккаунты сайта + сессии), publisher.js (оркестрация публ/удаления),
           publishArticle.js (публ/удаление по id + авто-delete_at), generateArticle.js,
           batch.js, distribute.js (раскладка), jobs.js (фоновые задачи), events.js (журнал статьи),
           settings.js, time.js (UTC-канон)
cli/       sites, keys, prompts, articles, generate, publish, ...
scripts/   login, get-profiles, start-profile, diagnose-login.js (диагностика логина),
           test-cookie-session.js (проверка переиспользования сессии)
web/       server.js, routes.js (все роуты+рендер), views.js (layout/NAV/тема)
scheduler.js   долгоживущий тик: публикует созревшие scheduled + удаляет созревшие delete_at; пишет heartbeat
test/      node --test (time/bbcode/linkblock/distribute/sites/events)
data/app.db    SQLite (gitignore)
```

## Ключевые детали

### Адаптеры сайтов (`lib/sites/*`)
Общий код нейтрален к сайту; сайт-специфика — в адаптере. Сайт выбирает адаптер полем `sites.adapter` (дефолт `meinbezirk`). Адаптер: `login`, `isLoggedIn`, `publish`, `deleteArticle`, `parseSiteArticleId`, `formatBody`, `previewHtml`. Реестр + `getAdapter(name)` — в `lib/sites/index.js`. **Новый сайт = новый модуль + строка в реестре.**
- **meinbezirk:** логин (`#username`/`#password`/`#_submit`, отмечает «angemeldet bleiben» `#remember_me`, подавляет плашки OneTrust/CleverPush — см. ниже); публикация на `/a/article/new` (`#article_title`, `#article_category`=18, тело **BBCode** в WysiBB `#article_content_text`, теги selectize ≥2, кнопка `#article_publish`); удаление — `POST /a/article/delete/{id}` (XHR с куками).

### Подавление плашек / быстрый логин
По диагностике (`scripts/diagnose-login.js`) cookie-баннер OneTrust и push-модал CleverPush всплывают с задержкой и перекрывают форму. `suppressOverlays` в адаптере **скрывает их стилем + кликает deny** (без долгих ожиданий), submit идёт **прямым кликом мимо оверлея** — логин ускорен с ~27с до ~5с.

### Cookie-сессии (без логина каждый раз)
Профиль с прокси одноразовый → раньше логинились на каждую из ~50 статей/сутки. Теперь сессия переиспользуется:
- `lib/browser.js`: `captureCookies`/`restoreCookies` (через CDP, site-agnostic).
- `site_accounts.cookies` (+ `cookies_updated_at`) — сохранённая сессия per-аккаунт.
- `lib/publisher.js` `ensureLoggedIn`: восстановить cookies → `adapter.isLoggedIn` → **логин пропустить**; если протухло — обычный логин + пересохранение.
- `withReauth`: если выкинуло из аккаунта **во время** публикации/удаления (адаптер кидает ошибку с `needLogin=true` — детект редиректа на `/login` после сабмита / XHR `redirect:'manual'`), оркестратор **перелогинивается и повторяет** один раз. Никаких ложных «успехов».
- UI: в настройках сайта у аккаунта колонка «сессия» (✓ есть / дата) + кнопка «⟳ сессия» (сброс).

Проверено экспериментом: сессия переживает пересоздание профиля. Нюанс: прокси-гейт может выдать другой IP — тогда сессия отвалится, но система сама залогинится заново (без участия пользователя).

### Регистрация аккаунтов (`lib/registrar.js`, `lib/mail/*`, `lib/captcha/*`, `lib/identity.js`)
Создание аккаунтов публикации на сайтах сети по пулу почт. Модульно: почтовые провайдеры
(`lib/mail/`, реестр `index.js`, драйвер `gmx.js`), решатели капч (`lib/captcha/`, `twocaptcha.js` —
2captcha-совместимый, поддерживает картинку и CaptchaFox), регистрация — capability адаптера сайта
(`meinbezirk.js`: `register`/`confirmationEmail`/`extractConfirmUrl`/`confirmRegistration`/`approvalEmail`/`isApproved`).
Оркестрация нейтральна (`lib/registrar.js`): `registerOnSite` (проверка ящика по IMAP → профиль с прокси →
форма+капча → письмо подтверждения по IMAP → переход по ссылке → `awaiting_admin`) и `checkApproval`
(через сутки, по IMAP, БЕЗ Dolphin → при одобрении создаёт `site_accounts`). Планировщик дергает
`checkApproval` для созревших (`site_registrations.next_check_at`). Личность DACH — `lib/identity.js`.

**Данные:** `email_accounts` (глобальный пул почт; правило сети «одна почта = один сайт» через
`site_id`; прокси у каждой почты), `site_registrations` (жизненный цикл). UI: страница `/emails` +
блок «Регистрация» в настройках сайта; CLI `npm run emails` / `npm run register`. Ключ капчи — в
настройках (`captcha_provider`/`captcha_api_key`).

**Критичные факты (проверено вживую, легко забыть):**
- **Чтение почты — по IMAP, НЕ через webmailer.** GMX-webmailer на Stencil/shadow DOM (парсить тяжело).
  IMAP-хост `imap.gmx.net:993`, нужно включить IMAP в настройках ящика (один раз). **GMX блокирует IMAP
  с «чужого» (не-AT) IP** → подключаемся ЧЕРЕЗ прокси аккаунта (HTTP CONNECT → TLS → IMAP, `lib/mail/imap.js`).
- **2captcha может быть недоступен напрямую** с этой сети → драйвер ходит к нему ЧЕРЕЗ прокси аккаунта
  (undici `ProxyAgent`, `getSolver(db,{proxy})`). Картинка-капча meinbezirk решается стабильно.
- **Вход gmx через браузер не нужен для регистрации** (всё чтение — IMAP). Браузерный `login` в `gmx.js`
  оставлен как legacy; на входе gmx стоит **CaptchaFox** (не reCAPTCHA), которую обходить дорого/хрупко.
- **URL формы регистрации meinbezirk — `/register`** (поля `#register_*`, графическая капча `img.captcha_image`).
- Диагностика: `scripts/diagnose-gmx.js`, `scripts/diagnose-register.js`.

### Генерация (`lib/claude.js`, `lib/generateArticle.js`)
Модель `claude-opus-4-8` (env `CLAUDE_MODEL`), без суффиксов-дат. Структурированный вывод `output_config.format` (json_schema: `{title, body_html}`), стриминг + `.finalMessage()`, обработка `stop_reason`. Реалтайм и Batches делят `prepareGeneration`/`persistArticle`. Ключи — в `claude_keys`, ротация LRU (`lib/keys.js`).

**Два движка генерации (`backend`):** `api` (Anthropic SDK, платно за токены, дефолт) и `cli` (`lib/claudeCli.js` — подписочный Claude CLI `claude -p --output-format json`, генерация «в рамках тарифа» Max, без API-ключа). `backend` прокидывается через `prepareGeneration`/`generateArticleForSite`/`generateArticle`; для `cli` ключ Claude не нужен (`keyId=null`). Выбор движка — у каждой формы генерации в UI (радио «API/Тариф»; дефолт из env `CLAUDE_BACKEND`). **Batches — только API** (у подписки батчей нет). CLI залогинен на ХОСТЕ → из Docker напрямую недоступен: `lib/claudeCli.js` при заданном `CLAUDE_CLI_URL` ходит по HTTP к **хостовому мосту** `scripts/claude-bridge.js` (`npm run claude-bridge`, слушает `0.0.0.0:3737`, опц. `CLAUDE_BRIDGE_TOKEN`); иначе спавнит `claude.exe` локально (на хосте — `npm run generate -- --site 1 --backend cli`). **Автозапуск моста**: `scripts/claude-bridge-autostart.cmd` (полный путь к `claude.exe`, лог в `%TEMP%\claude-bridge.log`), запускается скрытно из ярлыка `claude-bridge-autostart.vbs` в папке «Автозагрузка» (`shell:startup`) — в интерактивной сессии пользователя (нужно для OAuth подписки). Без моста генерация «Тариф» из веба падает с понятной ошибкой. Контракт ответа тот же — строгий `{title, body_html}` (CLI: системный промт фиксирует JSON, `cwd=tmp` чтобы не цеплять проектный CLAUDE.md). В compose `web`/`generator` уже получают `CLAUDE_CLI_URL=http://host.docker.internal:3737`.

### Ссылки и Binom (`lib/linkblock.js`)
Блок ссылок (BBCode) задаётся в **промте** (`prompts.link_block`), вставляется по позиции `prompts.link_position` (по заголовкам) или по метке `{{LINKS}}`. В URL добавляются `s1={tracking_id}` (статья), `s2={порядковый id ссылки}` (стабилен по бренду → в Binom видно «что заходит»). Тело статьи — HTML → BBCode (`lib/bbcode.js`) при публикации.

### Расписание, автоудаление, флаг «не удалять»
- `scheduler.js` (отдельный контейнер) каждый тик: публикует созревшие `scheduled` (`scheduled_at <= now`) и удаляет с сайта созревшие `delete_at` (`published`, не снятые). Пишет heartbeat в `settings` (`scheduler_last_tick`/`_last_summary`).
- **Авто-delete_at** при публикации (`publishArticleById`): режимы сайта `sites.auto_delete` = `off`(не удалять)/`window_end`/`ttl_capped` + `auto_delete_hours`. Считается **от момента публикации**. Ранее заданный `articles.delete_at` сохраняется, **только если он в будущем** (актуальный ручной выбор); просроченный (остался от раскладки на прошедший день, а публикация задержалась) игнорируется и пересчитывается от «сейчас» — иначе статья удалялась бы сразу после публикации (был такой баг с COALESCE стейл-значения).
- **`articles.no_auto_delete=1`** — флаг «не удалять»: при публикации настройка сайта НЕ применяется. Ставится из UI («Распределить» → «не удалять», «Автоудаление» → «не удалять»).

### Страница «Статьи» (карточки, вариант D)
`renderArticlesWorkspace` (web/routes.js) рендерит карточки + панель массовых действий по модели **«выбрал карточки → действие → раскрывается его настройка»**:
- Фильтр по статусам со счётчиками (`черновик (N)`…), категория **«архив»** (опубликованные и снятые с сайта; по умолчанию скрыта; статус в БД не меняется — виртуальная). Память выбора в `localStorage` (per-site). Сортировка (новизна/публикация/удаление, клиентская).
- Карточка: статус, промт, заголовок, строка состояния (в расписании → …/на сайте · удалится …), инлайн-редактор времени публикации (черновик/в расписании) или времени удаления (опубликованные), аккаунт+«Опубл.», «Удалить с сайта», «⋮» (снять с расписания/авто-удаление, удалить из БД).
- Массовые действия (form `#distform`, чекбоксы `name=ids form=distform`): Опубликовать, **Распределить** (окно+режим interval/even, + опц. режим удаления как в настройках), Снять с расписания, **Автоудаление** (режимы как в настройках), Удалить с сайта, Удалить из БД. Эндпоинты `/articles/distribute|unschedule|bulk-publish|bulk-set-delete-at|bulk-autodelete|bulk-site-delete|bulk-delete` + per-article `/articles/:id/...`.

### Страница «Планировщик» (`/scheduler`)
Статус планировщика по heartbeat (бейдж «Sched» в шапке рядом с «Anty», опрос `/scheduler-status`), очередь публикации, очередь автоудаления (с «через …»), недавняя активность (`article_events`). Автообновление каждые 15с.

### Журналы
- `article_events` (`lib/events.js`) — высокоуровневые вехи статьи (generated/scheduled/published/site_deleted/…), показываются на `/articles/:id` и в «Недавней активности».
- `jobs` + `lib/jobs.js` — фоновые задачи (generate/publish/delete) с пошаговым in-memory логом; страница `/jobs/:id` поллит `/jobs/:id/status` и показывает живой журнал. Зомби-задачи на старте → `failed` (`reapRunningJobs`). Таймауты через `withTimeout`.

### Конфигурация (`.env`)
`DOLPHIN_API_TOKEN` (обяз.), `DB_PATH` (опц., дефолт `data/app.db`), `CLAUDE_MODEL` (опц.), `DOLPHIN_HOST` (для Docker), `SCHEDULER_TICK_MS` (опц., 30000), `ADMIN_PASSWORD`. Ключи Claude — НЕ в `.env`.

### Зависимости
`@anthropic-ai/sdk`, `better-sqlite3` (prebuilt, Linux+Windows), `puppeteer-core`, `fastify` (+`@fastify/cookie`/`formbody`/`static`), `node-html-parser`, `@tabler/core`+`@tabler/icons-webfont`.

## Текущий статус

Каркас данных, генерация (реалтайм + Batches), ссылки+Binom, **живая публикация и удаление** через адаптеры, планировщик (раскладка/публикация/автоудаление + heartbeat), веб-админка (карточки статей, страница «Планировщик»), **переиспользование cookie-сессии** (логин ~один раз на ~50 статей/сутки, само-восстановление при вылете) — готовы и развёрнуты в Docker. Связка контейнер→Dolphin проверена вживую.

Опционально на будущее: прогон Batches на 50 статей (механика проверена на 3); расширение под несколько сайтов (через новые адаптеры).
