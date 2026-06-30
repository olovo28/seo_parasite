// Ротация API-ключей Claude по принципу least-recently-used.

import { getDb } from '../db/db.js';

// Атомарно «захватить» включённый ключ, который дольше всех не использовался (без last_used_at — первыми),
// СРАЗУ отметив его использованным. Один UPDATE…RETURNING → параллельные вызовы получают РАЗНЫЕ ключи
// (раньше pick и mark были разнесены: параллельные генерации брали один «давний» ключ → дисбаланс/рейт-лимит).
// Отметка при захвате означает, что упавший/залимиченный ключ не выберется сразу снова. null — если ключей нет.
export function pickKey() {
  return (
    getDb()
      .prepare(`
        UPDATE claude_keys SET last_used_at = datetime('now')
        WHERE id = (
          SELECT id FROM claude_keys
          WHERE enabled = 1
          ORDER BY (last_used_at IS NOT NULL), last_used_at ASC, id ASC
          LIMIT 1
        )
        RETURNING *
      `)
      .get() ?? null
  );
}

// Отметить ключ использованным (двигает в конец ротации). pickKey уже метит при захвате; этот вызов —
// «освежить» отметку после успешной работы (на случай долгой генерации). Идемпотентно.
export function markKeyUsed(id) {
  getDb().prepare("UPDATE claude_keys SET last_used_at = datetime('now') WHERE id = ?").run(id);
}
