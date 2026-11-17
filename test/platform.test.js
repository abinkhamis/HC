// Platform stability: two instances on different ports must not log each other out
// (browsers share localhost cookies across ports), and the page never starts blank.
// Fake data only, separate temporary databases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';

const instances = [];
before(async () => {
  for (const name of ['main', 'test']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hchub-${name}-`));
    const { creds, db } = seed({ dbFile: path.join(dir, 'hub.db'), storageDir: path.join(dir, 'storage'), demo: false, writeCredentials: false });
    db.close();
    const server = createApp({ dbFile: path.join(dir, 'hub.db'), storageDir: path.join(dir, 'storage') });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    instances.push({ dir, creds, server, base: `http://localhost:${server.address().port}` });
  }
});
after(() => { for (const i of instances) { i.server.close(); i.server.db.close(); try { fs.rmSync(i.dir, { recursive: true, force: true }); } catch {} } });

// Company A cookie jar for "localhost", like a real browser (cookies ignore the port).
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function call(base, method, url, body) {
  const r = await fetch(base + url, { method, headers: { cookie: cookieHeader(), 'X-Requested-With': 'hub', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) { const [kv] = sc.split(';'); const [k, v] = kv.split('='); if (v) jar.set(k, v); else jar.delete(k); }
  return r;
}

test('logging in to a second instance does not log the main platform out', async () => {
  const [main, other] = instances;
  assert.equal((await call(main.base, 'POST', '/api/login', { username: 'admin', password: main.creds.admin })).status, 200);
  assert.equal((await call(main.base, 'GET', '/api/session')).status, 200);
  assert.equal((await call(other.base, 'POST', '/api/login', { username: 'admin', password: other.creds.admin })).status, 200);
  assert.equal((await call(main.base, 'GET', '/api/session')).status, 200, 'main session still valid after logging in elsewhere');
  assert.equal((await call(other.base, 'GET', '/api/session')).status, 200);
  assert.equal(jar.size, 2, 'one cookie per port');
  // logging out of one instance leaves the other signed in
  await call(other.base, 'POST', '/api/logout');
  assert.equal((await call(other.base, 'GET', '/api/session')).status, 401);
  assert.equal((await call(main.base, 'GET', '/api/session')).status, 200);
});

test('login ignores spaces copied around the name or password, but still rejects a wrong password', async () => {
  const [, other] = instances;
  const login = (username, password) => fetch(other.base + '/api/login', { method: 'POST', headers: { 'X-Requested-With': 'hub', 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) }).then((r) => r.status);
  assert.equal(await login(' admin ', ` ${other.creds.admin} `), 200);
  assert.equal(await login('admin', `${other.creds.admin}\t`), 200);
  assert.equal(await login('admin', other.creds.admin.slice(0, -1)), 401);
  assert.equal(await login('admin', other.creds.admin + 'x'), 401);
  assert.equal(await login('admin', ''), 401);
  assert.equal(await login('admin', '   '), 401);
});

test('the page never starts blank and does not wait for external fonts', async () => {
  const html = await (await fetch(`${instances[0].base}/`)).text();
  assert.match(html, /جارٍ تحميل منصة HC Operations Hub/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com/, 'no render-blocking external stylesheet');
  const js = await (await fetch(`${instances[0].base}/app.js`)).text();
  assert.match(js, /تعذّر الاتصال بالمنصة/, 'clear message and automatic retry when the server is unreachable');
});
