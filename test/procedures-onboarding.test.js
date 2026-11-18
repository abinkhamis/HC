// New onboarding in one step + per-step owners — fake data in a separate temporary test database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-onb-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  call.useCompany = async (id) => { await call('POST', '/api/session/company', { company_id: id }); companyId = id; };
  return call;
}
const ok = (r) => { assert.ok(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const empCount = () => db.prepare('SELECT COUNT(*) n FROM employees').get().n;
const caseCount = () => db.prepare('SELECT COUNT(*) n FROM proc_cases').get().n;
const onboard = (who, employee, extra = {}) => who('POST', '/api/procedures/onboarding', { employee: { hire_date: today, ...employee }, case: {}, ...extra });

before(async () => {
  ({ creds, db: seeded } = seed({ dbFile, storageDir, demo: false, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  team = await login('hcteam', creds.team);
  admin = await login('admin', creds.admin);
  await team.useCompany(A);
  await admin.useCompany(A);
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('new employee + onboarding case created together, with the steps ready', async () => {
  const e0 = empCount();
  const c = ok(await onboard(team, { full_name_ar: 'موظف اختبار جديد', employee_no: 'T-100', national_id: '2000000001', nationality_ar: 'مصري', gender: 'male', job_title: 'محلل', department: 'إدارة اختبار' }));
  assert.equal(empCount(), e0 + 1);
  assert.match(c.case_no, /\/ONB\//);
  assert.equal(c.key_date, today);
  assert.equal(c.steps.length, 12, 'onboarding steps available immediately');
  assert.equal(c.steps.find((s) => s.name_ar === 'التسجيل في الدعم').status, 'na', 'non-Saudi rules applied');
  assert.ok(c.events.some((e) => e.event === 'employee_created'));
  // the directory record is the single source: other tools read it without re-entry
  const emp = ok(await team('GET', `/api/records/employees/${c.employee_id}`));
  assert.equal(emp.full_name_ar, 'موظف اختبار جديد');
  assert.equal(emp.hire_date, today);
  assert.equal(emp.status, 'onboarding', 'added by recruitment → «قيد الانضمام» until the start is confirmed');
  const air = ok(await team('GET', '/api/air-tickets/balances'));
  assert.ok(air.some((r) => r.employee.id === c.employee_id), 'appears in air tickets (non-Saudi) with no re-entry');
});

test('no duplicate employees: same employee number or ID is refused; same name needs confirmation', async () => {
  const e0 = empCount(); const c0 = caseCount();
  const r1 = await onboard(team, { full_name_ar: 'اسم آخر', employee_no: 't-100' });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'employee_no_taken', 'same number (case/spaces ignored) → refused with a link to the existing record');
  assert.equal(r1.body.details.full_name_ar, 'موظف اختبار جديد');
  const r2 = await onboard(team, { full_name_ar: 'اسم ثالث', national_id: ' 2000000001 ' });
  assert.equal(r2.body.code, 'employee_exists');
  const r3 = await onboard(team, { full_name_ar: 'موظف  اختبار  جديد' });
  assert.equal(r3.body.code, 'possible_duplicate', 'same name (spacing ignored) → confirm first');
  assert.equal(empCount(), e0);
  assert.equal(caseCount(), c0);
  const match = ok(await team('GET', `/api/procedures/employee-match?employee_no=T-100`));
  assert.equal(match.length, 1);
  assert.deepEqual(match[0].matched_by, ['employee_no']);
  assert.ok(match[0].open_onboarding, 'shows the existing open onboarding case');
  const forced = ok(await onboard(team, { full_name_ar: 'موظف اختبار جديد' }, { confirm_new_employee: true }));
  assert.equal(empCount(), e0 + 1);
  assert.notEqual(forced.employee_id, match[0].id);
  // Arabic letter variants count as the same name
  ok(await onboard(team, { full_name_ar: 'أحمد اختبار', employee_no: 'T-200' }));
  assert.equal((await onboard(team, { full_name_ar: 'احمد اختبار' })).body.code, 'possible_duplicate');
});

test('all or nothing: if the case cannot be opened, no employee is created (and vice versa)', async () => {
  const e0 = empCount(); const c0 = caseCount();
  // invalid case data (project of an unknown id) → the employee insert is rolled back
  const r1 = await team('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'اختبار تراجع', employee_no: 'T-300', hire_date: today }, case: { project_id: 999999 } });
  assert.equal(r1.status, 400);
  // invalid employee data → no case
  const r2 = await onboard(team, { full_name_ar: 'اختبار تراجع ٢', gender: 'غير معروف' });
  assert.equal(r2.status, 400);
  const r3 = await onboard(team, { full_name_ar: 'اختبار بلا تاريخ', hire_date: '' });
  assert.equal(r3.status, 400);
  assert.equal(empCount(), e0);
  assert.equal(caseCount(), c0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM employees WHERE employee_no = 'T-300'").get().n, 0);
  // no orphan in either direction
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proc_cases c LEFT JOIN employees e ON e.company_id = c.company_id AND e.id = c.employee_id WHERE e.id IS NULL').get().n, 0);
});

test('existing employee is picked directly without creating a new record', async () => {
  const existing = ok(await team('POST', '/api/records/employees', { full_name_ar: 'موظف موجود سابقًا', nationality_ar: 'سعودي', hire_date: today }));
  const e0 = empCount();
  const c = ok(await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: existing.id }));
  assert.equal(c.employee_id, existing.id);
  assert.equal(empCount(), e0);
});

test('each step can have its own owner from the team list', async () => {
  assert.equal((await team('POST', '/api/admin/procedures/members', { name: 'عضو اختبار' })).status, 403, 'team cannot edit the members list');
  const l = ok(await admin('POST', '/api/admin/procedures/members', { name: 'عضو اختبار ١' }));
  ok(await admin('POST', '/api/admin/procedures/members', { name: 'عضو اختبار ٢' }));
  assert.equal((await admin('POST', '/api/admin/procedures/members', { name: 'عضو اختبار ١' })).status, 409);
  const [m1, m2] = ok(await team('GET', '/api/procedures/lists')).members;
  void l;
  const c = ok(await team('GET', '/api/procedures/cases?case_type=onboarding'))[0];
  const full = ok(await team('GET', `/api/procedures/cases/${c.id}`));
  const [s1, s2] = full.steps.filter((s) => s.status === 'pending');
  ok(await team('PATCH', `/api/procedures/steps/${s1.id}`, { owner_member_id: m1.id }));
  const after2 = ok(await team('PATCH', `/api/procedures/steps/${s2.id}`, { owner_member_id: m2.id }));
  assert.equal(after2.steps.find((s) => s.id === s1.id).owner_name, 'عضو اختبار ١');
  assert.equal(after2.steps.find((s) => s.id === s2.id).owner_name, 'عضو اختبار ٢');
  assert.ok(after2.events.some((e) => e.event === 'step_updated' && JSON.parse(e.changes_json || '{}').owner_member_id?.[1] === 'عضو اختبار ٢'), 'log shows the name');
  const mine = ok(await team('GET', `/api/procedures/outstanding?owner_member_id=${m1.id}`));
  assert.deepEqual(mine.map((x) => x.id), [s1.id]);
  const s = ok(await team('GET', '/api/procedures/summary'));
  assert.ok(s.by_owner.some((o) => o.label === 'عضو اختبار ١' && o.pending === 1));
  assert.ok(s.by_owner.some((o) => o.label === 'بدون مسؤول'));
  // an id that is not in the company's team list is refused
  assert.equal((await team('PATCH', `/api/procedures/steps/${s1.id}`, { owner_member_id: 999999 })).status, 400);
  // «فريق الإدارة»: optional job title, and a count of open tasks per person
  let members = ok(await admin('PATCH', `/api/admin/procedures/members/${m1.id}`, { job_title: 'أخصائي موارد بشرية' })).members;
  assert.equal(members.find((m) => m.id === m1.id).job_title, 'أخصائي موارد بشرية');
  members = ok(await team('GET', '/api/procedures/lists')).members;
  assert.equal(members.find((m) => m.id === m1.id).open_tasks, 1);
  assert.equal(members.find((m) => m.id === m2.id).open_tasks, 1);
  ok(await team('PATCH', `/api/procedures/steps/${s1.id}`, { status: 'done', done_date: '2026-01-05' }));
  members = ok(await team('GET', '/api/procedures/lists')).members;
  assert.equal(members.find((m) => m.id === m1.id).open_tasks, 0, 'a finished step is no longer an open task');
  assert.equal(ok(await admin('POST', '/api/admin/procedures/members', { name: 'عضو اختبار ٣', job_title: 'منسق' })).members.find((m) => m.name === 'عضو اختبار ٣').job_title, 'منسق');
  assert.equal((await team('PATCH', `/api/admin/procedures/members/${m1.id}`, { job_title: 'x' })).status, 403, 'team cannot edit the team list');
});

test('company separation for members and the new onboarding flow', async () => {
  const aMember = ok(await team('GET', '/api/procedures/lists')).members[0];
  const aEmp = db.prepare("SELECT * FROM employees WHERE company_id = ? AND employee_no = 'T-100'").get(A);
  const t2 = await login('hcteam', creds.team);
  await t2.useCompany(B);
  assert.equal(ok(await t2('GET', '/api/procedures/lists')).members.length, 0, 'Company B has its own (empty) team list');
  assert.equal(ok(await t2('GET', '/api/procedures/employee-match?employee_no=T-100')).length, 0, 'duplicate check never looks at the other company');
  const c = ok(await onboard(t2, { full_name_ar: 'موظف اختبار جديد', employee_no: 'T-100' }));
  assert.equal(db.prepare('SELECT company_id FROM employees WHERE id = ?').get(c.employee_id).company_id, B);
  assert.notEqual(c.employee_id, aEmp.id);
  assert.equal((await t2('PATCH', `/api/procedures/steps/${c.steps[0].id}`, { owner_member_id: aMember.id })).status, 400, 'member of the other company refused');
  assert.throws(() => db.prepare('UPDATE proc_case_steps SET owner_member_id = ? WHERE id = ?').run(aMember.id, c.steps[0].id), /FOREIGN KEY/);
});

test('migration: an existing steps table gains the owner column and keeps every row', async () => {
  const file = path.join(dir, 'legacy.db');
  let d = openDb(file);
  const co = d.prepare("INSERT INTO companies (code, name_ar, name_en) VALUES ('leg', 'قديمة', 'Legacy')").run().lastInsertRowid;
  const emp = d.prepare("INSERT INTO employees (company_id, full_name_ar) VALUES (?, 'موظف قديم')").run(co).lastInsertRowid;
  const cs = d.prepare("INSERT INTO proc_cases (company_id, case_no, case_type, employee_id, employee_name, nationality_class, key_date) VALUES (?, 'LEG/1', 'onboarding', ?, 'موظف قديم', 'unknown', ?)").run(co, emp, today).lastInsertRowid;
  d.prepare("INSERT INTO proc_case_steps (company_id, case_id, name_ar, status, notes) VALUES (?, ?, 'إجراء قديم', 'done', 'ملاحظة')").run(co, cs);
  // turn the table back into the pre-owner layout
  const cols = d.prepare('PRAGMA table_info(proc_case_steps)').all().map((c) => c.name).filter((c) => c !== 'owner_member_id');
  d.exec('PRAGMA foreign_keys = OFF');
  d.exec(`CREATE TABLE old_steps AS SELECT ${cols.join(', ')} FROM proc_case_steps; DROP TABLE proc_case_steps; ALTER TABLE old_steps RENAME TO proc_case_steps;`);
  d.close();
  d = openDb(file);
  const names = d.prepare('PRAGMA table_info(proc_case_steps)').all().map((c) => c.name);
  assert.ok(names.includes('owner_member_id'));
  const row = d.prepare('SELECT * FROM proc_case_steps').get();
  assert.equal(row.name_ar, 'إجراء قديم');
  assert.equal(row.notes, 'ملاحظة');
  assert.equal(d.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.throws(() => d.prepare('UPDATE proc_case_steps SET company_id = 999 WHERE id = ?').run(row.id), /immutable/, 'company lock restored');
  d.close();
});
