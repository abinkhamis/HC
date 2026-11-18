// Full backup: Admin download, backup key (download only), and the weekly tool. Fake data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { readZip } from '../src/docx/zip.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-bk-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, A;

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body, raw = false) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}) }, body: body && JSON.stringify(body) });
    return raw ? { status: r.status, buf: Buffer.from(await r.arrayBuffer()) } : { status: r.status, body: await r.json().catch(() => null) };
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
});
after(() => { server.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

const restoreCheck = (zipBuf) => {
  const z = readZip(zipBuf);
  assert.ok(z.has('data/hub.db') && z.has('manifest.json'));
  assert.ok([...z.keys()].some((k) => k.startsWith('storage/companies/')), 'uploaded logos included');
  const f = path.join(dir, `restored-${Date.now()}.db`);
  fs.writeFileSync(f, z.get('data/hub.db'));
  const r = new DatabaseSync(f, { readOnly: true });
  const n = r.prepare("SELECT COUNT(*) n FROM employees WHERE full_name_ar = 'موظف في النسخة'").get().n;
  r.close();
  return { manifest: JSON.parse(z.get('manifest.json').toString()), n };
};

test('the Admin downloads a full backup that restores the data; the team cannot', async () => {
  const admin = await login('admin', creds.admin);
  await admin.useCompany(A);
  ok(await admin('POST', '/api/records/employees', { full_name_ar: 'موظف في النسخة' }));
  const team = await login('hcteam', creds.team);
  assert.equal((await team('GET', '/api/admin/backup', null, true)).status, 403);
  const r = await admin('GET', '/api/admin/backup', null, true);
  assert.equal(r.status, 200);
  const { manifest, n } = restoreCheck(r.buf);
  assert.equal(n, 1, 'the new employee is in the backup');
  assert.ok(manifest.counts.companies >= 2);
});

test('a backup key downloads the backup only; a new key replaces the old one', async () => {
  const admin = await login('admin', creds.admin);
  assert.equal((await fetch(base + '/api/backup')).status, 401);
  assert.equal((await fetch(base + '/api/backup', { headers: { Authorization: 'Bearer hubbk_wrongwrongwrongwrongwrong' } })).status, 401);
  const k1 = ok(await admin('POST', '/api/admin/backup/key')).key;
  const r = await fetch(base + '/api/backup', { headers: { Authorization: `Bearer ${k1}` } });
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  assert.ok(ok(await admin('GET', '/api/admin/backup/status')).key.last_used_at);
  // the key is not a login: it opens nothing else
  assert.equal((await fetch(base + '/api/session', { headers: { Authorization: `Bearer ${k1}` } })).status, 401);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM backup_keys').all()).includes(k1), 'only a hash is stored');
  const k2 = ok(await admin('POST', '/api/admin/backup/key')).key;
  assert.equal((await fetch(base + '/api/backup', { headers: { Authorization: `Bearer ${k1}` } })).status, 401, 'old key stopped');
  assert.equal((await fetch(base + '/api/backup', { headers: { Authorization: `Bearer ${k2}` } })).status, 200);
  ok(await admin('POST', '/api/admin/backup/key/revoke'));
  assert.equal((await fetch(base + '/api/backup', { headers: { Authorization: `Bearer ${k2}` } })).status, 401);
});

test('the weekly tool saves local and online backups and keeps only the newest ones', async () => {
  const admin = await login('admin', creds.admin);
  const key = ok(await admin('POST', '/api/admin/backup/key')).key;
  const folder = path.join(dir, 'HC-Backups');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'online.key'), key);
  fs.mkdirSync(path.join(folder, 'online'), { recursive: true });
  for (const d of ['2020-01-01-10-00', '2020-01-08-10-00', '2020-01-15-10-00']) fs.writeFileSync(path.join(folder, 'online', `HC-backup-${d}.zip`), 'old');
  const cfg = path.join(folder, 'backup-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ folder, keep: 2, targets: [
    { name: 'local', type: 'local', db: dbFile, storage: storageDir },
    { name: 'online', type: 'url', url: base, keyFile: 'online.key' },
    { name: 'nokey', type: 'url', url: base, keyFile: 'missing.key' },
  ] }));
  // run the tool as Task Scheduler would (async so this server keeps answering)
  await new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => execFile(process.execPath, ['--disable-warning=ExperimentalWarning', 'tools/backup.mjs', cfg], (e, out) => (e ? reject(new Error(out + e.message)) : resolve(out))));
  });
  const local = fs.readdirSync(path.join(folder, 'local'));
  const online = fs.readdirSync(path.join(folder, 'online')).sort();
  assert.equal(local.length, 1);
  assert.equal(restoreCheck(fs.readFileSync(path.join(folder, 'local', local[0]))).n, 1);
  assert.equal(online.length, 2, 'only the newest 2 kept');
  assert.ok(!online.includes('HC-backup-2020-01-01-10-00.zip'));
  assert.equal(restoreCheck(fs.readFileSync(path.join(folder, 'online', online.at(-1)))).n, 1);
  const logText = fs.readFileSync(path.join(folder, 'backup.log'), 'utf8');
  assert.match(logText, /nokey: skipped/);
  void execFileSync;
});
