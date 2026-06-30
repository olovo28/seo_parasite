// CRUD-роуты админки. Модель «по промту»: у сайта несколько промтов, у каждого свой
// текст + авторский блок ссылок (BBCode, редактор с валидацией) + теги. Генерация = выбор промта.
// Тема — Tabler (Bootstrap 5.3): карточки `.card`, формы `.form-control`/`.form-select`, кнопки `.btn`.

import { getDb } from '../db/db.js';
import { layout, esc, badge, STATUS_RU } from './views.js';
import { generateArticleForSite, addManualArticle } from '../lib/generateArticle.js';
import { scheduleDay } from '../lib/schedule.js';
import { publishArticleById, deleteArticleFromSiteById, deleteArticlesGrouped } from '../lib/publishArticle.js';
import { htmlToBBCode } from '../lib/bbcode.js';
import { validateBlock, bbcodeToHtml } from '../lib/linkblock.js';
import { createJob, finishJob, getJob, withTimeout, logJob, getJobLog, requestJobCancel, isJobCancelled } from '../lib/jobs.js';
import { logArticleEvent, getArticleEvents } from '../lib/events.js';
import { distributeArticles, roundRobinAccounts } from '../lib/distribute.js';
import { submitArticleBatch, collectArticleBatch } from '../lib/batch.js';
import { listSiteAccounts, enabledSiteAccounts, addSiteAccount, toggleSiteAccount, removeSiteAccount, clearAccountCookies } from '../lib/accounts.js';
import { listSemrushAccounts, enabledSemrushAccounts, addSemrushAccount, toggleSemrushAccount, removeSemrushAccount, setUnitsBalance, saveAccountCookiesText, clearAccountCookies as clearSemrushCookies } from '../lib/semrushAccounts.js';
import { runKeywordResearch } from '../lib/research.js';
import { unitsBalance } from '../lib/research/api.js';
import { createList, removeList, getList, listLists, listItems, listItemsWithStats, getItem, addKeywordsToList, addManualKeywordsToList, setItemStatus, linkItemArticle, removeItem, ITEM_STATUSES } from '../lib/lists.js';
import { KNOWN_SETTINGS, getSetting, setSetting } from '../lib/settings.js';
import { isDolphinRunning } from '../lib/dolphin.js';
import { adapterList, getAdapter } from '../lib/sites/index.js';
import { EU_TZ, zonedToEpoch, epochToZoned, utcStamp, parseStamp, fmtInTz, nextDailyOccurrence } from '../lib/time.js';
import { listEmailAccounts, freeEmailAccounts, addEmailAccount, importEmailAccounts, toggleEmailAccount, removeEmailAccount, clearEmailCookies, releaseEmail } from '../lib/emailAccounts.js';
import { importProxies, listGroups, getGroup, createGroup, updateGroup, deleteGroup, setProxiesGroup, PROXY_PURPOSES } from '../lib/proxyPool.js';
import { listRegistrations } from '../lib/registrations.js';
import { registerOnSite, checkApproval } from '../lib/registrar.js';
import { mailProviderList } from '../lib/mail/index.js';
import { createMailbox } from '../lib/mailRegistrar.js';
import { getSmsProvider } from '../lib/sms/index.js';
import { collectArticleStats, collectStatsForSite, keywordStats, articleStatsRows, articleLatestStats } from '../lib/stats.js';
import { checkArticleRank, checkRanksForSite, latestRanks, DACH } from '../lib/serp.js';

const PUBLISH_TIMEOUT_MS = Number(process.env.PUBLISH_TIMEOUT_MS || 240000);
const DELETE_TIMEOUT_MS = Number(process.env.DELETE_TIMEOUT_MS || 480000); // одиночное удаление (со сбором статистики)
const BULK_CONCURRENCY = Number(process.env.BULK_CONCURRENCY || 5); // массовое удаление: профилей параллельно
const BULK_DELETE_DELAY_MS = Number(process.env.BULK_DELETE_DELAY_MS || 10000); // пауза между удалениями внутри аккаунта
const STATS_TIMEOUT_MS = Number(process.env.STATS_TIMEOUT_MS || 1800000); // сбор по всему сайту может быть долгим

const page = (active, title, inner, opts = {}) => layout(active, inner, { title, ...opts });
// Длительность в секундах → «Xм Yс» (для среднего времени на странице).
const fmtDur = (s) => {
  if (s == null) return '—';
  const t = Math.round(Number(s));
  const m = Math.floor(t / 60);
  return m ? `${m}м ${t % 60}с` : `${t}с`;
};
// Уведомление — компактное, рендерится в хедере (layout opts.flash), авто-скрытие через 5с.
const flash = (q) => (q?.msg ? `<div class="alert alert-info m-0 py-1 px-3" id="flashmsg" role="alert">${esc(q.msg)}</div>` : '');
const mask = (k) => (!k ? '' : k.length <= 12 ? k : `${k.slice(0, 7)}…${k.slice(-4)}`);
// Карточка с телом.
const card = (title, body, id) =>
  `<div class="card mb-3"${id ? ` id="${id}"` : ''}>${title ? `<div class="card-header"><h3 class="card-title w-100">${title}</h3></div>` : ''}<div class="card-body">${body}</div></div>`;
// Таблица (Tabler-классы), при пустых строках — заглушка.
const tbl = (head, rows) =>
  `<div class="table-responsive"><table class="table table-vcenter"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}" class="text-secondary">нет</td></tr>`}</tbody></table></div>`;
// Карточка-таблица (таблица заподлицо с краями карточки).
const tableCard = (title, head, rows, id, footer) =>
  `<div class="card mb-3"${id ? ` id="${id}"` : ''}><div class="card-header"><h3 class="card-title">${title}</h3></div><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}" class="text-secondary">нет</td></tr>`}</tbody></table></div>${footer ? `<div class="card-footer">${footer}</div>` : ''}</div>`;
const promptName = (p) => esc(p.name || `Промт ${p.id}`);
const jobTypeRu = (t) => (t === 'generate' ? 'генерация' : t === 'publish' ? 'публикация' : t === 'register' ? 'регистрация' : t === 'stats' ? 'статистика' : t === 'rank' ? 'позиции' : t === 'mailbox' ? 'регистрация почт' : esc(t));
// Ячейка позиции в выдаче: «#3» (зелёная топ-10 / жёлтая 11-30 / серая дальше) или «—». data-v для сортировки.
const rankCell = (r) => {
  if (!r || r.position == null) return `<td data-v="999" class="text-secondary">${r && r.error ? '<span title="' + esc(r.error) + '">ошибка</span>' : '—'}</td>`;
  const cls = r.position <= 10 ? 'text-green' : r.position <= 30 ? 'text-yellow' : 'text-secondary';
  return `<td data-v="${r.position}" class="${cls}"><b>#${r.position}</b></td>`;
};
function jobBadge(s) {
  const m = { running: ['bg-azure', 'идёт'], done: ['bg-green', 'готово'], failed: ['bg-red', 'ошибка'], stopped: ['bg-orange', 'остановлено'] };
  const [cls, txt] = m[s] || ['bg-secondary', s];
  return `<span class="badge ${cls} text-white">${esc(txt)}</span>`;
}

// Рабочая область статей (панель распределения + таблица + публикация построчно/балком + клиентский
// фильтр по статусу). Общая для глобального /articles и вкладки «Статьи» хаба сайта.
// fixedSiteId — только статьи этого сайта (колонка «сайт» скрыта). from — куда возвращать балк-действия.
// Клиентский табличный движок для результатов анализа: сортировка по любому столбцу, живой поиск,
// фильтр по базам (свой/общий), пагинация, выбор + «в список», индикатор «в скольких списках уже».
// JS-строки в двойных кавычках, HTML-атрибуты в одинарных — чтобы не экранировать внутри backtick-шаблона.
const KW_TABLE_SCRIPT = `<script>
(function(){
var GOOD=window.__GOOD||[],BAD=window.__BAD||[],LISTOPTS=window.__LISTOPTS||"",RUNID=window.__RUNID;
var SHARED={linked:false,q:"",dbs:{de:true,at:true,ch:true}};
var tables=[];
function esc(s){return (""+(s==null?"":s)).replace(/[&<>"]/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c];});}
function make(mountId,data,kind){
  var root=document.getElementById(mountId);if(!root)return;
  var st={sort:kind==="good"?"score":"volume",dir:-1,page:0,size:50,q:"",dbs:{de:true,at:true,ch:true},sel:{}};
  try{var _ss=parseInt(localStorage.getItem("kwPageSize"),10);if(_ss>0)st.size=_ss;}catch(e){}
  var cols=kind==="good"?[["phrase","ключ"],["database","база"],["volume","объём"],["kd","KD%"],["intent","intent"],["cpc","CPC"],["score","score"],["m","в списках"]]:[["phrase","ключ"],["database","база"],["volume","объём"],["reject_reason","причина"],["m","в списках"]];
  var ttl=kind==="good"?"<i class='ti ti-circle-check'></i> Хорошие":"<i class='ti ti-ban'></i> Отклонённые";
  var dbf=["de","at","ch"].map(function(d){return "<label class='form-check form-check-inline m-0'><input type='checkbox' class='form-check-input dbf' data-db='"+d+"' checked><span class='form-check-label'>"+d+"</span></label>";}).join("");
  var th=cols.map(function(c){return "<th class='sort' data-k='"+c[0]+"' style='cursor:pointer;white-space:nowrap'>"+c[1]+" <span class='ar'></span></th>";}).join("");
  root.innerHTML="<div class='card mb-3'><div class='card-header py-2 d-flex flex-wrap align-items-center gap-2'><h3 class='card-title mb-0'>"+ttl+" <span class='cnt text-secondary'></span></h3><input type='search' class='form-control form-control-sm q' placeholder='поиск по ключу…' style='width:12rem'><span class='small text-secondary'>базы:</span>"+dbf+"<label class='form-check form-check-inline m-0 ms-1'><input type='checkbox' class='form-check-input lnk'><span class='form-check-label small'>общие фильтры</span></label><span class='ms-auto d-flex align-items-center gap-1'><span class='badge bg-primary text-white'>выбрано: <span class='sc'>0</span></span><select class='form-select form-select-sm lst' style='width:auto'>"+LISTOPTS+"<option value=''>— новый —</option></select><input class='form-control form-control-sm nl' placeholder='новый список' style='width:9rem'><button class='btn btn-sm btn-primary add' disabled><i class='ti ti-plus'></i> В список</button></span></div><div class='table-responsive'><table class='table table-vcenter card-table'><thead><tr><th class='w-1'><input type='checkbox' class='form-check-input all'></th>"+th+"</tr></thead><tbody class='bd'></tbody></table></div><div class='card-footer d-flex align-items-center gap-2'><button class='btn btn-sm btn-outline-secondary pp'>←</button><span class='small pg'></span><button class='btn btn-sm btn-outline-secondary nn'>→</button><select class='form-select form-select-sm sz ms-2' style='width:auto'><option>25</option><option selected>50</option><option>100</option><option>200</option></select></div></div>";
  function $(s){return root.querySelector(s);}
  function eff(){return SHARED.linked?{q:SHARED.q,dbs:SHARED.dbs}:{q:st.q,dbs:st.dbs};}
  function filtered(){var e=eff(),q=e.q.toLowerCase();var arr=data.filter(function(r){if(q&&(r.phrase||"").toLowerCase().indexOf(q)<0)return false;if(r.database&&!e.dbs[r.database])return false;return true;});var k=st.sort,dir=st.dir;return arr.slice().sort(function(a,b){var x=a[k],y=b[k];if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;if(typeof x==="string"||typeof y==="string"){x=(""+x).toLowerCase();y=(""+y).toLowerCase();return x<y?-dir:x>y?dir:0;}return (x-y)*dir;});}
  function paintBody(){var arr=filtered();var pages=Math.max(1,Math.ceil(arr.length/st.size));if(st.page>=pages)st.page=pages-1;if(st.page<0)st.page=0;var slice=arr.slice(st.page*st.size,(st.page+1)*st.size);$(".cnt").textContent="("+arr.length+(arr.length!==data.length?" / "+data.length:"")+")";var h="";slice.forEach(function(r){h+="<tr><td><input type='checkbox' class='form-check-input rc' data-id='"+r.id+"' "+(st.sel[r.id]?"checked":"")+"></td><td class='kwcell' style='cursor:pointer' title='Клик — выбрать ключ'>"+esc(r.phrase)+" <a href='https://www.semrush.com/analytics/keywordmagic/?q="+encodeURIComponent(r.phrase)+"&db="+(r.database||"")+"' target='_blank' rel='noopener' class='text-secondary ms-1' title='Открыть в SEMrush' onclick='event.stopPropagation()'>&#8599;</a></td><td>"+esc(r.database||"-")+"</td><td>"+(r.volume==null?"-":r.volume)+"</td>";if(kind==="good"){h+="<td>"+(r.kd==null?"-":r.kd)+"</td><td>"+esc(r.intent||"-")+"</td><td>"+(r.cpc==null?"-":r.cpc)+"</td><td><b>"+(r.score==null?"-":r.score)+"</b></td>";}else{h+="<td class='text-secondary small'>"+esc(r.reject_reason||"-")+"</td>";}h+="<td>"+(r.m?"<span class='badge bg-azure text-white' title='"+esc(r.mn||"")+"'>"+r.m+"</span>":"<span class='text-secondary'>—</span>")+"</td></tr>";});$(".bd").innerHTML=h||"<tr><td colspan='"+(cols.length+1)+"' class='text-secondary'>ничего не найдено</td></tr>";$(".pg").textContent="стр. "+(st.page+1)+" из "+pages;$(".pp").disabled=st.page<=0;$(".nn").disabled=st.page>=pages-1;var nsel=Object.keys(st.sel).length;$(".sc").textContent=nsel;$(".add").disabled=nsel===0;root.querySelectorAll(".sort").forEach(function(t){t.querySelector(".ar").textContent=(t.getAttribute("data-k")===st.sort)?(st.dir>0?"▲":"▼"):"";});}
  function sync(){var e=eff();var qi=$(".q");if(qi!==document.activeElement)qi.value=e.q;root.querySelectorAll(".dbf").forEach(function(c){c.checked=!!e.dbs[c.getAttribute("data-db")];});$(".lnk").checked=SHARED.linked;}
  function onFilter(){if(SHARED.linked){tables.forEach(function(t){t.sync();t.paint();});}else{paintBody();}}
  $(".q").addEventListener("input",function(e){if(SHARED.linked)SHARED.q=e.target.value;else st.q=e.target.value;st.page=0;onFilter();});
  root.querySelectorAll(".dbf").forEach(function(c){c.addEventListener("change",function(){var d=c.getAttribute("data-db");if(SHARED.linked)SHARED.dbs[d]=c.checked;else st.dbs[d]=c.checked;st.page=0;onFilter();});});
  $(".lnk").addEventListener("change",function(){SHARED.linked=$(".lnk").checked;if(SHARED.linked){SHARED.q=st.q;SHARED.dbs={de:st.dbs.de,at:st.dbs.at,ch:st.dbs.ch};}tables.forEach(function(t){t.sync();t.paint();});});
  root.querySelectorAll(".sort").forEach(function(t){t.addEventListener("click",function(){var k=t.getAttribute("data-k");if(st.sort===k)st.dir=-st.dir;else{st.sort=k;st.dir=(k==="phrase"||k==="database"||k==="intent"||k==="reject_reason")?1:-1;}paintBody();});});
  $(".pp").addEventListener("click",function(){st.page--;paintBody();});
  $(".nn").addEventListener("click",function(){st.page++;paintBody();});
  $(".sz").addEventListener("change",function(){st.size=parseInt($(".sz").value,10)||50;st.page=0;try{localStorage.setItem("kwPageSize",st.size);}catch(e){}paintBody();});
  $(".all").addEventListener("change",function(){var on=$(".all").checked;filtered().forEach(function(r){if(on)st.sel[r.id]=1;else delete st.sel[r.id];});paintBody();});
  $(".bd").addEventListener("change",function(e){if(e.target&&e.target.classList.contains("rc")){var id=e.target.getAttribute("data-id");if(e.target.checked)st.sel[id]=1;else delete st.sel[id];$(".sc").textContent=Object.keys(st.sel).length;$(".add").disabled=Object.keys(st.sel).length===0;}});
  $(".bd").addEventListener("click",function(e){var cell=e.target.closest&&e.target.closest(".kwcell");if(!cell||e.target.closest("a"))return;var tr=cell.closest("tr");var cb=tr&&tr.querySelector(".rc");if(!cb)return;cb.checked=!cb.checked;var id=cb.getAttribute("data-id");if(cb.checked)st.sel[id]=1;else delete st.sel[id];$(".sc").textContent=Object.keys(st.sel).length;$(".add").disabled=Object.keys(st.sel).length===0;});
  $(".add").addEventListener("click",function(){var ids=Object.keys(st.sel);if(!ids.length)return;var f=document.createElement("form");f.method="POST";f.action="/lists/add";function hid(n,v){var i=document.createElement("input");i.type="hidden";i.name=n;i.value=v;f.appendChild(i);}hid("from","/research/"+RUNID);hid("list",$(".lst").value);hid("new_list",$(".nl").value);ids.forEach(function(id){hid("ids",id);});document.body.appendChild(f);f.submit();});
  $(".sz").value=st.size;
  var api={paint:paintBody,sync:sync};tables.push(api);paintBody();return api;
}
make("kwgood",GOOD,"good");make("kwbad",BAD,"bad");
})();
</script>`;

