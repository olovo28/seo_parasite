// Аккаунты SEMrush для модуля «Анализ»: API-ключ (API-драйвер) + email/пароль/прокси/cookies (UI через Dolphin).
// Триалы эфемерны — несколько аккаунтов, переключаемся; выбираем включённый с наибольшим остатком юнитов.

export function listSemrushAccounts(db) {
  return db.prepare('SELECT * FROM semrush_accounts ORDER BY id').all();
}

export function enabledSemrushAccounts(db) {
  return db.prepare('SELECT * FROM semrush_accounts WHERE enabled = 1 ORDER BY id').all();
}

export function addSemrushAccount(db, { label, email, password, api_key, proxy, notes } = {}) {
  db.prepare('INSERT INTO semrush_accounts (label, email, password, api_key, proxy, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
    String(label || '').trim() || null,
    String(email || '').trim() || null,
    String(password || '').trim() || null,
    String(api_key || '').trim() || null,
    String(proxy || '').trim() || null,
    String(notes || '').trim() || null,
  );
}

export function toggleSemrushAccount(db, id) {
  db.prepare('UPDATE semrush_accounts SET enabled = 1 - enabled WHERE id = ?').run(id);
}

export function removeSemrushAccount(db, id) {
  db.prepare('DELETE FROM semrush_accounts WHERE id = ?').run(id);
}

export function setUnitsBalance(db, id, units) {
  db.prepare("UPDATE semrush_accounts SET units_balance = ?, units_checked_at = datetime('now') WHERE id = ?").run(Number.isFinite(units) ? units : null, id);
}

// UI-лимиты подписки (из ответа Keyword Magic) — кэш, обновляется попутно при UI-прогоне.
export function saveUiLimits(db, id, limits) {
  if (!id || !limits) return;
  db.prepare("UPDATE semrush_accounts SET ui_limits = ?, ui_limits_at = datetime('now') WHERE id = ?").run(JSON.stringify(limits), id);
}

export function saveAccountCookies(db, id, cookies) {
  if (!id) return;
  db.prepare("UPDATE semrush_accounts SET cookies = ?, cookies_updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cookies || []), id);
}

export function clearAccountCookies(db, id) {
  db.prepare('UPDATE semrush_accounts SET cookies = NULL, cookies_updated_at = NULL WHERE id = ?').run(id);
}

// Cookie-Editor JSON (экспорт из браузера) → формат CDP Network.setCookies. Так пользователь вставляет
// живую сессию SEMrush, и драйвер работает без авто-логина (его SEMrush блокирует капчей).
export function cookieEditorToCDP(arr) {
  return (Array.isArray(arr) ? arr : [])
    .map((c) => {
      const o = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/' };
      if (c.expirationDate) o.expires = Math.floor(c.expirationDate);
      if (c.secure != null) o.secure = !!c.secure;
      if (c.httpOnly != null) o.httpOnly = !!c.httpOnly;
      const ss = String(c.sameSite || '').toLowerCase();
      if (ss === 'no_restriction') o.sameSite = 'None';
      else if (ss === 'lax') o.sameSite = 'Lax';
      else if (ss === 'strict') o.sameSite = 'Strict';
      return o;
    })
    .filter((c) => c.name && c.domain);
}

// Сохранить вставленную пользователем сессию (Cookie-Editor JSON или уже CDP-массив). Возвращает число cookies.
export function saveAccountCookiesText(db, id, text) {
  let arr;
  try {
    arr = JSON.parse(text);
  } catch {
    throw new Error('Не похоже на JSON — вставь экспорт Cookie-Editor (массив cookies).');
  }
  const cdp = cookieEditorToCDP(arr);
  if (!cdp.length) throw new Error('В JSON нет валидных cookies.');
  db.prepare("UPDATE semrush_accounts SET cookies = ?, cookies_updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cdp), id);
  return cdp.length;
}

function toAcc(a) {
  let cookies = null;
  try {
    cookies = a.cookies ? JSON.parse(a.cookies) : null;
  } catch {
    cookies = null;
  }
  return { ...a, cookies };
}

// Аккаунт для прогона. requestedId — если включён → он; иначе включённый с наибольшим остатком юнитов (или первый).
export function resolveSemrushAccount(db, requestedId) {
  const enabled = enabledSemrushAccounts(db);
  if (!enabled.length) throw new Error('Нет включённых SEMrush-аккаунтов (добавь в разделе «Анализ»).');
  if (requestedId) {
    const a = enabled.find((x) => String(x.id) === String(requestedId));
    if (a) return toAcc(a);
  }
  const best = enabled.slice().sort((x, y) => (y.units_balance ?? -1) - (x.units_balance ?? -1))[0];
  return toAcc(best);
}
