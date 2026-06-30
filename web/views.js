// Серверные шаблоны админки (без фронт-сборки). Тема — Tabler (Bootstrap 5.3), отдаётся локально из node_modules.

const NAV = [
  ['/', 'Дашборд', 'dashboard'],
  ['/sites', 'Сайты', 'world'],
  ['/emails', 'Почты', 'mail'],
  ['/settings', 'Настройки', 'settings'],
  ['/scheduler', 'Планировщик', 'calendar-event'],
  ['/research', 'Анализ', 'chart-bar'],
  ['/lists', 'Списки', 'list-details'],
  ['/stats', 'Статистика', 'chart-histogram'],
  ['/jobs', 'Задачи', 'list-check'],
];

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const STATUS_RU = { draft: 'черновик', scheduled: 'в расписании', published: 'опубликовано', failed: 'ошибка' };

// Бейдж статуса статьи (цвета Tabler).
export function badge(status) {
  const s = String(status || '');
  const map = { draft: 'bg-secondary', scheduled: 'bg-azure', published: 'bg-green', failed: 'bg-red' };
  return `<span class="badge ${map[s] || 'bg-secondary'} text-white">${esc(STATUS_RU[s] || s)}</span>`;
}

// Минимум своего CSS — только то, чего нет в Tabler (на его переменных, чтобы менялось с темой).
const STYLE = `<style>
html{scrollbar-gutter:stable}
.mono{font-family:var(--tblr-font-monospace);font-size:.85em}
.muted{color:var(--tblr-secondary)}
.inline-form{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;margin-bottom:.6rem}
#distform .form-control,#distform .form-select{display:inline-block;width:auto;vertical-align:middle}
#distform input[type=date]{width:9.5rem}
#distform input[type=time]{width:7rem}
#distform input[type=number]{width:5rem}
#distform .fld{display:inline-block;min-width:5rem;color:var(--tblr-secondary)}
.article-preview h1,.article-preview h2,.article-preview h3,.article-preview h4{margin:1.1rem 0 .5rem;line-height:1.3}
.article-preview ul{padding-left:1.25rem}
.article-preview a{text-decoration:underline}
</style>`;

