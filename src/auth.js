import crypto from 'node:crypto';

const SESSION_HOURS = 12;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split(':');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function createSession(db, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', ?))`).run(
    id, userId, `+${SESSION_HOURS} hours`,
  );
  return id;
}

export function loadSession(db, id) {
  if (!id) return null;
  const row = db.prepare(`
    SELECT s.id, s.company_id, u.id AS user_id, u.username, u.display_name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1`).get(id);
  if (!row) return null;
  db.prepare(`UPDATE sessions SET expires_at = datetime('now', ?) WHERE id = ?`).run(`+${SESSION_HOURS} hours`, id);
  return {
    id: row.id,
    companyId: row.company_id,
    user: { id: row.user_id, username: row.username, display_name: row.display_name, role: row.role },
  };
}

export function destroySession(db, id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// Companies the user may switch to. Admins: all active companies.
export function accessibleCompanies(db, user) {
  const cols = `c.id, c.code, c.name_ar, c.name_en, c.logo_file_id, c.color_primary, c.color_secondary,
                c.color_accent, c.color_ink, c.updated_at`;
  if (user.role === 'admin') {
    return db.prepare(`SELECT ${cols} FROM companies c WHERE c.is_active = 1 ORDER BY c.sort_order, c.id`).all();
  }
  return db.prepare(`
    SELECT ${cols} FROM companies c JOIN user_companies uc ON uc.company_id = c.id
    WHERE uc.user_id = ? AND c.is_active = 1 ORDER BY c.sort_order, c.id`).all(user.id);
}
