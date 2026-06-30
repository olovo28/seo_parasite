// Жизненный цикл регистрации аккаунта на сайте (site_registrations). Одна почта = одна регистрация.

function toReg(r) {
  if (!r) return null;
  let identity = null;
  try {
    identity = r.identity ? JSON.parse(r.identity) : null;
  } catch {
    identity = null;
  }
  return { ...r, identity };
}

export function getRegistration(db, id) {
  return toReg(db.prepare('SELECT * FROM site_registrations WHERE id = ?').get(id));
}

export function getRegistrationByEmail(db, emailAccountId) {
  return toReg(db.prepare('SELECT * FROM site_registrations WHERE email_account_id = ?').get(emailAccountId));
}

// Регистрации сайта (с email для отображения).
export function listRegistrations(db, siteId, { limit = 100 } = {}) {
  return db
    .prepare(
      `SELECT r.*, e.email AS email, e.provider AS provider
       FROM site_registrations r JOIN email_accounts e ON e.id = r.email_account_id
       WHERE r.site_id = ? ORDER BY r.id DESC LIMIT ?`,
    )
    .all(siteId, limit)
    .map(toReg);
}

export function createRegistration(db, { siteId, emailAccountId, identity, siteUsername, sitePassword } = {}) {
  return db
    .prepare(
      `INSERT INTO site_registrations (site_id, email_account_id, identity, site_username, site_password, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
    )
    .run(siteId, emailAccountId, identity ? JSON.stringify(identity) : null, siteUsername || null, sitePassword || null).lastInsertRowid;
}

// Частичное обновление полей регистрации (+ updated_at). Поддерживаемые ключи — белый список.
export function updateRegistration(db, id, fields = {}) {
  const allowed = ['status', 'confirm_url', 'next_check_at', 'checks', 'account_id', 'error', 'site_username', 'site_password', 'identity', 'submitted_at', 'approved_at', 'last_checked_at'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      vals.push(k === 'identity' && fields[k] && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  db.prepare(`UPDATE site_registrations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// Регистрации, которым подошло время проверки одобрения админом (для планировщика).
export function dueApprovalChecks(db, nowUtc) {
  return db
    .prepare(
      `SELECT r.id FROM site_registrations r JOIN sites s ON s.id = r.site_id
       WHERE r.status = 'awaiting_admin' AND r.next_check_at IS NOT NULL AND r.next_check_at <= ? AND s.active = 1
       ORDER BY r.next_check_at, r.id`,
    )
    .all(nowUtc);
}