function renderArticlesWorkspace(db, { fixedSiteId = null, from = '/articles' } = {}) {
  const where = fixedSiteId ? ' WHERE a.site_id = @site' : '';
  const rows = db
    .prepare(`SELECT a.id, a.site_id, a.status, a.category, a.keyword, a.title, a.scheduled_at, a.published_at, a.generated_at, a.site_url, a.delete_at, a.no_auto_delete, a.site_deleted_at, a.account_id, acc.label AS acc_label, acc.username AS acc_username, s.name AS site_name FROM articles a LEFT JOIN sites s ON s.id = a.site_id LEFT JOIN site_accounts acc ON acc.id = a.account_id${where} ORDER BY a.id DESC LIMIT 200`)
    .all(fixedSiteId ? { site: Number(fixedSiteId) } : {});

  const siteIds = fixedSiteId ? [Number(fixedSiteId)] : [...new Set(rows.map((r) => r.site_id))];
  const accBySite = {};
  const tzBySite = {};
  for (const sid of siteIds) {
    accBySite[sid] = enabledSiteAccounts(db, sid);
    tzBySite[sid] = db.prepare('SELECT timezone FROM sites WHERE id = ?').get(sid)?.timezone || 'Europe/Vienna';
  }
  const accOpts = (sid) => (accBySite[sid] || []).map((acc) => `<option value="${acc.id}">${esc(acc.label || acc.username)}</option>`).join('');
  const bulkAccOpts =
    '<option value="">аккаунт по умолчанию</option>' +
    siteIds
      .map((sid) => {
        const opts = accOpts(sid);
        if (!opts) return '';
        if (fixedSiteId) return opts;
        const name = db.prepare('SELECT name FROM sites WHERE id = ?').get(sid)?.name || '#' + sid;
        return `<optgroup label="${esc(name)}">${opts}</optgroup>`;
      })
      .join('');

  // Дефолты диапазона + часовой пояс — из настроек сайта (окно/timezone). Ночное окно → конец завтра.
  let startTime = '09:00';
  let endTime = '21:00';
  let tz = 'Europe/Vienna';
  let delHours = 4;
  if (fixedSiteId) {
    const w = db.prepare('SELECT window_start, window_end, timezone, auto_delete_hours FROM sites WHERE id = ?').get(fixedSiteId);
    if (w) {
      startTime = w.window_start || startTime;
      endTime = w.window_end || endTime;
      tz = w.timezone || tz;
      if (w.auto_delete_hours > 0) delHours = w.auto_delete_hours;
    }
  }
  // «Сегодня/завтра» — в часовом поясе сайта (а не UTC контейнера).
  const today = epochToZoned(Date.now(), tz).date;
  const tomorrow = epochToZoned(Date.now() + 86400000, tz).date;
  const endDate = endTime <= startTime ? tomorrow : today; // окно через полночь → конец завтра
  const tzLabel = (EU_TZ.find(([v]) => v === tz) || [tz, tz])[1];
  const delDefault = epochToZoned(nextDailyOccurrence(endTime, tz), tz); // дефолт удаления — ближайшее закрытие окна
  // Аккаунт публикации статьи (для строки и фильтра): фактический (account_id) или плановый дефолтный (scheduled).
  const cardAccount = (a) => {
    if (a.account_id) return a.acc_label || a.acc_username || '#' + a.account_id + ' — удалён';
    if (a.status === 'scheduled') {
      const d = (accBySite[a.site_id] || [])[0];
      return d ? d.label || d.username : '';
    }
    return '';
  };
  // Список промтов (для фильтра) — по имени промта, которое хранится в articles.category.
  const promptNames = [...new Set(rows.map((r) => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const promptFilter = `<span class="small text-secondary ms-2">Промт:</span><select id="promptfilter" class="form-select form-select-sm" style="width:auto"><option value="">все</option>${promptNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>`;
  // Список аккаунтов (для фильтра).
  const accountNames = [...new Set(rows.map(cardAccount).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const accountFilter = `<span class="small text-secondary ms-2">Аккаунт:</span><select id="accfilter" class="form-select form-select-sm" style="width:auto"><option value="">все</option>${accountNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}<option value="__none__">— без аккаунта —</option></select>`;
  // Счётчики по статусам для фильтра (archive = опубликованные и уже снятые с сайта).
  const statusCnt = { draft: 0, scheduled: 0, published: 0, failed: 0, archive: 0 };
  for (const a of rows) {
    if (a.status === 'published' && a.site_deleted_at) statusCnt.archive++;
    else if (statusCnt[a.status] !== undefined) statusCnt[a.status]++;
  }
  // Панель массовых действий (вариант D): фильтр статусов + выбор карточек → действие → раскрывается его настройка.
  const actBtns = [
    ['cfgPub', '<i class="ti ti-upload"></i> Опубликовать', 'btn-primary', 'опубликовать выбранные на сайте сейчас'],
    ['cfgDist', '<i class="ti ti-calendar"></i> Распределить', 'btn-outline-primary', 'расставить время; опубликует планировщик'],
    ['cfgAcct', '<i class="ti ti-user-cog"></i> Аккаунт', 'btn-outline-secondary', 'назначить/раскидать аккаунт у выбранных (черновик/в расписании)'],
    ['cfgUnsched', '↩ Снять с расписания', 'btn-outline-secondary', 'вернуть в черновики, убрать время'],
    ['cfgAutodel', '<i class="ti ti-clock-hour-4"></i> Автоудаление', 'btn-outline-warning', 'когда снять с сайта автоматически'],
    ['cfgSiteDel', '<i class="ti ti-trash"></i> Удалить с сайта', 'btn-outline-warning', 'снять опубликованные с сайта сейчас'],
    ['cfgDrop', '<i class="ti ti-trash-x"></i> Удалить из БД', 'btn-outline-danger', 'удалить из базы (не трогая сайт)'],
  ];
  // Чекбоксы аккаунтов публикации (для раскладки/назначения): включённые аккаунты задействованных сайтов,
  // по умолчанию все отмечены. name — имя поля формы (разное у разных панелей, чтобы не было коллизий).
  const accCheckboxes = (name) =>
    siteIds
      .map((sid) => {
        const list = accBySite[sid] || [];
        if (!list.length) return '';
        const head = fixedSiteId ? '' : `<span class="w-100 small text-secondary">${esc(db.prepare('SELECT name FROM sites WHERE id = ?').get(sid)?.name || '#' + sid)}</span>`;
        return head + list.map((ac) => `<label class="form-check form-check-inline m-0"><input class="form-check-input" type="checkbox" name="${name}" value="${ac.id}" checked><span class="form-check-label">${esc(ac.label || ac.username)}</span></label>`).join('');
      })
      .filter(Boolean)
      .join('');
  const hasAccounts = siteIds.some((sid) => (accBySite[sid] || []).length);
  const distAccRow = hasAccounts
    ? `<div class="col-12"><label class="form-label small mb-1"><i class="ti ti-users"></i> Аккаунты публикации <span class="text-secondary">— раскидать по выбранным (round-robin со случайным порядком); по умолчанию все. Один отмеченный = всё на него.</span></label><div class="d-flex gap-2 flex-wrap">${accCheckboxes('dist_accounts')}</div></div>`
    : '';
  const seln = '<span class="seln">0</span>';
  const cancel = '<button type="button" class="btn btn-sm btn-link cfgcancel">отмена</button>';
  const bulkBar = `<div class="card mb-3"><form method="post" action="/articles/distribute" id="distform"><input type="hidden" name="from" value="${esc(from)}"><input type="hidden" name="timezone" value="${esc(tz)}"><div class="card-body py-2">
<div class="mb-2 d-flex align-items-center gap-3 flex-wrap"><span class="small text-secondary">Показать статусы:</span>${Object.entries(STATUS_RU).map(([v, l]) => `<label class="form-check form-check-inline m-0"><input class="form-check-input statusfilter" type="checkbox" value="${v}" checked><span class="form-check-label">${esc(l)} <span class="text-secondary">(${statusCnt[v] || 0})</span></span></label>`).join('')}<label class="form-check form-check-inline m-0" title="Опубликованные и уже снятые с сайта"><input class="form-check-input statusfilter" type="checkbox" value="archive"><span class="form-check-label">архив <span class="text-secondary">(${statusCnt.archive})</span></span></label><span class="small text-secondary ms-2">Сортировка:</span><select id="sortsel" class="form-select form-select-sm" style="width:auto"><option value="id_desc">новые сверху</option><option value="id_asc">старые сверху</option><option value="pub_asc">публикация: раньше→позже</option><option value="pub_desc">публикация: позже→раньше</option><option value="del_asc">удаление: раньше→позже</option></select>${promptFilter}${accountFilter}<span class="ms-auto small text-secondary d-flex align-items-center gap-1" title="Текущее время в часовом поясе сайта (${esc(tzLabel)})"><span class="d-none d-sm-inline"><i class="ti ti-clock"></i> ${esc(tzLabel)}:</span><b id="siteclock" class="mono text-body">--:--:--</b></span></div>
<hr class="my-2">
<div class="d-flex align-items-center gap-2 mb-1 flex-wrap"><label class="form-check m-0"><input type="checkbox" id="selall" class="form-check-input"><span class="form-check-label ms-1">выбрать все</span></label><span class="badge bg-primary text-white">Выбрано: <span id="selcount">0</span></span>${actBtns.map(([id, label, cls, note]) => `<button type="button" class="btn btn-sm ${cls} act-toggle" data-cfg="${id}" disabled title="${note}">${label}</button>`).join('')}<button type="button" id="bulkhelpbtn" class="btn btn-sm btn-outline-secondary" title="Что делают кнопки">?</button></div>
<div id="bulkhelp" class="d-none alert alert-info small py-2 mb-2"><div class="fw-bold mb-1">Как работать: отметь карточки галочками, затем нажми действие — раскроется его настройка.</div>${actBtns.map(([id, label, cls, note]) => `<div><b>${label}</b> — ${note}</div>`).join('')}</div>
<div id="cfgPub" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-upload"></i> Опубликует <b>${seln}</b> выбранных на сайте сейчас (Dolphin, последовательно).</div><div class="d-flex gap-2 align-items-end flex-wrap"><div><label class="form-label small mb-1">Аккаунт</label><select name="account" class="form-select form-select-sm" style="min-width:14rem">${bulkAccOpts}</select></div><button type="submit" class="btn btn-sm btn-primary bulk-action" formaction="/articles/bulk-publish" onclick="return confirm('Опубликовать выбранные на сайт через Dolphin?')">Опубликовать (${seln})</button>${cancel}</div></div>
<div id="cfgDist" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-calendar"></i> Расставит время публикации в окне; планировщик опубликует сам. Можно <b>сразу</b> задать и время снятия с сайта (опц.) — проставится на статью и сохранится при публикации.</div><div class="row g-2 align-items-end">${distAccRow}<div class="col-auto"><label class="form-label small mb-1">Начало</label><div class="d-flex gap-1"><input type="date" name="start_date" class="form-control form-control-sm" value="${today}" style="width:8.5rem"><input type="time" name="start_time" class="form-control form-control-sm" value="${startTime}" style="width:6rem"></div></div><div class="col-auto"><label class="form-label small mb-1">Конец</label><div class="d-flex gap-1"><input type="date" name="end_date" class="form-control form-control-sm" value="${endDate}" style="width:8.5rem"><input type="time" name="end_time" class="form-control form-control-sm" value="${endTime}" style="width:6rem"></div></div><div class="col-auto"><label class="form-label small mb-1">Режим</label><div class="d-flex gap-1 align-items-center"><label class="form-check form-check-inline m-0"><input class="form-check-input" type="radio" name="mode" value="interval" checked><span class="form-check-label">каждые</span></label><input type="number" name="interval" id="iv" class="form-control form-control-sm" value="10" min="1" style="width:4.5rem"><span class="small">мин</span><label class="form-check form-check-inline m-0 ms-2"><input class="form-check-input" type="radio" name="mode" value="even"><span class="form-check-label">равномерно</span></label></div></div><div class="col-auto"><label class="form-label small mb-1">Удалить с сайта</label><select name="del_mode" class="form-select form-select-sm" style="width:auto"><option value="site">как в настройках сайта</option><option value="none">не удалять</option><option value="window_end">к закрытию окна (${esc(endTime)})</option><option value="ttl">через N ч после публикации (до конца смены)</option><option value="exact">точное время…</option></select></div><div class="col-auto deldist-ttl d-none"><label class="form-label small mb-1">N часов</label><input type="number" name="del_hours" class="form-control form-control-sm" value="${delHours}" min="1" style="width:5rem"></div><div class="col-auto deldist-exact d-none"><label class="form-label small mb-1">Время (${esc(tzLabel)})</label><div class="d-flex gap-1"><input type="date" name="auto_del_date" class="form-control form-control-sm" style="width:8.5rem"><input type="time" name="auto_del_time" class="form-control form-control-sm" style="width:6rem"></div></div><div class="col-auto"><button type="submit" class="btn btn-sm btn-primary bulk-action" formaction="/articles/distribute">Распределить (${seln})</button>${cancel}</div></div></div>
<div id="cfgAcct" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-user-cog"></i> Назначит/раскидает аккаунт публикации у выбранных (только <b>черновик / в расписании</b>), round-robin со случайным порядком. Время публикации не меняется.</div>${hasAccounts ? `<div class="d-flex gap-2 flex-wrap mb-2">${accCheckboxes('set_accounts')}</div><button type="submit" class="btn btn-sm btn-outline-secondary bulk-action" formaction="/articles/bulk-set-account">Назначить аккаунт (${seln})</button>` : '<span class="text-secondary">У сайта нет включённых аккаунтов.</span>'} ${cancel}</div>
<div id="cfgUnsched" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2">↩ Уберёт выбранные из расписания, вернёт в черновики (на сайт не влияет).</div><button type="submit" class="btn btn-sm btn-outline-secondary bulk-action" formaction="/articles/unschedule">Снять с расписания (${seln})</button> ${cancel}</div>
<div id="cfgAutodel" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-clock-hour-4"></i> Когда снять выбранные <b>опубликованные</b> с сайта (исполнит планировщик). Те же режимы, что в настройках сайта.</div><div class="row g-2 align-items-end"><div class="col-auto"><label class="form-label small mb-1">Режим</label><select name="ad_mode" class="form-select form-select-sm" style="width:auto"><option value="none">не удалять</option><option value="window_end">к закрытию окна (${esc(endTime)})</option><option value="ttl">через N ч после публикации (до конца смены)</option><option value="exact" selected>точное время…</option></select></div><div class="col-auto adbulk-ttl d-none"><label class="form-label small mb-1">N часов</label><input type="number" name="ad_hours" class="form-control form-control-sm" value="${delHours}" min="1" style="width:5rem"></div><div class="col-auto adbulk-exact"><label class="form-label small mb-1">Время (${esc(tzLabel)})</label><div class="d-flex gap-1"><input type="date" name="ad_date" class="form-control form-control-sm" value="${delDefault.date}" style="width:8.5rem"><input type="time" name="ad_time" class="form-control form-control-sm" value="${delDefault.time}" style="width:6rem"></div></div><div class="col-auto"><button type="submit" class="btn btn-sm btn-outline-warning bulk-action" formaction="/articles/bulk-autodelete">Применить (${seln})</button>${cancel}</div></div></div>
<div id="cfgSiteDel" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-trash"></i> Снимет выбранные <b>опубликованные</b> статьи с сайта прямо сейчас (Dolphin, последовательно).</div><button type="submit" class="btn btn-sm btn-outline-warning bulk-action" formaction="/articles/bulk-site-delete" onclick="return confirm('Снять выбранные опубликованные с сайта?')">Удалить с сайта (${seln})</button> ${cancel}</div>
<div id="cfgDrop" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-trash-x"></i> Удалит выбранные из базы. Опубликованные пропускаются (сначала сними с сайта).</div><button type="submit" class="btn btn-sm btn-outline-danger bulk-action" formaction="/articles/bulk-delete" onclick="return confirm('Удалить выбранные из БД?')">Удалить из БД (${seln})</button> ${cancel}</div>
</div></form></div>`;

  const pubCell = (a) =>
    (accBySite[a.site_id] || []).length
      ? `<form method="post" action="/articles/${a.id}/publish" class="d-flex gap-1" onsubmit="return confirm('Опубликовать на сайт через Dolphin?')"><select name="account" class="form-select form-select-sm" style="width:auto">${accOpts(a.site_id)}</select><button class="btn btn-sm btn-outline-primary">Опубл.</button></form>`
      : `<a href="/sites/${a.site_id}#accounts" class="text-secondary small">нет аккаунта</a>`;
  // Инлайн-редактор времени публикации (для черновика/в расписании). Вводится в часовом поясе сайта.
  const schedCell = (a) => {
    const ztz = tzBySite[a.site_id] || 'Europe/Vienna';
    const z = a.scheduled_at ? epochToZoned(parseStamp(a.scheduled_at), ztz) : epochToZoned(Date.now(), ztz);
    return `<form method="post" action="/articles/${a.id}/schedule" class="d-flex gap-1"><input type="hidden" name="from" value="${esc(from)}"><input type="date" name="date" class="form-control form-control-sm" style="width:8.5rem" value="${z.date}"><input type="time" name="time" class="form-control form-control-sm" style="width:6rem" value="${z.time}"><button class="btn btn-sm btn-outline-secondary" title="Сохранить время публикации"><i class="ti ti-check"></i></button></form>`;
  };
  // Инлайн-редактор времени авто-удаления (для опубликованной, ещё не снятой).
  const delCell = (a) => {
    const ztz = tzBySite[a.site_id] || 'Europe/Vienna';
    const z = a.delete_at ? epochToZoned(parseStamp(a.delete_at), ztz) : delDefault;
    return `<form method="post" action="/articles/${a.id}/set-delete-at" class="d-flex gap-1"><input type="hidden" name="from" value="${esc(from)}"><input type="date" name="date" class="form-control form-control-sm" style="width:8.5rem" value="${z.date}"><input type="time" name="time" class="form-control form-control-sm" style="width:6rem" value="${z.time}"><button class="btn btn-sm btn-outline-warning" title="Сохранить время авто-удаления"><i class="ti ti-check"></i></button></form>`;
  };
  const siteDelBtn = (a) => `<form method="post" action="/articles/${a.id}/site-delete" onsubmit="return confirm('Снять статью с сайта через Dolphin?')"><button class="btn btn-sm btn-outline-warning">Удалить с сайта</button></form>`;
  const rel = (s) => {
    const ep = parseStamp(s);
    if (ep == null) return '';
    const o = ep < Date.now();
    const m = Math.round(Math.abs(ep - Date.now()) / 60000);
    const txt = m < 1 ? '<1 мин' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
    return o ? `просрочено на ${txt}` : `через ${txt}`;
  };
  const stateLine = (a) => {
    const ztz = tzBySite[a.site_id] || 'Europe/Vienna';
    if (a.status === 'draft') return '<span class="text-secondary">Черновик — не запланирована</span>';
    if (a.status === 'failed') return '<span class="text-danger">Ошибка генерации/публикации</span>';
    if (a.status === 'scheduled') return `<span class="text-info">В расписании</span> → <b>${esc(fmtInTz(a.scheduled_at, ztz))}</b> <span class="text-secondary small">(${rel(a.scheduled_at)})</span>` + (a.delete_at ? ` · <span class="text-warning">удалится ${esc(fmtInTz(a.delete_at, ztz))}</span>` : a.no_auto_delete ? ' · <span class="text-secondary">не удалять</span>' : '');
    if (a.status === 'published' && a.site_deleted_at) return `<span class="text-secondary">Снято с сайта ${esc(fmtInTz(a.site_deleted_at, ztz))}</span>`;
    if (a.status === 'published') return `<span class="text-success">На сайте</span> с ${esc(fmtInTz(a.published_at, ztz))}` + (a.delete_at ? ` · <span class="text-warning">удалится ${esc(fmtInTz(a.delete_at, ztz))}</span> <span class="text-secondary small">(${rel(a.delete_at)})</span>` : a.no_auto_delete ? ' · <span class="text-secondary">не удалять</span>' : ' · авто-удаление не задано');
    return '';
  };
  const statusCell = (a) => (a.status === 'published' && a.site_deleted_at ? '<span class="badge bg-secondary text-white">архив</span>' : badge(a.status));
  // Инлайн-кнопки действий (раньше прятались под «⋮» — места хватает, выводим всё сразу).
  const unschedBtn = (a) => `<form method="post" action="/articles/unschedule"><input type="hidden" name="ids" value="${a.id}"><input type="hidden" name="from" value="${esc(from)}"><button class="btn btn-sm btn-outline-secondary" title="Вернуть в черновики, убрать время">↩ Снять с расписания</button></form>`;
  const clearDelBtn = (a) => `<form method="post" action="/articles/${a.id}/clear-delete-at"><input type="hidden" name="from" value="${esc(from)}"><button class="btn btn-sm btn-outline-secondary" title="Отменить авто-удаление с сайта">Снять авто-удаление</button></form>`;
  const dropDbBtn = (a) => `<form method="post" action="/articles/bulk-delete" onsubmit="return confirm('Удалить статью из БД?')"><input type="hidden" name="ids" value="${a.id}"><input type="hidden" name="from" value="${esc(from)}"><button class="btn btn-sm btn-outline-danger" title="Удалить из базы (сайт не трогает)"><i class="ti ti-trash-x"></i></button></form>`;
  const linkBtn = (a) => `<a class="btn btn-sm btn-outline-success" href="${esc(a.site_url)}" target="_blank" rel="noopener" title="Открыть публикацию на сайте"><i class="ti ti-external-link"></i> На сайте</a>`;
  const acctLine = (a) => {
    const v = cardAccount(a);
    if (!v) return '';
    return a.account_id
      ? `<div class="small text-secondary mb-2"><i class="ti ti-user-check"></i> аккаунт: <b>${esc(v)}</b></div>`
      : `<div class="small text-secondary mb-2"><i class="ti ti-user"></i> аккаунт (план): ${esc(v)}</div>`;
  };
  const cards = rows
    .map((a) => {
      const editor =
        a.status === 'draft' || a.status === 'scheduled'
          ? `<div class="small text-secondary mb-1">Время публикации (${esc(tzLabel)})</div>${schedCell(a)}`
          : a.status === 'published' && !a.site_deleted_at
            ? `<div class="small text-secondary mb-1">Удалить с сайта в (${esc(tzLabel)})</div>${delCell(a)}`
            : '';
      const ztz = tzBySite[a.site_id] || 'Europe/Vienna';
      const f = [];
      if (a.status !== 'published') f.push(pubCell(a));
      if (a.status === 'published' && !a.site_deleted_at) f.push(siteDelBtn(a));
      if (a.status === 'published' && a.site_url && !a.site_deleted_at) f.push(linkBtn(a));
      if (a.status === 'scheduled') f.push(unschedBtn(a));
      if (a.status === 'published' && a.delete_at && !a.site_deleted_at) f.push(clearDelBtn(a));
      f.push(`<a class="btn btn-sm btn-outline-secondary ms-auto" href="/articles/${a.id}">Открыть</a>`);
      if (a.status !== 'published' || a.site_deleted_at) f.push(dropDbBtn(a)); // можно удалять не-опубликованные и архивные (снятые с сайта)
      const sub = `#${a.id}${fixedSiteId ? '' : ' · ' + esc(a.site_name || '#' + a.site_id)}${a.category ? ' · ' + esc(a.category) : ''}`;
      return `<div class="col-md-6 col-xl-4 dcard" data-status="${a.status === 'published' && a.site_deleted_at ? 'archive' : esc(a.status)}" data-prompt="${esc(a.category || '')}" data-account="${esc(cardAccount(a))}" data-id="${a.id}" data-sched="${parseStamp(a.scheduled_at) || parseStamp(a.published_at) || 0}" data-del="${parseStamp(a.delete_at) || 0}"><div class="card h-100">
<div class="card-header py-2 d-flex align-items-center gap-2 cardsel" style="cursor:pointer" title="Клик — выбрать карточку"><input class="form-check-input m-0" type="checkbox" name="ids" form="distform" value="${a.id}"> ${statusCell(a)}<span class="ms-auto text-secondary small">${sub}</span></div>
<div class="card-body">
<div class="fw-bold mb-1 cardsel" role="button" style="cursor:pointer" title="Клик — выбрать карточку">${esc((a.title || '').slice(0, 80))}</div>
${a.keyword ? `<div class="mb-1"><span class="badge bg-yellow text-dark kwcopy" role="button" data-kw="${esc(a.keyword)}" title="Клик — скопировать ключ"><i class="ti ti-key"></i> ${esc(a.keyword)}</span></div>` : ''}
<div class="small text-secondary mb-2"><i class="ti ti-sparkles"></i> сген.: ${esc(fmtInTz(a.generated_at, ztz))}</div>
${acctLine(a)}
<div class="small mb-3">${stateLine(a)}</div>
${editor}
</div>
<div class="card-footer py-2"><div class="d-flex flex-wrap gap-1 align-items-center">${f.join('')}</div></div>
</div></div>`;
    })
    .join('');
  const grid = `<div class="row row-cards mb-3" id="cardgrid">${cards || '<div class="col"><div class="card"><div class="card-body text-secondary">Статей нет.</div></div></div>'}</div>`;
  const script = `<script>(function(){
function boxes(){return Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox][name=ids]'));}
var sa=document.getElementById('selall'),cnt=document.getElementById('selcount'),iv=document.getElementById('iv'),sfs=document.querySelectorAll('.statusfilter'),pf=document.getElementById('promptfilter'),af=document.getElementById('accfilter');
function closeCfg(){Array.prototype.forEach.call(document.querySelectorAll('.cfg'),function(p){p.classList.add('d-none');});}
function upd(){var n=0;boxes().forEach(function(b){if(b.checked)n++;});if(cnt)cnt.textContent=n;Array.prototype.forEach.call(document.querySelectorAll('.seln'),function(e){e.textContent=n;});Array.prototype.forEach.call(document.querySelectorAll('.bulk-action,.act-toggle'),function(b){b.disabled=(n===0);});if(n===0)closeCfg();}
function syncMode(){var m=document.querySelector('input[name=mode]:checked');if(iv&&m)iv.disabled=(m.value!=='interval');}
function delmodesync(){var m=document.querySelector('select[name=del_mode]');if(m){var ttl=document.querySelector('.deldist-ttl'),ex=document.querySelector('.deldist-exact');if(ttl)ttl.classList.toggle('d-none',m.value!=='ttl');if(ex)ex.classList.toggle('d-none',m.value!=='exact');}var am=document.querySelector('select[name=ad_mode]');if(am){var at=document.querySelector('.adbulk-ttl'),ae=document.querySelector('.adbulk-exact');if(at)at.classList.toggle('d-none',am.value!=='ttl');if(ae)ae.classList.toggle('d-none',am.value!=='exact');}}
function filt(){var ch=[];sfs.forEach(function(c){if(c.checked)ch.push(c.value);});var pv=pf?pf.value:'';var av=af?af.value:'';Array.prototype.forEach.call(document.querySelectorAll('.dcard'),function(r){var okAcc=!av||(av==='__none__'?!r.getAttribute('data-account'):r.getAttribute('data-account')===av);var vis=ch.indexOf(r.getAttribute('data-status'))>=0&&(!pv||r.getAttribute('data-prompt')===pv)&&okAcc;r.style.display=vis?'':'none';if(!vis){var cb=r.querySelector('input[name=ids]');if(cb)cb.checked=false;}});upd();}
function sortCards(){var g=document.getElementById('cardgrid'),s=document.getElementById('sortsel');if(!g||!s)return;var k=s.value;function nz(el,a){var v=parseFloat(el.getAttribute(a));return isNaN(v)?0:v;}var arr=Array.prototype.slice.call(g.querySelectorAll('.dcard'));arr.sort(function(x,y){if(k==='id_desc')return nz(y,'data-id')-nz(x,'data-id');if(k==='id_asc')return nz(x,'data-id')-nz(y,'data-id');var attr=k.indexOf('pub')===0?'data-sched':'data-del',ax=nz(x,attr),ay=nz(y,attr);if(ax===0&&ay===0)return nz(y,'data-id')-nz(x,'data-id');if(ax===0)return 1;if(ay===0)return -1;return k.indexOf('desc')>=0?ay-ax:ax-ay;});arr.forEach(function(el){g.appendChild(el);});}
if(sa)sa.addEventListener('change',function(){boxes().forEach(function(b){var card=b.closest('.dcard');if(!card||card.style.display!=='none')b.checked=sa.checked;});upd();});
var FKEY='artfilter_${fixedSiteId || 'all'}';
function saveFilter(){try{var on=[];sfs.forEach(function(c){if(c.checked)on.push(c.value);});localStorage.setItem(FKEY,JSON.stringify(on));}catch(e){}}
function loadFilter(){try{var s=localStorage.getItem(FKEY);if(!s)return;var on=JSON.parse(s);sfs.forEach(function(c){c.checked=on.indexOf(c.value)>=0;});}catch(e){}}
loadFilter();
var PKEY='artprompt_${fixedSiteId || 'all'}';
try{var pv0=localStorage.getItem(PKEY);if(pv0&&pf&&Array.prototype.some.call(pf.options,function(o){return o.value===pv0;}))pf.value=pv0;}catch(e){}
if(pf)pf.addEventListener('change',function(){try{localStorage.setItem(PKEY,pf.value);}catch(e){}filt();});
var AKEY='artacc_${fixedSiteId || 'all'}';
try{var av0=localStorage.getItem(AKEY);if(av0&&af&&Array.prototype.some.call(af.options,function(o){return o.value===av0;}))af.value=av0;}catch(e){}
if(af)af.addEventListener('change',function(){try{localStorage.setItem(AKEY,af.value);}catch(e){}filt();});
sfs.forEach(function(c){c.addEventListener('change',function(){saveFilter();filt();});});
Array.prototype.forEach.call(document.querySelectorAll('.act-toggle'),function(btn){btn.addEventListener('click',function(){if(btn.disabled)return;var panel=document.getElementById(btn.getAttribute('data-cfg'));var open=panel&&!panel.classList.contains('d-none');closeCfg();if(panel&&!open)panel.classList.remove('d-none');});});
Array.prototype.forEach.call(document.querySelectorAll('.cfgcancel'),function(b){b.addEventListener('click',closeCfg);});
var hb=document.getElementById('bulkhelpbtn'),hp=document.getElementById('bulkhelp');if(hb&&hp)hb.addEventListener('click',function(){hp.classList.toggle('d-none');});
document.addEventListener('change',function(e){if(!e.target)return;if(e.target.name==='ids')upd();if(e.target.name==='mode')syncMode();if(e.target.name==='del_mode'||e.target.name==='ad_mode')delmodesync();if(e.target.id==='sortsel')sortCards();});
upd();syncMode();filt();delmodesync();sortCards();
function kwCopy(el){var kw=el.getAttribute('data-kw');if(!kw)return;var done=function(){var o=el.innerHTML;el.innerHTML='<i class="ti ti-check"></i> скопировано';el.classList.remove('bg-yellow');el.classList.add('bg-green','text-white');setTimeout(function(){el.innerHTML=o;el.classList.add('bg-yellow');el.classList.remove('bg-green','text-white');},1000);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(kw).then(done).catch(done);}else{var ta=document.createElement('textarea');ta.value=kw;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.focus();ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);done();}}
document.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('.kwcopy');if(el){e.preventDefault();kwCopy(el);}});
// Клик по заголовку/шапке карточки — выделить (кроме ссылок/кнопок/чекбокса/копирования ключа).
document.addEventListener('click',function(e){if(e.target.closest('a,button,input,select,form,.kwcopy'))return;var sel=e.target.closest('.cardsel');if(!sel)return;var card=sel.closest('.dcard');if(!card)return;var cb=card.querySelector('input[name=ids]');if(cb){cb.checked=!cb.checked;upd();}});
var clk=document.getElementById('siteclock');if(clk){var TZ='${tz}';var tick=function(){try{clk.textContent=new Intl.DateTimeFormat('ru-RU',{timeZone:TZ,hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date());}catch(e){}};tick();setInterval(tick,1000);}
})();</script>`;
  return bulkBar + grid + script;
}

export async function registerRoutes(app) {
  const db = getDb();

  // ============================ Сайты: список ============================
  app.get('/sites', async (req, reply) => {
    const rows = db.prepare('SELECT * FROM sites ORDER BY id').all();
    const cards = rows.length
      ? `<div class="row row-cards mb-3">${rows
          .map(
            (s) => `<div class="col-md-6 col-lg-4"><div class="card"><a class="card-body d-block text-reset text-decoration-none" href="/sites/${s.id}">
<h3 class="card-title mb-1">${esc(s.name)} ${s.active ? '' : '<span class="badge bg-secondary text-white">выкл</span>'}</h3>
<div class="text-secondary mono">${esc(s.origin)}</div>
<div class="text-secondary small mt-2">профиль: ${esc(s.profile_name)} · интервал ${s.publish_interval_minutes}м · ${esc(s.window_start)}–${esc(s.window_end)}</div></a></div></div>`,
          )
          .join('')}</div>`
      : '<p class="text-secondary">Сайтов пока нет.</p>';
    const form = `<details><summary class="btn btn-outline-primary">+ Добавить сайт</summary>
<div class="card mt-2"><div class="card-body"><form method="post" action="/sites">
<div class="mb-2"><input name="name" class="form-control" placeholder="название" required></div>
<div class="mb-2"><input name="origin" class="form-control" placeholder="https://..." required></div>
<div class="mb-2"><input name="profile" class="form-control" placeholder="Dolphin profile" required></div>
<div class="row g-2 mb-3"><div class="col"><input name="interval" type="number" class="form-control" value="5" placeholder="интервал, мин"></div><div class="col"><input name="window_start" class="form-control" value="09:00"></div><div class="col"><input name="window_end" class="form-control" value="21:00"></div></div>
<button type="submit" class="btn btn-primary">Добавить</button></form></div></div></details>`;
    reply.type('text/html').send(page('/sites', 'Сайты', cards + form, { flash: flash(req.query) }));
  });

  app.post('/sites', async (req, reply) => {
    const b = req.body;
    const info = db
      .prepare(
        `INSERT INTO sites (name,origin,profile_name,publish_interval_minutes,window_start,window_end,binom_param_article,binom_param_link,links_per_article,tags_per_article)
         VALUES (@name,@origin,@profile,@interval,@ws,@we,'s1','s2',3,3)`,
      )
      .run({ name: b.name, origin: String(b.origin || '').trim().replace(/\/+$/, ''), profile: b.profile, interval: Number(b.interval || 5), ws: b.window_start || '09:00', we: b.window_end || '21:00' });
    reply.redirect(`/sites/${info.lastInsertRowid}`);
  });

  // ============================ Сайт: хаб ============================
  app.get('/sites/:id', async (req, reply) => {
    const id = Number(req.params.id);
    const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(id);
    if (!s) return reply.code(404).send('Сайт не найден');

    const tzSelectOpts = EU_TZ.map(([v, l]) => `<option value="${v}"${v === (s.timezone || 'Europe/Vienna') ? ' selected' : ''}>${l}</option>`).join('');
    const grpLabel = (t) => `<div class="text-uppercase text-secondary small fw-bold mb-2">${t}</div>`;
    const fld = (cls, label, inputHtml) => `<div class="${cls}"><label class="form-label mb-1 small">${label}</label>${inputHtml}</div>`;
    const inp = (name, val, type = 'text') => `<input name="${name}" type="${type}" class="form-control form-control-sm" value="${esc(val)}">`;
    // Кнопки «Сохранить» и «Выключить» — одна форма, разные действия через formaction (toggle игнорирует поля).
    const settingsBody = `<form method="post" action="/sites/${id}">
${grpLabel('Сайт')}
<div class="row g-2 mb-3">${fld('col-md-4', 'Название', inp('name', s.name))}${fld('col-md-5', 'Origin', inp('origin', s.origin))}${fld('col-md-3', 'Dolphin профиль', inp('profile', s.profile_name))}${fld('col-md-4', 'Тип сайта (адаптер)', `<select name="adapter" class="form-select form-select-sm">${adapterList().map((ad) => `<option value="${ad.name}"${ad.name === (s.adapter || 'meinbezirk') ? ' selected' : ''}>${esc(ad.label)}</option>`).join('')}</select>`)}</div>
${grpLabel('Расписание публикации')}
<div class="row g-2 mb-3">${fld('col-6 col-md-2', 'Интервал, мин', inp('interval', s.publish_interval_minutes, 'number'))}${fld('col-6 col-md-2', 'Окно с', inp('window_start', s.window_start))}${fld('col-6 col-md-2', 'Окно до', inp('window_end', s.window_end))}${fld('col-6 col-md-3', 'Часовой пояс', `<select name="timezone" class="form-select form-select-sm">${tzSelectOpts}</select>`)}${fld('col-6 col-md-3', 'Автоудаление с сайта', `<select name="auto_delete" class="form-select form-select-sm"><option value="off"${s.auto_delete === 'off' ? ' selected' : ''}>Не удалять</option><option value="window_end"${(s.auto_delete || 'window_end') === 'window_end' ? ' selected' : ''}>К закрытию окна (${esc(s.window_end || '09:00')})</option><option value="ttl_capped"${s.auto_delete === 'ttl_capped' ? ' selected' : ''}>Через N часов, но до конца смены</option></select>`)}${fld('col-6 col-md-2', 'N часов (для «через N»)', inp('auto_delete_hours', s.auto_delete_hours ?? 4, 'number'))}</div>
${grpLabel('Binom и лимиты')}
<div class="row g-2 mb-3">${fld('col-6 col-md-2', 'Binom — статья', inp('binom_article', s.binom_param_article))}${fld('col-6 col-md-2', 'Binom — ссылка', inp('binom_link', s.binom_param_link))}${fld('col-6 col-md-3', 'Дневной лимит <span class="text-secondary fw-normal">(0 = без)</span>', inp('daily_limit', s.daily_limit ?? 0, 'number'))}</div>
<div class="d-flex flex-wrap gap-2"><button type="submit" class="btn btn-primary">Сохранить</button><button type="submit" formaction="/sites/${id}/toggle" class="btn btn-outline-secondary">${s.active ? 'Выключить' : 'Включить'}</button></div>
</form>`;
    const settings = card('<i class="ti ti-settings"></i> Настройки', settingsBody, 'settings');

    // --- аккаунты публикации (логин/пароль + своя прокси; выбираются при публикации) ---
    const mask = (v) => (!v ? '' : v.length <= 3 ? '•••' : `${v.slice(0, 2)}•••${v.slice(-1)}`);
    const siteAccs = listSiteAccounts(db, id);
    const accRows = siteAccs
      .map(
        (acc) => `<tr><td>${acc.id}</td><td>${esc(acc.username)}</td><td class="text-secondary mono">${esc(mask(acc.password))}</td><td class="text-secondary mono">${esc((acc.proxy || '-').split(':')[0])}</td><td>${esc(acc.label || '-')}</td><td>${acc.enabled ? '<span class="badge bg-green text-white">вкл</span>' : '<span class="badge bg-secondary text-white">выкл</span>'}</td>
<td>${acc.cookies_updated_at ? `<span class="badge bg-azure text-white" title="сохранена ${esc(acc.cookies_updated_at)} UTC — логин пропускается"><i class="ti ti-check"></i> есть</span>` : '<span class="text-secondary small">—</span>'}</td>
<td><div class="d-flex gap-1"><form method="post" action="/site-accounts/${acc.id}/toggle"><button class="btn btn-sm btn-outline-secondary">${acc.enabled ? 'выкл' : 'вкл'}</button></form>
${acc.cookies_updated_at ? `<form method="post" action="/site-accounts/${acc.id}/clear-cookies" title="сбросить сессию — при следующей публикации залогинится заново"><button class="btn btn-sm btn-outline-secondary">⟳ сессия</button></form>` : ''}
<form method="post" action="/site-accounts/${acc.id}/delete" onsubmit="return confirm('Удалить аккаунт?')"><button class="btn btn-sm btn-outline-danger">×</button></form></div></td></tr>`,
      )
      .join('');
    const addAcc = `<form method="post" action="/sites/${id}/accounts" class="row g-2 align-items-end">
<div class="col-auto"><label class="form-label">Логин</label><input name="username" class="form-control" required></div>
<div class="col-auto"><label class="form-label">Пароль</label><input name="password" class="form-control" required></div>
<div class="col"><label class="form-label">Прокси (host:port[:user:pass])</label><input name="proxy" class="form-control" placeholder="напр. 1.2.3.4:8080:user:pass"></div>
<div class="col-auto"><label class="form-label">Метка</label><input name="label" class="form-control" placeholder="опц." style="max-width:9rem"></div>
<div class="col-auto"><button type="submit" class="btn btn-primary">Добавить</button></div></form>`;
    const accountsCard = `<div class="card mb-3" id="accounts"><div class="card-header"><h3 class="card-title"><i class="ti ti-key"></i> Аккаунты публикации</h3></div><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>id</th><th>логин</th><th>пароль</th><th>прокси</th><th>метка</th><th>статус</th><th>сессия</th><th></th></tr></thead><tbody>${accRows || '<tr><td colspan="8" class="text-secondary">аккаунтов нет — добавь</td></tr>'}</tbody></table></div><div class="card-footer">${addAcc}</div></div>`;

    // --- регистрация аккаунтов (по свободным почтам пула) ---
    const regStatusRu = {
      pending: 'в очереди', mail_login_failed: 'вход в почту не удался', submitted: 'форма отправлена',
      confirm_failed: 'нет подтверждения', awaiting_admin: 'ждём одобрения админа', approved: 'одобрено', rejected: 'отклонено', failed: 'ошибка',
    };
    const regStatusBadge = (s) => {
      const m = { approved: 'bg-green', awaiting_admin: 'bg-azure', submitted: 'bg-azure', pending: 'bg-secondary', rejected: 'bg-red', failed: 'bg-red', mail_login_failed: 'bg-red', confirm_failed: 'bg-orange' };
      return `<span class="badge ${m[s] || 'bg-secondary'} text-white">${esc(regStatusRu[s] || s)}</span>`;
    };
    const adapterObj = getAdapter(s.adapter);
    const supportsReg = !!adapterObj.register;
    const captchaReady = !!(process.env.CAPTCHA_PROVIDER || getSetting(db, 'captcha_provider')) && !!(process.env.CAPTCHA_API_KEY || getSetting(db, 'captcha_api_key'));
    const freeEmails = freeEmailAccounts(db);
    const regList = listRegistrations(db, id, { limit: 50 });
    const retryStatuses = ['failed', 'confirm_failed', 'mail_login_failed', 'submitted'];
    const anyAwaiting = regList.some((r) => r.status === 'awaiting_admin');
    const regRows = regList
      .map((r) => {
        const cb = r.status === 'awaiting_admin' ? `<input class="form-check-input m-0" type="checkbox" name="regs" value="${r.id}" form="regcheck">` : '';
        const check = r.status === 'awaiting_admin' ? `<form method="post" action="/registrations/${r.id}/check" onsubmit="return confirm('Проверить одобрение по IMAP?')"><button class="btn btn-sm btn-outline-secondary">проверить</button></form>` : '';
        const retry = retryStatuses.includes(r.status) ? `<form method="post" action="/registrations/${r.id}/retry" onsubmit="return confirm('Повторить регистрацию (последовательно)?')"><button class="btn btn-sm btn-outline-primary">повторить</button></form>` : '';
        return `<tr><td>${cb}</td><td>${r.id}</td><td>${esc(r.email)}</td><td>${regStatusBadge(r.status)}</td><td class="text-secondary small">${esc(r.identity?.name || '-')}</td>
<td class="text-secondary small" style="white-space:nowrap">${esc(fmtInTz(r.submitted_at, 'UTC'))}</td>
<td class="text-secondary small" style="white-space:nowrap">${r.approved_at ? esc(fmtInTz(r.approved_at, 'UTC')) : '—'}</td>
<td class="text-secondary small" style="white-space:nowrap">${r.last_checked_at ? esc(fmtInTz(r.last_checked_at, 'UTC')) + (r.checks ? ` <span class="text-secondary">(${r.checks})</span>` : '') : '—'}</td>
<td class="text-secondary small">${esc((r.error || '').slice(0, 60))}</td>
<td><div class="d-flex gap-1">${check}${retry}</div></td></tr>`;
      })
      .join('');
    const selectAllCb = anyAwaiting ? `<input class="form-check-input m-0" type="checkbox" title="выбрать все «ждём одобрения»" onclick="var on=this.checked;document.querySelectorAll('input[name=regs]').forEach(function(c){c.checked=on});">` : '';
    const regTable = `<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>${selectAllCb}</th><th>id</th><th>почта</th><th>статус</th><th>имя</th><th title="первый этап: форма+подтверждение пройдены (UTC)">первый этап</th><th title="когда обнаружено письмо-одобрение админом (UTC)">одобрен</th><th title="время последней IMAP-проверки одобрения (UTC); в скобках — число проверок">посл. проверка</th><th>ошибка</th><th></th></tr></thead><tbody>${regRows || '<tr><td colspan="10" class="text-secondary">регистраций ещё нет</td></tr>'}</tbody></table></div>`;
    const bulkCheckBar = anyAwaiting
      ? `<div class="card-footer"><form id="regcheck" method="post" action="/sites/${id}/check-approvals" onsubmit="return confirm('Проверить одобрение выбранных регистраций по IMAP?')"><button class="btn btn-sm btn-outline-secondary" type="submit"><i class="ti ti-refresh"></i> Проверить выбранные</button> <span class="text-secondary small">Отметь «ждём одобрения» и запусти проверку пачкой (по IMAP, без Dolphin; одной задачей последовательно).</span></form></div>`
      : '';
    const emailChecks = freeEmails.length
      ? freeEmails.map((e) => `<label class="form-check"><input class="form-check-input" type="checkbox" name="emails" value="${e.id}"><span class="form-check-label">${esc(e.email)} <span class="text-secondary small">${esc((e.proxy || 'без прокси').split(':')[0])}</span></span></label>`).join('')
      : '<div class="text-secondary small">Свободных почт нет — добавь на странице <a href="/emails">«Почты»</a>.</div>';
    const regWarn = !supportsReg
      ? '<div class="alert alert-warning">Адаптер этого сайта не поддерживает регистрацию.</div>'
      : !captchaReady
        ? '<div class="alert alert-warning">Не настроен сервис решения капч — задай его в <a href="/settings">Настройках</a> (без него регистрация с капчей не пройдёт).</div>'
        : '';
    const regForm = supportsReg
      ? `${regWarn}<form method="post" action="/sites/${id}/register" onsubmit="return confirm('Запустить регистрацию выбранных почт через Dolphin? Реальные действия на сайте.')">
<div class="mb-2 text-secondary small">Выбери свободные почты пула (каждая закрепляется за этим сайтом — правило «одна почта = один сайт»). Личность и пароль генерируются автоматически.</div>
<div class="row"><div class="col" style="max-height:14rem;overflow:auto">${emailChecks}</div></div>
<button type="submit" class="btn btn-primary mt-2"${freeEmails.length ? '' : ' disabled'}>Зарегистрировать выбранные</button></form>`
      : regWarn;
    const registrationCard = `<div class="card mb-3" id="registration"><div class="card-header"><h3 class="card-title"><i class="ti ti-user-plus"></i> Регистрация аккаунтов</h3></div><div class="card-body">${regForm}</div>${regTable}${bulkCheckBar}</div>`;

    // --- промты (скрытые не показываем; ?showHidden=1 — показать с кнопкой «вернуть») ---
    const showHidden = req.query.showHidden === '1';
    const visiblePrompts = db.prepare('SELECT * FROM prompts WHERE site_id = ? AND hidden = 0 ORDER BY id').all(id);
    const hiddenPrompts = showHidden ? db.prepare('SELECT * FROM prompts WHERE site_id = ? AND hidden = 1 ORDER BY id').all(id) : [];
    const promptRow = (p, hidden) => {
      const v = validateBlock(p.link_block || '');
      const tagsN = String(p.tags || '').split(',').map((t) => t.trim()).filter(Boolean).length;
      return `<tr${hidden ? ' class="opacity-50"' : ''}><td>${p.id}</td><td>${promptName(p)} ${p.active ? '<span class="badge bg-green text-white">активный</span>' : ''}${hidden ? ' <span class="badge bg-secondary text-white">скрыт</span>' : ''}</td>
<td>${(p.link_block || '').trim() ? `${v.urls.length} ссыл. ${v.ok ? '<i class="ti ti-circle-check text-green"></i>' : '<span class="badge bg-red text-white">ошибки формата</span>'}` : '<span class="text-secondary">нет блока</span>'}</td>
<td>${tagsN >= 2 ? tagsN + ' тегов' : `<span class="badge bg-red text-white">${tagsN} тег.</span>`}</td>
<td><div class="d-flex gap-1"><a href="/prompts/${p.id}" class="btn btn-sm btn-outline-secondary">ред.</a>${hidden ? `<form method="post" action="/prompts/${p.id}/unhide"><button class="btn btn-sm btn-outline-success">вернуть</button></form>` : `<form method="post" action="/prompts/${p.id}/delete" onsubmit="return confirm('Скрыть промт из списка? (статьи по нему не пострадают)')"><button class="btn btn-sm btn-outline-danger">скрыть</button></form>`}</div></td></tr>`;
    };
    const promptRows = visiblePrompts.map((p) => promptRow(p, false)).join('') + hiddenPrompts.map((p) => promptRow(p, true)).join('');
    const promptsFooter = `<div class="d-flex flex-wrap gap-2 align-items-center"><form method="post" action="/prompts"><input type="hidden" name="site" value="${id}"><button type="submit" class="btn btn-primary">+ Новый промт</button></form><a href="/sites/${id}?tab=generate&showHidden=${showHidden ? '0' : '1'}#prompts" class="btn btn-link btn-sm">${showHidden ? 'скрыть архивные' : 'показать скрытые'}</a></div>`;
    const promptsCard = tableCard('<i class="ti ti-edit"></i> Промты', ['id', 'название', 'блок ссылок', 'теги', ''], promptRows, 'prompts', promptsFooter);

    // --- статьи сайта (полная рабочая область: распределение + публикация построчно/балком) ---
    const articlesWs = renderArticlesWorkspace(db, { fixedSiteId: id, from: `/sites/${id}?tab=articles` });

    // --- генерация + (свёрнутое) ручное добавление ---
    const promptOpts = visiblePrompts.map((p) => `<option value="${p.id}"${p.active ? ' selected' : ''}>${promptName(p)}</option>`).join('');
    // Движок (API/Тариф) — БЕЗ авто-выбора: пользователь выбирает явно (segmented-блок в форме ниже).
    // ключи из сохранённых списков — для автоподсказки в поле «Целевой ключ»
    const kwSuggest = db.prepare('SELECT DISTINCT phrase FROM kw_list_items ORDER BY phrase').all();
    const kwDatalist = `<datalist id="kwlist-${id}">${kwSuggest.map((k) => `<option value="${esc(k.phrase)}"></option>`).join('')}</datalist>`;
    // Списки ключей — для режима «Список ключей» (фолдится в единую панель генерации).
    const listGenOpts = listLists(db).map((l) => `<option value="${l.id}" data-new="${l.c_new}">${esc(l.name)} — новых: ${l.c_new}</option>`).join('') || '<option value="">нет списков (создай в «Списки»)</option>';
    // Единая панель: общие Промт + Движок сверху, переключатель «Источник» меняет только нужное поле и кнопку.
    const genBody = visiblePrompts.length
      ? `<form method="post" id="gencard-${id}">${kwDatalist}
<div class="row g-2 mb-2 align-items-end"><div class="col"><label class="form-label">Промт <span class="text-secondary small">— ключ подставляется в <code>{{KEYWORD}}</code></span></label><select name="prompt" class="form-select" required>${promptOpts}</select></div></div>
<div class="d-flex flex-wrap gap-4 mb-3">
<div><label class="form-label d-block mb-1">Движок <span class="text-secondary small">— выбери явно</span></label>
<div class="btn-group" role="group">
<input type="radio" class="btn-check" name="backend" id="be-api-${id}" value="api"><label class="btn btn-outline-primary" for="be-api-${id}"><i class="ti ti-coin"></i> API <span class="text-secondary">(платно)</span></label>
<input type="radio" class="btn-check" name="backend" id="be-cli-${id}" value="cli"><label class="btn btn-outline-primary" for="be-cli-${id}"><i class="ti ti-user-check"></i> Тариф <span class="text-secondary">(подписка)</span></label>
</div></div>
<div><label class="form-label d-block mb-1">Источник ключей</label>
<div class="btn-group" role="group">
<input type="radio" class="btn-check" name="gensrc" id="src-one-${id}" value="one" checked><label class="btn btn-outline-primary" for="src-one-${id}"><i class="ti ti-key"></i> Один ключ</label>
<input type="radio" class="btn-check" name="gensrc" id="src-list-${id}" value="list"><label class="btn btn-outline-primary" for="src-list-${id}"><i class="ti ti-list-check"></i> Список ключей</label>
<input type="radio" class="btn-check" name="gensrc" id="src-batch-${id}" value="batch"><label class="btn btn-outline-primary" for="src-batch-${id}"><i class="ti ti-stack-2"></i> Пачкой (−50%)</label>
</div></div>
</div>
<div class="gm-one mb-2"><label class="form-label">Целевой ключ <span class="text-secondary small">— опц.</span></label><input name="keyword" class="form-control" list="kwlist-${id}" placeholder="например: book of dead freispiele ohne einzahlung"></div>
<div class="gm-list d-none">
<div class="row g-2 align-items-end mb-2"><div class="col-md-7"><label class="form-label">Список ключей</label><select name="list" class="form-select">${listGenOpts}</select></div></div>
<div class="d-flex flex-wrap align-items-center gap-2 mb-2"><button type="button" class="btn btn-sm btn-outline-secondary keys-all"><i class="ti ti-checks"></i> Выбрать все</button><button type="button" class="btn btn-sm btn-outline-secondary keys-none">Снять</button><span class="badge bg-blue text-white keys-count">Выбрано: 0</span><span class="text-secondary small keys-info ms-auto"></span></div>
<div class="border rounded" style="max-height:360px;overflow:auto"><table class="table table-sm table-hover align-middle mb-0 keys-tbl"><thead></thead><tbody><tr><td class="text-secondary p-3">Выбери список — ключи загрузятся.</td></tr></tbody></table></div>
</div>
<div class="gm-batch d-none mb-2"><label class="form-label">Статей</label><input name="count" type="number" class="form-control" value="10" min="1" style="max-width:8rem"></div>
<label class="form-check my-2"><input type="checkbox" class="form-check-input" name="confirm" value="1" required><span class="form-check-label">Подтверждаю запуск генерации</span></label>
<div class="d-flex flex-wrap gap-2">
<button type="submit" class="btn btn-primary genbtn" data-mode="one" formaction="/sites/${id}/generate"><i class="ti ti-bolt"></i> Сгенерировать (1 шт)</button>
<button type="submit" class="btn btn-primary genbtn d-none" data-mode="list" formaction="/lists/bulk-generate"><i class="ti ti-bolt"></i> Сгенерировать выбранные</button>
<button type="submit" class="btn btn-primary genbtn d-none" data-mode="batch" formaction="/sites/${id}/batch"><i class="ti ti-stack-2"></i> Отправить пачкой (−50%, API)</button>
</div>
<p class="text-secondary small mt-2 mb-0"><b>Один ключ</b> — 1 статья сразу (ключ опц.). <b>Список</b> — отметь ключи в таблице (можно и уже отработанные — регенерим, чтобы снова выйти в топ), по статье на каждый выбранный; сортируй по трафику/позициям, чтобы понять, что пора освежить. <b>Пачкой</b> — N статей через Batches API (−50%, только API), затем «Собрать» (история ниже). Раскладка по времени — в разделе <a href="/articles?site=${id}">Статьи</a>.</p>
<script>(function(){var R=document.getElementById('gencard-${id}');if(!R)return;var btns=R.querySelectorAll('.genbtn');var one=R.querySelector('.gm-one'),lst=R.querySelector('.gm-list'),bat=R.querySelector('.gm-batch');var kw=R.querySelector('[name=keyword]'),list=R.querySelector('[name=list]'),count=R.querySelector('[name=count]'),cf=R.querySelector('[name=confirm]');var cli=R.querySelector('input[name=backend][value=cli]');var tbl=R.querySelector('.keys-tbl'),thead=tbl.querySelector('thead'),tbody=tbl.querySelector('tbody'),cntB=R.querySelector('.keys-count'),info=R.querySelector('.keys-info');function e(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}var COLS=[['sel','',0],['phrase','Ключ',0],['database','БД',0],['volume','Vol',1],['kd','KD',1],['cpc','CPC',1],['score','Score',1],['status','Статус',0],['seo_views','SEO',1],['total_views','Всего',1],['rank_at','AT',1],['rank_de','DE',1],['rank_ch','CH',1]];var SB={'new':'bg-azure','testing':'bg-yellow','winner':'bg-green','loser':'bg-red','skip':'bg-secondary'};var DATA=[],sk='score',sd=-1,SEL={};function num(v){return v==null||v===''?null:parseFloat(v);}function selCount(){var n=0;for(var k in SEL)if(SEL[k])n++;return n;}function head(){var h='<tr>';COLS.forEach(function(c){if(c[0]==='sel'){h+='<th style="width:1%;position:sticky;top:0;background:var(--tblr-bg-surface,#182433)"></th>';return;}var ar=sk===c[0]?(sd<0?' ↓':' ↑'):'';h+='<th class="ksort" data-k="'+c[0]+'" style="cursor:pointer;white-space:nowrap;position:sticky;top:0;background:var(--tblr-bg-surface,#182433)">'+e(c[1])+ar+'</th>';});h+='</tr>';thead.innerHTML=h;thead.querySelectorAll('.ksort').forEach(function(th){th.addEventListener('click',function(){var k=th.getAttribute('data-k');if(sk===k)sd=-sd;else{sk=k;sd=-1;}head();rows();});});}function rows(){var col=COLS.find(function(c){return c[0]===sk;});var arr=DATA.slice().sort(function(a,b){var x=a[sk],y=b[sk];if(col&&col[2]){x=num(x);y=num(y);if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;return (x-y)*sd;}x=(x==null?'':String(x)).toLowerCase();y=(y==null?'':String(y)).toLowerCase();return x<y?-sd:x>y?sd:0;});var rk=function(v){return v==null?'<span class="text-secondary">—</span>':'#'+v;};var nv=function(v){return v==null?'<span class="text-secondary">—</span>':v;};var h='';arr.forEach(function(it){h+='<tr style="cursor:pointer"><td><input type="checkbox" class="form-check-input keychk" name="ids" value="'+it.id+'"'+(SEL[it.id]?' checked':'')+'></td><td>'+e(it.phrase)+(it.article_id?' <a href="/articles/'+it.article_id+'" class="small">#'+it.article_id+'</a>':'')+'</td><td class="text-secondary">'+e(it.database||'')+'</td><td>'+nv(it.volume)+'</td><td>'+nv(it.kd)+'</td><td>'+nv(it.cpc)+'</td><td>'+(it.score==null?'':Math.round(it.score*100)/100)+'</td><td><span class="badge '+(SB[it.status]||'bg-secondary')+' text-white">'+e(it.status)+'</span></td><td>'+nv(it.seo_views)+'</td><td>'+nv(it.total_views)+'</td><td>'+rk(it.rank_at)+'</td><td>'+rk(it.rank_de)+'</td><td>'+rk(it.rank_ch)+'</td></tr>';});tbody.innerHTML=h||'<tr><td class="text-secondary p-3" colspan="13">Ключей нет.</td></tr>';tbody.querySelectorAll('.keychk').forEach(function(c){c.addEventListener('change',function(){SEL[this.value]=this.checked;upd();});});upd();}function chks(){return tbody.querySelectorAll('.keychk');}function upd(){cntB.textContent='Выбрано: '+selCount();validate();}function load(){SEL={};if(!list||!list.value){DATA=[];head();tbody.innerHTML='<tr><td class="text-secondary p-3">Выбери список.</td></tr>';info.textContent='';upd();return;}info.textContent='загрузка…';fetch('/lists/'+encodeURIComponent(list.value)+'/keys').then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){DATA=(d&&d.items)||[];info.textContent='ключей: '+DATA.length+(DATA.length>=2000?' (первые 2000)':'');head();rows();}).catch(function(){info.textContent='не удалось загрузить';DATA=[];head();rows();});}function mode(){var c=R.querySelector('input[name=gensrc]:checked');return c?c.value:'one';}function valid(m){if(!R.querySelector('input[name=backend]:checked'))return false;if(cf&&!cf.checked)return false;if(m==='list')return selCount()>0;if(m==='batch')return !!(count&&parseInt(count.value,10)>0);return true;}function validate(){var m=mode();btns.forEach(function(b){if(b.getAttribute('data-mode')===m)b.disabled=!valid(m);});}function apply(m){one.classList.toggle('d-none',m!=='one');lst.classList.toggle('d-none',m!=='list');bat.classList.toggle('d-none',m!=='batch');if(kw)kw.disabled=m!=='one';if(list)list.disabled=m!=='list';if(count)count.disabled=m!=='batch';if(cli){cli.disabled=(m==='batch');if(m==='batch'&&cli.checked)cli.checked=false;}if(m==='list'&&!DATA.length&&list&&list.value)load();btns.forEach(function(b){var on=b.getAttribute('data-mode')===m;b.classList.toggle('d-none',!on);b.disabled=!on;});validate();}R.querySelectorAll('input[name=gensrc]').forEach(function(r){r.addEventListener('change',function(){if(r.checked)apply(r.value);});});R.querySelectorAll('input[name=backend]').forEach(function(r){r.addEventListener('change',validate);});if(cf)cf.addEventListener('change',validate);if(count)count.addEventListener('input',validate);if(list)list.addEventListener('change',load);var ab=R.querySelector('.keys-all'),nb=R.querySelector('.keys-none');if(ab)ab.addEventListener('click',function(){chks().forEach(function(c){c.checked=true;SEL[c.value]=true;});upd();});if(nb)nb.addEventListener('click',function(){chks().forEach(function(c){c.checked=false;SEL[c.value]=false;});upd();});tbody.addEventListener('click',function(ev){if(ev.target.closest('a'))return;if(ev.target.classList&&ev.target.classList.contains('keychk'))return;var tr=ev.target.closest('tr');if(!tr)return;var c=tr.querySelector('.keychk');if(!c)return;c.checked=!c.checked;SEL[c.value]=c.checked;upd();});var lb=R.querySelector('.genbtn[data-mode=list]');if(lb)lb.addEventListener('click',function(ev){var n=selCount();if(n>1&&!confirm('Будет запущено '+n+' генераций (платно). Продолжить?'))ev.preventDefault();});var c0=R.querySelector('input[name=gensrc]:checked');apply(c0?c0.value:'one');})();</script></form>`
      : '<p class="text-secondary">Сначала создай промт.</p>';
    const manualBody = `<form method="post" action="/sites/${id}/manual-article">
<div class="row g-2 mb-2"><div class="col-md-8"><label class="form-label mb-1 small">Заголовок</label><input name="title" class="form-control" required placeholder="Überschrift"></div><div class="col-md-4"><label class="form-label mb-1 small">Промт (какой использовал)</label><select name="prompt" class="form-select" required>${promptOpts}</select></div></div>
<div class="mb-2"><label class="form-label mb-1 small">Тело статьи (HTML)</label><textarea name="body_html" class="form-control mono" rows="10" required placeholder="&lt;h2&gt;Подзаголовок&lt;/h2&gt;&#10;&lt;p&gt;Текст…&lt;/p&gt;"></textarea></div>
<button type="submit" class="btn btn-primary">Добавить статью</button>
<p class="text-secondary small mt-2 mb-0">Тело — HTML (как из генератора). Блок ссылок и теги из выбранного промта добавятся автоматически (Binom s1/s2). Маркер <code>{{LINKS}}</code> в тексте задаёт позицию блока (иначе — по позиции из промта). Сохранится как черновик.</p></form>`;
    const genTitle = `<span class="d-flex align-items-center w-100"><i class="ti ti-bolt"></i> Генерация${visiblePrompts.length ? '<button type="button" id="manualtoggle" class="btn btn-sm btn-outline-secondary ms-auto"><i class="ti ti-pencil-plus"></i> Добавить вручную</button>' : ''}</span>`;
    const manualBox = visiblePrompts.length
      ? `<div id="manualbox" class="d-none mt-3 pt-3 border-top">${manualBody}</div><script>(function(){var b=document.getElementById('manualtoggle'),x=document.getElementById('manualbox');if(b&&x)b.addEventListener('click',function(){x.classList.toggle('d-none');});})();</script>`
      : '';
    const genCard = card(genTitle, genBody + manualBox, 'gen');

    const batchList = db.prepare('SELECT * FROM batches WHERE site_id = ? ORDER BY id DESC LIMIT 10').all(id);
    const batchRows = batchList
      .map((b) => {
        const sum = b.summary ? JSON.parse(b.summary) : null;
        const st = b.status === 'collected' ? '<span class="badge bg-green text-white">собран</span>' : '<span class="badge bg-azure text-white">отправлен</span>';
        const info = sum ? `записано ${sum.persisted}/${sum.total}` + (sum.errored ? `, ошибок ${sum.errored}` : '') : `${b.count} шт`;
        const action = b.status === 'collected' ? '' : `<form method="post" action="/batches/${b.id}/collect"><button class="btn btn-sm btn-outline-secondary">Собрать</button></form>`;
        return `<tr><td>${b.id}</td><td>${st}</td><td>${info}</td><td class="text-secondary mono">${esc((b.batch_id || '').slice(0, 16))}…</td><td class="text-secondary">${esc(b.created_at)}</td><td>${action}</td></tr>`;
      })
      .join('');
    const batchesCard = tableCard('История пачек', ['id', 'статус', 'итог', 'batch', 'создан', ''], batchRows, 'batches');

    // Три вкладки: Генерация / Статьи (полная рабочая область + публикация) / Настройки.
    // Навигация (← Сайты) + статус — в хедер (navLeft); имя сайта — заголовок хедера.
    const navLeft = `<a href="/sites" class="text-decoration-none">← Сайты</a>${s.active ? '<span class="badge bg-green text-white">активен</span>' : '<span class="badge bg-secondary text-white">выключен</span>'}<a href="/sites/${id}/keywords" class="ms-2 text-decoration-none small text-secondary"><i class="ti ti-key"></i> Ключи сайта</a><a href="/stats?site=${id}" class="ms-2 text-decoration-none small text-secondary"><i class="ti ti-chart-bar"></i> Статистика</a>`;
    const tabsNav = `<ul class="nav nav-tabs mb-3">
<li class="nav-item"><button class="nav-link" type="button" data-tab="generate"><i class="ti ti-edit"></i> Генерация</button></li>
<li class="nav-item"><button class="nav-link" type="button" data-tab="articles"><i class="ti ti-news"></i> Статьи</button></li>
<li class="nav-item"><button class="nav-link" type="button" data-tab="settings"><i class="ti ti-settings"></i> Настройки</button></li></ul>`;
    // «Генерация по списку ключей» влита в единую панель genCard (режим «Список ключей»).
    const paneGenerate = `<div id="tab-generate" class="d-none">${genCard}${promptsCard}${batchesCard}</div>`;
    const paneArticles = `<div id="tab-articles" class="d-none">${articlesWs}</div>`;
    const paneSettings = `<div id="tab-settings" class="d-none">${settings}${accountsCard}${registrationCard}</div>`;
    const tabScript = `<script>(function(){var DEF='generate',KEY='siteTab:${id}';var btns=document.querySelectorAll('[data-tab]');var panes={generate:document.getElementById('tab-generate'),articles:document.getElementById('tab-articles'),settings:document.getElementById('tab-settings')};function show(name){if(!panes[name])name=DEF;for(var k in panes){panes[k].classList.toggle('d-none',k!==name);}btns.forEach(function(b){b.classList.toggle('active',b.getAttribute('data-tab')===name);});try{localStorage.setItem(KEY,name);}catch(e){}}btns.forEach(function(b){b.addEventListener('click',function(){show(b.getAttribute('data-tab'));});});var qtab=new URLSearchParams(location.search).get('tab');var h=location.hash&&document.querySelector(location.hash);var stored;try{stored=localStorage.getItem(KEY);}catch(e){}var initial=qtab&&panes[qtab]?qtab:(h?(Object.keys(panes).find(function(k){return panes[k]===h||panes[k].contains(h);})||DEF):(stored&&panes[stored]?stored:DEF));show(initial);if(h&&initial!=='generate'){setTimeout(function(){try{h.scrollIntoView();}catch(e){}},50);}})();</script>`;
    reply
      .type('text/html')
      .send(layout('/sites', tabsNav + paneGenerate + paneArticles + paneSettings + tabScript, { title: s.name, navLeft, flash: flash(req.query) }));
  });

  app.post('/sites/:id', async (req, reply) => {
    const b = req.body;
    db.prepare(`UPDATE sites SET name=@name,origin=@origin,profile_name=@profile,publish_interval_minutes=@interval,window_start=@ws,window_end=@we,binom_param_article=@ba,binom_param_link=@bl,daily_limit=@dl,timezone=@tz,auto_delete=@ad,auto_delete_hours=@adh,adapter=@adapter WHERE id=@id`)
      .run({ id: Number(req.params.id), name: b.name, origin: String(b.origin || '').trim().replace(/\/+$/, ''), profile: b.profile, interval: Number(b.interval || 5), ws: b.window_start, we: b.window_end, ba: b.binom_article, bl: b.binom_link, dl: Number(b.daily_limit || 0), tz: b.timezone || 'Europe/Vienna', ad: ['off', 'window_end', 'ttl_capped'].includes(b.auto_delete) ? b.auto_delete : 'window_end', adh: Math.max(1, Number(b.auto_delete_hours) || 4), adapter: adapterList().some((a) => a.name === b.adapter) ? b.adapter : 'meinbezirk' });
    reply.redirect(`/sites/${req.params.id}?msg=${encodeURIComponent('Сохранено')}#settings`);
  });
  app.post('/sites/:id/toggle', async (req, reply) => {
    db.prepare('UPDATE sites SET active = 1 - active WHERE id = ?').run(req.params.id);
    reply.redirect(`/sites/${req.params.id}`);
  });

  // Аккаунты публикации сайта (логин/пароль + своя прокси; выбираются при публикации).
  app.post('/sites/:id/accounts', async (req, reply) => {
    const id = Number(req.params.id);
    const b = req.body;
    try {
      addSiteAccount(db, id, { username: b.username, password: b.password, proxy: b.proxy, label: b.label });
      reply.redirect(`/sites/${id}?msg=${encodeURIComponent('Аккаунт добавлен')}#accounts`);
    } catch (e) {
      reply.redirect(`/sites/${id}?msg=${encodeURIComponent('Ошибка: ' + e.message)}#accounts`);
    }
  });
  app.post('/site-accounts/:id/toggle', async (req, reply) => {
    const r = db.prepare('SELECT site_id FROM site_accounts WHERE id = ?').get(req.params.id);
    toggleSiteAccount(db, Number(req.params.id));
    reply.redirect(`/sites/${r?.site_id || ''}#accounts`);
  });
  app.post('/site-accounts/:id/delete', async (req, reply) => {
    const r = db.prepare('SELECT site_id FROM site_accounts WHERE id = ?').get(req.params.id);
    removeSiteAccount(db, Number(req.params.id));
    reply.redirect(`/sites/${r?.site_id || ''}#accounts`);
  });
  app.post('/site-accounts/:id/clear-cookies', async (req, reply) => {
    const r = db.prepare('SELECT site_id FROM site_accounts WHERE id = ?').get(req.params.id);
    clearAccountCookies(db, Number(req.params.id));
    reply.redirect(`/sites/${r?.site_id || ''}?msg=${encodeURIComponent('Сессия сброшена — при следующей публикации будет логин')}#accounts`);
  });
  // Ручное добавление готовой статьи (без Claude) — сразу пишет draft + ссылки/теги по промту.
  app.post('/sites/:id/manual-article', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      const r = addManualArticle(db, { siteId: id, promptId: Number(req.body.prompt), title: req.body.title, bodyHtml: req.body.body_html });
      const w = r.warnings.length ? ' (!)' + r.warnings.join('; ') : '';
      reply.redirect(`/articles/${r.id}?msg=${encodeURIComponent(`Статья добавлена (#${r.id}, ссылок: ${r.linkCount}).${w}`)}`);
    } catch (e) {
      reply.redirect(`/sites/${id}?tab=generate&msg=${encodeURIComponent('Ошибка: ' + e.message)}`);
    }
  });
  app.post('/sites/:id/generate', async (req, reply) => {
    const id = Number(req.params.id);
    if (req.body.confirm !== '1') return reply.redirect(`/sites/${id}?msg=${encodeURIComponent('Нужно подтверждение (платно)')}#gen`);
    const promptId = req.body.prompt ? Number(req.body.prompt) : undefined;
    const backend = req.body.backend === 'cli' ? 'cli' : 'api';
    const keyword = (req.body.keyword || '').trim() || null;
    const jobId = createJob('generate', { siteId: id });
    logJob(jobId, `Старт: генерация статьи (${backend === 'cli' ? 'подписка/CLI' : 'API'})${keyword ? `, ключ «${keyword}»` : ''}`);
    withTimeout(generateArticleForSite(db, { siteId: id, promptId, keyword, backend, onStep: (m) => logJob(jobId, m) }), 300000, 'генерация')
      .then((r) => finishJob(jobId, { ok: true, articleId: r.id, message: `#${r.id}: ${r.title}` + (r.warnings.length ? ' (!)' + r.warnings.join(' ') : '') }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });
  app.post('/sites/:id/schedule', async (req, reply) => {
    const id = Number(req.params.id);
    try {
      const r = scheduleDay(db, id, req.body.date || undefined);
      reply.redirect(`/sites/${id}?msg=${encodeURIComponent(`Запланировано ${r.assigned.length} на ${r.date}`)}#articles`);
    } catch (e) {
      reply.redirect(`/sites/${id}?msg=${encodeURIComponent('Ошибка: ' + e.message)}#do`);
    }
  });

  // Отправить пачку (Batches API). Платно — требует подтверждения.
  app.post('/sites/:id/batch', async (req, reply) => {
    const id = Number(req.params.id);
    if (req.body.confirm !== '1') return reply.redirect(`/sites/${id}?msg=${encodeURIComponent('Нужно подтверждение (платно)')}#gen`);
    try {
      const r = await submitArticleBatch(db, {
        siteId: id,
        promptId: req.body.prompt ? Number(req.body.prompt) : undefined,
        count: Number(req.body.count || 1),
      });
      reply.redirect(`/sites/${id}?msg=${encodeURIComponent(`Батч отправлен (id ${r.batchId}, ${r.count} шт). Собери результаты в истории, когда обработается.`)}#batches`);
    } catch (e) {
      reply.redirect(`/sites/${id}?msg=${encodeURIComponent('Ошибка: ' + e.message)}#gen`);
    }
  });

  // Забрать результаты батча и записать статьи.
  app.post('/batches/:id/collect', async (req, reply) => {
    const rowId = Number(req.params.id);
    const b = db.prepare('SELECT site_id FROM batches WHERE id = ?').get(rowId);
    try {
      const res = await collectArticleBatch(db, rowId);
      const firstErr = (res.items || []).find((i) => !i.ok);
      const msg = res.pending
        ? `Ещё обрабатывается (${res.status}).`
        : res.alreadyCollected
          ? `Уже собран ранее: записано ${res.persisted}.`
          : `Собрано: записано ${res.persisted}, ошибок ${res.errored}, всего ${res.total}.` + (firstErr ? ` Первая ошибка: ${firstErr.reason}` : '');
      reply.redirect(`/sites/${b?.site_id || ''}?msg=${encodeURIComponent(msg)}#batches`);
    } catch (e) {
      reply.redirect(`/sites/${b?.site_id || ''}?msg=${encodeURIComponent('Ошибка: ' + e.message)}#batches`);
    }
  });

  // ============================ Промт: редактор ============================
  app.post('/prompts', async (req, reply) => {
    const siteId = Number(req.body.site);
    const info = db.prepare("INSERT INTO prompts (site_id, name, content, active) VALUES (?, 'Новый промт', '', 0)").run(siteId);
    reply.redirect(`/prompts/${info.lastInsertRowid}`);
  });

  app.get('/prompts/:id', async (req, reply) => {
    const p = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
    if (!p) return reply.code(404).send('нет');
    const navLeft = `<a href="/sites/${p.site_id}?tab=generate" class="text-decoration-none">← Сайт</a>`;
    const POS = [['start', 'В начале'], ['1', 'После 1-го заголовка'], ['2', 'После 2-го'], ['3', 'После 3-го'], ['4', 'После 4-го'], ['end', 'В конце']];
    const curPos = String(p.link_position || '1').split(',').map((s) => s.trim()).filter(Boolean);
    const posChecks = POS.map(([val, l]) => `<label class="form-check form-check-inline m-0"><input class="form-check-input lppos" type="checkbox" name="link_position" value="${val}"${curPos.includes(val) ? ' checked' : ''}><span class="form-check-label">${l}</span></label>`).join('');
    const helpHtml = `<p class="mb-1">Пиши на BBCode. Пример пункта:</p><pre class="mb-1" style="white-space:pre-wrap">[list]
[*][b][u][urlnt=https://example.com/aff]CROWNSLOTS[/urlnt][/u][/b] - 400% bis zu €4.000 + 250 FS💣[/*]
[/list]</pre><p class="mb-0">Позиция блока — поле «Позиция блока ссылок» (по заголовкам). Маркер <code>{{LINKS}}</code> необязателен. Binom <code>s1</code>/<code>s2</code> добавляются автоматически — вручную не пиши.</p>`;
    const formBody = `<form method="post" action="/prompts/${p.id}">
<div class="mb-2"><label class="form-label">Название</label><input name="name" class="form-control" value="${esc(p.name || '')}" placeholder="напр. Casino Österreich"></div>
<div class="mb-2"><label class="form-label">Текст промта (то, что уходит в Claude)</label>
<textarea name="content" class="form-control" rows="7" placeholder="Напиши статью на немецком про ...">${esc(p.content || '')}</textarea>
<div class="form-text">Для генерации по списку вставь <code>{{KEYWORD}}</code> там, где должен быть целевой ключ (напр. «…о теме <code>{{KEYWORD}}</code>…»). При генерации он заменится на ключ; без плейсхолдера ключ допишется инструкцией в конец.</div></div>
<div class="row g-2 mb-3"><div class="col-md-5"><label class="form-label">Теги (через запятую, ≥2)</label><input name="tags" class="form-control" value="${esc(p.tags || '')}" placeholder="Information, Informationsabend"></div><div class="col-md-7"><label class="form-label">Позиции блока ссылок <span class="text-secondary fw-normal small">(1–4, можно несколько — блок продублируется)</span></label><div class="d-flex flex-wrap gap-2 pt-1">${posChecks}</div></div></div>
<div class="d-flex align-items-center flex-wrap gap-2 mb-1"><label class="form-label mb-0">Блок ссылок (BBCode)</label><span id="lbstatus" class="badge bg-secondary" title="">—</span><button type="button" id="lbhelpbtn" class="btn btn-sm btn-outline-secondary" title="Как форматировать блок">?</button></div>
<div id="lbhelp" class="d-none alert alert-info small">${helpHtml}</div>
<div class="mb-1 small text-secondary d-flex flex-wrap align-items-center gap-1"><span class="me-1">Вставить:</span><span id="tpltags"></span><span id="tplsnip"></span><span id="emo"></span></div>
<div class="row g-2 mb-3">
<div class="col-md-6"><textarea id="lb" name="link_block" rows="14" class="form-control mono" placeholder="[list]&#10;[*][b][u][urlnt=https://...]BRAND[/urlnt][/u][/b] - оффер 💣[/*]&#10;[/list]">${esc(p.link_block || '')}</textarea></div>
<div class="col-md-6"><div class="text-secondary small mb-1">Превью (как отрисует сайт)</div><div id="lbprev" class="border rounded p-3" style="overflow:auto;max-height:22rem"></div></div>
</div>
<div class="d-flex flex-wrap gap-2"><button type="submit" class="btn btn-primary">Сохранить</button>
<button type="submit" class="btn btn-outline-secondary" formaction="/prompts/${p.id}/activate">${p.active ? 'активный <i class="ti ti-check"></i>' : 'сделать активным'}</button>
<button type="submit" class="btn btn-outline-danger" formaction="/prompts/${p.id}/delete" onclick="return confirm('Скрыть промт из списка? (статьи по нему не пострадают)')">Скрыть из списка</button></div></form>`;
    const form = card('Промт', formBody);
    const script = `<script>
(function(){var ta=document.getElementById('lb'),stt=document.getElementById('lbstatus'),prev=document.getElementById('lbprev'),helpb=document.getElementById('lbhelpbtn'),help=document.getElementById('lbhelp');
function count(s,sub){return s.split(sub).length-1;}
function check(){var t=ta.value,issues=[];var tags=['list','b','u','i','h2','quote'];for(var i=0;i<tags.length;i++){var o=count(t,'['+tags[i]+']'),c=count(t,'[/'+tags[i]+']');if(o!==c)issues.push('['+tags[i]+'] откр '+o+' / закр '+c);}var uo=count(t,'[urlnt='),uc=count(t,'[/urlnt]');if(uo!==uc)issues.push('[urlnt] откр '+uo+' / закр '+uc);var so=count(t,'[*]'),sc=count(t,'[/*]');if(so!==sc)issues.push('[*] откр '+so+' / закр '+sc);
if(!t.trim()){stt.className='badge bg-secondary';stt.textContent='пусто';stt.title='';ta.style.borderColor='';return;}
if(issues.length===0){stt.className='badge bg-green text-white';stt.textContent='ок, ссылок: '+uo;stt.title='Формат корректен';ta.style.borderColor='';}
else{stt.className='badge bg-red text-white';stt.textContent='ошибки: '+issues.length;stt.title=issues.join(String.fromCharCode(10));ta.style.borderColor='var(--tblr-danger)';}}
var pvT;function preview(){clearTimeout(pvT);pvT=setTimeout(function(){fetch('/prompts/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bbcode:ta.value})}).then(function(r){return r.json();}).then(function(d){prev.innerHTML=(d.html&&d.html.trim())?d.html:'<span class=\"text-secondary\">—</span>';}).catch(function(){});},400);}
function insertAt(s){var st=ta.selectionStart,en=ta.selectionEnd,val=ta.value;ta.value=val.slice(0,st)+s+val.slice(en);var pos=st+s.length;ta.focus();ta.setSelectionRange(pos,pos);check();preview();}
function wrap(open,close,ph){var st=ta.selectionStart,en=ta.selectionEnd,val=ta.value,sel=val.slice(st,en),inner=sel||ph,ins=open+inner+close;ta.value=val.slice(0,st)+ins+val.slice(en);ta.focus();if(sel){var pp=st+ins.length;ta.setSelectionRange(pp,pp);}else{var s2=st+open.length;ta.setSelectionRange(s2,s2+ph.length);}check();preview();}
function mkbtn(label,fn){var b=document.createElement('button');b.type='button';b.className='btn btn-sm btn-outline-secondary me-1 mb-1';b.textContent=label;b.onclick=fn;return b;}
var TAGS=[['Бренд-ссылка','[b][u][urlnt=ССЫЛКА]','[/urlnt][/u][/b]','БРЕНД'],['Ссылка','[urlnt=ССЫЛКА]','[/urlnt]','ТЕКСТ'],['Жирный','[b]','[/b]','ТЕКСТ'],['Подчёркнутый','[u]','[/u]','ТЕКСТ'],['Заголовок','[h2]','[/h2]','ЗАГОЛОВОК']];
var SNIP=[['+ список','[list][*][b][u][urlnt=ССЫЛКА1]БРЕНД1[/urlnt][/u][/b] - ОПИСАНИЕ 💣[/*][*][b][u][urlnt=ССЫЛКА2]БРЕНД2[/urlnt][/u][/b] - ОПИСАНИЕ 🎰[/*][/list]'],['+ пункт','[*][b][u][urlnt=ССЫЛКА]БРЕНД[/urlnt][/u][/b] - ОПИСАНИЕ 🎰[/*]']];
var EMO=['🎰','🎲','🃏','💰','💸','🤑','🎁','🔥','💥','💣','🚀','⭐','✅','🎉','👑','💎','🍀','🏆','⚡'];
var box=document.getElementById('tpltags');if(box){TAGS.forEach(function(t){box.appendChild(mkbtn(t[0],function(){wrap(t[1],t[2],t[3]);}));});}
box=document.getElementById('tplsnip');if(box){SNIP.forEach(function(t){box.appendChild(mkbtn(t[0],function(){insertAt(t[1]);}));});}
box=document.getElementById('emo');if(box){EMO.forEach(function(e){box.appendChild(mkbtn(e,function(){insertAt(e);}));});}
if(helpb&&help)helpb.addEventListener('click',function(){help.classList.toggle('d-none');});
if(ta){ta.addEventListener('input',function(){check();preview();});check();preview();}
var lppos=document.querySelectorAll('.lppos');function lpcap(e){var n=0;lppos.forEach(function(c){if(c.checked)n++;});if(n>4&&e&&e.target){e.target.checked=false;alert('Не больше 4 позиций блока ссылок.');}}lppos.forEach(function(c){c.addEventListener('change',lpcap);});})();
</script>`;
    reply.type('text/html').send(layout('/sites', form + script, { title: p.name || `Промт ${p.id}`, navLeft, flash: flash(req.query) }));
  });

  // Живое превью блока ссылок для редактора промта (BBCode → HTML тем же рендером, что на сайте).
  app.post('/prompts/preview', async (req) => ({ html: bbcodeToHtml(String(req.body?.bbcode || '')) }));

  app.post('/prompts/:id', async (req, reply) => {
    const b = req.body;
    // Позиции блока: чекбоксы → массив (или одиночное значение) → нормализуем в строку «start,2,4» (до 4).
    const posList = (Array.isArray(b.link_position) ? b.link_position : b.link_position ? [b.link_position] : [])
      .map((s) => String(s).trim())
      .filter(Boolean);
    const lp = posList.length ? posList.slice(0, 4).join(',') : '1';
    db.prepare('UPDATE prompts SET name=@name, content=@content, link_block=@lb, tags=@tags, link_position=@lp WHERE id=@id')
      .run({ id: Number(req.params.id), name: b.name || null, content: b.content || '', lb: b.link_block || null, tags: b.tags || null, lp });
    reply.redirect(`/prompts/${req.params.id}?msg=${encodeURIComponent('Сохранено')}`);
  });
  app.post('/prompts/:id/activate', async (req, reply) => {
    const r = db.prepare('SELECT site_id FROM prompts WHERE id = ?').get(req.params.id);
    if (r) {
      db.transaction(() => {
        db.prepare('UPDATE prompts SET active = 0 WHERE site_id = ?').run(r.site_id);
        db.prepare('UPDATE prompts SET active = 1 WHERE id = ?').run(req.params.id);
      })();
    }
    reply.redirect(`/prompts/${req.params.id}?msg=${encodeURIComponent('Сделан активным')}`);
  });
  // «Удаление» промта = скрытие (мягкое): убираем из списков, но статьи по нему (category) не ломаются.
  app.post('/prompts/:id/delete', async (req, reply) => {
    const r = db.prepare('SELECT site_id FROM prompts WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE prompts SET hidden = 1, active = 0 WHERE id = ?').run(req.params.id);
    reply.redirect(`/sites/${r?.site_id || ''}?tab=generate&msg=${encodeURIComponent('Промт скрыт')}#prompts`);
  });
  app.post('/prompts/:id/unhide', async (req, reply) => {
    const r = db.prepare('SELECT site_id FROM prompts WHERE id = ?').get(req.params.id);
    db.prepare('UPDATE prompts SET hidden = 0 WHERE id = ?').run(req.params.id);
    reply.redirect(`/sites/${r?.site_id || ''}?tab=generate&showHidden=1&msg=${encodeURIComponent('Промт возвращён')}#prompts`);
  });

  // ============================ Настройки (глобальные ключи + ключи Claude) ============================
  // Статус Dolphin{anty} для бейджа «Anty» в шапке (пинг Local API; на клиенте, чтобы не блокировать рендер).
  // TTL-кэш: несколько открытых вкладок не должны бить реальный Local API на каждый опрос (каждые ~7с).
  let dolphinCache = { at: 0, running: false };
  const DOLPHIN_STATUS_TTL_MS = Number(process.env.DOLPHIN_STATUS_TTL_MS || 4000);
  app.get('/dolphin-status', async (req, reply) => {
    if (Date.now() - dolphinCache.at > DOLPHIN_STATUS_TTL_MS) {
      dolphinCache = { at: Date.now(), running: await isDolphinRunning() };
    }
    reply.send({ running: dolphinCache.running });
  });

  // Статус планировщика для бейджа «Sched» в шапке (по heartbeat scheduler_last_tick).
  app.get('/scheduler-status', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const tickMs = Number(process.env.SCHEDULER_TICK_MS || 30000);
    const ep = parseStamp(getSetting(db, 'scheduler_last_tick'));
    const ageMs = ep != null ? Date.now() - ep : null;
    return { alive: ageMs != null && ageMs <= tickMs * 3 + 5000, ageSec: ageMs != null ? Math.round(ageMs / 1000) : null };
  });

  app.get('/settings', async (req, reply) => {
    // Глобальные ключи/токены (Dolphin API и пр.) — пишутся в БД, гидратируют process.env.
    const settingsRows = Object.entries(KNOWN_SETTINGS)
      .map(([key, def]) => {
        const set = !!(process.env[def.env] || getSetting(db, key));
        return `<div class="mb-3"><label class="form-label">${esc(def.label)} ${set ? '<span class="badge bg-green text-white">задан</span>' : '<span class="badge bg-secondary text-white">не задан</span>'}</label>
<input name="${key}" class="form-control" placeholder="${set ? '•••••• (оставь пустым — не менять)' : 'вставь значение'}">
<div class="text-secondary small mt-1">${esc(def.hint)}</div></div>`;
      })
      .join('');
    const dolphinHint = `<div class="text-secondary small mb-3">Статус Dolphin{anty} — в правом верхнем углу («Anty», зелёный/красный). Запускается вручную на этом ПК (из веба нельзя), нужен для публикации.</div>`;
    const settingsCard = card('<i class="ti ti-tool"></i> Глобальные ключи', dolphinHint + `<form method="post" action="/settings">${settingsRows}<button type="submit" class="btn btn-primary">Сохранить</button></form>`);

    // Ключи Claude (общие, ротация LRU).
    const rows = db.prepare('SELECT * FROM claude_keys ORDER BY id').all();
    const tr = rows
      .map(
        (k) => `<tr><td>${k.id}</td><td>${k.enabled ? '<i class="ti ti-circle-check text-green"></i>' : '<i class="ti ti-ban text-danger"></i>'}</td><td class="mono">${esc(mask(k.api_key))}</td><td>${esc(k.label)}</td><td class="text-secondary">${esc(k.last_used_at || '-')}</td>
<td><div class="d-flex gap-1"><form method="post" action="/keys/${k.id}/toggle"><button class="btn btn-sm btn-outline-secondary">${k.enabled ? 'выкл' : 'вкл'}</button></form>
<form method="post" action="/keys/${k.id}/delete" onsubmit="return confirm('Удалить ключ?')"><button class="btn btn-sm btn-outline-danger">×</button></form></div></td></tr>`,
      )
      .join('');
    const addKey = `<details><summary class="btn btn-outline-primary">+ Добавить ключ Claude</summary>
<div class="mt-2"><form method="post" action="/keys">
<div class="row g-2 mb-2"><div class="col"><input name="label" class="form-control" placeholder="label" required></div><div class="col"><input name="key" class="form-control" placeholder="sk-ant-..." required></div></div>
<div class="mb-2"><input name="notes" class="form-control" placeholder="заметка"></div>
<button type="submit" class="btn btn-primary">Добавить</button></form></div></details>`;
    const keysCard = `<div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-robot"></i> Ключи Claude</h3></div><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>id</th><th>акт.</th><th>ключ</th><th>label</th><th>last used</th><th></th></tr></thead><tbody>${tr || '<tr><td colspan="6" class="text-secondary">нет</td></tr>'}</tbody></table></div><div class="card-footer">${addKey}</div></div>`;

    reply.type('text/html').send(page('/settings', 'Настройки', settingsCard + keysCard, { flash: flash(req.query) }));
  });
  app.get('/keys', async (req, reply) => reply.redirect('/settings'));

  app.post('/settings', async (req, reply) => {
    for (const [key, def] of Object.entries(KNOWN_SETTINGS)) {
      const v = String(req.body[key] || '').trim();
      if (v) {
        setSetting(db, key, v);
        process.env[def.env] = v; // применяем сразу к текущему процессу (без перезапуска)
      }
    }
    reply.redirect(`/settings?msg=${encodeURIComponent('Сохранено')}`);
  });

  app.post('/keys', async (req, reply) => {
    db.prepare('INSERT INTO claude_keys (label, api_key, notes) VALUES (?, ?, ?)').run(req.body.label, req.body.key, req.body.notes || null);
    reply.redirect(`/settings?msg=${encodeURIComponent('Ключ добавлен')}`);
  });
  app.post('/keys/:id/toggle', async (req, reply) => {
    db.prepare('UPDATE claude_keys SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
    reply.redirect('/settings');
  });
  app.post('/keys/:id/delete', async (req, reply) => {
    db.prepare('DELETE FROM claude_keys WHERE id = ?').run(req.params.id);
    reply.redirect(`/settings?msg=${encodeURIComponent('Удалён')}`);
  });

  // ============================ Статьи (глобально, по всем сайтам) ============================
  app.get('/articles', async (req, reply) => {
    const sites = db.prepare('SELECT id, name FROM sites ORDER BY id').all();
    const siteOpts =
      '<option value="">Все сайты</option>' +
      sites.map((s) => `<option value="${s.id}"${String(s.id) === String(req.query.site || '') ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
    const filterCard = card(
      'Фильтр по сайту',
      `<form method="get" action="/articles" class="d-flex flex-wrap align-items-end gap-2"><div><label class="form-label">Сайт</label><select name="site" class="form-select">${siteOpts}</select></div><button type="submit" class="btn btn-primary">Показать</button></form>`,
    );
    const fixedSiteId = req.query.site || null;
    const ws = renderArticlesWorkspace(db, { fixedSiteId, from: fixedSiteId ? `/articles?site=${fixedSiteId}` : '/articles' });
    reply.type('text/html').send(page('/articles', 'Статьи', filterCard + ws, { flash: flash(req.query) }));
  });

  // Глобальный поиск статьи: точный tracking_id (Binom s1) → сразу на статью; иначе подстрока по
  // tracking_id / ключу / заголовку. Один результат → на статью, несколько → список, ноль → сообщение.
  app.get('/articles/find', async (req, reply) => {
    const q = String(req.query.q || req.query.tid || '').trim();
    if (!q) return reply.redirect('/articles');
    const exact = db.prepare('SELECT id FROM articles WHERE tracking_id = ?').get(q);
    if (exact) return reply.redirect(`/articles/${exact.id}`);
    const like = `%${q}%`;
    const rows = db
      .prepare(
        `SELECT a.id, a.title, a.keyword, a.status, a.tracking_id, s.name site_name
         FROM articles a LEFT JOIN sites s ON s.id = a.site_id
         WHERE a.tracking_id LIKE ? OR a.keyword LIKE ? OR a.title LIKE ?
         ORDER BY a.id DESC LIMIT 100`,
      )
      .all(like, like, like);
    if (rows.length === 1) return reply.redirect(`/articles/${rows[0].id}`);
    if (rows.length === 0) return reply.redirect(`/articles?msg=${encodeURIComponent(`Ничего не найдено по «${q}»`)}`);
    const tr = rows
      .map(
        (r) =>
          `<tr><td>${badge(r.status)}</td><td><a href="/articles/${r.id}">${esc((r.title || '').slice(0, 70) || '#' + r.id)}</a></td><td class="text-secondary small">${esc(r.keyword || '')}</td><td class="text-secondary small">${esc(r.site_name || '')}</td><td class="mono small"><a href="/articles/${r.id}" class="text-decoration-none">${esc(r.tracking_id || '')}</a></td></tr>`,
      )
      .join('');
    const body = tableCard(`<i class="ti ti-search"></i> Результаты поиска «${esc(q)}» (${rows.length})`, ['статус', 'заголовок', 'ключ', 'сайт', 'tracking_id'], tr, 'search');
    reply.type('text/html').send(page('/articles', `Поиск: ${q}`, body, { flash: flash(req.query) }));
  });

  app.get('/articles/:id', async (req, reply) => {
    const a = db.prepare('SELECT * FROM articles WHERE id = ?').get(req.params.id);
    if (!a) return reply.code(404).send('нет');
    const links = db.prepare('SELECT * FROM article_links WHERE article_id = ? ORDER BY CAST(link_id AS INTEGER)').all(a.id);
    const site = db.prepare('SELECT timezone, window_end, auto_delete FROM sites WHERE id = ?').get(a.site_id);
    const tz = site?.timezone || 'Europe/Vienna';
    const tzLabel = (EU_TZ.find(([v]) => v === tz) || [tz, tz])[1];
    const TIME_KEYS = new Set(['scheduled_at', 'published_at', 'delete_at', 'site_deleted_at', 'generated_at']); // показываем в TZ сайта
    const meta = ['keyword', 'tracking_id', 'category', 'tags', 'scheduled_at', 'published_at', 'delete_at', 'site_url', 'site_deleted_at', 'generated_at', 'error']
      .map((k) => `<tr><th>${k}</th><td class="mono" style="word-break:break-all">${TIME_KEYS.has(k) ? esc(fmtInTz(a[k], tz)) : esc(a[k] ?? '-')}</td></tr>`)
      .join('');
    const linksTr = links.map((l) => `<tr><td>${esc(l.link_id)}</td><td><b>${esc(l.anchor)}</b></td><td class="mono" style="word-break:break-all">${esc(l.final_url)}</td></tr>`).join('');
    const bbcode = htmlToBBCode(a.body_html || '');
    // Бейдж + навигация + заголовок — одной строкой (экономим высоту; своя «шапка» вместо page-header).
    const navLeft = `${badge(a.status)}<a href="/sites/${a.site_id}?tab=articles" class="text-decoration-none">← Сайт</a><a href="/articles" class="text-decoration-none">Все статьи</a>`;
    const aAccs = enabledSiteAccounts(db, a.site_id);
    const pubForm = aAccs.length
      ? `<form method="post" action="/articles/${a.id}/publish" class="d-flex gap-2" onsubmit="return confirm('Опубликовать на сайте (через Dolphin)?')"><select name="account" class="form-select" style="width:auto">${aAccs.map((acc) => `<option value="${acc.id}">${esc(acc.label || acc.username)}</option>`).join('')}</select><button type="submit" class="btn btn-primary">Опубликовать на сайте</button></form>`
      : `<a href="/sites/${a.site_id}#accounts" class="btn btn-outline-secondary">Добавить аккаунт публикации</a>`;
    // Удалять можно только неопубликованную (опубликованную — запрещено).
    const deleteBtn =
      a.status === 'published' && !a.site_deleted_at
        ? '<span class="text-secondary small">Статья на сайте — сначала сними с сайта</span>'
        : `<form method="post" action="/articles/${a.id}/delete" onsubmit="return confirm('Удалить из БД?')"><button class="btn btn-outline-danger">Удалить из БД</button></form>`;
    // Удаление С САЙТА (через Dolphin) — для опубликованной с известным URL и ещё не снятой.
    const hasSiteId = /_a\d+/.test(a.site_url || '');
    const siteDeleteBtn = a.site_deleted_at
      ? `<span class="text-secondary small">Снята с сайта: ${esc(fmtInTz(a.site_deleted_at, tz))}</span>`
      : a.status === 'published' && hasSiteId
        ? `<form method="post" action="/articles/${a.id}/site-delete" class="d-flex gap-2" onsubmit="return confirm('Удалить статью С САЙТА через Dolphin? Действие необратимо.')"><select name="account" class="form-select" style="width:auto">${aAccs.map((acc) => `<option value="${acc.id}">${esc(acc.label || acc.username)}</option>`).join('')}</select><button type="submit" class="btn btn-outline-warning">Удалить с сайта</button></form>`
        : a.status === 'published'
          ? '<span class="text-secondary small">Нет URL на сайте — удаление недоступно</span>'
          : '';
    const siteLink = a.site_url ? `<a href="${esc(a.site_url)}" target="_blank" rel="noopener" class="btn btn-outline-secondary"><i class="ti ti-external-link"></i> Открыть на сайте</a>` : '';
    const actions = card('Действия', `<div class="d-flex flex-wrap gap-2 align-items-center">${pubForm}${siteLink}${siteDeleteBtn}${deleteBtn}</div>`);

    // Ручное редактирование времени публикации (в часовом поясе сайта). Для опубликованной — недоступно.
    const schedZ = a.scheduled_at ? epochToZoned(parseStamp(a.scheduled_at), tz) : epochToZoned(Date.now(), tz);
    const scheduleCard =
      a.status === 'published'
        ? card('Время публикации', `<p class="mb-0 text-secondary">Статья опубликована${a.published_at ? ' (' + esc(fmtInTz(a.published_at, tz)) + ')' : ''} — менять расписание нельзя.</p>`)
        : card(
            'Время публикации',
            `<form method="post" action="/articles/${a.id}/schedule" class="d-flex flex-wrap align-items-end gap-2">
<div><label class="form-label mb-1 small">Дата</label><input type="date" name="date" class="form-control" value="${schedZ.date}"></div>
<div><label class="form-label mb-1 small">Время (${esc(tzLabel)})</label><input type="time" name="time" class="form-control" value="${schedZ.time}"></div>
<button type="submit" class="btn btn-primary">Запланировать</button></form>
${a.scheduled_at ? `<form method="post" action="/articles/${a.id}/unschedule" class="mt-2"><button class="btn btn-outline-secondary">Снять с расписания</button></form>` : ''}
<p class="text-secondary small mt-2 mb-0">Время — в часовом поясе сайта (${esc(tzLabel)}). Сейчас: ${a.scheduled_at ? esc(fmtInTz(a.scheduled_at, tz)) : 'без расписания'}.</p>`,
          );
    // Автоудаление с сайта (delete_at) — для опубликованной и ещё не снятой. Дефолт — ближайшее закрытие окна.
    let autoDelCard = '';
    if (a.status === 'published' && !a.site_deleted_at) {
      const delZ = a.delete_at
        ? epochToZoned(parseStamp(a.delete_at), tz)
        : epochToZoned(nextDailyOccurrence(site?.window_end || '09:00', tz), tz);
      autoDelCard = card(
        'Автоудаление с сайта',
        `<form method="post" action="/articles/${a.id}/set-delete-at" class="d-flex flex-wrap align-items-end gap-2">
<div><label class="form-label mb-1 small">Дата</label><input type="date" name="date" class="form-control" value="${delZ.date}"></div>
<div><label class="form-label mb-1 small">Время (${esc(tzLabel)})</label><input type="time" name="time" class="form-control" value="${delZ.time}"></div>
<button type="submit" class="btn btn-warning">Запланировать удаление</button></form>
${a.delete_at ? `<form method="post" action="/articles/${a.id}/clear-delete-at" class="mt-2"><button class="btn btn-outline-secondary">Снять авто-удаление</button></form>` : ''}
<p class="text-secondary small mt-2 mb-0">Планировщик удалит статью с сайта в это время (часовой пояс сайта). Сейчас: ${a.delete_at ? esc(fmtInTz(a.delete_at, tz)) : 'не задано'}.</p>`,
      );
    }
    // «Как выглядит» = финальный BBCode → HTML (как отрендерит сайт; блок ссылок хранится в теле как BBCode).
    const previewHtml = bbcodeToHtml(bbcode);
    const contentCard = `<div class="card mb-3">
<div class="card-header d-flex align-items-center">
<h3 class="card-title mb-0">Содержимое</h3>
<div class="btn-group btn-group-sm ms-auto" role="group">
<button type="button" class="btn btn-primary" id="view-preview">Как выглядит</button>
<button type="button" class="btn btn-outline-secondary" id="view-bbcode">BBCode</button></div></div>
<div class="card-body" style="max-height:50vh;overflow:auto">
<div id="pane-preview" class="article-preview">${previewHtml}</div>
<div id="pane-bbcode" class="d-none"><pre style="white-space:pre-wrap;margin:0">${esc(bbcode)}</pre></div></div></div>
<script>(function(){var bp=document.getElementById('view-preview'),bb=document.getElementById('view-bbcode'),pp=document.getElementById('pane-preview'),pb=document.getElementById('pane-bbcode');function show(prev){pp.classList.toggle('d-none',!prev);pb.classList.toggle('d-none',prev);bp.className='btn '+(prev?'btn-primary':'btn-outline-secondary');bb.className='btn '+(prev?'btn-outline-secondary':'btn-primary');}bp.onclick=function(){show(true);};bb.onclick=function(){show(false);};})();</script>`;

    // Журнал статьи (персистентные события). Источник — article_events; для старых статей — generated_at.
    const EVENT_RU = { generated: 'сгенерирована', manual: 'добавлена вручную', scheduled: 'запланирована', unscheduled: 'снята с расписания', delete_at: 'автоудаление', published: 'опубликована', publish_failed: 'ошибка публикации', site_deleted: 'снята с сайта', site_delete_failed: 'ошибка удаления', stats: 'статистика' };
    const evColor = (k) => (k.includes('failed') ? 'bg-red text-white' : k === 'published' || k === 'site_deleted' ? 'bg-green text-white' : 'bg-secondary text-white');
    const evs = getArticleEvents(db, a.id);
    const evRows = (evs.length ? evs : [{ ts: a.generated_at, kind: 'generated', message: 'создана (до журнала событий)' }])
      .map((e) => `<tr><td class="text-secondary" style="white-space:nowrap">${esc(fmtInTz(e.ts, tz))}</td><td><span class="badge ${evColor(e.kind)}">${esc(EVENT_RU[e.kind] || e.kind)}</span></td><td>${esc(e.message || '')}</td></tr>`)
      .join('');
    const eventsCard = card('Журнал статьи', `<div class="table-responsive"><table class="table table-sm table-vcenter mb-0"><tbody>${evRows}</tbody></table></div>`);

    // Тестируемый ключ (если статья сгенерирована под ключ из списка) — наглядно сверху.
    const keywordCard = a.keyword
      ? `<div class="card mb-3"><div class="card-body py-2 d-flex align-items-center flex-wrap gap-2"><i class="ti ti-key text-warning"></i><span class="text-secondary">Тестируемый ключ:</span><span class="badge bg-yellow text-dark kwcopy" role="button" data-kw="${esc(a.keyword)}" title="Клик — скопировать ключ" style="font-size:.9rem">${esc(a.keyword)}</span><a class="ms-2 small text-secondary" href="/sites/${a.site_id}/keywords"><i class="ti ti-list-search"></i> ключи сайта</a></div></div>
<script>(function(){function c(el){var kw=el.getAttribute('data-kw');if(!kw)return;var done=function(){var o=el.innerHTML;el.innerHTML='<i class="ti ti-check"></i> скопировано';el.classList.remove('bg-yellow');el.classList.add('bg-green','text-white');setTimeout(function(){el.innerHTML=o;el.classList.add('bg-yellow');el.classList.remove('bg-green','text-white');},1000);};if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(kw).then(done).catch(done);}else{var ta=document.createElement('textarea');ta.value=kw;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');}catch(e){}document.body.removeChild(ta);done();}}document.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('.kwcopy');if(el){e.preventDefault();c(el);}});})();</script>`
      : '';
    // Статистика трафика (последний снимок Content-Cockpit) + сбор по кнопке.
    const latest = articleLatestStats(db, a.id);
    const canStats = a.status === 'published' && /_a\d+/.test(a.site_url || '');
    const statsCollectBtn = canStats
      ? `<form method="post" action="/articles/${a.id}/collect-stats" onsubmit="return confirm('Собрать статистику этой статьи через Dolphin?')"><button class="btn btn-sm btn-outline-primary"><i class="ti ti-refresh"></i> Обновить статистику</button></form>`
      : '<span class="text-secondary small">Доступно для опубликованной статьи с URL на сайте.</span>';
    const metric = (label, val, cls = '') => `<div class="col-auto"><div class="text-secondary small">${label}</div><div class="h3 mb-0 ${cls}">${val}</div></div>`;
    const statsBody = latest
      ? `<div class="row g-3">${metric('всего', latest.total_views ?? '—')}${metric('из поиска', latest.seo_views ?? '—', latest.seo_views ? 'text-green' : '')}${metric('перцентиль', latest.percentile != null ? latest.percentile + ' %' : '—')}${metric('ср. время', fmtDur(latest.avg_time_on_page))}</div>
<div class="text-secondary small mt-2">Каналы: соц ${latest.social_views ?? 0} · кур ${latest.curated_views ?? 0} · нл ${latest.newsletter_views ?? 0} · qr ${latest.qr_views ?? 0} · проч ${latest.rest_views ?? 0}. Снимок: ${esc(fmtInTz(latest.captured_at, tz))}${latest.reason ? ` (${esc(latest.reason)})` : ''}. <a href="/stats?site=${a.site_id}">вся статистика сайта</a></div>
<div class="mt-2">${statsCollectBtn}</div>`
      : `<p class="text-secondary mb-2">Снимков статистики ещё нет.</p>${statsCollectBtn}`;
    // Позиции в Google (DACH) — последняя проверка по странам + кнопка.
    const rkRows = db
      .prepare(
        `WITH latest AS (
           SELECT r.* FROM article_ranks r
           JOIN (SELECT country, MAX(id) mid FROM article_ranks WHERE article_id = ? GROUP BY country) m ON m.mid = r.id
         ) SELECT country, position, captured_at, source, error FROM latest`,
      )
      .all(a.id);
    const rkMap = Object.fromEntries(rkRows.map((r) => [r.country, r]));
    const rkFmt = (c) => {
      const r = rkMap[c];
      const lbl = c.toUpperCase();
      if (!r) return `<span class="text-secondary">${lbl} —</span>`;
      if (r.position == null) return `<span class="text-secondary" title="${esc(r.error || '')}">${lbl} ${r.error ? 'ошибка' : 'не в топ'}</span>`;
      const cls = r.position <= 10 ? 'text-green' : r.position <= 30 ? 'text-yellow' : '';
      return `<span class="${cls}">${lbl} #${r.position}</span>`;
    };
    const rankBtn = canStats
      ? `<form method="post" action="/articles/${a.id}/check-rank" class="mt-2" onsubmit="return confirm('Проверить позиции в Google (DACH) через Dolphin/прокси?')"><button class="btn btn-sm btn-outline-primary"><i class="ti ti-target-arrow"></i> Проверить позиции (DACH)</button></form>`
      : '';
    const ranksLine = `<hr class="my-3"><div class="text-secondary small mb-1">Позиции в Google по ключу (последняя проверка)</div><div class="d-flex gap-3 fw-bold">${['at', 'de', 'ch'].map(rkFmt).join('<span class="text-secondary">·</span>')}</div>${rkRows.length ? `<div class="text-secondary small mt-1">${esc(fmtInTz(rkRows[0].captured_at, tz))}</div>` : '<div class="text-secondary small mt-1">ещё не проверяли</div>'}${rankBtn}`;
    const statsCard = card('Статистика трафика и позиции', statsBody + ranksLine);

    const body = `${keywordCard}${contentCard}
${scheduleCard}
${autoDelCard}
${actions}
${statsCard}
${eventsCard}
${card('Метаданные', `<div class="table-responsive"><table class="table table-vcenter"><tbody>${meta}</tbody></table></div>`)}
${card(`Ссылки (${links.length})`, tbl(['s2', 'бренд', 'final_url'], linksTr))}`;
    reply.type('text/html').send(layout('/articles', body, { title: a.title, navLeft, flash: flash(req.query) }));
  });

  app.post('/articles/:id/publish', async (req, reply) => {
    const aid = Number(req.params.id);
    const a = db.prepare('SELECT site_id FROM articles WHERE id = ?').get(aid);
    const jobId = createJob('publish', { siteId: a?.site_id });
    logJob(jobId, `Старт: публикация статьи #${aid}`);
    withTimeout(publishArticleById(db, aid, { accountId: req.body.account, onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'публикация')
      .then((res) => finishJob(jobId, { ok: res.ok, articleId: aid, message: res.message }))
      .catch((e) => finishJob(jobId, { ok: false, articleId: aid, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });
  app.post('/articles/:id/delete', async (req, reply) => {
    const a = db.prepare('SELECT site_id, status, site_deleted_at FROM articles WHERE id = ?').get(req.params.id);
    if (a?.status === 'published' && !a.site_deleted_at) {
      return reply.redirect(`/articles/${req.params.id}?msg=${encodeURIComponent('Статья ещё на сайте — сначала сними её с сайта, потом удаляй из БД.')}`);
    }
    db.prepare('DELETE FROM articles WHERE id = ?').run(req.params.id);
    reply.redirect(`/sites/${a?.site_id || ''}?tab=articles&msg=${encodeURIComponent('Статья удалена')}`);
  });

  // Ручное редактирование времени публикации статьи (вводится в часовом поясе сайта).
  // from (если задан — inline-правка из таблицы) → вернуться в таблицу; иначе на страницу статьи.
  app.post('/articles/:id/schedule', async (req, reply) => {
    const id = Number(req.params.id);
    const back = (msg) => {
      const base = req.body.from || `/articles/${id}`;
      return `${base}${base.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;
    };
    const a = db.prepare('SELECT site_id, status FROM articles WHERE id = ?').get(id);
    if (!a) return reply.code(404).send('нет');
    if (a.status === 'published') return reply.redirect(back('Статья опубликована — расписание менять нельзя.'));
    const site = db.prepare('SELECT timezone FROM sites WHERE id = ?').get(a.site_id);
    try {
      const ep = zonedToEpoch(req.body.date, req.body.time, site?.timezone || 'Europe/Vienna');
      if (!Number.isFinite(ep)) throw new Error('неверные дата/время');
      db.prepare("UPDATE articles SET scheduled_at = ?, status = 'scheduled' WHERE id = ?").run(utcStamp(new Date(ep)), id);
      logArticleEvent(db, id, 'scheduled', `Запланирована на ${fmtInTz(utcStamp(new Date(ep)), site?.timezone || 'Europe/Vienna')} (время сайта)`);
      reply.redirect(back('Время публикации обновлено'));
    } catch (e) {
      reply.redirect(back('Ошибка: ' + e.message));
    }
  });
  app.post('/articles/:id/unschedule', async (req, reply) => {
    const info = db.prepare("UPDATE articles SET status = 'draft', scheduled_at = NULL WHERE id = ? AND status != 'published'").run(req.params.id);
    if (info.changes) logArticleEvent(db, Number(req.params.id), 'unscheduled', 'Снята с расписания');
    reply.redirect(`/articles/${req.params.id}?msg=${encodeURIComponent('Снято с расписания')}`);
  });

  // Время авто-удаления с сайта (delete_at) — вводится в часовом поясе сайта. Только для опубликованной и не снятой.
  app.post('/articles/:id/set-delete-at', async (req, reply) => {
    const id = Number(req.params.id);
    const back = (msg) => {
      const base = req.body.from || `/articles/${id}`;
      return `${base}${base.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;
    };
    const a = db.prepare('SELECT site_id, status, site_deleted_at FROM articles WHERE id = ?').get(id);
    if (!a) return reply.code(404).send('нет');
    if (a.status !== 'published' || a.site_deleted_at) return reply.redirect(back('Задавать удаление можно только у опубликованной и ещё не снятой статьи.'));
    const site = db.prepare('SELECT timezone FROM sites WHERE id = ?').get(a.site_id);
    try {
      const ep = zonedToEpoch(req.body.date, req.body.time, site?.timezone || 'Europe/Vienna');
      if (!Number.isFinite(ep)) throw new Error('неверные дата/время');
      db.prepare('UPDATE articles SET delete_at = ? WHERE id = ?').run(utcStamp(new Date(ep)), id);
      logArticleEvent(db, id, 'delete_at', `Автоудаление назначено на ${fmtInTz(utcStamp(new Date(ep)), site?.timezone || 'Europe/Vienna')} (время сайта)`);
      reply.redirect(back('Время авто-удаления обновлено'));
    } catch (e) {
      reply.redirect(back('Ошибка: ' + e.message));
    }
  });
  app.post('/articles/:id/clear-delete-at', async (req, reply) => {
    db.prepare('UPDATE articles SET delete_at = NULL WHERE id = ?').run(req.params.id);
    logArticleEvent(db, Number(req.params.id), 'delete_at', 'Автоудаление снято');
    const base = req.body.from || `/articles/${req.params.id}`;
    reply.redirect(`${base}${base.includes('?') ? '&' : '?'}msg=${encodeURIComponent('Авто-удаление снято')}`);
  });

  // Удаление статьи С САЙТА (через Dolphin): фоновая задача, как публикация. POST /a/article/delete/<id>.
  app.post('/articles/:id/site-delete', async (req, reply) => {
    const id = Number(req.params.id);
    const a = db.prepare('SELECT site_id, status, site_url FROM articles WHERE id = ?').get(id);
    if (!a) return reply.code(404).send('нет');
    if (a.status !== 'published' || !a.site_url) {
      return reply.redirect(`/articles/${id}?msg=${encodeURIComponent('Нет URL опубликованной статьи на сайте — удалять нечего.')}`);
    }
    const jobId = createJob('delete', { siteId: a.site_id, articleId: id });
    logJob(jobId, `Старт: удаление статьи #${id} с сайта`);
    withTimeout(deleteArticleFromSiteById(db, id, { accountId: req.body.account, onStep: (m) => logJob(jobId, m) }), DELETE_TIMEOUT_MS, 'удаление с сайта')
      .then((r) => finishJob(jobId, { ok: r.ok, articleId: id, message: r.message }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  // --- bulk-действия над выделенными статьями ---
  const bulkIds = (body) => (Array.isArray(body.ids) ? body.ids : [body.ids]).map(Number).filter(Boolean);
  // Возврат балк-действия туда, откуда пришли (хаб сайта или глобальные статьи).
  const backTo = (from, msg) => {
    const base = from || '/articles';
    return `${base}${base.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`;
  };

  app.post('/articles/distribute', async (req, reply) => {
    const b = req.body;
    try {
      const distAccounts = Array.isArray(b.dist_accounts) ? b.dist_accounts : b.dist_accounts ? [b.dist_accounts] : [];
      const r = distributeArticles(db, {
        ids: b.ids,
        startDate: b.start_date, startTime: b.start_time, endDate: b.end_date, endTime: b.end_time,
        mode: b.mode || 'interval', intervalMin: b.interval, timeZone: b.timezone || 'Europe/Vienna',
        accountIds: distAccounts,
      });
      // Опционально: разом задать время авто-удаления с сайта (режимы как в настройках; считается ПО КАЖДОЙ статье
      // от её времени публикации). 'site' → не трогаем (при публикации применится auto_delete сайта через COALESCE).
      let delMsg = '';
      const dm = b.del_mode || 'site';
      const ids = bulkIds(b);
      if (dm === 'none') {
        // «Не удалять»: помечаем флагом (настройка сайта при публикации не применится) + чистим delete_at.
        if (ids.length) db.prepare(`UPDATE articles SET no_auto_delete = 1, delete_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
        delMsg = '; авто-удаление выключено (не удалять)';
      } else if (dm !== 'site') {
        const setDel = db.prepare('UPDATE articles SET delete_at = ?, no_auto_delete = 0 WHERE id = ?');
        const getArt = db.prepare('SELECT scheduled_at, site_id FROM articles WHERE id = ?');
        const getSite = db.prepare('SELECT window_end, timezone FROM sites WHERE id = ?');
        let n = 0;
        db.transaction(() => {
          for (const id of ids) {
            const a = getArt.get(id);
            if (!a || !a.scheduled_at) continue; // ставим удаление только тем, кому реально проставилось расписание
            const st = getSite.get(a.site_id) || {};
            const stz = st.timezone || b.timezone || 'Europe/Vienna';
            const schedEp = parseStamp(a.scheduled_at);
            let ep = null;
            if (dm === 'window_end' && st.window_end) {
              ep = nextDailyOccurrence(st.window_end, stz, schedEp); // ближайшее закрытие окна ПОСЛЕ публикации
            } else if (dm === 'ttl' && st.window_end) {
              const nh = Number(b.del_hours) > 0 ? Number(b.del_hours) : 4;
              ep = Math.min(schedEp + nh * 3600000, nextDailyOccurrence(st.window_end, stz, schedEp) - 5 * 60000); // N ч, но не позже (конец смены − 5 мин)
            } else if (dm === 'exact') {
              const ex = zonedToEpoch(b.auto_del_date, b.auto_del_time, b.timezone || 'Europe/Vienna');
              if (Number.isFinite(ex)) ep = ex;
            }
            if (ep != null && Number.isFinite(ep)) {
              setDel.run(utcStamp(new Date(ep)), id);
              n++;
            }
          }
        })();
        const dmRu = { window_end: 'к закрытию окна', ttl: 'через N ч до конца смены', exact: 'на точное время' }[dm] || dm;
        if (n) delMsg = `; удаление с сайта задано для ${n} (${dmRu})`;
      } else if (ids.length) {
        // «как в настройках сайта»: снять флаг «не удалять», чтобы применилась настройка сайта при публикации.
        db.prepare(`UPDATE articles SET no_auto_delete = 0 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
      }
      const accMsg = r.withAccount ? `; аккаунты назначены для ${r.withAccount}` : '';
      const msg = `Запланировано ${r.assigned} из ${r.total}` + (r.skipped ? ` (не влезло ${r.skipped} — увеличь диапазон или уменьши интервал)` : '') + accMsg + delMsg;
      reply.redirect(backTo(b.from, msg));
    } catch (e) {
      reply.redirect(backTo(b.from, 'Ошибка: ' + e.message));
    }
  });

  // Назначить/раскидать аккаунты по выбранным статьям (только черновики/в расписании) — round-robin+shuffle.
  app.post('/articles/bulk-set-account', async (req, reply) => {
    const b = req.body;
    const ids = bulkIds(b);
    const accountIds = Array.isArray(b.set_accounts) ? b.set_accounts : b.set_accounts ? [b.set_accounts] : [];
    if (!ids.length) return reply.redirect(backTo(b.from, 'Не выбрано ни одной статьи.'));
    if (!accountIds.length) return reply.redirect(backTo(b.from, 'Не выбран ни один аккаунт.'));
    const rows = db.prepare(`SELECT id, site_id FROM articles WHERE id IN (${ids.map(() => '?').join(',')}) AND status IN ('draft','scheduled') ORDER BY id`).all(...ids);
    const assign = roundRobinAccounts(db, rows, accountIds);
    const upd = db.prepare('UPDATE articles SET account_id = ? WHERE id = ?');
    let n = 0;
    db.transaction(() => {
      rows.forEach((r, i) => {
        if (assign[i] != null) {
          upd.run(assign[i], r.id);
          n++;
        }
      });
    })();
    reply.redirect(backTo(b.from, `Аккаунт назначен для ${n} из ${ids.length} (учитываются только черновики и статьи в расписании).`));
  });

  app.post('/articles/unschedule', async (req, reply) => {
    const ids = bulkIds(req.body);
    if (ids.length) db.prepare(`UPDATE articles SET status='draft', scheduled_at=NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    reply.redirect(backTo(req.body.from, `Снято с расписания: ${ids.length}`));
  });

  app.post('/articles/bulk-delete', async (req, reply) => {
    const ids = bulkIds(req.body);
    let deleted = 0;
    let skipped = 0;
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      // Нельзя удалять только живые на сайте (published без site_deleted_at). Архивные (снятые с сайта) — можно.
      skipped = db.prepare(`SELECT COUNT(*) c FROM articles WHERE status = 'published' AND site_deleted_at IS NULL AND id IN (${ph})`).get(...ids).c;
      deleted = db.prepare(`DELETE FROM articles WHERE (status != 'published' OR site_deleted_at IS NOT NULL) AND id IN (${ph})`).run(...ids).changes;
    }
    reply.redirect(backTo(req.body.from, `Удалено: ${deleted}${skipped ? `, пропущено опубликованных: ${skipped}` : ''}`));
  });

  // Балк: поставить время авто-удаления (del_date/del_time в часовом поясе панели) для выбранных опубликованных.
  app.post('/articles/bulk-set-delete-at', async (req, reply) => {
    const ids = bulkIds(req.body);
    try {
      const ep = zonedToEpoch(req.body.del_date, req.body.del_time, req.body.timezone || 'Europe/Vienna');
      if (!Number.isFinite(ep)) throw new Error('неверные дата/время');
      let n = 0;
      if (ids.length) {
        const ph = ids.map(() => '?').join(',');
        n = db.prepare(`UPDATE articles SET delete_at = ? WHERE status='published' AND site_deleted_at IS NULL AND id IN (${ph})`).run(utcStamp(new Date(ep)), ...ids).changes;
      }
      reply.redirect(backTo(req.body.from, `Удаление назначено: ${n} (только опубликованные)`));
    } catch (e) {
      reply.redirect(backTo(req.body.from, 'Ошибка: ' + e.message));
    }
  });
  app.post('/articles/bulk-clear-delete-at', async (req, reply) => {
    const ids = bulkIds(req.body);
    let n = 0;
    if (ids.length) n = db.prepare(`UPDATE articles SET delete_at = NULL WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
    reply.redirect(backTo(req.body.from, `Авто-удаление снято: ${n}`));
  });

  // Балк-автоудаление для опубликованных: режимы как в настройках сайта (none/window_end/ttl/exact).
  // Считается по каждой статье от её published_at (для ttl) / от «сейчас» (window_end). Только published, не снятые.
  app.post('/articles/bulk-autodelete', async (req, reply) => {
    const b = req.body;
    const ids = bulkIds(b);
    const mode = b.ad_mode || 'exact';
    let n = 0;
    if (mode === 'none') {
      if (ids.length) n = db.prepare(`UPDATE articles SET no_auto_delete = 1, delete_at = NULL WHERE status='published' AND site_deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`).run(...ids).changes;
      return reply.redirect(backTo(b.from, `Не удалять: ${n}`));
    }
    let exactEp = null;
    if (mode === 'exact') {
      exactEp = zonedToEpoch(b.ad_date, b.ad_time, b.timezone || 'Europe/Vienna');
      if (!Number.isFinite(exactEp)) return reply.redirect(backTo(b.from, 'Ошибка: неверные дата/время'));
    }
    const setDel = db.prepare("UPDATE articles SET delete_at = ?, no_auto_delete = 0 WHERE id = ? AND status='published' AND site_deleted_at IS NULL");
    const getArt = db.prepare('SELECT published_at, site_id FROM articles WHERE id = ?');
    const getSite = db.prepare('SELECT window_end, timezone FROM sites WHERE id = ?');
    db.transaction(() => {
      for (const id of ids) {
        const a = getArt.get(id);
        if (!a) continue;
        const st = getSite.get(a.site_id) || {};
        const stz = st.timezone || b.timezone || 'Europe/Vienna';
        let ep = null;
        if (mode === 'exact') ep = exactEp;
        else if (mode === 'window_end' && st.window_end) ep = nextDailyOccurrence(st.window_end, stz, Date.now());
        else if (mode === 'ttl' && st.window_end) {
          const nh = Number(b.ad_hours) > 0 ? Number(b.ad_hours) : 4;
          const pubEp = parseStamp(a.published_at) || Date.now();
          ep = Math.min(pubEp + nh * 3600000, nextDailyOccurrence(st.window_end, stz, pubEp) - 5 * 60000);
        }
        if (ep != null && Number.isFinite(ep) && setDel.run(utcStamp(new Date(ep)), id).changes) n++;
      }
    })();
    const ru = { window_end: 'к закрытию окна', ttl: 'через N ч до конца смены', exact: 'на точное время' }[mode] || mode;
    reply.redirect(backTo(b.from, `Авто-удаление задано: ${n} (${ru})`));
  });

  // Балк-публикация выбранных (последовательно, фоновой задачей). Профиль резолвится под сайт каждой статьи.
  app.post('/articles/bulk-publish', async (req, reply) => {
    const ids = bulkIds(req.body);
    if (!ids.length) return reply.redirect(`/articles?msg=${encodeURIComponent('Не выбрано ни одной статьи.')}`);
    const accountId = req.body.account || undefined;
    const jobId = createJob('publish', {});
    logJob(jobId, `Старт: публикация ${ids.length} статей (#${ids.join(', #')})`);
    (async () => {
      let ok = 0;
      let fail = 0;
      let stopped = false;
      const done = [];
      for (let i = 0; i < ids.length; i++) {
        if (isJobCancelled(jobId)) { stopped = true; break; }
        const id = ids[i];
        logJob(jobId, `── [${i + 1}/${ids.length}] статья #${id} ──`);
        try {
          const r = await withTimeout(publishArticleById(db, id, { accountId, onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'публикация');
          if (r.ok) { ok++; done.push(id); } else fail++;
        } catch (e) {
          logJob(jobId, `сбой#${id}: ${e.message}`);
          fail++;
        }
      }
      finishJob(jobId, { ok: !stopped && fail === 0, stopped, message: `${stopped ? 'Остановлено. ' : ''}Опубликовано ${ok} из ${ids.length}${fail ? `, ошибок ${fail}` : ''}`, result: { kind: 'publish', ids: done } });
    })().catch((e) => { try { finishJob(jobId, { ok: false, message: 'Сбой задачи: ' + e.message }); } catch {} });
    reply.redirect(`/jobs/${jobId}`);
  });

  // Балк: снять выбранные опубликованные с сайта (последовательно, фоновой задачей).
  app.post('/articles/bulk-site-delete', async (req, reply) => {
    const ids = bulkIds(req.body);
    const pubIds = ids.filter((id) => {
      const a = db.prepare('SELECT status, site_url, site_deleted_at FROM articles WHERE id = ?').get(id);
      return a && a.status === 'published' && a.site_url && !a.site_deleted_at;
    });
    if (!pubIds.length) return reply.redirect(backTo(req.body.from, 'Нет выбранных опубликованных статей на сайте — снимать нечего.'));
    const jobId = createJob('delete', {});
    logJob(jobId, `Старт: снятие с сайта ${pubIds.length} статей — группировка по аккаунту, до ${BULK_CONCURRENCY} профилей параллельно.`);
    // Группируем по аккаунту: один профиль на аккаунт, до BULK_CONCURRENCY параллельно, пауза внутри аккаунта.
    deleteArticlesGrouped(db, pubIds, { concurrency: BULK_CONCURRENCY, delayMs: BULK_DELETE_DELAY_MS, shouldStop: () => isJobCancelled(jobId), onStep: (m) => logJob(jobId, m) })
      .then((r) => {
        const deletedIds = pubIds.filter((id) => db.prepare('SELECT site_deleted_at FROM articles WHERE id = ?').get(id)?.site_deleted_at);
        const stopped = !!r.stopped;
        finishJob(jobId, { ok: !stopped && r.fail === 0, stopped, message: `${stopped ? 'Остановлено. ' : ''}Снято с сайта ${r.ok} из ${r.total}${r.fail ? `, ошибок ${r.fail}` : ''}`, result: { kind: 'delete', ids: deletedIds } });
      })
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  // ============================ Фоновые задачи ============================
  app.get('/jobs', async (req, reply) => {
    const where = [];
    const params = {};
    if (req.query.type) { where.push('type = @type'); params.type = req.query.type; }
    if (req.query.status) { where.push('status = @status'); params.status = req.query.status; }
    const sql = 'SELECT * FROM jobs' + (where.length ? ` WHERE ${where.join(' AND ')}` : '') + ' ORDER BY datetime(updated_at) DESC, id DESC LIMIT 300';
    const rows = db.prepare(sql).all(params);
    const hasRunning = rows.some((j) => j.status === 'running');
    const sel = (name, opts, cur) =>
      `<select name="${name}" class="form-select" style="width:auto;display:inline-block"><option value="">${opts[0]}</option>${opts.slice(1).map(([val, l]) => `<option value="${val}"${val === cur ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    const filter = `<form method="get" action="/jobs" class="inline-form mb-3">${sel('type', ['все типы', ['generate', 'генерация'], ['publish', 'публикация']], req.query.type || '')}${sel('status', ['все статусы', ['running', 'идёт'], ['done', 'готово'], ['failed', 'ошибка']], req.query.status || '')}<button type="submit" class="btn btn-primary">Фильтр</button></form>`;
    const tr = rows
      .map(
        (j) => `<tr><td>${j.id}</td><td>${jobTypeRu(j.type)}</td><td>${jobBadge(j.status)}</td>
<td>${j.site_id ? `<a href="/sites/${j.site_id}">#${j.site_id}</a>` : '-'}</td>
<td>${j.article_id ? `<a href="/articles/${j.article_id}">#${j.article_id}</a>` : '-'}</td>
<td>${esc((j.message || '').slice(0, 70))}</td><td class="text-secondary">${esc(j.created_at)}</td><td class="text-secondary">${esc(j.updated_at)}</td>
<td><a href="/jobs/${j.id}">открыть</a></td></tr>`,
      )
      .join('');
    const note = hasRunning ? '<p class="text-secondary"><i class="ti ti-hourglass"></i> Есть активные задачи — страница сама обновляется.</p>' : '';
    const refresh = hasRunning ? '<script>setTimeout(function(){location.reload();},3000);</script>' : '';
    reply.type('text/html').send(page('/jobs', 'Задачи', filter + note + tbl(['id', 'тип', 'статус', 'сайт', 'статья', 'сообщение', 'начато', 'завершено', ''], tr) + refresh));
  });

  app.get('/jobs/:id', async (req, reply) => {
    const j = getJob(req.params.id);
    if (!j) return reply.code(404).send('Задача не найдена');
    const typeRu = j.type === 'generate' ? 'генерация' : j.type === 'publish' ? 'публикация' : j.type === 'delete' ? 'удаление с сайта' : j.type;
    const progress = `<div id="jpr"${j.status === 'running' ? '' : ' style="display:none"'}><div class="progress"><div class="progress-bar progress-bar-indeterminate"></div></div></div>`;
    const fmtT = (ts) => {
      const d = new Date(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const logText = getJobLog(j.id).map((e) => `${fmtT(e.ts)} — ${e.msg}`).join('\n');
    const logCard = card('Журнал', `<pre id="joblog" class="mono mb-0" style="max-height:55vh;overflow:auto;white-space:pre-wrap;word-break:break-word">${esc(logText) || '<span class="text-secondary">…</span>'}</pre>`);
    const stopBtn = j.status === 'running'
      ? `<form method="post" action="/jobs/${j.id}/cancel" class="d-inline" onsubmit="return confirm('Остановить задачу? Она завершится после текущего шага.')"><button class="btn btn-outline-danger"><i class="ti ti-player-stop"></i> Остановить</button></form>`
      : '';
    let resultCard = '';
    if (j.result) {
      try {
        const r = JSON.parse(j.result);
        const rids = r.ids || [];
        if (r.kind === 'mailbox' && (r.emails || []).length) {
          resultCard = card(`<i class="ti ti-checklist"></i> Создано ящиков (${r.emails.length})`, `<p class="mb-2">Добавлены в пул <a href="/emails">Почты</a>.</p><div style="max-height:30vh;overflow:auto" class="mono small">${r.emails.map((e) => esc(e)).join('<br>')}</div>`);
        } else if (rids.length) {
          const hint = { publish: 'Опубликованы на сайте. Чтобы отменить — снять с сайта на странице «Статьи».', generate: 'Созданы черновики. Чтобы отменить — удалить из БД на странице «Статьи».', delete: 'Сняты с сайта (отменить нельзя — уже удалены).' }[r.kind] || '';
          const links = rids.map((aid) => `<a href="/articles/${aid}" class="me-2 text-nowrap">#${aid}</a>`).join('');
          resultCard = card(`<i class="ti ti-checklist"></i> Что успело выполниться (${rids.length})`, `<p class="mb-2">${esc(hint)}</p><div style="max-height:30vh;overflow:auto">${links}</div>`);
        }
      } catch {
        // битый result — пропускаем
      }
    }
    const body = `${card('', `<p class="mb-1">Статус: <b id="jst">${esc(j.status)}</b></p><p id="jmsg" class="text-secondary mb-2">${esc(j.message || '')}</p>${progress}`)}
${resultCard}
${logCard}
<div class="d-flex flex-wrap gap-2 my-3">${stopBtn}<a href="/sites/${j.site_id || ''}" class="btn btn-outline-secondary">К сайту</a> ${j.article_id ? `<a href="/articles/${j.article_id}" class="btn btn-primary">К статье</a>` : ''}</div>
<script>
(function(){var id=${j.id},st=document.getElementById('jst'),mg=document.getElementById('jmsg'),pr=document.getElementById('jpr'),jl=document.getElementById('joblog');
function fmt(ts){var d=new Date(ts);function p(n){return (n<10?'0':'')+n;}return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
function renderLog(log){if(!log||!log.length)return;jl.textContent=log.map(function(e){return fmt(e.ts)+' — '+e.msg;}).join(String.fromCharCode(10));jl.scrollTop=jl.scrollHeight;}
function fin(s){st.textContent=s;if(pr)pr.style.display='none';}
function poll(){fetch('/jobs/'+id+'/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){st.textContent=d.status;mg.textContent=d.message||'';renderLog(d.log);if(d.status==='running'){setTimeout(poll,1500);}else{location.reload();}}).catch(function(){setTimeout(poll,3000);});}
if(jl)jl.scrollTop=jl.scrollHeight;
if('${j.status}'==='running'){poll();}
})();
</script>
<p class="mt-3"><a href="/jobs" class="text-secondary">← Все задачи</a></p>`;
    reply.type('text/html').send(layout('/jobs', body, { title: `Задача #${j.id}: ${typeRu}`, navLeft: `<a href="/jobs" class="text-decoration-none">← Задачи</a>`, flash: flash(req.query) }));
  });

  app.get('/jobs/:id/status', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const j = getJob(req.params.id);
    if (!j) {
      reply.code(404);
      return { error: 'not found' };
    }
    return { status: j.status, message: j.message, article_id: j.article_id, log: getJobLog(req.params.id) };
  });

  // Остановить идущую задачу (кооперативно: завершится после текущего шага). Балк-циклы проверяют флаг между элементами.
  app.post('/jobs/:id/cancel', async (req, reply) => {
    const ok = requestJobCancel(req.params.id);
    reply.redirect(`/jobs/${req.params.id}?msg=${encodeURIComponent(ok ? 'Остановка запрошена — задача завершится после текущего шага.' : 'Задача уже не выполняется.')}`);
  });

  // ============================ Планировщик ============================
  // Относительное время от «сейчас» по хранимой UTC-метке: «через 2 ч 5 мин» / «просрочено …».
  const relFromNow = (utcStr) => {
    const ep = parseStamp(utcStr);
    if (ep == null) return '—';
    const overdue = ep < Date.now();
    let m = Math.round(Math.abs(ep - Date.now()) / 60000);
    const txt = m < 1 ? '<1 мин' : m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
    return overdue ? `<span class="text-warning">просрочено на ${txt} → в ближайший тик</span>` : `через ${txt}`;
  };
  const EVENT_RU = { published: 'опубликована', site_deleted: 'снята с сайта', publish_failed: 'ошибка публикации', site_delete_failed: 'ошибка удаления' };
  const evBadge = (k) => `<span class="badge ${k.includes('failed') ? 'bg-red' : 'bg-green'} text-white">${EVENT_RU[k] || k}</span>`;

  app.get('/scheduler', async (req, reply) => {
    const tickMs = Number(process.env.SCHEDULER_TICK_MS || 30000);
    const lastTick = getSetting(db, 'scheduler_last_tick');
    const lastSummary = getSetting(db, 'scheduler_last_summary');
    const ageMs = lastTick ? Date.now() - parseStamp(lastTick) : null;
    const alive = ageMs != null && ageMs <= tickMs * 3 + 5000; // ~3 тика + запас
    const statusBadge = lastTick == null ? '<span class="badge bg-secondary text-white">нет данных</span>' : alive ? '<span class="badge bg-green text-white">работает</span>' : '<span class="badge bg-red text-white">не отвечает</span>';
    const ageTxt = lastTick == null ? 'тиков ещё не было' : `${Math.round(ageMs / 1000)} сек назад (${esc(fmtInTz(lastTick, 'UTC'))} UTC)`;
    const statusCard = card(
      'Статус планировщика',
      `<p class="mb-1">${statusBadge} &nbsp;последний тик: <b>${ageTxt}</b></p>
<p class="text-secondary small mb-0">Тик каждые ${tickMs / 1000}с. ${lastTick != null && !alive ? 'Похоже, контейнер <code>scheduler</code> не работает — проверь <code>docker compose ps</code> / <code>docker compose logs scheduler</code>. ' : ''}${lastSummary ? '<br>Последняя сводка: ' + esc(lastSummary) : ''}</p>`,
    );

    const pubQueue = db
      .prepare(`SELECT a.id, a.title, a.scheduled_at, s.name site_name, s.timezone tz FROM articles a JOIN sites s ON s.id = a.site_id WHERE a.status='scheduled' AND a.scheduled_at IS NOT NULL AND s.active=1 ORDER BY a.scheduled_at, a.id LIMIT 300`)
      .all();
    const pubRows = pubQueue
      .map((a) => `<tr><td>${a.id}</td><td>${esc(a.site_name)}</td><td><a href="/articles/${a.id}">${esc((a.title || '').slice(0, 60))}</a></td><td class="text-secondary" style="white-space:nowrap">${esc(fmtInTz(a.scheduled_at, a.tz))}</td><td class="text-secondary">${relFromNow(a.scheduled_at)}</td></tr>`)
      .join('');
    const pubTotal = db.prepare("SELECT COUNT(*) c FROM articles a JOIN sites s ON s.id = a.site_id WHERE a.status='scheduled' AND a.scheduled_at IS NOT NULL AND s.active=1").get().c;
    const pubCard = tableCard(`<i class="ti ti-upload"></i> Очередь публикации (${pubTotal})${pubTotal > pubQueue.length ? ` — показаны первые ${pubQueue.length}` : ''}`, ['id', 'сайт', 'заголовок', 'когда (время сайта)', 'через'], pubRows, 'pubq');

    const delQueue = db
      .prepare(`SELECT a.id, a.title, a.delete_at, s.name site_name, s.timezone tz FROM articles a JOIN sites s ON s.id = a.site_id WHERE a.status='published' AND a.site_deleted_at IS NULL AND a.delete_at IS NOT NULL AND s.active=1 ORDER BY a.delete_at, a.id LIMIT 300`)
      .all();
    const delRows = delQueue
      .map((a) => `<tr><td>${a.id}</td><td>${esc(a.site_name)}</td><td><a href="/articles/${a.id}">${esc((a.title || '').slice(0, 60))}</a></td><td class="text-secondary" style="white-space:nowrap">${esc(fmtInTz(a.delete_at, a.tz))}</td><td class="text-secondary">${relFromNow(a.delete_at)}</td></tr>`)
      .join('');
    const delTotal = db.prepare("SELECT COUNT(*) c FROM articles a JOIN sites s ON s.id = a.site_id WHERE a.status='published' AND a.site_deleted_at IS NULL AND a.delete_at IS NOT NULL AND s.active=1").get().c;
    const delCard = tableCard(`<i class="ti ti-trash"></i> Очередь автоудаления (${delTotal})${delTotal > delQueue.length ? ` — показаны первые ${delQueue.length}` : ''}`, ['id', 'сайт', 'заголовок', 'удалить в (время сайта)', 'через'], delRows, 'delq');

    const acts = db
      .prepare(`SELECT e.ts, e.kind, e.message, e.article_id, s.timezone tz FROM article_events e JOIN articles a ON a.id = e.article_id JOIN sites s ON s.id = a.site_id WHERE e.kind IN ('published','site_deleted','publish_failed','site_delete_failed') ORDER BY e.id DESC LIMIT 25`)
      .all();
    const actRows = acts
      .map((e) => `<tr><td class="text-secondary" style="white-space:nowrap">${esc(fmtInTz(e.ts, e.tz))}</td><td><a href="/articles/${e.article_id}">#${e.article_id}</a></td><td>${evBadge(e.kind)}</td><td>${esc(e.message || '')}</td></tr>`)
      .join('');
    const actCard = tableCard('<i class="ti ti-history"></i> Недавняя активность', ['время (сайт)', 'статья', 'событие', 'текст'], actRows, 'acts');

    // Регистрации: сводка по статусам + очередь проверок одобрения (планировщик дергает по next_check_at).
    const regStatusRu = { pending: 'в очереди', mail_login_failed: 'почта недоступна', submitted: 'форма отправлена', confirm_failed: 'нет подтверждения', awaiting_admin: 'ждём одобрения', approved: 'одобрено', rejected: 'отклонено', failed: 'ошибка' };
    const regSummary = db.prepare('SELECT status, COUNT(*) c FROM site_registrations GROUP BY status').all();
    const regAwait = db
      .prepare(`SELECT r.id, e.email, r.next_check_at, r.checks, s.name site_name FROM site_registrations r JOIN email_accounts e ON e.id = r.email_account_id JOIN sites s ON s.id = r.site_id WHERE r.status = 'awaiting_admin' ORDER BY r.next_check_at, r.id LIMIT 200`)
      .all();
    const summaryTxt = regSummary.length ? regSummary.map((x) => `${esc(regStatusRu[x.status] || x.status)}: ${x.c}`).join(' · ') : 'регистраций ещё нет';
    const regRows = regAwait
      .map((r) => `<tr><td>${r.id}</td><td>${esc(r.site_name)}</td><td>${esc(r.email)}</td><td class="text-secondary" style="white-space:nowrap">${esc(fmtInTz(r.next_check_at, 'UTC'))} UTC</td><td class="text-secondary">${relFromNow(r.next_check_at)}</td><td class="text-secondary">${r.checks}/7</td></tr>`)
      .join('');
    const regCard = tableCard(
      `<i class="ti ti-user-plus"></i> Регистрации — очередь проверок одобрения (${regAwait.length})`,
      ['id', 'сайт', 'почта', 'проверка в', 'через', 'попыток'],
      regRows,
      'regq',
      `<div class="text-secondary small">Сводка: ${summaryTxt}. Регистрация идёт строго последовательно (один поток); живой лог каждой — в <a href="/jobs">Задачах</a>. Проверка одобрения — по IMAP, без Dolphin.</div>`,
    );

    const refresh = '<script>setTimeout(function(){location.reload();},15000);</script>';
    reply.type('text/html').send(page('/scheduler', 'Планировщик', statusCard + pubCard + delCard + regCard + actCard + refresh));
  });

  // ============================ Макеты управления статьями (черновик дизайна) ============================
  // Несколько ЖИВЫХ макетов на реальных статьях для выбора вида. Кнопки декоративные. URL: /mockups?site=1
  app.get('/mockups', async (req, reply) => {
    const sid = Number(req.query.site || 1);
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(sid) || { timezone: 'Europe/Vienna', name: '' };
    const tz = site.timezone || 'Europe/Vienna';
    const rows = db.prepare('SELECT id, status, category, title, scheduled_at, published_at, delete_at, site_deleted_at FROM articles WHERE site_id = ? ORDER BY id DESC LIMIT 6').all(sid);
    const t = (s) => esc(fmtInTz(s, tz));
    const ttl = (a) => esc((a.title || '').slice(0, 46));
    const cb = '<input type="checkbox" class="form-check-input m-0">';
    // Реальные контролы текущей страницы (декоративные): инлайн-редактор времени, аккаунт+Опубл., статус.
    const accOpts = enabledSiteAccounts(db, sid).map((ac) => `<option>${esc(ac.label || ac.username)}</option>`).join('') || '<option>аккаунт</option>';
    const ez = (s, useNow) => {
      const ep = parseStamp(s) ?? (useNow ? Date.now() : null);
      return ep == null ? { date: '', time: '' } : epochToZoned(ep, tz);
    };
    const editor = (z, btn) => `<div class="d-flex gap-1"><input type="date" class="form-control form-control-sm" style="width:8.2rem" value="${z.date}"><input type="time" class="form-control form-control-sm" style="width:5.6rem" value="${z.time}"><button class="btn btn-sm ${btn}" title="сохранить"><i class="ti ti-check"></i></button></div>`;
    const schedCell = (a) => (a.status === 'published' || a.status === 'failed' ? `<span class="text-secondary">${t(a.scheduled_at)}</span>` : editor(ez(a.scheduled_at, true), 'btn-outline-secondary'));
    const delCell = (a) => (a.status === 'published' && !a.site_deleted_at ? editor(ez(a.delete_at, true), 'btn-outline-warning') : `<span class="text-secondary">${t(a.delete_at)}</span>`);
    const pubCell = () => `<div class="d-flex gap-1"><select class="form-select form-select-sm" style="width:auto">${accOpts}</select><button class="btn btn-sm btn-outline-primary">Опубл.</button></div>`;
    const statusCell = (a) => `${badge(a.status)}${a.site_deleted_at ? ' <span class="badge bg-orange text-white">снята</span>' : ''}`;
    // Жизненный цикл в одной ячейке.
    const state = (a) => {
      if (a.status === 'draft') return '<span class="text-secondary">Черновик — не запланирована</span>';
      if (a.status === 'failed') return '<span class="text-danger">Ошибка</span>';
      if (a.status === 'scheduled') return `<span class="text-info">В расписании</span> → <b>${t(a.scheduled_at)}</b> <span class="text-secondary small">(${relFromNow(a.scheduled_at)})</span>`;
      if (a.status === 'published' && a.site_deleted_at) return `<span class="text-secondary">Снято с сайта ${t(a.site_deleted_at)}</span>`;
      if (a.status === 'published') return `<span class="text-success">На сайте</span> с ${t(a.published_at)}` + (a.delete_at ? ` · <span class="text-warning">удалится ${t(a.delete_at)}</span> <span class="text-secondary small">(${relFromNow(a.delete_at)})</span>` : ' · авто-удаление не задано');
      return '-';
    };
    const menu = '<button type="button" class="btn btn-sm btn-outline-secondary" title="ещё действия">⋮</button>';
    const actsRow = (a) => {
      if (a.status === 'draft') return `<div class="btn-list flex-nowrap"><button class="btn btn-sm btn-primary">Опубликовать</button><button class="btn btn-sm btn-outline-secondary">Запланировать</button>${menu}</div>`;
      if (a.status === 'scheduled') return `<div class="btn-list flex-nowrap"><button class="btn btn-sm btn-outline-secondary">Изменить время</button><button class="btn btn-sm btn-outline-secondary">Снять</button>${menu}</div>`;
      if (a.status === 'published' && !a.site_deleted_at) return `<div class="btn-list flex-nowrap"><button class="btn btn-sm btn-outline-warning">Удалить с сайта</button><a class="btn btn-sm btn-outline-secondary" href="/articles/${a.id}">Открыть</a>${menu}</div>`;
      if (a.status === 'published') return `<div class="btn-list flex-nowrap"><a class="btn btn-sm btn-outline-secondary" href="/articles/${a.id}">Открыть</a>${menu}</div>`;
      return `<div class="btn-list flex-nowrap"><button class="btn btn-sm btn-outline-danger">Повторить</button>${menu}</div>`;
    };

    // Свёрнутая панель массовых действий — общая шапка.
    const collapsedBulk = `<div class="card mb-3"><div class="card-body py-2 d-flex align-items-center gap-2"><button type="button" class="btn btn-outline-primary" onclick="var b=document.getElementById('bulkdemo');b.classList.toggle('d-none');"><i class="ti ti-settings"></i> Массовые действия ▾</button><span class="text-secondary small">распределение по времени · публикация выбранных · авто-удаление — свёрнуто, разворачивается по кнопке</span></div><div id="bulkdemo" class="card-body border-top d-none text-secondary">(здесь раскрывается текущая большая панель «Распределить / опубликовать / удалить»)</div></div>`;

    // ВАРИАНТ A — текущая таблица: ВСЕ колонки и инлайн-редакторы, но «датовые» сгруппированы + столбец «⋮».
    const aRows = rows
      .map((a) => `<tr><td>${cb}</td><td>${a.id}</td><td>${statusCell(a)}</td><td>${esc(a.category || '')}</td><td>${ttl(a)}</td><td>${schedCell(a)}</td><td class="text-secondary border-start">${t(a.published_at)}</td><td>${delCell(a)}</td><td class="text-secondary">${t(a.site_deleted_at)}</td><td class="border-start">${pubCell()}</td><td>${menu}</td></tr>`)
      .join('');
    const variantA = `<h2 class="mb-1">ВАРИАНТ A — «Текущая таблица, аккуратнее»</h2>
<p class="text-secondary">Всё на месте: статус, промт, инлайн-редактор расписания (есть), время удаления (есть), аккаунт + «Опубл.». Три «датовых» столбца сгруппированы под общей шапкой <b><i class="ti ti-world"></i> На сайте</b>, добавлен столбец <b>⋮</b> с остальными действиями (открыть / снять / удалить из БД). Уже и понятнее, но широкая.</p>
<div class="card mb-3"><div class="table-responsive"><table class="table table-vcenter card-table">
<thead>
<tr><th rowspan="2" class="w-1">${cb}</th><th rowspan="2">id</th><th rowspan="2">статус</th><th rowspan="2">промт</th><th rowspan="2">заголовок</th><th rowspan="2">расписание</th><th colspan="3" class="text-center border-start"><i class="ti ti-world"></i> На сайте</th><th rowspan="2" class="border-start">публикация</th><th rowspan="2"></th></tr>
<tr><th class="border-start">опубликовано</th><th>удалить в</th><th>удалено</th></tr>
</thead>
<tbody>${aRows}</tbody></table></div></div>`;

    // ВАРИАНТ B — секции по статусу: в каждой ТОЛЬКО нужные колонки + нужный инлайн-редактор + своя массовая панель.
    const sec = (label, list, headers, rowFn, bulk, note) =>
      `<div class="card mb-2"><div class="card-header py-2 d-flex align-items-center gap-2"><h3 class="card-title mb-0">${label} <span class="text-secondary">(${list.length})</span></h3><div class="ms-auto btn-list">${bulk || ''}</div></div>${note ? `<div class="px-3 py-1 text-secondary small">${note}</div>` : ''}${
        list.length
          ? `<div class="table-responsive"><table class="table table-vcenter card-table mb-0"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${list.map(rowFn).join('')}</tbody></table></div>`
          : '<div class="card-body py-2 text-secondary">нет</div>'
      }</div>`;
    const drafts = rows.filter((a) => a.status === 'draft');
    const sched = rows.filter((a) => a.status === 'scheduled');
    const pub = rows.filter((a) => a.status === 'published' && !a.site_deleted_at);
    const arch = rows.filter((a) => a.status === 'failed' || (a.status === 'published' && a.site_deleted_at));
    const variantB = `<h2 class="mb-1">ВАРИАНТ B — «Секции по статусу»</h2>
<p class="text-secondary">Список разбит на этапы жизни. В черновиках — редактор расписания и «Опубл.»; в расписании — только время + «снять»; в опубликованных — редактор времени удаления и «удалить с сайта». Лишних колонок нет, у каждой секции своя массовая панель.</p>
${sec('<i class="ti ti-edit"></i> Черновики', drafts, ['', 'id', 'промт', 'заголовок', 'расписание', 'публикация', ''], (a) => `<tr><td class="w-1">${cb}</td><td>#${a.id}</td><td>${esc(a.category || '')}</td><td>${ttl(a)}</td><td>${schedCell(a)}</td><td>${pubCell()}</td><td>${menu}</td></tr>`, '<button class="btn btn-sm btn-outline-primary">Распределить выбр.</button><button class="btn btn-sm btn-primary">Опубликовать выбр.</button>')}
${sec('<i class="ti ti-clock"></i> В расписании', sched, ['', 'id', 'заголовок', 'опубликовать в', '', ''], (a) => `<tr><td class="w-1">${cb}</td><td>#${a.id}</td><td>${ttl(a)}</td><td>${schedCell(a)}</td><td><button class="btn btn-sm btn-outline-secondary">снять</button></td><td>${menu}</td></tr>`, '<button class="btn btn-sm btn-outline-secondary">Снять выбр.</button>', 'Публикуются автоматически планировщиком.')}
${sec('<i class="ti ti-circle-check"></i> Опубликованы', pub, ['', 'id', 'заголовок', 'опубликовано', 'удалить с сайта в', '', ''], (a) => `<tr><td class="w-1">${cb}</td><td>#${a.id}</td><td>${ttl(a)}</td><td class="text-secondary">${t(a.published_at)}</td><td>${delCell(a)}</td><td><button class="btn btn-sm btn-outline-warning">удалить с сайта</button></td><td>${menu}</td></tr>`, '<button class="btn btn-sm btn-outline-warning">Удалить выбр. с сайта</button>')}
${sec('<i class="ti ti-archive"></i> Архив (снятые / ошибки)', arch, ['id', 'заголовок', 'опубликовано', 'удалено', ''], (a) => `<tr><td>#${a.id}</td><td>${ttl(a)}</td><td class="text-secondary">${t(a.published_at)}</td><td class="text-secondary">${t(a.site_deleted_at)}</td><td><a class="btn btn-sm btn-outline-secondary" href="/articles/${a.id}">открыть</a></td></tr>`)}`;

    // ВАРИАНТ C — компактная таблица + раскрывающаяся строка с ПОЛНЫМИ контролами в drawer.
    const cKeyDate = (a) => (a.status === 'scheduled' ? `→ ${t(a.scheduled_at)}` : a.published_at ? t(a.published_at) : '—');
    const drawerControls = (a) => {
      const blocks = [];
      if (a.status === 'draft' || a.status === 'scheduled') blocks.push(`<div class="col-auto"><div class="small text-secondary mb-1">Расписание (TZ сайта)</div>${schedCell(a)}</div>`);
      if (a.status === 'published' && !a.site_deleted_at) blocks.push(`<div class="col-auto"><div class="small text-secondary mb-1">Удалить с сайта в</div>${delCell(a)}</div>`);
      blocks.push(`<div class="col-auto"><div class="small text-secondary mb-1">Публикация</div>${pubCell()}</div>`);
      blocks.push(`<div class="col-auto align-self-end"><div class="btn-list"><a class="btn btn-sm btn-outline-secondary" href="/articles/${a.id}">Открыть</a>${a.status === 'published' && !a.site_deleted_at ? '<button class="btn btn-sm btn-outline-warning">Удалить с сайта</button>' : ''}${menu}</div></div>`);
      return `<div class="row g-3">${blocks.join('')}</div>`;
    };
    const cRows = rows
      .map((a, i) => {
        const open = i === 0;
        const main = `<tr style="cursor:pointer" onclick="var d=document.getElementById('dr${a.id}');if(d)d.classList.toggle('d-none');this.querySelector('.cx').textContent=d.classList.contains('d-none')?'▸':'▾';"><td>${cb}</td><td>#${a.id}</td><td>${statusCell(a)}</td><td>${esc(a.category || '')}</td><td>${ttl(a)}</td><td class="text-secondary">${cKeyDate(a)}</td><td class="cx">${open ? '▾' : '▸'}</td></tr>`;
        const drawer = `<tr id="dr${a.id}" class="${open ? '' : 'd-none'}"><td colspan="7" class="bg-body-tertiary"><div class="p-2">${drawerControls(a)}<div class="mt-2 small text-secondary">Журнал: создана … · запланирована … · опубликована … (события статьи прямо тут)</div></div></td></tr>`;
        return main + drawer;
      })
      .join('');
    const variantC = `<h2 class="mb-1">ВАРИАНТ C — «Раскрывающаяся строка»</h2>
<p class="text-secondary">Компактная таблица (статус + промт + заголовок + ключевая дата). Клик по строке раскрывает панель со <b>всеми контролами и журналом</b> прямо в таблице: редактор расписания / времени удаления, аккаунт + «Опубл.», открыть. (Первая строка уже раскрыта — кликни по другим.)</p>
<div class="card mb-3"><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">${cb}</th><th>id</th><th>статус</th><th>промт</th><th>заголовок</th><th>дата</th><th></th></tr></thead><tbody>${cRows}</tbody></table></div></div>`;

    // ВАРИАНТ D — карточки с ПОЛНЫМИ контролами.
    const dCard = (a) => {
      const ed =
        a.status === 'draft' || a.status === 'scheduled'
          ? `<div class="small text-secondary mb-1">Расписание (TZ сайта)</div>${schedCell(a)}`
          : a.status === 'published' && !a.site_deleted_at
            ? `<div class="small text-secondary mb-1">Удалить с сайта в</div>${delCell(a)}`
            : '';
      const f = [];
      if (a.status !== 'published') f.push(pubCell());
      if (a.status === 'scheduled') f.push('<button class="btn btn-sm btn-outline-secondary">Снять</button>');
      if (a.status === 'published' && !a.site_deleted_at) f.push('<button class="btn btn-sm btn-outline-warning">Удалить с сайта</button>');
      f.push(`<a class="btn btn-sm btn-outline-secondary ms-auto" href="/articles/${a.id}">Открыть</a>`);
      f.push(menu);
      return `<div class="col-md-6 col-xl-4 dcard" data-status="${a.status}"><div class="card h-100">
<div class="card-header py-2 d-flex align-items-center gap-2"><input type="checkbox" class="form-check-input m-0 dsel"> ${statusCell(a)}<span class="ms-auto text-secondary small">#${a.id} · ${esc(a.category || '')}</span></div>
<div class="card-body">
<div class="fw-bold mb-2" style="min-height:2.6em">${ttl(a)}</div>
<div class="small mb-3">${state(a)}</div>
${ed}
</div>
<div class="card-footer py-2"><div class="d-flex flex-wrap gap-1 align-items-center">${f.join('')}</div></div>
</div></div>`;
    };
    // Панель массовых действий НАД карточками: фильтр статусов + выбор → действие → его настройка раскрывается.
    const actBtns = [
      ['cfgPub', '<i class="ti ti-upload"></i> Опубликовать', 'btn-primary', 'сразу опубликовать выбранные на сайте'],
      ['cfgDist', '<i class="ti ti-calendar"></i> Распределить', 'btn-outline-primary', 'расставить время; опубликует планировщик'],
      ['cfgUnsched', '↩ Снять с расписания', 'btn-outline-secondary', 'вернуть в черновики, убрать время'],
      ['cfgAutodel', '<i class="ti ti-clock-hour-4"></i> Автоудаление', 'btn-outline-warning', 'когда снять с сайта автоматически'],
      ['cfgDel', '<i class="ti ti-trash"></i> Удалить с сайта', 'btn-outline-warning', 'снять опубликованные с сайта сейчас'],
      ['cfgDrop', '<i class="ti ti-trash-x"></i> Удалить из БД', 'btn-outline-danger', 'удалить из базы (не трогая сайт)'],
    ];
    const cancel = '<button type="button" class="btn btn-sm btn-link cfgcancel">отмена</button>';
    const dtPair = (timeVal) => `<div class="d-flex gap-1"><input type="date" class="form-control form-control-sm" style="width:8.2rem"><input type="time" class="form-control form-control-sm" value="${timeVal}" style="width:5.6rem"></div>`;
    const dBulk = `<div class="card mb-3 border-primary"><div class="card-body py-2">
<div class="mb-2 d-flex align-items-center gap-3 flex-wrap"><span class="text-secondary small">Показать статусы:</span>${[['draft', 'черновик'], ['scheduled', 'в расписании'], ['published', 'опубликовано'], ['failed', 'ошибка']].map(([v, l]) => `<label class="form-check m-0"><input type="checkbox" class="form-check-input dfil" value="${v}" checked><span class="form-check-label ms-1">${l}</span></label>`).join('')}<span class="text-secondary small ms-auto">часовой пояс: ${esc(tz)}</span></div>
<hr class="my-2">
<div class="d-flex align-items-center gap-2 mb-2 flex-wrap"><label class="form-check m-0"><input type="checkbox" id="dselall" class="form-check-input"><span class="form-check-label ms-1">выбрать все</span></label><span class="badge bg-primary text-white">Выбрано: <span id="dselcount">0</span></span><span class="text-secondary small">— отметь карточки галочками, затем выбери действие ниже</span></div>
<div class="d-flex flex-wrap gap-3 mb-1">${actBtns.map(([id, label, cls, note]) => `<div class="text-center" style="width:9.5rem"><button class="btn btn-sm ${cls} dbtn w-100" data-cfg="${id}" disabled title="${note}">${label}</button><div class="text-secondary mt-1" style="font-size:.72rem;line-height:1.15">${note}</div></div>`).join('')}</div>
<div id="cfgPub" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-upload"></i> Опубликует <b><span class="dn">0</span></b> выбранных на сайте прямо сейчас (через профиль и аккаунт).</div><div class="d-flex gap-2 align-items-end flex-wrap"><div><label class="form-label small mb-1">Аккаунт</label><select class="form-select form-select-sm" style="width:auto">${accOpts}</select></div><button class="btn btn-sm btn-primary">Опубликовать (<span class="dn">0</span>)</button>${cancel}</div></div>
<div id="cfgDist" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-calendar"></i> Расставит время публикации внутри окна; планировщик опубликует их сам в назначенное время.</div><div class="row g-2 align-items-end"><div class="col-auto"><label class="form-label small mb-1">Начало</label>${dtPair('21:00')}</div><div class="col-auto"><label class="form-label small mb-1">Конец</label>${dtPair('09:00')}</div><div class="col-auto"><label class="form-label small mb-1">Режим</label><div class="d-flex gap-1 align-items-center"><select class="form-select form-select-sm" style="width:auto"><option>каждые N мин</option><option>равномерно</option></select><input type="number" class="form-control form-control-sm" value="10" style="width:4.5rem"></div></div><div class="col-auto"><button class="btn btn-sm btn-primary">Распределить (<span class="dn">0</span>)</button>${cancel}</div></div></div>
<div id="cfgUnsched" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2">↩ Уберёт выбранные из расписания и вернёт их в черновики (на сайт не влияет).</div><button class="btn btn-sm btn-outline-secondary">Снять с расписания (<span class="dn">0</span>)</button> ${cancel}</div>
<div id="cfgAutodel" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-clock-hour-4"></i> Задаст время, когда снять выбранные <b>опубликованные</b> статьи с сайта (исполнит планировщик).</div><div class="d-flex gap-2 align-items-end flex-wrap"><div><label class="form-label small mb-1">Удалить в (TZ сайта)</label>${dtPair('09:00')}</div><button class="btn btn-sm btn-outline-warning">Поставить (<span class="dn">0</span>)</button>${cancel}</div></div>
<div id="cfgDel" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-trash"></i> Снимет выбранные <b>опубликованные</b> статьи с сайта прямо сейчас.</div><button class="btn btn-sm btn-outline-warning">Удалить с сайта (<span class="dn">0</span>)</button> ${cancel}</div>
<div id="cfgDrop" class="cfg d-none border rounded p-2 mt-2"><div class="small text-secondary mb-2"><i class="ti ti-trash-x"></i> Удалит выбранные из базы данных. Если они опубликованы — на сайте останутся.</div><button class="btn btn-sm btn-outline-danger">Удалить из БД (<span class="dn">0</span>)</button> ${cancel}</div>
</div></div>`;
    const dScript = `<script>(function(){
function sel(){return Array.prototype.slice.call(document.querySelectorAll('.dsel'));}
var cnt=document.getElementById('dselcount'),all=document.getElementById('dselall');
function closeCfg(){Array.prototype.forEach.call(document.querySelectorAll('.cfg'),function(p){p.classList.add('d-none');});}
function upd(){var s=sel(),n=s.filter(function(c){return c.checked;}).length;if(cnt)cnt.textContent=n;Array.prototype.forEach.call(document.querySelectorAll('.dn'),function(e){e.textContent=n;});Array.prototype.forEach.call(document.querySelectorAll('.dbtn'),function(b){b.disabled=n===0;});if(all)all.checked=(n>0&&n===s.length);if(n===0)closeCfg();}
sel().forEach(function(c){c.addEventListener('change',upd);});
if(all)all.addEventListener('change',function(){sel().forEach(function(c){c.checked=all.checked;});upd();});
Array.prototype.forEach.call(document.querySelectorAll('.dbtn[data-cfg]'),function(btn){btn.addEventListener('click',function(){if(btn.disabled)return;var panel=document.getElementById(btn.dataset.cfg);var open=panel&&!panel.classList.contains('d-none');closeCfg();if(panel&&!open)panel.classList.remove('d-none');});});
Array.prototype.forEach.call(document.querySelectorAll('.cfgcancel'),function(b){b.addEventListener('click',closeCfg);});
function applyFilter(){var on={};Array.prototype.forEach.call(document.querySelectorAll('.dfil'),function(c){on[c.value]=c.checked;});Array.prototype.forEach.call(document.querySelectorAll('.dcard'),function(card){card.style.display=on[card.getAttribute('data-status')]?'':'none';});}
Array.prototype.forEach.call(document.querySelectorAll('.dfil'),function(c){c.addEventListener('change',applyFilter);});
applyFilter();upd();})();</script>`;
    const variantD = `<h2 class="mb-1">ВАРИАНТ D — «Карточки»</h2>
<p class="text-secondary">Сначала <b>фильтр по статусам</b>, затем отмечаешь карточки галочками — и выбираешь действие. Кнопка действия раскрывает <b>только свою настройку</b> (ничего лишнего), под каждой кнопкой — подпись, что она делает. Потыкай: выбери пару карточек и понажимай «Опубликовать» / «Распределить».</p>
${dBulk}
<div class="row row-cards mb-3">${rows.map(dCard).join('')}</div>
${dScript}`;

    const intro = `<div class="alert alert-info">Это <b>макеты для выбора вида</b> управления статьями (на реальных статьях сайта «${esc(site.name)}»). Всё как на текущей странице — те же инлайн-редакторы, аккаунт+«Опубл.», массовые действия — просто разная компоновка. Кнопки декоративные. Скажи, какой блок (A/B/C/D) и какие элементы понравились — соберу финал. <a href="/sites/${sid}?tab=articles">← вернуться к текущему виду</a></div>`;
    const html = intro + collapsedBulk + variantA + '<hr class="my-4">' + variantB + '<hr class="my-4">' + variantC + '<hr class="my-4">' + variantD;
    reply.type('text/html').send(page('/mockups', 'Макеты статей', html));
  });

  // ============================ Анализ ключей (SEMrush) ============================
  const DEFAULT_SEEDS = ['Sportwetten', 'Wettanbieter', 'beste Wettanbieter', 'Sportwetten Bonus', 'Wettbonus', 'Sportwetten Vergleich', 'Buchmacher', 'Online Wetten', 'Wett Tipps', 'Fußball Wetten', 'neue Wettanbieter', 'Sportwetten Österreich', 'Wettanbieter Österreich', 'Quoten Vergleich'];
  const KW_DBS = [['at', 'Австрия (AT)'], ['de', 'Германия (DE)'], ['ch', 'Швейцария (CH)']];
  const smask = (v) => (!v ? '—' : v.length <= 6 ? '•••' : `${v.slice(0, 3)}•••${v.slice(-2)}`);
  const kwBadge = (s) => `<span class="badge ${s === 'done' ? 'bg-green' : s === 'failed' ? 'bg-red' : 'bg-yellow'} text-white">${esc(s)}</span>`;
  const uiLim = (a) => {
    try {
      const l = a.ui_limits ? JSON.parse(a.ui_limits) : null;
      return l ? `UI: ${l.remaining_updates}/${l.max_updates} обн.${l.rows_count ? ` · до ${l.rows_count} строк` : ''}${l.trial_status ? ` · trial ${l.trial_status}` : ''}` : '';
    } catch {
      return '';
    }
  };

  app.get('/research', async (req, reply) => {
    const accs = listSemrushAccounts(db);
    const accRows = accs
      .map((a) => `<tr><td>${a.id}</td><td>${esc(a.label || '-')}</td><td class="text-secondary">${esc(a.email || '-')}</td><td class="text-secondary mono">${esc(smask(a.api_key))}</td><td class="text-secondary mono">${esc((a.proxy || '-').split(':')[0])}</td><td>${a.units_balance != null ? `<span class="badge bg-azure text-white" title="API-юниты · ${esc(a.units_checked_at || '')} UTC">API ${a.units_balance}</span>` : '<span class="text-secondary small">API ?</span>'}${uiLim(a) ? `<div class="small text-secondary mt-1" title="UI-лимиты подписки · ${esc(a.ui_limits_at || '')} UTC">${esc(uiLim(a))}</div>` : ''}</td><td>${a.enabled ? '<span class="badge bg-green text-white">вкл</span>' : '<span class="badge bg-secondary text-white">выкл</span>'}</td>
<td>${a.cookies_updated_at ? `<span class="badge bg-azure text-white" title="${esc(a.cookies_updated_at)} UTC"><i class="ti ti-check"></i> сессия</span>` : '<span class="text-secondary small">нет</span>'}<details class="mt-1"><summary class="small text-secondary" style="cursor:pointer">вставить cookies</summary><form method="post" action="/semrush-accounts/${a.id}/cookies" class="mt-1"><textarea name="cookies" class="form-control form-control-sm mono" rows="3" placeholder="Cookie-Editor JSON для semrush.com (войди вручную → экспортируй cookies)" style="min-width:18rem"></textarea><div class="d-flex gap-1 mt-1"><button class="btn btn-sm btn-primary">Сохранить</button>${a.cookies_updated_at ? `<button formaction="/semrush-accounts/${a.id}/clear-cookies" class="btn btn-sm btn-outline-secondary">сбросить</button>` : ''}</div></form></details></td>
<td><div class="d-flex gap-1"><form method="post" action="/semrush-accounts/${a.id}/refresh-units"><button class="btn btn-sm btn-outline-secondary" title="обновить остаток юнитов">⟳ юниты</button></form><form method="post" action="/semrush-accounts/${a.id}/toggle"><button class="btn btn-sm btn-outline-secondary">${a.enabled ? 'выкл' : 'вкл'}</button></form><form method="post" action="/semrush-accounts/${a.id}/delete" onsubmit="return confirm('Удалить аккаунт?')"><button class="btn btn-sm btn-outline-danger">×</button></form></div></td></tr>`)
      .join('');
    const addAcc = `<form method="post" action="/semrush-accounts" class="row g-2 align-items-end"><div class="col-auto"><label class="form-label small mb-1">Метка</label><input name="label" class="form-control form-control-sm" placeholder="напр. trial-1"></div><div class="col-auto"><label class="form-label small mb-1">Email</label><input name="email" class="form-control form-control-sm"></div><div class="col-auto"><label class="form-label small mb-1">Пароль</label><input name="password" class="form-control form-control-sm"></div><div class="col"><label class="form-label small mb-1">API-ключ</label><input name="api_key" class="form-control form-control-sm" placeholder="для API-драйвера"></div><div class="col-auto"><label class="form-label small mb-1">Прокси (для UI)</label><input name="proxy" class="form-control form-control-sm" placeholder="host:port:user:pass"></div><div class="col-auto"><button class="btn btn-primary">Добавить</button></div></form>`;
    const accountsCard = `<div class="card mb-3" id="accounts"><div class="card-header"><h3 class="card-title"><i class="ti ti-key"></i> SEMrush аккаунты</h3></div><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>id</th><th>метка</th><th>email</th><th>API-ключ</th><th>прокси</th><th>юниты</th><th>статус</th><th>сессия (UI)</th><th></th></tr></thead><tbody>${accRows || '<tr><td colspan="9" class="text-secondary">аккаунтов нет — добавь</td></tr>'}</tbody></table></div><div class="card-footer">${addAcc}</div></div>`;

    const enabled = enabledSemrushAccounts(db);
    const accOpts = enabled.map((a) => `<option value="${a.id}">${esc(a.label || a.email || '#' + a.id)}${a.units_balance != null ? ` (юнитов: ${a.units_balance})` : ''}</option>`).join('') || '<option value="">нет включённых аккаунтов</option>';
    const dbChecks = KW_DBS.map(([v, l]) => `<label class="form-check form-check-inline m-0"><input class="form-check-input" type="checkbox" name="db" value="${v}"${v !== 'ch' ? ' checked' : ''}><span class="form-check-label">${l}</span></label>`).join('');
    const newRun = `<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-bolt"></i> Новый прогон</h3></div><div class="card-body"><form method="post" action="/research">
<div class="row g-2 mb-2"><div class="col-md-4"><label class="form-label small mb-1">Название</label><input name="name" class="form-control form-control-sm" value="Беттинг DACH" required></div><div class="col-md-3"><label class="form-label small mb-1">Источник</label><select name="source" class="form-select form-select-sm"><option value="api">API (юниты)</option><option value="ui">UI через Dolphin (в разработке)</option><option value="auto">Авто</option></select></div><div class="col-md-3"><label class="form-label small mb-1">Аккаунт</label><select name="account" class="form-select form-select-sm">${accOpts}</select></div><div class="col-md-2"><label class="form-label small mb-1">Ключей на seed</label><input name="limit" type="number" class="form-control form-control-sm" value="100" min="10" max="1000"></div></div>
<div class="mb-2"><label class="form-label small mb-1">Базы</label><div>${dbChecks}</div></div>
<div class="mb-2"><label class="form-label small mb-1">Seed-слова (по одному в строке)</label><textarea name="seeds" class="form-control form-control-sm mono" rows="6">${esc(DEFAULT_SEEDS.join('\n'))}</textarea></div>
<div class="d-flex align-items-center gap-3"><label class="form-check m-0"><input type="checkbox" name="analyze" class="form-check-input" checked><span class="form-check-label ms-1">анализ Claude (платно)</span></label><button class="btn btn-primary">Запустить прогон</button><span class="text-secondary small">SEMrush-юниты тратятся; KD только по топу.</span></div>
</form></div></div>`;

    const runs = db.prepare('SELECT r.*, a.label acc_label, (SELECT COUNT(*) FROM kw_keywords k WHERE k.run_id = r.id) kw FROM kw_runs r LEFT JOIN semrush_accounts a ON a.id = r.account_id ORDER BY r.id DESC LIMIT 100').all();
    const runRows = runs
      .map((r) => `<tr><td>${r.id}</td><td><a href="/research/${r.id}">${esc(r.name || 'Прогон ' + r.id)}</a></td><td>${esc(r.source)}</td><td class="text-secondary">${esc(r.acc_label || '-')}</td><td>${kwBadge(r.status)}</td><td>${r.kw}</td><td class="text-secondary">${r.units_used || 0}</td><td class="text-secondary" style="white-space:nowrap">${esc(r.created_at)}</td></tr>`)
      .join('');
    const runsCard = tableCard('<i class="ti ti-flask"></i> Прогоны', ['id', 'название', 'источник', 'аккаунт', 'статус', 'ключей', 'юниты', 'создан'], runRows, 'runs');

    reply.type('text/html').send(page('/research', 'Анализ ключей', accountsCard + newRun + runsCard, { flash: flash(req.query) }));
  });

  app.post('/research', async (req, reply) => {
    const b = req.body;
    const seeds = String(b.seeds || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const dbs = (Array.isArray(b.db) ? b.db : [b.db]).filter(Boolean);
    if (!seeds.length || !dbs.length) return reply.redirect(`/research?msg=${encodeURIComponent('Укажи seed-слова и хотя бы одну базу')}`);
    const source = ['api', 'ui', 'auto'].includes(b.source) ? b.source : 'api';
    const accountId = b.account ? Number(b.account) : null;
    const limit = Math.max(10, Math.min(1000, Number(b.limit) || 100));
    const analyze = !!b.analyze;
    const runId = db.prepare("INSERT INTO kw_runs (name, direction, source, seeds, databases, account_id, status) VALUES (?, 'betting-DACH', ?, ?, ?, ?, 'running')").run(b.name || 'Прогон', source, JSON.stringify(seeds), JSON.stringify(dbs), accountId).lastInsertRowid;
    const jobId = createJob('research', {});
    logJob(jobId, `Старт анализа: ${dbs.join('/')} × ${seeds.length} seed (источник ${source})`);
    withTimeout(runKeywordResearch(db, { runId, limit, analyze, onStep: (m) => logJob(jobId, m) }), 900000, 'анализ')
      .then((res) => finishJob(jobId, { ok: true, message: `Ключей ${res.keywords}, юнитов ~${res.unitsUsed}` }))
      .catch((e) => {
        db.prepare("UPDATE kw_runs SET status = 'failed' WHERE id = ?").run(runId);
        finishJob(jobId, { ok: false, message: e.message });
      });
    reply.redirect(`/jobs/${jobId}`);
  });

  app.get('/research/:id', async (req, reply) => {
    const run = db.prepare('SELECT * FROM kw_runs WHERE id = ?').get(req.params.id);
    if (!run) return reply.code(404).send('нет');
    // Инлайним ограниченное число строк (огромный JSON в HTML блокирует event loop и раздувает страницу).
    // Полный список — в CSV-экспорте.
    const INLINE_CAP = Number(process.env.RESEARCH_INLINE_CAP || 1500);
    const good = db.prepare('SELECT id, phrase, database, volume, kd, intent, cpc, score FROM kw_keywords WHERE run_id = ? AND rejected = 0 ORDER BY score DESC, volume DESC LIMIT ?').all(run.id, INLINE_CAP);
    const bad = db.prepare('SELECT id, phrase, database, volume, reject_reason FROM kw_keywords WHERE run_id = ? AND rejected = 1 ORDER BY volume DESC LIMIT ?').all(run.id, INLINE_CAP);
    const goodTotal = db.prepare('SELECT COUNT(*) c FROM kw_keywords WHERE run_id = ? AND rejected = 0').get(run.id).c;
    const badTotal = db.prepare('SELECT COUNT(*) c FROM kw_keywords WHERE run_id = ? AND rejected = 1').get(run.id).c;
    const truncNote = goodTotal > INLINE_CAP || badTotal > INLINE_CAP ? `<div class="alert alert-info py-2">Показаны первые ${INLINE_CAP} из ${goodTotal} подходящих${badTotal > INLINE_CAP ? ` и ${INLINE_CAP} из ${badTotal} отклонённых` : ''}. Полный список — в <a href="/research/${run.id}/export.csv?all=1">CSV</a>.</div>` : '';
    // в скольких списках уже есть каждый ключ (по фразе+базе)
    const memRows = db.prepare('SELECT i.phrase, i.database, COUNT(DISTINCT i.list_id) c, GROUP_CONCAT(DISTINCT l.name) names FROM kw_list_items i JOIN kw_lists l ON l.id = i.list_id GROUP BY i.phrase, i.database').all();
    const memMap = {};
    for (const r of memRows) memMap[`${r.phrase} ${r.database || ''}`] = { c: r.c, n: r.names };
    const ann = (k) => {
      const m = memMap[`${k.phrase} ${k.database || ''}`];
      return { ...k, m: m ? m.c : 0, mn: m ? m.n : '' };
    };
    const analysisCard = run.analysis
      ? card('<i class="ti ti-bulb"></i> Шорт-лист (Claude)', `<div style="white-space:pre-wrap">${esc(run.analysis)}</div>`)
      : run.status === 'running'
        ? '<div class="alert alert-info">Прогон ещё идёт — обнови позже (см. <a href="/jobs">Задачи</a>).</div>'
        : '';
    const listOptsJson = listLists(db).map((l) => `<option value="${l.id}">${esc(l.name)} (${l.items})</option>`).join('');
    const head = `<div class="mb-2 text-secondary">Источник: ${esc(run.source)} · статус: ${kwBadge(run.status)} · юнитов ~${run.units_used || 0} · <a href="/research/${run.id}/export.csv">экспорт CSV (${goodTotal})</a> · <a href="/research/${run.id}/export.csv?all=1">все+причины</a></div>`;
    const J = (x) => JSON.stringify(x).replace(/</g, '\\u003c');
    const dataScript = `<script>window.__GOOD=${J(good.map(ann))};window.__BAD=${J(bad.map(ann))};window.__LISTOPTS=${J(listOptsJson)};window.__RUNID=${run.id};</script>`;
    reply.type('text/html').send(page('/research', run.name || `Прогон ${run.id}`, head + truncNote + analysisCard + '<div id="kwgood"></div><div id="kwbad"></div>' + dataScript + KW_TABLE_SCRIPT, { navLeft: '<a href="/research" class="text-decoration-none">← Анализ</a>', flash: flash(req.query) }));
  });

  app.get('/research/:id/export.csv', async (req, reply) => {
    // По умолчанию — только хорошие; ?all=1 — все (с причиной отклонения).
    const all = req.query.all === '1';
    const where = all ? '' : ' AND rejected = 0';
    const kws = db.prepare(`SELECT database, phrase, volume, kd, intent, cpc, competition, results, score, rejected, reject_reason FROM kw_keywords WHERE run_id = ?${where} ORDER BY rejected, score DESC`).all(req.params.id);
    const head = 'database;phrase;volume;kd;intent;cpc;competition;results;score' + (all ? ';rejected;reject_reason' : '');
    const lines = kws.map((k) => {
      const base = [k.database, String(k.phrase).replace(/;/g, ','), k.volume ?? '', k.kd ?? '', k.intent ?? '', k.cpc ?? '', k.competition ?? '', k.results ?? '', k.score ?? ''];
      if (all) base.push(k.rejected, String(k.reject_reason || '').replace(/;/g, ','));
      return base.join(';');
    });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="research-${req.params.id}${all ? '-all' : ''}.csv"`).send([head, ...lines].join('\n'));
  });

  app.post('/semrush-accounts', async (req, reply) => {
    addSemrushAccount(db, req.body);
    reply.redirect('/research#accounts');
  });
  app.post('/semrush-accounts/:id/toggle', async (req, reply) => {
    toggleSemrushAccount(db, Number(req.params.id));
    reply.redirect('/research#accounts');
  });
  app.post('/semrush-accounts/:id/delete', async (req, reply) => {
    removeSemrushAccount(db, Number(req.params.id));
    reply.redirect('/research#accounts');
  });
  app.post('/semrush-accounts/:id/cookies', async (req, reply) => {
    let msg;
    try {
      const n = saveAccountCookiesText(db, Number(req.params.id), String(req.body.cookies || ''));
      msg = `Сессия сохранена: ${n} cookies`;
    } catch (e) {
      msg = 'Ошибка: ' + e.message;
    }
    reply.redirect(`/research?msg=${encodeURIComponent(msg)}#accounts`);
  });
  app.post('/semrush-accounts/:id/clear-cookies', async (req, reply) => {
    clearSemrushCookies(db, Number(req.params.id));
    reply.redirect('/research?msg=' + encodeURIComponent('Сессия сброшена') + '#accounts');
  });
  app.post('/semrush-accounts/:id/refresh-units', async (req, reply) => {
    const a = db.prepare('SELECT api_key FROM semrush_accounts WHERE id = ?').get(req.params.id);
    let msg = 'нет API-ключа';
    if (a?.api_key) {
      const u = await unitsBalance(a.api_key);
      setUnitsBalance(db, Number(req.params.id), u);
      msg = u != null ? `остаток юнитов: ${u}` : 'не удалось получить остаток';
    }
    reply.redirect(`/research?msg=${encodeURIComponent(msg)}#accounts`);
  });

  // ============================ Списки ключей (база) ============================
  const ITEM_RU = { new: 'новый', testing: 'в тесте', winner: 'зашёл', loser: 'не зашёл', skip: 'пропуск' };
  const itemBadge = (s) => `<span class="badge ${s === 'winner' ? 'bg-green' : s === 'loser' ? 'bg-red' : s === 'testing' ? 'bg-azure' : s === 'skip' ? 'bg-secondary' : 'bg-yellow'} text-white">${ITEM_RU[s] || s}</span>`;

  app.get('/lists', async (req, reply) => {
    const lists = listLists(db);
    const rows = lists
      .map((l) => `<tr><td>${l.id}</td><td><a href="/lists/${l.id}">${esc(l.name)}</a></td><td>${l.items}</td><td class="small">${itemBadge('new')} ${l.c_new} · ${itemBadge('testing')} ${l.c_testing} · ${itemBadge('winner')} ${l.c_winner} · ${itemBadge('loser')} ${l.c_loser}</td><td class="text-secondary" style="white-space:nowrap">${esc(l.created_at)}</td><td><form method="post" action="/lists/${l.id}/delete" onsubmit="return confirm('Удалить список?')"><button class="btn btn-sm btn-outline-danger">×</button></form></td></tr>`)
      .join('');
    const create = `<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-plus"></i> Новый список</h3></div><div class="card-body"><form method="post" action="/lists" class="row g-2 align-items-end"><div class="col-md-6"><label class="form-label small mb-1">Название</label><input name="name" class="form-control form-control-sm" placeholder="напр. DACH беттинг — первая сотня" required></div><div class="col-auto"><button class="btn btn-primary">Создать</button></div></form></div></div>`;
    reply.type('text/html').send(page('/lists', 'Списки ключей', create + tableCard('<i class="ti ti-folder"></i> Списки', ['id', 'название', 'ключей', 'статусы', 'создан', ''], rows, 'lists'), { flash: flash(req.query) }));
  });

  app.post('/lists', async (req, reply) => {
    const id = createList(db, req.body.name, req.body.notes);
    reply.redirect(`/lists/${id}`);
  });
  app.post('/lists/:id/delete', async (req, reply) => {
    removeList(db, Number(req.params.id));
    reply.redirect('/lists');
  });

  app.get('/lists/:id', async (req, reply) => {
    const list = getList(db, req.params.id);
    if (!list) return reply.code(404).send('нет');
    const status = ITEM_STATUSES.includes(req.query.status) ? req.query.status : null;
    const items = listItems(db, list.id, status);
    const prompts = db.prepare('SELECT id, name, site_id FROM prompts WHERE hidden = 0 ORDER BY site_id, id').all();
    const promptOpts = prompts.map((p) => `<option value="${p.id}">${esc(p.name || 'Промт ' + p.id)}</option>`).join('') || '<option value="">нет промтов</option>';
    const lb = process.env.CLAUDE_BACKEND === 'cli' ? 'cli' : 'api';
    const backendSel = `<select name="backend" class="form-select form-select-sm" style="width:auto" title="Движок генерации"><option value="api"${lb === 'api' ? ' selected' : ''}>API</option><option value="cli"${lb === 'cli' ? ' selected' : ''}>Тариф</option></select>`;
    const rows = items
      .map(
        (it) => `<tr><td>${esc(it.phrase)}</td><td>${esc(it.database || '-')}</td><td>${it.volume ?? '-'}</td><td>${it.kd ?? '-'}</td><td><b>${it.score ?? '-'}</b></td><td>${itemBadge(it.status)}</td><td>${it.article_id ? `<a href="/articles/${it.article_id}">#${it.article_id}</a>` : '<span class="text-secondary">—</span>'}</td>
<td><div class="d-flex gap-1 flex-wrap">${it.article_id ? '' : `<form method="post" action="/lists/items/${it.id}/generate" class="d-flex gap-1"><select name="prompt" class="form-select form-select-sm" style="width:auto">${promptOpts}</select>${backendSel}<button class="btn btn-sm btn-primary" onclick="return confirm('Сгенерировать статью под ключ?')">Сген.</button></form>`}<form method="post" action="/lists/items/${it.id}/status"><input type="hidden" name="status" value="winner"><button class="btn btn-sm btn-outline-success" title="зашёл"><i class="ti ti-check"></i></button></form><form method="post" action="/lists/items/${it.id}/status"><input type="hidden" name="status" value="loser"><button class="btn btn-sm btn-outline-danger" title="не зашёл"><i class="ti ti-x"></i></button></form><form method="post" action="/lists/items/${it.id}/status"><input type="hidden" name="status" value="skip"><button class="btn btn-sm btn-outline-secondary" title="пропуск"><i class="ti ti-player-skip-forward"></i></button></form><form method="post" action="/lists/items/${it.id}/remove" onsubmit="return confirm('Убрать из списка?')"><button class="btn btn-sm btn-outline-secondary" title="убрать из списка"><i class="ti ti-trash"></i></button></form></div></td></tr>`,
      )
      .join('');
    const addCard = `<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-clipboard-plus"></i> Добавить ключи вручную</h3></div><div class="card-body"><form method="post" action="/lists/${list.id}/add-manual"><div class="mb-2"><textarea name="keywords" class="form-control" rows="6" placeholder="1 строка = 1 ключ" required></textarea><div class="form-hint">Каждый ключ с новой строки. Пустые строки и повторы пропускаются.</div></div><button class="btn btn-primary"><i class="ti ti-plus"></i> Добавить в список</button></form></div></div>`;
    const filter = `<div class="mb-2 d-flex gap-1 flex-wrap"><a href="/lists/${list.id}" class="btn btn-sm ${!status ? 'btn-primary' : 'btn-outline-secondary'}">все</a>${ITEM_STATUSES.map((s) => `<a href="/lists/${list.id}?status=${s}" class="btn btn-sm ${status === s ? 'btn-primary' : 'btn-outline-secondary'}">${ITEM_RU[s]}</a>`).join('')}</div>`;
    reply.type('text/html').send(page('/lists', list.name, addCard + filter + tableCard(`<i class="ti ti-key"></i> Ключи списка (${items.length})`, ['ключ', 'база', 'объём', 'KD%', 'score', 'статус', 'статья', 'действия'], rows, 'items'), { navLeft: '<a href="/lists" class="text-decoration-none">← Списки</a>', flash: flash(req.query) }));
  });

  app.post('/lists/add', async (req, reply) => {
    const b = req.body;
    const ids = (Array.isArray(b.ids) ? b.ids : [b.ids]).filter(Boolean);
    let listId = b.list ? Number(b.list) : null;
    if (b.new_list && String(b.new_list).trim()) listId = createList(db, b.new_list);
    if (!listId || !ids.length) return reply.redirect(backTo(b.from, 'Выбери список и хотя бы один ключ'));
    const n = addKeywordsToList(db, listId, ids);
    reply.redirect(`/lists/${listId}?msg=${encodeURIComponent(`Добавлено в список: ${n}`)}`);
  });

  app.post('/lists/:id/add-manual', async (req, reply) => {
    const list = getList(db, req.params.id);
    if (!list) return reply.code(404).send('нет');
    const { added, total } = addManualKeywordsToList(db, list.id, req.body.keywords);
    const msg = total
      ? `Добавлено ключей: ${added}${added < total ? ` (пропущено дублей: ${total - added})` : ''}`
      : 'Не распознано ни одного ключа';
    reply.redirect(`/lists/${list.id}?msg=${encodeURIComponent(msg)}`);
  });

  app.post('/lists/items/:id/status', async (req, reply) => {
    setItemStatus(db, Number(req.params.id), req.body.status);
    const it = getItem(db, req.params.id);
    reply.redirect(`/lists/${it?.list_id || ''}`);
  });
  app.post('/lists/items/:id/remove', async (req, reply) => {
    const it = getItem(db, req.params.id);
    removeItem(db, Number(req.params.id));
    reply.redirect(`/lists/${it?.list_id || ''}`);
  });
  app.post('/lists/items/:id/generate', async (req, reply) => {
    const item = getItem(db, req.params.id);
    if (!item) return reply.code(404).send('нет');
    const prompt = db.prepare('SELECT id, site_id FROM prompts WHERE id = ?').get(req.body.prompt);
    if (!prompt) return reply.redirect(`/lists/${item.list_id}?msg=${encodeURIComponent('Выбери промт')}`);
    const backend = req.body.backend === 'cli' ? 'cli' : 'api';
    const jobId = createJob('generate', { siteId: prompt.site_id });
    logJob(jobId, `Старт: генерация под ключ «${item.phrase}» (${backend === 'cli' ? 'подписка/CLI' : 'API'})`);
    withTimeout(generateArticleForSite(db, { siteId: prompt.site_id, promptId: prompt.id, keyword: item.phrase, backend, onStep: (m) => logJob(jobId, m) }), 300000, 'генерация')
      .then((res) => {
        linkItemArticle(db, item.id, res.id);
        finishJob(jobId, { ok: true, articleId: res.id, message: res.title });
      })
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  // Массовая генерация по списку: берёт N ещё не использованных (status='new') ключей, генерит под каждый статью.
  // Ключи списка с метриками + трафиком/позициями (JSON) — для таблицы выбора в генерации.
  app.get('/lists/:id/keys', async (req, reply) => {
    const list = getList(db, Number(req.params.id));
    if (!list) return reply.code(404).send({ error: 'нет списка' });
    reply.send({ name: list.name, items: listItemsWithStats(db, list.id) });
  });

  app.post('/lists/bulk-generate', async (req, reply) => {
    const b = req.body;
    const prompt = db.prepare('SELECT id, site_id FROM prompts WHERE id = ?').get(b.prompt);
    const list = getList(db, b.list);
    if (!prompt || !list) return reply.redirect(`/lists?msg=${encodeURIComponent('Выбери список и промт')}`);
    const backend = b.backend === 'cli' ? 'cli' : 'api';
    // Генерируем по ВЫБРАННЫМ ключам (любого статуса — для периодической регенерации и нового захода в топ).
    // Фолбэк (если ids не передали): top-N «новых» по count — на случай старых форм/скриптов.
    const raw = b.ids;
    const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(Number).filter(Boolean);
    let items;
    if (ids.length) {
      items = db.prepare(`SELECT * FROM kw_list_items WHERE list_id = ? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY score DESC`).all(list.id, ...ids);
    } else {
      const n = Math.max(1, Math.min(50, Number(b.count) || 10));
      items = db.prepare("SELECT * FROM kw_list_items WHERE list_id = ? AND status = 'new' ORDER BY score DESC LIMIT ?").all(list.id, n);
    }
    if (!items.length) return reply.redirect(`/lists/${list.id}?msg=${encodeURIComponent('Не выбрано ни одного ключа')}`);
    const jobId = createJob('generate', { siteId: prompt.site_id });
    logJob(jobId, `Старт: генерация ${items.length} статей по списку «${list.name}» (промт #${prompt.id}, ${backend === 'cli' ? 'подписка/CLI' : 'API'})`);
    (async () => {
      let ok = 0;
      let fail = 0;
      let stopped = false;
      const done = [];
      for (let i = 0; i < items.length; i++) {
        if (isJobCancelled(jobId)) { stopped = true; break; }
        const it = items[i];
        logJob(jobId, `── [${i + 1}/${items.length}] ключ «${it.phrase}» ──`);
        try {
          const res = await withTimeout(generateArticleForSite(db, { siteId: prompt.site_id, promptId: prompt.id, keyword: it.phrase, backend, onStep: (m) => logJob(jobId, m) }), 300000, 'генерация');
          linkItemArticle(db, it.id, res.id);
          ok++;
          done.push(res.id);
        } catch (e) {
          logJob(jobId, `сбой «${it.phrase}»: ${e.message}`);
          fail++;
        }
      }
      finishJob(jobId, { ok: !stopped && fail === 0, stopped, message: `${stopped ? 'Остановлено. ' : ''}Сгенерировано ${ok} из ${items.length}${fail ? `, ошибок ${fail}` : ''}`, result: { kind: 'generate', ids: done } });
    })().catch((e) => { try { finishJob(jobId, { ok: false, message: 'Сбой задачи: ' + e.message }); } catch {} });
    reply.redirect(`/jobs/${jobId}`);
  });

  // Реестр использованных ключей сайта (из articles.keyword) — задел под Binom.
  app.get('/sites/:id/keywords', async (req, reply) => {
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(req.params.id);
    if (!site) return reply.code(404).send('нет');
    const rows = db
      .prepare(
        `SELECT keyword, COUNT(*) n,
          SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) pub,
          SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) sch,
          SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) drf,
          GROUP_CONCAT(tracking_id) tids
         FROM articles WHERE site_id = ? AND keyword IS NOT NULL AND keyword <> '' GROUP BY keyword ORDER BY n DESC, MAX(id) DESC`,
      )
      .all(site.id);
    const tr = rows
      .map((r) => {
        const tidLinks = (r.tids || '')
          .split(',')
          .filter(Boolean)
          .map((t) => `<a href="/articles/find?tid=${encodeURIComponent(t)}" class="text-decoration-none" title="Открыть статью">${esc(t)}</a>`)
          .join(', ');
        return `<tr><td>${esc(r.keyword)}</td><td>${r.n}</td><td class="text-secondary small">${r.pub || 0} / ${r.sch || 0} / ${r.drf || 0}</td><td class="mono small" style="max-width:24rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.tids || '')}">${tidLinks}</td><td class="text-secondary">—</td></tr>`;
      })
      .join('');
    const note = `<div class="text-secondary small mb-2">Ключи, под которые делали статьи на сайте. Столбец «клики» заполнится при подключении Binom (по s1 = tracking_id). Трафик по ключам — на <a href="/stats?site=${site.id}">странице статистики</a>.</div>`;
    reply.type('text/html').send(page('/sites', `Ключи сайта · ${site.name}`, note + tableCard(`<i class="ti ti-key"></i> Использованные ключи (${rows.length})`, ['ключ', 'статей', 'опубл/распис/чрнвк', 'tracking_id (Binom s1)', 'клики'], tr, 'sitekw'), { navLeft: `<a href="/sites/${site.id}" class="text-decoration-none">← Сайт</a>`, flash: flash(req.query) }));
  });

  // Старый per-site адрес → единый раздел статистики.
  app.get('/sites/:id/stats', async (req, reply) => reply.redirect(`/stats?site=${Number(req.params.id)}`));

  // ===== Раздел «Статистика» (Content-Cockpit): по ключам и по статьям, с сортировкой/фильтрами =====
  app.get('/stats', async (req, reply) => {
    const sites = db.prepare('SELECT id, name, timezone FROM sites ORDER BY id').all();
    if (!sites.length) return reply.type('text/html').send(page('/stats', 'Статистика', '<div class="text-secondary">Сначала добавь сайт.</div>', { flash: flash(req.query) }));
    const wanted = Number(req.query.site);
    const site = sites.find((s) => s.id === wanted) || db.prepare('SELECT id, name, timezone FROM sites WHERE active = 1 ORDER BY id LIMIT 1').get() || sites[0];
    const tz = site.timezone || 'Europe/Vienna';
    const kw = keywordStats(db, site.id);
    const arts = articleStatsRows(db, site.id);
    const ranks = latestRanks(db, site.id); // Map(article_id -> {at,de,ch})
    const tsv = (s) => (s ? parseStamp(s) || 0 : 0); // UTC-строка → epoch для сортировки

    // По ключам (числовые ячейки несут data-v для надёжной сортировки; строка — data-search для поиска).
    const kwTr = kw
      .map((r) => {
        const seo = r.seo_views || 0;
        const tot = r.total_views || 0;
        const pct = r.best_percentile;
        const liveN = r.live || 0;
        const archN = r.archived || 0;
        const stCell = [liveN ? `<span class="text-green small">${liveN} на сайте</span>` : null, archN ? `<span class="text-secondary small">${archN} в архиве</span>` : null].filter(Boolean).join(' · ');
        return `<tr data-search="${esc((r.keyword || '').toLowerCase())}" data-seo="${seo}" data-live="${liveN}" data-arch="${archN}"><td>${esc(r.keyword)}</td><td data-v="${r.articles || 0}">${r.articles || 0}${stCell ? ` <span class="text-secondary small">(${stCell})</span>` : ''}</td><td data-v="${tot}"><b>${tot}</b></td><td data-v="${seo}" class="${seo ? 'text-green' : 'text-secondary'}"><b>${seo}</b></td><td data-v="${pct == null ? -1 : pct}">${pct != null ? pct + ' %' : '—'}</td><td data-v="${tsv(r.last_captured)}" class="text-secondary small" style="white-space:nowrap">${r.last_captured ? esc(fmtInTz(r.last_captured, tz)) : '—'}</td></tr>`;
      })
      .join('');
    // По статьям.
    const artTr = arts
      .map((a) => {
        const ch = [a.social_views ? `соц:${a.social_views}` : null, a.curated_views ? `кур:${a.curated_views}` : null, a.newsletter_views ? `нл:${a.newsletter_views}` : null, a.qr_views ? `qr:${a.qr_views}` : null, a.rest_views ? `проч:${a.rest_views}` : null].filter(Boolean).join(' ') || '—';
        const status = a.status === 'published' && !a.site_deleted_at ? 'live' : a.site_deleted_at ? 'removed' : 'other';
        const seo = a.seo_views;
        const rk = ranks.get(a.id) || {};
        return `<tr data-search="${esc(((a.keyword || '') + ' ' + (a.title || '')).toLowerCase())}" data-seo="${seo || 0}" data-status="${status}"><td><a href="/articles/${a.id}">${esc((a.title || '').slice(0, 70))}</a></td><td>${a.keyword ? `<span class="badge bg-yellow text-dark">${esc(a.keyword)}</span>` : '<span class="text-secondary">—</span>'}</td><td data-v="${status === 'live' ? 1 : 0}">${status === 'removed' ? '<span class="badge bg-secondary text-white">архив</span>' : badge(a.status)}</td>${rankCell(rk.at)}${rankCell(rk.de)}${rankCell(rk.ch)}<td data-v="${a.total_views ?? -1}"><b>${a.total_views ?? '—'}</b></td><td data-v="${seo ?? -1}" class="${seo ? 'text-green' : ''}">${seo ?? '—'}</td><td class="text-secondary small">${ch}</td><td data-v="${a.percentile ?? -1}">${a.percentile != null ? a.percentile + ' %' : '—'}</td><td data-v="${a.avg_time_on_page ?? -1}">${fmtDur(a.avg_time_on_page)}</td><td data-v="${tsv(a.captured_at)}" class="text-secondary small" style="white-space:nowrap">${a.captured_at ? esc(fmtInTz(a.captured_at, tz)) : '—'}</td></tr>`;
      })
      .join('');

    const sortHead = (heads) => `<thead><tr>${heads.map((h) => `<th data-sortable role="button">${h}</th>`).join('')}</tr></thead>`;
    const statTable = (title, heads, rowsHtml, id) =>
      `<div class="card mb-3" id="${id}"><div class="card-header"><h3 class="card-title">${title}</h3></div><div class="table-responsive stats-tbl-wrap"><table class="table table-vcenter card-table js-stats">${sortHead(heads)}<tbody>${rowsHtml || `<tr><td colspan="${heads.length}" class="text-secondary">нет данных — нажми «Обновить статистику»</td></tr>`}</tbody></table></div></div>`;
    // Заголовки колонок «прилипают» к верху экрана при прокрутке (удобно для скриншотов). У .table-responsive
    // overflow-x:auto делает контейнер вертикальным скролл-портом и ломает sticky → снимаем overflow у этих таблиц.
    const stickyCss = `<style>
.stats-tbl-wrap{overflow:visible}
.js-stats thead th{position:sticky;top:0;z-index:3;background:var(--tblr-bg-surface,#fff);box-shadow:inset 0 -1px 0 var(--tblr-border-color,#dee2e6)}
</style>`;

    const liveCount = arts.filter((a) => a.status === 'published' && !a.site_deleted_at).length;
    const archCount = arts.filter((a) => a.site_deleted_at).length;
    const statusChips = `<div class="btn-group btn-group-sm" role="group" id="st-status-group" aria-label="Фильтр по статусу (таблица «По статьям»)">
<button type="button" data-st="all" class="btn btn-primary">Все (${arts.length})</button>
<button type="button" data-st="live" class="btn btn-outline-secondary">Опубликованные (${liveCount})</button>
<button type="button" data-st="removed" class="btn btn-outline-secondary">Архив (${archCount})</button>
</div>`;
    const siteSel = sites.length > 1 ? `<select class="form-select" style="width:auto" onchange="location.href='/stats?site='+this.value">${sites.map((s) => `<option value="${s.id}"${s.id === site.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : `<span class="fw-bold">${esc(site.name)}</span>`;
    const collectBtn = `<form method="post" action="/sites/${site.id}/stats/collect" class="mb-0" onsubmit="return confirm('Собрать статистику по всем опубликованным статьям сайта через Dolphin? Реальные запросы к сайту.')"><button class="btn btn-primary"><i class="ti ti-refresh"></i> Обновить статистику</button></form>`;
    const rankBtn = `<form method="post" action="/sites/${site.id}/ranks/check" class="mb-0" onsubmit="return confirm('Проверить позиции в Google (DACH) по всем живым статьям сайта? Реальные запросы через Dolphin/прокси.')"><button class="btn btn-outline-primary"><i class="ti ti-target-arrow"></i> Проверить позиции (DACH)</button></form>`;
    const toolbar = `<div class="card mb-3"><div class="card-body d-flex flex-wrap gap-2 align-items-center">${siteSel}${statusChips}<input id="st-q" class="form-control" style="max-width:18rem" placeholder="поиск по ключу/заголовку"><label class="form-check form-switch mb-0 ms-1"><input id="st-seo" class="form-check-input" type="checkbox"><span class="form-check-label">только с трафиком из поиска</span></label><div class="ms-auto d-flex gap-2">${rankBtn}${collectBtn}</div></div></div>`;
    const note = '<div class="text-secondary small mb-2">Источник — Content-Cockpit («Analyse und Benchmark»). «Из поиска» = органический трафик (Suchmaschine); так как 1 статья = 1 ключ, это трафик по ключу. По умолчанию отсортировано по органике. Клик по заголовку колонки — сортировка. Снимки: ежедневно планировщиком, кнопкой и перед удалением статьи.</div>';

    const script = `<script>
(function(){
  var stStatus="all"; // выбранный фильтр статуса (чипы «Все/Опубликованные/Архив»); влияет на таблицу «По статьям»
  function val(td){ var v=td.getAttribute("data-v"); return v!==null?parseFloat(v):(td.textContent||"").trim().toLowerCase(); }
  function applyFilters(){
    var q=(document.getElementById("st-q").value||"").trim().toLowerCase();
    var seoOnly=document.getElementById("st-seo").checked;
    var st=stStatus;
    document.querySelectorAll("table.js-stats tbody tr").forEach(function(tr){
      if(!tr.getAttribute("data-search")&&tr.cells.length===1){ return; }
      var ok=true;
      if(q && (tr.getAttribute("data-search")||"").indexOf(q)<0) ok=false;
      if(seoOnly && parseFloat(tr.getAttribute("data-seo")||"0")<=0) ok=false;
      if(st!=="all"){
        var ds=tr.getAttribute("data-status");
        if(ds){ // строка статьи: точное совпадение статуса
          if(ds!==st) ok=false;
        } else if(tr.hasAttribute("data-live")){ // строка ключа (агрегат): по наличию живых/архивных статей
          var lv=parseInt(tr.getAttribute("data-live")||"0",10), ar=parseInt(tr.getAttribute("data-arch")||"0",10);
          if(st==="live" && lv<=0) ok=false;
          if(st==="removed" && ar<=0) ok=false;
        }
      }
      tr.style.display=ok?"":"none";
    });
  }
  function sortTable(table, idx, dir){
    var tb=table.tBodies[0]; var rows=[].slice.call(tb.rows).filter(function(r){return r.cells.length>1;});
    rows.sort(function(a,b){
      var x=val(a.cells[idx]), y=val(b.cells[idx]);
      if(typeof x==="number"&&typeof y==="number") return dir*(x-y);
      return dir*String(x).localeCompare(String(y));
    });
    rows.forEach(function(r){ tb.appendChild(r); });
  }
  document.querySelectorAll("table.js-stats thead th[data-sortable]").forEach(function(th){
    th.addEventListener("click",function(){
      var table=th.closest("table"); var idx=[].indexOf.call(th.parentNode.children, th);
      var dir=th.getAttribute("data-dir")==="1"?-1:1;
      table.querySelectorAll("th").forEach(function(o){o.removeAttribute("data-dir"); var s=o.querySelector(".st-arr"); if(s)s.remove();});
      th.setAttribute("data-dir", dir===1?"1":"-1");
      var arr=document.createElement("span"); arr.className="st-arr text-secondary"; arr.textContent=dir===1?" \\u25B2":" \\u25BC"; th.appendChild(arr);
      sortTable(table, idx, dir);
    });
  });
  ["st-q","st-seo"].forEach(function(id){ var el=document.getElementById(id); if(el){ el.addEventListener("input",applyFilters); el.addEventListener("change",applyFilters); } });
  // Чипы статуса: активная — синяя, остальные — контурные; фильтруют таблицу «По статьям».
  var grp=document.getElementById("st-status-group");
  if(grp){ grp.querySelectorAll("button[data-st]").forEach(function(b){ b.addEventListener("click",function(){
    stStatus=b.getAttribute("data-st");
    grp.querySelectorAll("button[data-st]").forEach(function(o){ o.className="btn "+(o===b?"btn-primary":"btn-outline-secondary"); });
    applyFilters();
  }); }); }
  applyFilters();
})();
</script>`;

    const body = `${stickyCss}${note}${toolbar}${statTable('<i class="ti ti-key"></i> По ключам', ['ключ', 'статей', 'всего просм.', 'из поиска', 'лучший перцентиль', 'обновлено'], kwTr, 'kwstats')}${statTable('<i class="ti ti-article"></i> По статьям', ['статья', 'ключ', 'статус', 'AT', 'DE', 'CH', 'всего', 'поиск', 'каналы', 'перцентиль', 'ср. время', 'снимок'], artTr, 'artstats')}${script}`;
    reply.type('text/html').send(page('/stats', `Статистика · ${site.name}`, body, { flash: flash(req.query) }));
  });

  app.post('/sites/:id/stats/collect', async (req, reply) => {
    const siteId = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(siteId)) return reply.code(404).send('нет');
    const jobId = createJob('stats', { siteId });
    logJob(jobId, 'Старт: сбор статистики по всем опубликованным статьям сайта.');
    withTimeout(collectStatsForSite(db, siteId, { reason: 'manual', onStep: (m) => logJob(jobId, m) }), STATS_TIMEOUT_MS, 'сбор статистики')
      .then((r) => finishJob(jobId, { ok: r.fail === 0, message: r.skipped ? 'Адаптер сайта не умеет собирать статистику' : `Собрано ${r.ok}, ошибок ${r.fail} из ${r.total}` }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  app.post('/articles/:id/collect-stats', async (req, reply) => {
    const articleId = Number(req.params.id);
    const a = db.prepare('SELECT site_id FROM articles WHERE id = ?').get(articleId);
    if (!a) return reply.code(404).send('нет');
    const jobId = createJob('stats', { siteId: a.site_id });
    logJob(jobId, `Старт: сбор статистики статьи #${articleId}.`);
    withTimeout(collectArticleStats(db, articleId, { reason: 'manual', onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'сбор статистики')
      .then((s) => finishJob(jobId, { ok: true, articleId, message: `${s.totalViews} просмотров (из поиска ${s.channels?.seo ?? 0}), перцентиль ${s.percentile ?? '-'}` }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  // ===== Позиции в Google (DACH) =====
  app.post('/sites/:id/ranks/check', async (req, reply) => {
    const siteId = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM sites WHERE id = ?').get(siteId)) return reply.code(404).send('нет');
    const jobId = createJob('rank', { siteId });
    logJob(jobId, 'Старт: проверка позиций в Google (DACH) по живым статьям сайта.');
    withTimeout(checkRanksForSite(db, siteId, { countries: DACH, onStep: (m) => logJob(jobId, m) }), STATS_TIMEOUT_MS, 'проверка позиций')
      .then((r) => finishJob(jobId, { ok: r.fail === 0, message: `Проверено ok ${r.ok}, ошибок ${r.fail} из ${r.total}` }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  app.post('/articles/:id/check-rank', async (req, reply) => {
    const articleId = Number(req.params.id);
    const a = db.prepare('SELECT site_id FROM articles WHERE id = ?').get(articleId);
    if (!a) return reply.code(404).send('нет');
    const jobId = createJob('rank', { siteId: a.site_id });
    logJob(jobId, `Старт: проверка позиций статьи #${articleId} (DACH).`);
    withTimeout(checkArticleRank(db, articleId, { countries: DACH, onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'проверка позиций')
      .then((res) => finishJob(jobId, { ok: true, articleId, message: res.map((x) => `${x.country.toUpperCase()}:${x.position ? '#' + x.position : '—'}`).join(' ') }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });

  // ===== Пул почт (глобальный ресурс сети) =====
  app.get('/emails', async (req, reply) => {
    const maskPw = (v) => (!v ? '' : v.length <= 3 ? '•••' : `${v.slice(0, 2)}•••${v.slice(-1)}`);
    const sites = db.prepare('SELECT id, name FROM sites').all();
    const siteName = (sid) => sites.find((x) => x.id === sid)?.name || `#${sid}`;
    const rows = listEmailAccounts(db);
    const statusRu = { new: 'новая', verified: 'вход ок', used: 'использована', bad: 'вход не удался' };
    const tr = rows
      .map((e) => `<tr><td>${e.id}</td><td>${e.enabled ? '<i class="ti ti-circle-check text-green"></i>' : '<i class="ti ti-ban text-danger"></i>'}</td><td>${esc(e.provider)}</td><td>${esc(e.email)}</td><td class="text-secondary mono">${esc(maskPw(e.password))}</td><td class="text-secondary mono">${esc((e.proxy || '-').split(':')[0])}</td><td>${esc(statusRu[e.status] || e.status)}</td>
<td>${e.site_id ? `<a href="/sites/${e.site_id}#registration">${esc(siteName(e.site_id))}</a>` : '<span class="text-secondary">свободна</span>'}</td>
<td>${e.cookies_updated_at ? '<span class="badge bg-azure text-white"><i class="ti ti-check"></i></span>' : '<span class="text-secondary small">—</span>'}</td>
<td><div class="d-flex gap-1"><form method="post" action="/email-accounts/${e.id}/toggle"><button class="btn btn-sm btn-outline-secondary">${e.enabled ? 'выкл' : 'вкл'}</button></form>
${e.cookies_updated_at ? `<form method="post" action="/email-accounts/${e.id}/clear-cookies" title="сбросить сессию почты"><button class="btn btn-sm btn-outline-secondary">⟳</button></form>` : ''}
${e.site_id ? `<form method="post" action="/email-accounts/${e.id}/release" title="освободить от сайта" onsubmit="return confirm('Освободить почту от сайта? (используй только если регистрация не состоялась)')"><button class="btn btn-sm btn-outline-warning">освоб.</button></form>` : ''}
<form method="post" action="/email-accounts/${e.id}/delete" onsubmit="return confirm('Удалить почту?')"><button class="btn btn-sm btn-outline-danger">×</button></form></div></td></tr>`)
      .join('');
    const provOpts = mailProviderList().map((p) => `<option value="${p.name}">${esc(p.label)}</option>`).join('');
    const addForm = `<form method="post" action="/emails" class="row g-2 align-items-end">
<div class="col-auto"><label class="form-label">Провайдер</label><select name="provider" class="form-select">${provOpts}</select></div>
<div class="col-auto"><label class="form-label">Email</label><input name="email" class="form-control" required></div>
<div class="col-auto"><label class="form-label">Пароль</label><input name="password" class="form-control" required></div>
<div class="col-auto"><label class="form-label">Страна</label><input name="country" class="form-control" value="at" style="width:5rem" title="из пула какой страны взять прокси, если не указана"></div>
<div class="col"><label class="form-label">Прокси (опц.; иначе из пула страны)</label><input name="proxy" class="form-control" placeholder="host:port:user:pass — или пусто"></div>
<div class="col-auto"><button type="submit" class="btn btn-primary">Добавить</button></div></form>`;
    const importForm = `<details><summary class="btn btn-outline-secondary btn-sm">Массовый импорт почт</summary>
<div class="mt-2"><form method="post" action="/emails/import"><div class="mb-2 d-flex gap-2 align-items-center"><select name="provider" class="form-select form-select-sm" style="width:auto">${provOpts}</select><span class="small text-secondary">страна (пул прокси):</span><input name="country" class="form-control form-control-sm" value="at" style="width:5rem"></div>
<textarea name="text" class="form-control mono" rows="6" placeholder="по строке на почту (прокси возьмётся из пула страны):&#10;email:password&#10;…или со своей прокси: email:password:host:port:user:pass"></textarea>
<button type="submit" class="btn btn-primary mt-2">Импортировать</button></form></div></details>`;
    const tableHtml = `<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-mail"></i> Пул почт (${rows.length})</h3></div><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>id</th><th>акт.</th><th>провайдер</th><th>email</th><th>пароль</th><th>прокси</th><th>статус</th><th>сайт</th><th>сессия</th><th></th></tr></thead><tbody>${tr || '<tr><td colspan="10" class="text-secondary">почт нет — добавь</td></tr>'}</tbody></table></div><div class="card-footer">${addForm}<div class="mt-2">${importForm}</div></div></div>`;

    const note = '<div class="text-secondary small mb-2">Почты — общий ресурс сети (одна почта = один сайт). Прокси берутся из пула по стране почты (раздел <a href="/proxies">Прокси</a>) и распределяются автоматически.</div>';
    reply.type('text/html').send(page('/emails', 'Почты', note + tableHtml, { flash: flash(req.query) }));
  });

  app.post('/emails', async (req, reply) => {
    const b = req.body;
    try {
      addEmailAccount(db, { provider: b.provider, email: b.email, password: b.password, proxy: b.proxy, country: b.country });
      reply.redirect(`/emails?msg=${encodeURIComponent('Почта добавлена')}`);
    } catch (e) {
      reply.redirect(`/emails?msg=${encodeURIComponent('Ошибка: ' + e.message)}`);
    }
  });
  app.post('/emails/import', async (req, reply) => {
    const r = importEmailAccounts(db, req.body.text, { provider: req.body.provider, country: req.body.country });
    const np = r.noProxy ? `, без прокси ${r.noProxy} (пул ${esc(req.body.country || 'at')} кончился)` : '';
    reply.redirect(`/emails?msg=${encodeURIComponent(`Импорт: добавлено ${r.added}, дублей ${r.skipped}, ошибок ${r.errors.length}${np}`)}`);
  });
  // ===== Регистрация почт: автосоздание ящиков через Dolphin (createMailbox по выбранному провайдеру) =====
  app.get('/mailboxes', async (req, reply) => {
    const provs = mailProviderList();
    const opts = provs.map((p) => `<option value="${p.name}">${esc(p.label)}</option>`).join('');
    const byProv = Object.fromEntries(db.prepare('SELECT provider, COUNT(*) c FROM email_accounts GROUP BY provider').all().map((r) => [r.provider, r.c]));
    const provRows = provs.map((p) => `<tr><td>${esc(p.label)}</td><td class="mono">${esc(p.name)}</td><td>${byProv[p.name] || 0}</td></tr>`).join('');
    let smsBal = '';
    try {
      const sms = getSmsProvider(db);
      if (sms?.balance) smsBal = `5sim баланс: ${await sms.balance()}`;
    } catch (e) {
      smsBal = `5sim: ${e.message.slice(0, 50)}`;
    }
    const jobs = db.prepare("SELECT * FROM jobs WHERE type = 'mailbox' ORDER BY id DESC LIMIT 12").all();
    const jobRows = jobs.map((j) => `<tr><td><a href="/jobs/${j.id}">#${j.id}</a></td><td>${jobBadge(j.status)}</td><td>${esc((j.message || '').slice(0, 80))}</td><td class="text-secondary">${esc(j.created_at)}</td></tr>`).join('');
    const form = card('<i class="ti ti-user-plus"></i> Создать ящики', `<form method="post" action="/mailboxes/create" onsubmit="return confirm('Запустить создание ящиков через Dolphin? Расход: номер 5sim + капча за каждый.')">
<div class="row g-2 align-items-end mb-2"><div class="col-auto"><label class="form-label">Провайдер</label><select name="provider" class="form-select">${opts}</select></div>
<div class="col-auto"><label class="form-label">Сколько</label><input name="count" type="number" class="form-control" value="1" min="1" max="50" style="width:6rem"></div>
<div class="col-auto"><label class="form-label">Страна (пул прокси)</label><input name="country" class="form-control" value="at" style="width:6rem"></div></div>
<button class="btn btn-primary">Создать</button>
<p class="text-secondary small mt-2 mb-0">Создаётся последовательно (один профиль Dolphin за раз): прокси «Регистрация» нужной страны → форма + капча (CaptchaFox) + SMS (5sim) → IMAP → запись в пул «Почты». Прервать — кнопкой «Остановить» на странице задачи. Драйверы: <b>GMX</b> рабочий; <b>web.de/mail.com</b> (United Internet) — нужна живая доводка селекторов/URL; <b>Outlook</b> — каркас (нужен решатель FunCaptcha).</p></form>`);
    const provCard = tableCard('<i class="ti ti-mail-cog"></i> Провайдеры и пул', ['провайдер', 'код', 'почт в пуле'], provRows, 'mprov');
    const jobsCard = tableCard('<i class="ti ti-history"></i> Недавние прогоны', ['задача', 'статус', 'итог', 'когда'], jobRows, 'mjobs');
    const bal = smsBal ? `<div class="text-secondary small mb-2">${esc(smsBal)}</div>` : '';
    reply.type('text/html').send(page('/mailboxes', 'Регистрация почт', bal + form + provCard + jobsCard, { flash: flash(req.query) }));
  });
  app.post('/mailboxes/create', async (req, reply) => {
    const provider = String(req.body.provider || 'gmx');
    const country = String(req.body.country || 'at').trim().toLowerCase() || 'at';
    const count = Math.max(1, Math.min(50, Number(req.body.count) || 1));
    const jobId = createJob('mailbox', {});
    logJob(jobId, `Старт: создание ${count} ящиков [${provider}], страна ${country} — последовательно через Dolphin.`);
    (async () => {
      let ok = 0;
      let fail = 0;
      let stopped = false;
      const done = [];
      for (let i = 0; i < count; i++) {
        if (isJobCancelled(jobId)) { stopped = true; break; }
        logJob(jobId, `── ящик ${i + 1}/${count} ──`);
        try {
          const r = await createMailbox(db, { provider, country, onStep: (m) => logJob(jobId, m) });
          if (r.ok) { ok += 1; done.push(r.email); }
          else { fail += 1; logJob(jobId, `не создан: ${r.message}`); }
        } catch (e) {
          fail += 1;
          logJob(jobId, `сбой: ${e.message}`);
        }
      }
      finishJob(jobId, { ok: !stopped && fail === 0, stopped, message: `${stopped ? 'Остановлено. ' : ''}Создано ${ok} из ${count}${fail ? `, ошибок ${fail}` : ''}`, result: { kind: 'mailbox', emails: done } });
    })().catch((e) => { try { finishJob(jobId, { ok: false, message: 'Сбой задачи: ' + e.message }); } catch {} });
    reply.redirect(`/jobs/${jobId}`);
  });

  // ===== Прокси: именованные группы (назначение по видам работы) + пул =====
  const maskProxy = (u) => String(u || '').replace(/\/\/[^@/]*@/, '//***@');
  app.get('/proxies', async (req, reply) => {
    const groups = listGroups(db);
    const sites = db.prepare('SELECT id, name FROM sites ORDER BY id').all();
    const purposeBadges = (csv) => PROXY_PURPOSES.filter(([k]) => (',' + (csv || '') + ',').includes(',' + k + ',')).map(([, l]) => `<span class="badge bg-blue text-white me-1">${l}</span>`).join('') || '<span class="text-secondary">—</span>';
    const sitesLabel = (csv) => { if (!csv) return '<span class="text-secondary">все</span>'; return csv.split(',').map(Number).map((id) => esc((sites.find((s) => s.id === id) || {}).name || ('#' + id))).join(', '); };
    const purposeChecks = (csv) => PROXY_PURPOSES.map(([k, l]) => `<label class="form-check form-check-inline"><input type="checkbox" class="form-check-input" name="purposes" value="${k}" ${(',' + (csv || '') + ',').includes(',' + k + ',') ? 'checked' : ''}><span class="form-check-label">${l}</span></label>`).join('');
    const siteChecks = (csv) => { const sel = new Set((csv || '').split(',').map(Number)); return sites.length ? sites.map((s) => `<label class="form-check form-check-inline"><input type="checkbox" class="form-check-input" name="site_ids" value="${s.id}" ${sel.has(s.id) ? 'checked' : ''}><span class="form-check-label">${esc(s.name)}</span></label>`).join('') : '<span class="text-secondary small">сайтов нет</span>'; };
    const groupRows = groups.map((g) => `<tr><td><b>${esc(g.name)}</b></td><td>${purposeBadges(g.purposes)}</td><td>${sitesLabel(g.site_ids)}</td><td><a href="/proxies?group=${g.id}">${g.cnt}</a></td><td>
<details><summary class="btn btn-sm btn-outline-secondary">править</summary><form method="post" action="/proxies/groups/${g.id}/edit" class="mt-2" style="min-width:20rem"><input name="name" class="form-control form-control-sm mb-2" value="${esc(g.name)}"><div class="mb-2"><div class="small text-secondary">назначение:</div>${purposeChecks(g.purposes)}</div><div class="mb-2"><div class="small text-secondary">сайты (ничего = все):</div>${siteChecks(g.site_ids)}</div><button class="btn btn-sm btn-primary">Сохранить</button></form>
<form method="post" action="/proxies/groups/${g.id}/delete" class="mt-1" onsubmit="return confirm('Удалить группу «${esc(g.name)}»? Прокси не удалятся — отвяжутся.')"><button class="btn btn-sm btn-outline-danger">Удалить группу</button></form></details></td></tr>`).join('');
    const groupsCard = tableCard('<i class="ti ti-route"></i> Группы прокси', ['имя', 'назначение', 'сайты', 'прокси', ''], groupRows, 'pgroups');
    const createCard = card('<i class="ti ti-plus"></i> Новая группа', `<form method="post" action="/proxies/groups">
<div class="mb-2"><label class="form-label">Имя</label><input name="name" class="form-control" required placeholder="напр. AT — публикация сайт 1"></div>
<div class="mb-2"><label class="form-label d-block">Назначение</label>${purposeChecks('')}</div>
<div class="mb-2"><label class="form-label d-block">Сайты <span class="text-secondary small">(ничего не отмечено = все)</span></label>${siteChecks('')}</div>
<button class="btn btn-primary">Создать</button></form>`);
    const groupOpts = groups.map((g) => `<option value="${g.id}">${esc(g.name)} (${g.cnt})</option>`).join('');
    const importCard = card('<i class="ti ti-upload"></i> Импорт прокси в группу', `<form method="post" action="/proxies/import">
<div class="row g-2 mb-2 align-items-end"><div class="col-auto"><label class="form-label">Страна</label><input name="country" class="form-control" value="at" style="width:6rem" required></div><div class="col"><label class="form-label">Группа</label><select name="group" class="form-select">${groupOpts || '<option value="">— сначала создай группу —</option>'}</select></div></div>
<textarea name="text" class="form-control mono" rows="6" placeholder="по строке: scheme://user:pass@host:port"></textarea>
<button class="btn btn-primary mt-2">Загрузить</button></form>`);
    let proxiesCard = '';
    if (req.query.group) {
      const gid = Number(req.query.group);
      const g = getGroup(db, gid);
      const list = db.prepare('SELECT id, url, country, last_assigned_at FROM proxies WHERE group_id = ? ORDER BY id LIMIT 200').all(gid);
      const total = db.prepare('SELECT COUNT(*) c FROM proxies WHERE group_id = ?').get(gid).c;
      const prows = list.map((p) => `<tr><td><input type="checkbox" name="ids" form="pmove" value="${p.id}"></td><td class="mono small">${esc(maskProxy(p.url))}</td><td>${esc(p.country)}</td><td class="text-secondary small">${esc(p.last_assigned_at || '—')}</td></tr>`).join('');
      const moveOpts = groups.filter((x) => x.id !== gid).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
      proxiesCard = `<div class="card mb-3"><div class="card-header"><h3 class="card-title">Прокси группы «${esc(g ? g.name : '')}» (${total}${total > 200 ? ', показаны 200' : ''})</h3></div>
<div class="table-responsive" style="max-height:420px;overflow:auto"><table class="table table-sm card-table"><thead><tr><th style="width:1%"></th><th>хост</th><th>страна</th><th>выдан</th></tr></thead><tbody>${prows || '<tr><td colspan="4" class="text-secondary p-3">пусто</td></tr>'}</tbody></table></div>
<div class="card-footer"><form id="pmove" method="post" action="/proxies/move" class="d-flex gap-2 align-items-center flex-wrap"><input type="hidden" name="from" value="${gid}"><span class="small text-secondary">выбранные →</span><select name="group" class="form-select form-select-sm" style="width:auto">${moveOpts || '<option value="">нет других групп</option>'}</select><button class="btn btn-sm btn-primary">Переместить</button></form></div></div>`;
    }
    reply.type('text/html').send(page('/proxies', 'Прокси', groupsCard + createCard + importCard + proxiesCard, { flash: flash(req.query) }));
  });
  app.post('/proxies/groups', async (req, reply) => {
    createGroup(db, { name: req.body.name, purposes: req.body.purposes, siteIds: req.body.site_ids });
    reply.redirect(`/proxies?msg=${encodeURIComponent('Группа создана')}`);
  });
  app.post('/proxies/groups/:id/edit', async (req, reply) => {
    updateGroup(db, Number(req.params.id), { name: req.body.name, purposes: req.body.purposes, siteIds: req.body.site_ids });
    reply.redirect(`/proxies?msg=${encodeURIComponent('Группа обновлена')}`);
  });
  app.post('/proxies/groups/:id/delete', async (req, reply) => {
    deleteGroup(db, Number(req.params.id));
    reply.redirect(`/proxies?msg=${encodeURIComponent('Группа удалена (прокси отвязаны)')}`);
  });
  app.post('/proxies/import', async (req, reply) => {
    const r = importProxies(db, req.body.text, { country: req.body.country, groupId: req.body.group || null });
    reply.redirect(`/proxies?msg=${encodeURIComponent(`Прокси [${r.country}]: добавлено ${r.added}, обновлено/дублей ${r.skipped}, ошибок ${r.errors.length}`)}`);
  });
  app.post('/proxies/move', async (req, reply) => {
    const n = setProxiesGroup(db, req.body.ids, req.body.group || null);
    reply.redirect(`/proxies?group=${encodeURIComponent(req.body.from || '')}&msg=${encodeURIComponent(`Перемещено: ${n}`)}`);
  });
  app.post('/email-accounts/:id/toggle', async (req, reply) => {
    toggleEmailAccount(db, Number(req.params.id));
    reply.redirect('/emails');
  });
  app.post('/email-accounts/:id/clear-cookies', async (req, reply) => {
    clearEmailCookies(db, Number(req.params.id));
    reply.redirect(`/emails?msg=${encodeURIComponent('Сессия почты сброшена')}`);
  });
  app.post('/email-accounts/:id/release', async (req, reply) => {
    releaseEmail(db, Number(req.params.id));
    reply.redirect(`/emails?msg=${encodeURIComponent('Почта освобождена от сайта')}`);
  });
  app.post('/email-accounts/:id/delete', async (req, reply) => {
    removeEmailAccount(db, Number(req.params.id));
    reply.redirect(`/emails?msg=${encodeURIComponent('Почта удалена')}`);
  });

  // ===== Запуск регистрации (СТРОГО ПОСЛЕДОВАТЕЛЬНО) и проверка одобрения =====
  // Один профиль Dolphin за раз: регистрации выстраиваются в общую очередь и идут по одной
  // (параллельный запуск 14 профилей перегружает Dolphin/прокси и палит паттерн на сайте).
  let regQueueChain = Promise.resolve();
  let regQueueLen = 0;
  function enqueueRegistration(siteId, emailAccountId) {
    const jobId = createJob('register', { siteId });
    regQueueLen += 1;
    logJob(jobId, `В очереди на регистрацию (поток один; впереди: ${regQueueLen - 1}). Почта #${emailAccountId}.`);
    regQueueChain = regQueueChain.then(async () => {
      logJob(jobId, `Старт: регистрация почты #${emailAccountId} на сайте #${siteId}`);
      try {
        const res = await withTimeout(registerOnSite(db, { siteId, emailAccountId, onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'регистрация');
        finishJob(jobId, { ok: res.ok, message: res.message });
      } catch (e) {
        finishJob(jobId, { ok: false, message: e.message });
      } finally {
        regQueueLen -= 1;
      }
    });
    return jobId;
  }

  app.post('/sites/:id/register', async (req, reply) => {
    const siteId = Number(req.params.id);
    const raw = req.body.emails;
    const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(Number).filter(Boolean);
    if (!ids.length) return reply.redirect(`/sites/${siteId}?tab=settings&msg=${encodeURIComponent('Не выбрана ни одна почта')}#registration`);
    let firstJob = null;
    for (const emailAccountId of ids) {
      const jobId = enqueueRegistration(siteId, emailAccountId);
      if (firstJob == null) firstJob = jobId;
    }
    // одна почта → на страницу её задачи; несколько → на сайт (очередь видна в «Задачах»)
    if (ids.length === 1) return reply.redirect(`/jobs/${firstJob}`);
    reply.redirect(`/sites/${siteId}?tab=settings&msg=${encodeURIComponent(`В очередь на регистрацию (последовательно): ${ids.length}. Прогресс — в «Задачах».`)}#registration`);
  });
  app.post('/registrations/:id/retry', async (req, reply) => {
    const regId = Number(req.params.id);
    const reg = db.prepare('SELECT site_id, email_account_id FROM site_registrations WHERE id = ?').get(regId);
    if (!reg) return reply.redirect(`/sites/?msg=${encodeURIComponent('Регистрация не найдена')}`);
    const jobId = enqueueRegistration(reg.site_id, reg.email_account_id);
    reply.redirect(`/jobs/${jobId}`);
  });
  // Массовая проверка одобрения по IMAP: одна задача, регистрации проверяются последовательно
  // (IMAP без Dolphin; на отказ прокси registrar сам меняет её на свободную из пула).
  app.post('/sites/:id/check-approvals', async (req, reply) => {
    const siteId = Number(req.params.id);
    const raw = req.body?.regs;
    const ids = (Array.isArray(raw) ? raw : raw != null ? [raw] : []).map(Number).filter(Boolean);
    if (!ids.length) return reply.redirect(`/sites/${siteId}?tab=settings&msg=${encodeURIComponent('Не выбрана ни одна регистрация')}#registration`);
    const jobId = createJob('register', { siteId });
    logJob(jobId, `Старт: проверка одобрения по IMAP для ${ids.length} регистраций.`);
    (async () => {
      let approved = 0;
      let fail = 0;
      let stopped = false;
      let checked = 0;
      for (let i = 0; i < ids.length; i++) {
        if (isJobCancelled(jobId)) { stopped = true; break; }
        const regId = ids[i];
        checked += 1;
        logJob(jobId, `── [${i + 1}/${ids.length}] регистрация #${regId} ──`);
        try {
          const res = await withTimeout(checkApproval(db, { registrationId: regId, onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'проверка одобрения');
          if (res.status === 'approved') approved += 1;
        } catch (e) {
          logJob(jobId, `сбой #${regId}: ${e.message}`);
          fail += 1;
        }
      }
      finishJob(jobId, { ok: !stopped && fail === 0, stopped, message: `${stopped ? 'Остановлено. ' : ''}Проверено ${checked} из ${ids.length}, одобрено ${approved}${fail ? `, ошибок ${fail}` : ''}` });
    })().catch((e) => { try { finishJob(jobId, { ok: false, message: 'Сбой задачи: ' + e.message }); } catch {} });
    reply.redirect(`/jobs/${jobId}`);
  });
  app.post('/registrations/:id/check', async (req, reply) => {
    const regId = Number(req.params.id);
    const reg = db.prepare('SELECT site_id FROM site_registrations WHERE id = ?').get(regId);
    const jobId = createJob('register', { siteId: reg?.site_id });
    logJob(jobId, `Старт: проверка одобрения регистрации #${regId}`);
    withTimeout(checkApproval(db, { registrationId: regId, onStep: (m) => logJob(jobId, m) }), PUBLISH_TIMEOUT_MS, 'проверка одобрения')
      .then((res) => finishJob(jobId, { ok: res.ok, message: res.message }))
      .catch((e) => finishJob(jobId, { ok: false, message: e.message }));
    reply.redirect(`/jobs/${jobId}`);
  });
}
