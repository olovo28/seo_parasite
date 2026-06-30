// Аккаунты публикации сайта: логин/пароль к сайту + своя прокси (несколько на сайт).
// Аккаунт выбирается при публикации; resolvePublishAccount даёт фолбэк (первый включённый / env).

export function listSiteAccounts(db, siteId) {
  return db.prepare('SELECT * FROM site_accounts WHERE site_id = ? ORDER BY id').all(siteId);
}

export function enabledSiteAccounts(db, siteId) {
  return db.prepare('SELECT * FROM site_accounts WHERE site_id = ? AND enabled = 1 ORDER BY id').all(siteId);
}

export function addSiteAccount(db, siteId, { username, password, proxy, label } = {}) {
  const u = String(username || '').trim();
  if (!u) throw new Error('Пустой логин.');
  if (!String(password || '').trim()) throw new Error('Пустой пароль.');
  if (proxy) parseProxy(proxy); // валидируем формат прокси сразу
  db.prepare('INSERT OR IGNORE INTO site_accounts (site_id, username, password, proxy, label) VALUES (?, ?, ?, ?, ?)').run(
    siteId,
    u,
    String(password),
    String(proxy || '').trim() || null,
    String(label || '').trim() || null,
  );
}

export function toggleSiteAccount(db, id) {
  db.prepare('UPDATE site_accounts SET enabled = 1 - enabled WHERE id = ?').run(id);
}

export function removeSiteAccount(db, id) {
  db.prepare('DELETE FROM site_accounts WHERE id = ?').run(id);
}

function toAcc(a) {
  let cookies = null;
  try {
    cookies = a.cookies ? JSON.parse(a.cookies) : null;
  } catch {
    cookies = null;
  }
  return { id: a.id, username: a.username, password: a.password, proxy: a.proxy, label: a.label || a.username, cookies };
}

// Сохранить сессию (cookies) аккаунта — чтобы при следующей публикации не логиниться заново.
export function saveAccountCookies(db, accountId, cookies) {
  if (!accountId) return;
  db.prepare("UPDATE site_accounts SET cookies = ?, cookies_updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(cookies || []), accountId);
}

// Сбросить сохранённую сессию аккаунта (заставит логиниться заново).
export function clearAccountCookies(db, accountId) {
  db.prepare('UPDATE site_accounts SET cookies = NULL, cookies_updated_at = NULL WHERE id = ?').run(accountId);
}

// Аккаунт по id независимо от enabled (для удаления статьи именно её аккаунтом-владельцем,
// даже если он сейчас выключен). null — если строки уже нет (аккаунт удалён).
export function getSiteAccountById(db, id) {
  if (!id) return null;
  const a = db.prepare('SELECT * FROM site_accounts WHERE id = ?').get(id);
  return a ? toAcc(a) : null;
}

// Аккаунт для публикации статьи сайта. requestedId — если включён у сайта; иначе первый включённый; иначе env.
export function resolvePublishAccount(db, siteId, requestedId) {
  const enabled = enabledSiteAccounts(db, siteId);
  if (requestedId) {
    const a = enabled.find((x) => String(x.id) === String(requestedId));
    if (a) return toAcc(a);
  }
  if (enabled.length) return toAcc(enabled[0]);
  const u = process.env.MEINBEZIRK_USER;
  const p = process.env.MEINBEZIRK_PASS;
  if (u && p) return { id: null, username: u, password: p, proxy: null, label: 'env' };
  throw new Error('У сайта нет включённых аккаунтов публикации (добавь аккаунт в настройках сайта).');
}

// Разбор строки прокси в { type, host, port, login, password }. Пусто → null, иначе throws.
// Форматы: scheme://user:pass@host:port | host:port:user:pass | host:port  (scheme: http/https/socks5)
export function parseProxy(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  let type = 'http';
  let rest = s;
  const scheme = s.match(/^(https?|socks5):\/\//i);
  if (scheme) {
    type = scheme[1].toLowerCase();
    rest = s.slice(scheme[0].length);
  }
  if (type === 'https') type = 'http'; // Dolphin использует http для https-прокси

  let host;
  let port;
  let login;
  let password;
  if (rest.includes('@')) {
    const [cred, hp] = rest.split('@');
    [login, password] = cred.split(':');
    [host, port] = hp.split(':');
  } else {
    const parts = rest.split(':');
    host = parts[0];
    port = parts[1];
    if (parts.length >= 4) {
      login = parts[2];
      password = parts.slice(3).join(':');
    }
  }
  if (!host || !port || !/^\d+$/.test(port)) {
    throw new Error(`Не удалось разобрать прокси: "${str}". Формат: host:port[:user:pass] или scheme://user:pass@host:port`);
  }
  return { type, host, port: Number(port), login: login || undefined, password: password || undefined };
}
