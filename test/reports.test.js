// Reports centre: the weekly team report shows who did what (personal accounts), open tasks by
// owner, and exports as Excel or a printable page. Company-scoped. Fake data in a temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { weekOf } from '../src/reports.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-rep-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, A, B, admin, sara;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body, { raw = false, noCompany = false } = {}) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId && !noCompany ? { 'X-Company-Id': String(companyId) } : {}) }, body: body && JSON.stringify(body) });
    if (raw) return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) };
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  call.useCompany = async (id) => { await call('POST', '/api/session/company', { company_id: id }); companyId = id; };
  return call;
}
const ok = (r) => { assert.ok(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };

before(async () => {
  ({ creds } = seed({ dbFile, storageDir, demo: false, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin', creds.admin);
  await admin.useCompany(A);
  // Sara: a team member with her own account
  const m = ok(await admin('POST', '/api/admin/procedures/members', { name: 'سارة' })).members.find((x) => x.name === 'سارة');
  const acc = ok(await admin('POST', `/api/admin/team/${m.id}/account`, { username: 'sara' }));
  sara = await login('sara', acc.temporary_password);
  ok(await sara('POST', '/api/account/password', { current_password: acc.temporary_password, new_password: 'SaraPass2026' }));
  await sara.useCompany(A);
  // Sara onboards a new employee and finishes one step, assigned to herself
  const r = ok(await sara('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'موظف جديد للتقرير', hire_date: today }, case: {} }));
  const full = r;
  const [s1, s2] = full.steps.filter((s) => s.status === 'pending');
  ok(await sara('PATCH', `/api/procedures/steps/${s1.id}`, { owner_member_id: m.id }));
  ok(await sara('PATCH', `/api/procedures/steps/${s1.id}`, { status: 'done', done_date: today }));
  ok(await sara('PATCH', `/api/procedures/steps/${s2.id}`, { owner_member_id: m.id }));
  // the Admin adds an employee directly
  ok(await admin('POST', '/api/records/employees', { full_name_ar: 'موظف أضافته المسؤولة' }));
});
after(() => { server.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('weeks run Sunday to Saturday', () => {
  assert.deepEqual(weekOf('2026-11-18'), { from: '2026-11-15', to: '2026-11-21' }); // Wednesday
  assert.deepEqual(weekOf('2026-11-15'), { from: '2026-11-15', to: '2026-11-21' }); // Sunday
  assert.deepEqual(weekOf('2026-11-21'), { from: '2026-11-15', to: '2026-11-21' }); // Saturday
});

test('the weekly report shows each person and what they did', async () => {
  const w = ok(await sara('GET', `/api/reports/weekly?week=${today}`));
  const s = w.people.find((p) => p.user === 'سارة');
  const a = w.people.find((p) => p.user === 'مسؤول النظام');
  assert.ok(s && a, 'both people appear under their own names');
  assert.equal(s.done_tasks, 1, 'the finished step counts as a task she completed');
  assert.ok(s.items.some((i) => i.action === 'إنجاز إجراء' && i.subject === 'موظف جديد للتقرير'));
  assert.ok(s.items.some((i) => i.source === 'employees' && i.action === 'إضافة موظف'));
  assert.ok(a.items.some((i) => i.subject === 'موظف أضافته المسؤولة'));
  assert.ok(s.by_source['متابعة الإجراءات'] >= 3);
  // open tasks by owner
  assert.equal(w.owners.find((o) => o.owner === 'سارة').open, 1);
  assert.ok(w.owners.some((o) => o.owner === 'بدون مسؤول'));
  assert.equal(w.totals.done_tasks, 1);
  // a past week with nothing in it
  const old = ok(await sara('GET', '/api/reports/weekly?week=2020-01-08'));
  assert.equal(old.totals.actions, 0);
  assert.equal((await sara('GET', '/api/reports/weekly?from=2020-01-01&to=2022-01-01')).status, 400, 'at most one year');
});

test('Excel and printable (PDF) outputs', async () => {
  for (const url of [`/api/reports/weekly.xlsx?week=${today}`, '/api/reports/employees.xlsx', `/api/reports/movements.xlsx?from=${today}&to=${today}`, `/api/reports/activity.xlsx?from=${today}&to=${today}`]) {
    const r = await sara('GET', url, null, { raw: true });
    assert.equal(r.status, 200, url);
    assert.match(r.type, /spreadsheetml/);
    assert.equal(r.buf.subarray(0, 2).toString(), 'PK', 'a real .xlsx (zip) file');
  }
  // print pages are opened in a new tab: the company comes in the address instead of a header
  const p = await sara('GET', `/api/reports/weekly/print?week=${today}&company=${A}`, null, { raw: true, noCompany: true });
  assert.equal(p.status, 200);
  assert.match(p.type, /text\/html/);
  const html = p.buf.toString();
  assert.ok(html.includes('سارة') && html.includes('موظف جديد للتقرير') && html.includes('window.print'));
  const mv = (await sara('GET', `/api/reports/movements/print?from=${today}&to=${today}&company=${A}`, null, { raw: true, noCompany: true })).buf.toString();
  assert.ok(mv.includes('موظف جديد للتقرير'), 'new starter listed');
  const emp = (await sara('GET', `/api/reports/employees/print?status=onboarding&company=${A}`, null, { raw: true, noCompany: true })).buf.toString();
  assert.ok(emp.includes('موظف جديد للتقرير') && !emp.includes('موظف أضافته المسؤولة'), 'status filter');
  // a stale company in the address is refused, like the header
  assert.equal((await sara('GET', `/api/reports/weekly/print?company=${B}`, null, { raw: true, noCompany: true })).status, 409);
});

test('each company sees only its own activity', async () => {
  await admin.useCompany(B);
  const w = ok(await admin('GET', `/api/reports/weekly?week=${today}`));
  assert.equal(w.totals.actions, 0);
  assert.equal(w.open_tasks.length, 0);
  await admin.useCompany(A);
});
