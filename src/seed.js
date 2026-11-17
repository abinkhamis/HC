// First-run setup: creates initial companies, letter types, an Admin account and
// a shared team account. Generated passwords are written to data/INITIAL_CREDENTIALS.txt.
// Usage: npm run seed              (empty operational records)
//        npm run seed -- --demo    (clearly-marked demo records, for test environments only)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import { hashPassword } from './auth.js';
import { saveFile, IMAGE_TYPES } from './files.js';
import { tenantRepo } from './tenancy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function seed({ dbFile = path.join(ROOT, 'data', 'hub.db'), storageDir = path.join(ROOT, 'storage'), demo = true, writeCredentials = true, adminPassword, teamPassword } = {}) {
  const db = openDb(dbFile);
  if (db.prepare('SELECT COUNT(*) n FROM companies').get().n > 0) {
    console.log('Database already initialised — nothing to do.');
    return { db };
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'seed', 'companies.json'), 'utf8'));
  const pw = () => crypto.randomBytes(9).toString('base64url');
  const creds = { admin: adminPassword || pw(), team: teamPassword || pw() };

  tx(db, () => {
    const adminId = Number(db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('admin', 'مسؤول النظام', ?, 'admin')`).run(hashPassword(creds.admin)).lastInsertRowid);
    const teamId = Number(db.prepare(`INSERT INTO users (username, display_name, password_hash, role) VALUES ('hcteam', 'فريق رأس المال البشري', ?, 'team')`).run(hashPassword(creds.team)).lastInsertRowid);

    cfg.companies.forEach((c, i) => {
      const id = Number(db.prepare(`INSERT INTO companies (code, name_ar, name_en, color_primary, color_secondary, color_accent, color_ink, color_source, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.code, c.name_ar, c.name_en, c.colors.primary, c.colors.secondary, c.colors.accent, c.colors.ink, c.color_source, i + 1).lastInsertRowid);
      if (c.logo) {
        const p = path.join(ROOT, 'seed', c.logo);
        const fileId = saveFile(db, storageDir, { companyId: id, kind: 'logo', filename: path.basename(p), buffer: fs.readFileSync(p), allowed: IMAGE_TYPES, userId: adminId });
        db.prepare('UPDATE companies SET logo_file_id = ? WHERE id = ?').run(fileId, id);
      }
      db.prepare('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)').run(teamId, id);

      if (demo) {
        const repo = tenantRepo(db, id);
        const tag = c.name_en.split(' ')[0];
        const e1 = repo.create('employees', { employee_no: `${c.code.toUpperCase()}-001`, full_name_ar: `موظف تجريبي ١ — ${c.name_ar}`, job_title: 'أخصائي موارد بشرية', department: 'رأس المال البشري', hire_date: '2024-01-15' }, adminId);
        repo.create('employees', { employee_no: `${c.code.toUpperCase()}-002`, full_name_ar: `موظف تجريبي ٢ — ${c.name_ar}`, job_title: 'محاسب', department: 'المالية', hire_date: '2023-06-01' }, adminId);
        const k = repo.create('consultants', { full_name_ar: `استشاري تجريبي — ${c.name_ar}`, gender: 'male', nationality_ar: 'سعودي', mobile: '0500000000' }, adminId);
        const cc = Number(db.prepare(`INSERT INTO consulting_contracts (company_id, contract_no, consultant_id, project_name, status, contract_date, start_date, end_date, signed_at, created_by)
          VALUES (?, ?, ?, 'مشروع تجريبي', 'active', '2026-10-01', '2026-10-01', '2027-03-31', '2026-10-01', ?)`).run(id, `${c.code.toUpperCase()}/CC/DEMO/0001`, k.id, adminId).lastInsertRowid);
        db.prepare(`INSERT INTO contract_deliverables (company_id, contract_id, seq, title, amount, due_date, period_from, period_to) VALUES
          (?, ?, 1, 'المخرج الأول (تجريبي)', 10000, '2026-11-30', '2026-10-01', '2026-11-30'),
          (?, ?, 2, 'المخرج الثاني (تجريبي)', 15000, '2027-03-31', '2026-12-01', '2027-03-31')`).run(id, cc, id, cc);
        repo.create('tickets', { ticket_no: `${tag}-T-01`, subject: `تذكرة تجريبية — ${c.name_ar}`, employee_id: e1.id, category: 'travel' }, adminId);
      }
    });

    for (const t of cfg.letter_types) {
      db.prepare('INSERT INTO letter_types (code, name_ar, name_en) VALUES (?, ?, ?)').run(t.code, t.name_ar, t.name_en);
    }
  });

  if (writeCredentials) {
    const out = path.join(path.dirname(dbFile), 'INITIAL_CREDENTIALS.txt');
    fs.writeFileSync(out, [
      'HC Operations Hub — initial accounts (change these after first login; delete this file once stored safely)',
      '',
      `Admin  : admin  / ${creds.admin}`,
      `Team   : hcteam / ${creds.team}`,
      '',
    ].join('\n'));
    console.log(`Seeded. Initial credentials written to ${out}`);
  }
  return { db, creds };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--data-dir');
  const dataDir = i > 0 ? path.resolve(process.argv[i + 1]) : null;
  seed({ demo: process.argv.includes('--demo'), ...(dataDir ? { dbFile: path.join(dataDir, 'hub.db'), storageDir: path.join(dataDir, 'storage') } : {}) });
}
