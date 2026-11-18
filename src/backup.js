// Full backup: one .zip with a consistent copy of the database and every uploaded file,
// so the platform can be restored anywhere (this computer, another one, or a server).
// Download: by the Admin from the screen, or automatically with a backup key (download only;
// the key cannot sign in or change anything). Only a hash of the key is stored.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeZip } from './docx/zip.js';
import { HttpError } from './errors.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Builds the backup zip from a database file (read-only) and the storage folder. */
export function buildBackup(dbFile, storageDir, { platform = 'HC Operations Hub' } = {}) {
  const tmp = path.join(os.tmpdir(), `hub-backup-${process.pid}-${Date.now()}.db`);
  try {
    const src = new DatabaseSync(dbFile, { readOnly: true });
    try { src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); } finally { src.close(); }
    const check = new DatabaseSync(tmp, { readOnly: true });
    let counts;
    try {
      if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('integrity check failed');
      counts = Object.fromEntries(['companies', 'users', 'employees', 'proc_cases', 'consulting_contracts', 'issued_letters']
        .map((t) => { try { return [t, check.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]; } catch { return [t, null]; } }));
    } finally { check.close(); }
    const entries = new Map();
    entries.set('data/hub.db', fs.readFileSync(tmp));
    const files = walk(storageDir);
    for (const f of files) entries.set('storage/' + path.relative(storageDir, f).split(path.sep).join('/'), fs.readFileSync(f));
    const manifest = {
      platform, created_at: new Date().toISOString(), files: files.length, counts,
      restore: 'Stop the platform, put data/hub.db and the storage folder in the data folder, then start it again.',
    };
    entries.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    return { zip: writeZip(entries), manifest };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

export function createBackups(db, { dbFile, storageDir }) {
  db.exec(`CREATE TABLE IF NOT EXISTS backup_keys (
    id INTEGER PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, created_by INTEGER REFERENCES users (id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT, revoked_at TEXT)`);

  const status = () => {
    const k = db.prepare('SELECT k.created_at, k.last_used_at, u.display_name AS created_by FROM backup_keys k LEFT JOIN users u ON u.id = k.created_by WHERE k.revoked_at IS NULL ORDER BY k.id DESC LIMIT 1').get();
    return { key: k ? { created_at: k.created_at, last_used_at: k.last_used_at, created_by: k.created_by } : null };
  };
  // One active key: a new one replaces the old one.
  function newKey(userId) {
    const key = 'hubbk_' + crypto.randomBytes(32).toString('base64url');
    db.prepare(`UPDATE backup_keys SET revoked_at = datetime('now') WHERE revoked_at IS NULL`).run();
    db.prepare('INSERT INTO backup_keys (key_hash, created_by) VALUES (?, ?)').run(sha(key), userId);
    return { key, status: status() };
  }
  function revoke() {
    db.prepare(`UPDATE backup_keys SET revoked_at = datetime('now') WHERE revoked_at IS NULL`).run();
    return status();
  }
  function checkKey(header) {
    const m = /^Bearer\s+(hubbk_[A-Za-z0-9_-]{20,})$/.exec(String(header || '').trim());
    const row = m && db.prepare('SELECT id FROM backup_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha(m[1]));
    if (!row) throw new HttpError(401, 'مفتاح النسخ الاحتياطي غير صالح.');
    db.prepare(`UPDATE backup_keys SET last_used_at = datetime('now') WHERE id = ?`).run(row.id);
  }
  const build = () => buildBackup(dbFile, storageDir);
  return { status, newKey, revoke, checkKey, build };
}
