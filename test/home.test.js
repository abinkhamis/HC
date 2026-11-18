// Home page data: this month's starters and leavers, deliverables due, and tasks that need action.
// Fake data in a temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-home-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, A, B, team;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const monthStart = today.slice(0, 8) + '01';

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

before(async () => {
  ({ creds } = seed({ dbFile, storageDir, demo: false, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  team = await login('hcteam', creds.team);
  await team.useCompany(A);
});
after(() => { server.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('an empty company has an empty, valid home page', async () => {
  const h = ok(await team('GET', '/api/home'));
  assert.equal(h.today, today);
  assert.equal(h.month.from, monthStart);
  assert.deepEqual([h.counts.starters, h.counts.leavers, h.counts.tickets_due, h.counts.deliverables_due, h.tasks.length], [0, 0, 0, 0, 0]);
});

test('starters this month with onboarding progress, and the start to confirm', async () => {
  const c = ok(await team('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'مباشر هذا الشهر', job_title: 'محلل', hire_date: monthStart }, case: {} }));
  // an employee hired last year is not a starter this month
  ok(await team('POST', '/api/records/employees', { full_name_ar: 'موظف قديم', hire_date: '2020-01-05', status: 'active' }));
  const h = ok(await team('GET', '/api/home'));
  assert.equal(h.counts.starters, 1);
  const s = h.starters[0];
  assert.equal(s.full_name_ar, 'مباشر هذا الشهر');
  assert.equal(s.case_id, c.id);
  assert.ok(s.progress.total > 0);
  // start date reached, start not confirmed: a task to confirm it
  if (monthStart <= today) assert.ok(h.tasks.some((t) => t.kind === 'confirm_start' && t.link === `#/procedures/case/${c.id}`));
});

test('a procedure step that is overdue is shown first as a late task', async () => {
  const c = db.prepare("SELECT id FROM proc_cases WHERE company_id = ? AND case_type = 'onboarding'").get(A);
  const step = db.prepare("SELECT id FROM proc_case_steps WHERE company_id = ? AND case_id = ? AND status = 'pending' LIMIT 1").get(A, c.id);
  db.prepare('UPDATE proc_case_steps SET due_date = ? WHERE id = ?').run(addDays(today, -2), step.id);
  const h = ok(await team('GET', '/api/home'));
  assert.equal(h.tasks[0].when, 'late');
  assert.ok(h.tasks.some((t) => t.kind === 'step' && t.when === 'late'));
  assert.ok(h.counts.tasks_late >= 1);
});

test('leavers this month and the other company stays separate', async () => {
  ok(await team('POST', '/api/records/employees', { full_name_ar: 'آخر يوم هذا الشهر', hire_date: '2021-03-01', end_date: today, status: 'inactive' }));
  const h = ok(await team('GET', '/api/home'));
  assert.ok(h.leavers.some((l) => l.full_name_ar === 'آخر يوم هذا الشهر' && l.last_day === today));
  await team.useCompany(B);
  const hb = ok(await team('GET', '/api/home'));
  assert.deepEqual([hb.counts.starters, hb.counts.leavers, hb.tasks.length], [0, 0, 0]);
  await team.useCompany(A);
});
