// Глобальный пул почтовых ящиков (общий ресурс сети). Провайдер выбирает драйвер lib/mail/*.
// Правило сети: одна почта используется только на ОДНОМ сайте (email_accounts.site_id; NULL = свободна).

import { parseProxy } from './accounts.js';
import { assignProxy, assignUnusedProxy } from './proxyPool.js';
import { providerForEmail, countryForEmail } from './mail/index.js';

function toAcc(a) {
  if (!a) return null;
  let cookies = null;
  try {
    cookies = a.cookies ? JSON.parse(a.cookies) : null;
  } catch {
    cookies = null;
  }
  return { ...a, cookies };
}

export function listEmailAccounts(db) {
  return db.prepare('SELECT * FROM email_accounts ORDER BY id').all();
}

// Свободные почты (не закреплены ни за каким сайтом и включены) — кандидаты на регистрацию.
export function freeEmailAccounts(db) {
  return db.prepare('SELECT * FROM email_accounts WHERE site_id IS NULL AND enabled = 1 ORDER BY id').all();
}

export function getEmailAccountById(db, id) {
  if (!id) return null;
  return toAcc(db.prepare('SELECT * FROM email_accounts WHERE id = ?').get(id));
}

// Добавить почту. Если proxy не задан, но задан country — берём прокси из пула этой страны (авто-распределение).
export function addEmailAccount(db, { provider = 'gmx', email, password, proxy, country, notes } = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) throw new Error('Пустой email.');
  if (!String(password || '').trim()) throw new Error('Пустой пароль почты.');
  // Провайдер и страна прокси — по домену адреса (gmx.de→gmxde/DE, gmx.ch→gmxch/CH, gmx.net→gmxnet/DE), с фолбэком.
  const prov = providerForEmail(e, String(provider || 'gmx').trim());
  const c = String(country || '').trim().toLowerCase() || countryForEmail(e, 'at');
  let px = String(proxy || '').trim() || null;
  if (px) parseProxy(px); // валидируем формат прокси сразу
  else if (c) px = assignProxy(db, { country: c, purpose: 'register' }); // авто-выдача из пула страны (для регистрации)
  db.prepare('INSERT INTO email_accounts (provider, email, password, proxy, country, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
    prov,
    e,
    String(password),
    px,
    c,
    String(notes || '').trim() || null,
  );
}

// Массовый импорт. Строки: "email:password" (прокси возьмётся из пула страны country)
// или "email:password:host:port[:user:pass]" (своя прокси). Возвращает { added, skipped, errors, noProxy }.
export function importEmailAccounts(db, text, { provider = 'gmx', country = 'at' } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0;
  let skipped = 0;
  let noProxy = 0; // сколько почт остались без прокси (пул страны кончился)
  const errors = [];
  for (const line of lines) {
    const parts = line.split(':');
    const email = parts[0]?.trim().toLowerCase();
    const password = parts[1]?.trim();
    const proxy = parts.length > 2 ? parts.slice(2).join(':').trim() : null;
    if (!email || !password) {
      errors.push(`строка пропущена (нет email/пароля): ${line.slice(0, 40)}`);
      continue;
    }
    try {
      addEmailAccount(db, { provider, email, password, proxy, country });
      const row = db.prepare('SELECT proxy FROM email_accounts WHERE email = ?').get(email);
      if (!row?.proxy) noProxy += 1;
      added++;
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) skipped++;
      else errors.push(`${email}: ${e.message}`);
    }
  }
  return { total: lines.length, added, skipped, errors, noProxy };
}

export function toggleEmailAccount(db, id) {
  db.prepare('UPDATE email_accounts SET enabled = 1 - enabled WHERE id = ?').run(id);
}

export function removeEmailAccount(db, id) {
  db.prepare('DELETE FROM email_accounts WHERE id = ?').run(id);
}

// Закрепить почту за сайтом (правило уникальности). Атомарно: только если ещё свободна.
// Возвращает true, если удалось закрепить (иначе уже занята другим сайтом / гонка).
export function lockEmailToSite(db, id, siteId) {
  const r = db.prepare('UPDATE email_accounts SET site_id = ? WHERE id = ? AND site_id IS NULL').run(siteId, id);
  return r.changes > 0;
}

// Освободить почту (например, если регистрация удалена/откатилась до старта).
export function releaseEmail(db, id) {
  db.prepare('UPDATE email_accounts SET site_id = NULL WHERE id = ?').run(id);
}

// Сменить прокси почты на свободную (никем не используемую) из пула её страны — например, когда текущая
// прокси отказала на IMAP CONNECT (503). Возвращает новый url прокси или null, если свободных в пуле нет.
export function swapEmailProxy(db, id) {
  const acc = db.prepare('SELECT id, country FROM email_accounts WHERE id = ?').get(id);
  if (!acc) return null;
  const country = String(acc.country || process.env.GMX_PROXY_COUNTRY || 'at').trim().toLowerCase();
  const url = assignUnusedProxy(db, { country, purpose: 'register' });
  if (!url) return null;
  db.prepare('UPDATE email_accounts SET proxy = ? WHERE id = ?').run(url, id);
  return url;
}

export function setEmailStatus(db, id, status) {
  db.prepare('UPDATE email_accounts SET status = ? WHERE id = ?').run(status, id);
}

export function saveEmailCookies(db, id, cookies) {
  if (!id) return;
  db.prepare("UPDATE email_accounts SET cookies = ?, cookies_updated_at = datetime('now'), last_login_at = datetime('now') WHERE id = ?").run(JSON.stringify(cookies || []), id);
}

export function clearEmailCookies(db, id) {
  db.prepare('UPDATE email_accounts SET cookies = NULL, cookies_updated_at = NULL WHERE id = ?').run(id);
}
