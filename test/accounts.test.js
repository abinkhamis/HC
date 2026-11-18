// Personal team accounts («فريق الإدارة»): same team role for everyone, admin work stays with the Admin,
// a temporary password must be changed first, and every action is recorded under the person who did it.
// Fake data only, in a temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-acc-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, A, B, admin;

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  if (res.status !== 200) return { status: res.status };
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  call.useCompany = async (id) => { const r = await call('POST', '/api/session/company', { company_id: id }); companyId = id; return r; };
  call.status = 200;
  return call;
}
const ok = (r) => { assert.ok(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const member = async (name) => ok(await admin('POST', '/api/admin/procedures/members', { name })).members.find((m) => m.name === name);

before(async () => {
  ({ creds } = seed({ dbFile, storageDir, demo: false, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = await login('admin', creds.admin);
  await admin.useCompany(A);
});
after(() => { server.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

let sara, saraPw;
test('the Admin creates a personal account; the temporary password must be changed before anything else', async () => {
  const m = await member('سارة التجريبية');
  const bad = await admin('POST', `/api/admin/team/${m.id}/account`, { username: 'سارة' });
  assert.equal(bad.status, 400, 'English usernames only');
  assert.equal((await admin('POST', `/api/admin/team/${m.id}/account`, { username: 'admin' })).status, 409, 'username already taken');
  const r = ok(await admin('POST', `/api/admin/team/${m.id}/account`, { username: 'Sara.Test' }));
  assert.equal(r.username, 'sara.test');
  assert.ok(r.temporary_password.length >= 12);
  assert.equal((await admin('POST', `/api/admin/team/${m.id}/account`, { username: 'sara2' })).status, 409, 'one account per member');
  const row = db.prepare("SELECT role, must_change_password, password_hash FROM users WHERE username = 'sara.test'").get();
  assert.equal(row.role, 'team');
  assert.equal(row.must_change_password, 1);
  assert.ok(!row.password_hash.includes(r.temporary_password), 'only a hash is stored');

  sara = await login('sara.test', r.temporary_password);
  assert.equal(sara.status, 200);
  const s = ok(await sara('GET', '/api/session'));
  assert.equal(s.user.must_change_password, true);
  assert.equal(s.companies.length, 1, 'access to the company of the team list only');
  const blocked = await sara('GET', '/api/records/employees');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');

  assert.equal((await sara('POST', '/api/account/password', { current_password: 'wrong', new_password: 'Abcdefgh1234' })).status, 400);
  assert.equal((await sara('POST', '/api/account/password', { current_password: r.temporary_password, new_password: 'short1' })).status, 400);
  assert.equal((await sara('POST', '/api/account/password', { current_password: r.temporary_password, new_password: 'onlyletterspassword' })).status, 400);
  saraPw = 'NewPass2026xyz';
  ok(await sara('POST', '/api/account/password', { current_password: r.temporary_password, new_password: saraPw }));
  assert.equal(ok(await sara('GET', '/api/session')).user.must_change_password, false);
  await sara.useCompany(A);
  assert.equal((await sara('GET', '/api/records/employees')).status, 200);
});

test('every team account has the same team rights: tools yes, administration no', async () => {
  const emp = ok(await sara('POST', '/api/records/employees', { full_name_ar: 'موظف أضافته سارة' }));
  assert.ok(emp.id);
  for (const [method, url, body] of [
    ['GET', '/api/admin/users'], ['POST', '/api/admin/procedures/members', { name: 'x' }],
    ['POST', '/api/admin/air-tickets/policy', { cycle_months: 12 }], ['POST', '/api/admin/attestations/policy', { free_per_year: 5 }],
    ['POST', `/api/admin/users/1/reset-password`], ['POST', '/api/admin/team/1/account', { username: 'zz1' }],
  ]) assert.equal((await sara(method, url, body)).status, 403, `${method} ${url} is admin only`);
  // the change is recorded under her own name, not a shared account
  const ev = db.prepare(`SELECT u.display_name FROM employee_events e JOIN users u ON u.id = e.user_id WHERE e.employee_id = ? ORDER BY e.id LIMIT 1`).get(emp.id);
  assert.equal(ev.display_name, 'سارة التجريبية');
  // she cannot open the other company
  assert.equal((await sara('POST', '/api/session/company', { company_id: B })).status, 403);
});

test('reset and stop: a new temporary password signs her out; a stopped account cannot sign in', async () => {
  const id = db.prepare("SELECT id FROM users WHERE username = 'sara.test'").get().id;
  const r = ok(await admin('POST', `/api/admin/users/${id}/reset-password`));
  assert.equal((await sara('GET', '/api/session')).status, 401, 'old session ended');
  assert.equal((await login('sara.test', saraPw)).status, 401, 'old password no longer works');
  sara = await login('sara.test', r.temporary_password);
  assert.equal(ok(await sara('GET', '/api/session')).user.must_change_password, true);
  ok(await sara('POST', '/api/account/password', { current_password: r.temporary_password, new_password: saraPw }));

  ok(await admin('POST', `/api/admin/users/${id}/active`, { is_active: false }));
  assert.equal((await sara('GET', '/api/session')).status, 401);
  assert.equal((await login('sara.test', saraPw)).status, 401);
  ok(await admin('POST', `/api/admin/users/${id}/active`, { is_active: true }));
  assert.equal((await login('sara.test', saraPw)).status, 200);
  // the Admin account itself cannot be stopped or reset from here
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  assert.equal((await admin('POST', `/api/admin/users/${adminId}/active`, { is_active: false })).status, 403);
  assert.equal((await admin('POST', `/api/admin/users/${adminId}/reset-password`)).status, 403);
});

test('the Admin is also a member of the team; the same person can be linked in the other company', async () => {
  const me = await member('المسؤولة (أنا)');
  ok(await admin('POST', `/api/admin/team/${me.id}/link`, { user_id: 'me' }));
  let list = ok(await admin('GET', '/api/procedures/lists')).members;
  assert.equal(list.find((m) => m.id === me.id).account_role, 'admin');
  // an account is linked to one name per company
  const other = await member('اسم آخر');
  assert.equal((await admin('POST', `/api/admin/team/${other.id}/link`, { user_id: 'me' })).status, 409);
  // her own password change works for the Admin too, and other admin sessions keep working on this device
  // Sara added to company B's team gets access to B as well
  await admin.useCompany(B);
  const saraId = db.prepare("SELECT id FROM users WHERE username = 'sara.test'").get().id;
  const mb = ok(await admin('POST', '/api/admin/procedures/members', { name: 'سارة التجريبية' })).members[0];
  // a member of company A cannot be reached while company B is selected
  const aMember = db.prepare('SELECT id FROM proc_team_members WHERE company_id = ? AND user_id IS NULL LIMIT 1').get(A);
  assert.equal((await admin('POST', `/api/admin/team/${aMember.id}/account`, { username: 'cross1' })).status, 404);
  ok(await admin('POST', `/api/admin/team/${mb.id}/link`, { user_id: saraId }));
  sara = await login('sara.test', saraPw);
  assert.equal(ok(await sara('GET', '/api/session')).companies.length, 2);
  list = ok(await admin('GET', '/api/procedures/lists')).members;
  assert.equal(list[0].username, 'sara.test');
  ok(await admin('POST', `/api/admin/team/${mb.id}/unlink`));
  assert.equal(ok(await admin('GET', '/api/procedures/lists')).members[0].user_id, null);
  await admin.useCompany(A);
});

test('the Admin can rename a company; the team cannot; a name cannot be empty', async () => {
  const before = db.prepare('SELECT code, name_ar FROM companies WHERE id = ?').get(B);
  assert.equal((await sara('PATCH', `/api/admin/companies/${B}`, { name_ar: 'x' })).status, 403);
  assert.equal((await admin('PATCH', `/api/admin/companies/${B}`, { name_ar: '  ' })).status, 400);
  ok(await admin('PATCH', `/api/admin/companies/${B}`, { name_ar: 'اسم جديد للشركة', name_en: 'New Company Name' }));
  const after = db.prepare('SELECT code, name_ar, name_en FROM companies WHERE id = ?').get(B);
  assert.deepEqual([after.name_ar, after.name_en, after.code], ['اسم جديد للشركة', 'New Company Name', before.code], 'the code never changes');
  ok(await admin('PATCH', `/api/admin/companies/${B}`, { name_ar: before.name_ar }));
});

test('repeated wrong passwords lock the name for a while; a secure cookie over HTTPS', async () => {
  const tryLogin = (username, password, headers = {}) => fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub', ...headers }, body: JSON.stringify({ username, password }) });
  for (let i = 0; i < 5; i++) assert.equal((await tryLogin('sara.test', 'wrong-' + i)).status, 401);
  const locked = await tryLogin('sara.test', saraPw);
  assert.equal(locked.status, 429, 'even the right password waits while locked');
  assert.equal((await locked.json()).code, 'login_locked');
  // another address is not locked by these attempts (only 5 < the per-name limit)
  const other = await tryLogin('sara.test', saraPw, { 'X-Forwarded-For': '203.0.113.9' });
  assert.equal(other.status, 200);
  // behind an HTTPS proxy the session cookie is Secure and HSTS is sent
  const https = await tryLogin('admin', creds.admin, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.10' });
  assert.equal(https.status, 200);
  assert.match(https.headers.get('set-cookie'), /; Secure/);
  assert.match(https.headers.get('strict-transport-security') || '', /max-age=/);
  const plain = await tryLogin('admin', creds.admin, { 'X-Forwarded-For': '203.0.113.11' });
  assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/);
});
