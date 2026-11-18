// ID / Iqama number and IBAN are optional everywhere; when filled they are still checked.
// Fake data in temporary databases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { openDb } from '../src/db.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-opt-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, A, team;

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
  [A] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  team = await login('hcteam', creds.team);
  await team.useCompany(A);
});
after(() => { server.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('employees and consultants are saved without an ID / Iqama number or IBAN', async () => {
  ok(await team('POST', '/api/records/employees', { full_name_ar: 'موظف بدون هوية' }));
  ok(await team('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'مباشر بدون هوية', hire_date: '2026-11-01' }, case: {} }));
  ok(await team('POST', '/api/records/consultants', { full_name_ar: 'استشاري بدون هوية أو آيبان' }));
});

test('a bank account can be saved without an IBAN; a filled IBAN is still checked', async () => {
  const r = ok(await team('POST', '/api/records/bank_accounts', { account_holder: 'صاحب حساب', bank_name: 'بنك تجريبي' }));
  assert.equal(r.iban ?? null, null);
  ok(await team('POST', '/api/records/bank_accounts', { account_holder: 'صاحب حساب ثانٍ', bank_name: 'بنك تجريبي', iban: '' }));
  assert.equal((await team('POST', '/api/records/bank_accounts', { account_holder: 'x', bank_name: 'y', iban: 'SA12' })).status, 400);
  ok(await team('POST', '/api/records/bank_accounts', { account_holder: 'z', bank_name: 'y', iban: 'SA03 8000 0000 6080 1016 7519' }));
});

test('an existing database: bank_accounts is rebuilt once, every row kept', () => {
  const f = path.join(dir, 'old.db');
  let d = openDb(f);
  // make it look like a database from before the change (IBAN NOT NULL) with one row
  d.exec('PRAGMA foreign_keys = OFF; DROP TABLE bank_accounts;');
  d.exec(`CREATE TABLE bank_accounts (id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies (id), employee_id INTEGER,
    account_holder TEXT NOT NULL, bank_name TEXT NOT NULL, iban TEXT NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users (id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (company_id, id), UNIQUE (company_id, iban),
    FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id))`);
  const cid = Number(d.prepare("INSERT INTO companies (code, name_ar, name_en) VALUES ('t1', 'ت', 'T')").run().lastInsertRowid);
  d.prepare("INSERT INTO bank_accounts (company_id, account_holder, bank_name, iban, created_at) VALUES (?, 'قديم', 'بنك', 'SA0380000000608010167519', '2026-01-01 10:00:00')").run(cid);
  d.close();
  d = openDb(f);
  const col = d.prepare('PRAGMA table_info(bank_accounts)').all().find((c) => c.name === 'iban');
  assert.equal(col.notnull, 0, 'IBAN is now optional');
  const row = d.prepare('SELECT account_holder, iban, created_at FROM bank_accounts').get();
  assert.deepEqual({ ...row }, { account_holder: 'قديم', iban: 'SA0380000000608010167519', created_at: '2026-01-01 10:00:00' });
  // the company of an existing row still cannot be changed (tenant triggers recreated)
  assert.throws(() => d.prepare('UPDATE bank_accounts SET company_id = company_id + 1').run(), /company|constraint|FOREIGN/i);
  d.close();
});
