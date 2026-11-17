// Verifies company data separation at the database, repository and HTTP levels.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { tenantRepo } from '../src/tenancy.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, A, B, seeded;

before(async () => {
  ({ creds, db: seeded } = seed({ dbFile, storageDir, demo: true, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body, extra = {}) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}), ...extra }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  call.setCompany = (id) => (companyId = id);
  return call;
}

test('repository only returns rows of its own company', () => {
  const ra = tenantRepo(db, A), rb = tenantRepo(db, B);
  assert.ok(ra.list('employees').length > 0);
  assert.ok(ra.list('employees').every((e) => e.company_id === A));
  assert.ok(rb.list('employees').every((e) => e.company_id === B));
  const bEmp = rb.list('employees')[0];
  assert.throws(() => ra.get('employees', bEmp.id), /غير موجود/);
  assert.throws(() => ra.update('employees', bEmp.id, { job_title: 'x' }), /غير موجود/);
});

test('insert ignores a client-supplied company_id', () => {
  const r = tenantRepo(db, A).create('employees', { full_name_ar: 'محاولة', company_id: B });
  assert.equal(r.company_id, A);
});

test('database rejects linking a record to another company\'s employee', () => {
  const bEmp = tenantRepo(db, B).list('employees')[0];
  assert.throws(() => tenantRepo(db, A).create('tickets', { subject: 'x', employee_id: bEmp.id }), /الشركة الحالية/);
  assert.throws(() => db.prepare('INSERT INTO tickets (company_id, subject, employee_id) VALUES (?, ?, ?)').run(A, 'raw', bEmp.id), /FOREIGN KEY/);
});

test('database forbids moving a record between companies', () => {
  const e = tenantRepo(db, A).list('employees')[0];
  assert.throws(() => db.prepare('UPDATE employees SET company_id = ? WHERE id = ?').run(B, e.id), /immutable/);
});

test('database forbids issuing a letter with another company\'s template', () => {
  const fileB = Number(db.prepare(`INSERT INTO files (company_id, kind, original_name, mime, size, sha256, storage_path) VALUES (?, 'template', 'b.docx', 'x', 1, 'x', 'x')`).run(B).lastInsertRowid);
  const typeId = db.prepare('SELECT id FROM letter_types LIMIT 1').get().id;
  const tplB = Number(db.prepare('INSERT INTO letter_templates (company_id, letter_type_id, file_id, version) VALUES (?, ?, ?, 1)').run(B, typeId, fileB).lastInsertRowid);
  const empA = tenantRepo(db, A).list('employees')[0];
  assert.throws(() => db.prepare('INSERT INTO issued_letters (company_id, employee_id, letter_type_id, template_id) VALUES (?, ?, ?, ?)').run(A, empA.id, typeId, tplB), /FOREIGN KEY/);
  // and a template file must belong to the template's company
  const fileA = Number(db.prepare(`INSERT INTO files (company_id, kind, original_name, mime, size, sha256, storage_path) VALUES (?, 'template', 'a.docx', 'x', 1, 'x', 'x')`).run(A).lastInsertRowid);
  assert.throws(() => db.prepare('INSERT INTO letter_templates (company_id, letter_type_id, file_id, version, is_active) VALUES (?, ?, ?, 9, 0)').run(B, typeId, fileA), /FOREIGN KEY/);
});

test('HTTP: switching company changes the data returned; stale tab is refused', async () => {
  const team = await login('hcteam', creds.team);
  const s = await team('GET', '/api/session');
  assert.equal(s.body.companies.length, 2);
  team.setCompany(s.body.current_company_id);
  const first = await team('GET', '/api/records/employees');
  assert.ok(first.body.rows.every((r) => r.company_id === s.body.current_company_id));

  const other = s.body.companies.find((c) => c.id !== s.body.current_company_id).id;
  assert.equal((await team('POST', '/api/session/company', { company_id: other })).status, 200);
  // page still claims the old company -> refused
  const stale = await team('GET', '/api/records/employees');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'company_changed');
  team.setCompany(other);
  const second = await team('GET', '/api/records/employees');
  assert.ok(second.body.rows.length > 0 && second.body.rows.every((r) => r.company_id === other));

  const created = await team('POST', '/api/records/employees', { full_name_ar: 'جديد', company_id: s.body.current_company_id });
  assert.equal(created.status, 200);
  assert.equal(created.body.company_id, other);
});

test('HTTP: team account cannot change identity, templates, signatures or stamps', async () => {
  const team = await login('hcteam', creds.team);
  const s = await team('GET', '/api/session');
  team.setCompany(s.body.current_company_id);
  assert.equal(s.body.permissions.manage_branding, false);
  for (const [m, u, b] of [
    ['PATCH', `/api/admin/companies/${A}`, { colors: { primary: '#000000' } }],
    ['POST', `/api/admin/companies/${A}/logo`, { file: { filename: 'x.png', data: '' } }],
    ['POST', '/api/admin/companies', { code: 'x1', name_ar: 'x', name_en: 'x' }],
    ['POST', '/api/admin/templates', {}],
    ['POST', '/api/admin/assets', {}],
    ['GET', '/api/admin/templates'],
  ]) {
    assert.equal((await team(m, u, b)).status, 403, `${m} ${u}`);
  }
  // but can use the letters tool
  assert.equal((await team('GET', '/api/letters/catalog')).status, 200);
});

test('HTTP: admin can add a new company without code changes', async () => {
  const admin = await login('admin', creds.admin);
  const r = await admin('POST', '/api/admin/companies', { code: 'acme', name_ar: 'شركة ثالثة', name_en: 'Third Co' });
  assert.equal(r.status, 200);
  assert.equal(r.body.colors.primary, null); // no guessed colours
  const team = await login('hcteam', creds.team);
  assert.equal((await team('GET', '/api/session')).body.companies.length, 3);
});

test('HTTP: letter preview refuses an employee of another company', async () => {
  const team = await login('hcteam', creds.team);
  const s = await team('GET', '/api/session');
  await team('POST', '/api/session/company', { company_id: A });
  team.setCompany(A);
  const empB = tenantRepo(db, B).list('employees')[0];
  const typeId = db.prepare('SELECT id FROM letter_types LIMIT 1').get().id;
  const r = await team('POST', '/api/letters/preview', { letter_type_id: typeId, employee_id: empB.id });
  assert.equal(r.status, 404);
  assert.ok(s.body);
});
