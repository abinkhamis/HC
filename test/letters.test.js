// Letter generation: placeholder filling, images, and company isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { tenantRepo } from '../src/tenancy.js';
import { readZip, writeZip } from '../src/docx/zip.js';
import { renderDocx, findPlaceholders } from '../src/docx/merge.js';
import { makeDocx, PNG_1x1 } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-letters-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, typeId;

before(async () => {
  ({ creds, db: seeded } = seed({ dbFile, storageDir, demo: true, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  typeId = db.prepare("SELECT id FROM letter_types WHERE code = 'salary_certificate'").get().id;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body, { raw = false } = {}) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}) }, body: body && JSON.stringify(body) });
    return { status: r.status, body: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null) };
  };
  call.useCompany = async (id) => { await call('POST', '/api/session/company', { company_id: id }); companyId = id; };
  return call;
}
const b64 = (buf) => buf.toString('base64');
const docText = (buf) => readZip(buf).get('word/document.xml').toString('utf8').replace(/<[^>]+>/g, '');

test('placeholders split across runs are found and filled', () => {
  const tpl = makeDocx([['الاسم: {{emp', 'loyee_na', 'me_ar}} — ', '{{ basic_salary }}'], 'ثابت']);
  assert.deepEqual(findPlaceholders(tpl).sort(), ['basic_salary', 'employee_name_ar']);
  const out = renderDocx(tpl, { employee_name_ar: 'سارة & <علي>', basic_salary: '7,000' });
  const xml = readZip(out).get('word/document.xml').toString('utf8');
  assert.match(docText(out), /الاسم: سارة &amp; &lt;علي&gt; — 7,000ثابت/);
  assert.doesNotMatch(xml, /\{\{/);
});

test('image placeholders become inline pictures in body and header', () => {
  const tpl = makeDocx(['{{signature}}', 'نص'], { header: ['{{logo}}'] });
  const out = readZip(renderDocx(tpl, {}, { logo: { buffer: PNG_1x1, maxHeightCm: 1 }, signature: { buffer: PNG_1x1, maxHeightCm: 1 } }));
  assert.match(out.get('word/document.xml').toString(), /<w:drawing>/);
  assert.match(out.get('word/header1.xml').toString(), /<w:drawing>/);
  assert.match(out.get('word/_rels/header1.xml.rels').toString(), /media\/hub_logo_/);
  assert.match(out.get('[Content_Types].xml').toString(), /Extension="png"/);
  assert.ok([...out.keys()].some((k) => k.startsWith('word/media/hub_signature_')));
  // excluded image -> placeholder removed
  const out2 = readZip(renderDocx(tpl, {}, { logo: null, signature: null }));
  assert.doesNotMatch(out2.get('word/header1.xml').toString(), /\{\{|drawing/);
});

test('admin upload rejects unknown placeholders and records known ones', async () => {
  const admin = await login('admin', creds.admin);
  await admin.useCompany(A);
  const bad = await admin('POST', '/api/admin/templates', { letter_type_id: typeId, file: { filename: 'x.docx', data: b64(makeDocx(['{{employe_name}}'])) } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'unknown_placeholders');
  const ok = await admin('POST', '/api/admin/templates', { letter_type_id: typeId, file: { filename: 'تعريف.docx', data: b64(makeDocx(['{{company_name_ar}} — {{employee_name_ar}} — {{basic_salary}} — {{reference_no}}', '{{logo}}'])) } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.placeholders.sort(), ['basic_salary', 'company_name_ar', 'employee_name_ar', 'logo', 'reference_no']);
});

test('team issues a letter with the current company template only', async () => {
  const team = await login('hcteam', creds.team);
  await team.useCompany(A);
  const emp = tenantRepo(db, A).list('employees')[0];

  // missing salary -> refused, with the missing field named
  const pre = await team('POST', '/api/letters/preview', { letter_type_id: typeId, employee_id: emp.id, include_logo: true });
  assert.equal(pre.status, 200);
  assert.deepEqual(pre.body.missing, ['الراتب الأساسي']);
  assert.equal((await team('POST', '/api/letters/issue', { letter_type_id: typeId, employee_id: emp.id, include_logo: true })).status, 422);

  tenantRepo(db, A).update('employees', emp.id, { basic_salary: 7000 });
  const r = await team('POST', '/api/letters/issue', { letter_type_id: typeId, employee_id: emp.id, include_logo: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const code = db.prepare('SELECT code FROM companies WHERE id = ?').get(A).code.toUpperCase();
  assert.match(r.body.reference_no, new RegExp(`^${code}/HR/\\d{4}/0001$`));

  const file = await team('GET', `/api/letters/issued/${r.body.id}/file`, undefined, { raw: true });
  assert.equal(file.status, 200);
  const text = docText(file.body);
  assert.match(text, /7,000/);
  assert.match(text, new RegExp(r.body.reference_no.replace(/\//g, '\\/')));
  assert.ok(readZip(file.body).get('word/document.xml').toString().includes('<w:drawing>'), 'logo inserted');

  // company B has no template for this type -> refused, never falls back to A's
  await team.useCompany(B);
  const empB = tenantRepo(db, B).list('employees')[0];
  const rb = await team('POST', '/api/letters/issue', { letter_type_id: typeId, employee_id: empB.id });
  assert.equal(rb.status, 422);
  assert.equal(rb.body.code, 'no_template');
  // A's letter cannot be downloaded from B's workspace, and A's employee cannot be used
  assert.equal((await team('GET', `/api/letters/issued/${r.body.id}/file`)).status, 404);
  assert.equal((await team('POST', '/api/letters/preview', { letter_type_id: typeId, employee_id: emp.id })).status, 404);
  assert.equal((await team('GET', '/api/letters/issued')).body.length, 0);
});

test('page thumbnails (which can show a previous employee) are stripped', () => {
  const src = readZip(makeDocx(['{{employee_name_ar}}']));
  src.set('docProps/thumbnail.emf', Buffer.from('OLD EMPLOYEE DATA'));
  src.set('_rels/.rels', Buffer.from(src.get('_rels/.rels').toString().replace('</Relationships>', '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.emf"/></Relationships>')));
  const out = readZip(renderDocx(writeZip(src), { employee_name_ar: 'x' }));
  assert.ok(!out.has('docProps/thumbnail.emf'));
  assert.doesNotMatch(out.get('_rels/.rels').toString(), /thumbnail/);
});