// Общая «голова»: Tabler CSS/иконки + наш мини-CSS + скрипт темы (до отрисовки — против мигания).
const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/static/tabler/css/tabler.min.css">
<link rel="stylesheet" href="/static/icons/tabler-icons.min.css">
${STYLE}
<script>(function(){try{var t=localStorage.getItem('theme')||(window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.setAttribute('data-bs-theme',t);}catch(e){}})();</script>`;

// Скрипт тумблера темы (system+localStorage) — общий для всех страниц с шапкой.
const THEME_TOGGLE_JS = `<script>(function(){var b=document.getElementById('theme-toggle');if(!b)return;function ic(){b.innerHTML='<i class="ti ti-'+(document.documentElement.getAttribute('data-bs-theme')==='dark'?'sun':'moon')+'"></i>';}ic();b.addEventListener('click',function(){var c=document.documentElement.getAttribute('data-bs-theme')==='dark'?'light':'dark';document.documentElement.setAttribute('data-bs-theme',c);try{localStorage.setItem('theme',c);}catch(e){}ic();});})();</script>`;

export function layout(active, body, opts = {}) {
  const title = opts.title || '';
  const navLeft = opts.navLeft || ''; // навигация (← назад) в самом левом краю хедера
  const flash = opts.flash || ''; // уведомление — в хедере, рядом с заголовком
  const nav = NAV.map(
    ([href, label, icon]) =>
      `<li class="nav-item${href === active ? ' active' : ''}"><a class="nav-link" href="${href}"><span class="nav-link-icon"><i class="ti ti-${icon}"></i></span><span class="nav-link-title">${label}</span></a></li>`,
  ).join('');
  return `<!doctype html><html lang="ru"><head><title>Austria Automation</title>${HEAD}</head><body>
<div class="page">
<aside class="navbar navbar-vertical navbar-expand-lg">
<div class="container-fluid">
<button class="navbar-toggler" type="button" data-bs-toggle="collapse" data-bs-target="#sidebar"><span class="navbar-toggler-icon"></span></button>
<h1 class="navbar-brand navbar-brand-autodark m-0"><a href="/" class="text-reset text-decoration-none"><i class="ti ti-settings"></i> Austria Automation</a></h1>
<div class="collapse navbar-collapse" id="sidebar"><ul class="navbar-nav pt-lg-3">${nav}</ul></div>
</div>
</aside>
<header class="navbar navbar-expand-md d-print-none">
<div class="container-fluid">
<div class="d-flex align-items-center flex-wrap gap-2 gap-md-3 w-100">
${navLeft}
${title ? `<span class="navbar-brand m-0 h2 mb-0 text-truncate" style="max-width:42vw">${esc(title)}</span>` : ''}
${flash}
<div class="ms-auto d-flex align-items-center gap-2">
<form method="get" action="/articles/find" class="m-0" role="search"><div class="input-group input-group-sm"><input name="q" class="form-control" placeholder="Поиск: tracking_id / ключ / заголовок" style="min-width:16rem" autocomplete="off" aria-label="Поиск статьи"><button class="btn btn-outline-secondary" type="submit" title="Найти статью"><i class="ti ti-search"></i></button></div></form>
<a href="/scheduler" class="text-decoration-none"><span id="sched-status" class="badge bg-secondary text-white" title="Планировщик">Sched</span></a>
<span id="anty-status" class="badge bg-secondary text-white" style="cursor:pointer" title="Dolphin{anty} — клик, чтобы проверить">Anty</span>
<button class="btn btn-icon btn-ghost-secondary" id="theme-toggle" type="button" title="Светлая/тёмная тема"><i class="ti ti-moon"></i></button>
<form method="post" action="/logout" class="m-0"><button class="btn btn-outline-secondary btn-sm">Выйти</button></form>
</div>
</div>
</div>
</header>
<div class="page-wrapper">
<div class="page-body"><div class="container-fluid">${body}</div></div>
</div>
</div>
<script src="/static/tabler/js/tabler.min.js" defer></script>
${THEME_TOGGLE_JS}
<script>(function(){var f=document.getElementById('flashmsg');if(f)setTimeout(function(){f.style.transition='opacity .4s';f.style.opacity='0';setTimeout(function(){if(f.parentNode)f.parentNode.removeChild(f);},400);},5000);
// Убрать служебные параметры (msg/tab) из адресной строки — уведомление уже показано, вкладка уже открыта.
try{var u=new URL(location.href),ch=false;['msg','tab'].forEach(function(k){if(u.searchParams.has(k)){u.searchParams.delete(k);ch=true;}});if(ch)history.replaceState(null,'',u.pathname+u.search+u.hash);}catch(e){}
// Статус Dolphin{anty} в шапке — на клиенте (не блокируем рендер): опрос каждые 7с, клик и возврат на вкладку = мгновенная проверка.
var ab=document.getElementById('anty-status');if(ab){var au=function(){ab.title='Dolphin{anty}: проверка…';fetch('/dolphin-status',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json();}).then(function(d){ab.className='badge text-white '+(d.running?'bg-green':'bg-red');ab.title='Dolphin{anty}: '+(d.running?'запущен':'не запущен — открой приложение на этом ПК')+' (клик — проверить)';}).catch(function(){ab.className='badge text-white bg-secondary';ab.title='Dolphin{anty}: статус неизвестен (клик — проверить)';});};au();setInterval(au,7000);ab.addEventListener('click',function(e){e.preventDefault();au();});document.addEventListener('visibilitychange',function(){if(!document.hidden)au();});}
// Статус планировщика в шапке (по heartbeat) — на клиенте, опрос каждые 10с + при возврате на вкладку.
var sb=document.getElementById('sched-status');if(sb){var su=function(){fetch('/scheduler-status',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json();}).then(function(d){sb.className='badge text-white '+(d.alive?'bg-green':'bg-red');sb.title='Планировщик: '+(d.alive?'работает':'не отвечает')+(d.ageSec!=null?' ('+d.ageSec+' сек назад)':' (тиков не было)');}).catch(function(){sb.className='badge text-white bg-secondary';sb.title='Планировщик: статус неизвестен';});};su();setInterval(su,10000);document.addEventListener('visibilitychange',function(){if(!document.hidden)su();});}})();</script>
</body></html>`;
}

export function loginPage(error = '') {
  return `<!doctype html><html lang="ru"><head><title>Вход</title>${HEAD}</head><body class="d-flex flex-column bg-body-tertiary">
<div class="page page-center"><div class="container container-tight py-4">
<div class="text-center mb-4"><span class="navbar-brand navbar-brand-autodark h2"><i class="ti ti-settings"></i> Austria Automation</span></div>
<div class="card card-md"><div class="card-body">
<h2 class="h2 text-center mb-3">Вход в админку</h2>
${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
<form method="post" action="/login">
<div class="mb-3"><label class="form-label">Пароль</label><input type="password" name="password" class="form-control" placeholder="Пароль" required autofocus></div>
<div class="form-footer"><button type="submit" class="btn btn-primary w-100">Войти</button></div>
</form></div></div></div></div>
</body></html>`;
}

export function dashboardPage({ byStatus, sitesCount, keys, prompts, log, siteList }) {
  const c = Object.fromEntries(byStatus.map((r) => [r.status, r.c]));
  const stat = (num, lbl) =>
    `<div class="col-6 col-md-3 col-xl"><div class="card card-sm"><div class="card-body text-center"><div class="h1 m-0">${num}</div><div class="text-secondary">${lbl}</div></div></div></div>`;
  const stats = `<div class="row row-cards mb-3">
${stat(c.draft || 0, 'черновики')}${stat(c.scheduled || 0, 'в расписании')}${stat(c.published || 0, 'опубликовано')}${stat(c.failed || 0, 'ошибки')}${stat(sitesCount, 'сайты')}${stat(keys, 'ключи')}${stat(prompts, 'промты')}</div>`;

  const cards = siteList.length
    ? `<div class="row row-cards">${siteList
        .map(
          (s) => `<div class="col-md-6 col-lg-4"><div class="card"><a class="card-body d-block text-reset text-decoration-none" href="/sites/${s.id}">
<h3 class="card-title mb-1">${esc(s.name)} ${s.active ? '' : '<span class="badge bg-secondary text-white">выкл</span>'}</h3>
<div class="text-secondary mono">${esc(s.origin)}</div></a></div></div>`,
        )
        .join('')}</div>`
    : '<p class="text-secondary">Сайтов пока нет — добавь на странице «Сайты».</p>';

  const rows = log.length
    ? log
        .map(
          (l) => `<tr><td>${l.id}</td><td><a href="/articles/${l.article_id}">#${l.article_id}</a></td><td>${l.ok ? '<span class="badge bg-green text-white"><i class="ti ti-check"></i></span>' : '<span class="badge bg-red text-white"><i class="ti ti-x"></i></span>'}</td><td class="text-secondary">${esc(l.attempted_at)}</td><td>${esc((l.message || '').slice(0, 90))}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="text-secondary">пока пусто</td></tr>';

  const body = `${stats}
<div class="card mb-3"><div class="card-header"><h3 class="card-title">Сайты</h3></div><div class="card-body">${cards}</div></div>
<div class="card"><div class="card-header"><h3 class="card-title">Последние публикации</h3></div>
<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>#</th><th>статья</th><th>ok</th><th>время</th><th>сообщение</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  return layout('/', body, { title: 'Дашборд' });
}
