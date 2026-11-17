// Consulting contracts: deliverables, certificates, payments, templates and isolation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { readZip } from '../src/docx/zip.js';
import { makeDocx } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-cc-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin;

const iso = (offsetDays) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays); return d.toISOString().slice(0, 10); };
const b64 = (buf) => buf.toString('base64');
const docText = (buf) => readZip(buf).get('word/document.xml').toString('utf8').replace(/<[^>]+>/g, '');

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

before(async () => {
  ({ creds, db: seeded } = seed({ dbFile, storageDir, demo: true, writeCredentials: false }));
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

let consultant, contract;
// three approvers' names are entered at every certificate issue (titles optional)
const APPROVERS = [{ name: 'معتمد اختبار ١', title: 'مدير اختبار' }, { name: 'معتمد اختبار ٢' }, { name: 'معتمد اختبار ٣' }];

test('register consultant and a contract with several deliverables (company forced from session)', async () => {
  const k = await team('POST', '/api/records/consultants', { full_name_ar: 'سارة الاستشارية', gender: 'female', iban: 'SA03 8000 0000 6080 1016 7519', bank_name: 'بنك', company_id: B });
  assert.equal(k.status, 200);
  assert.equal(k.body.company_id, A);
  consultant = k.body;
  const r = await team('POST', '/api/consulting/contracts', {
    consultant_id: consultant.id, project_name: 'مشروع أ', supervisor_name: 'مدير', contract_date: iso(-40), start_date: iso(-40), end_date: iso(20),
    deliverables: [
      { title: 'المخرج الأول', amount: '10,000', due_date: iso(-5), period_from: iso(-40), period_to: iso(-5) },
      { title: 'المخرج الثاني', amount: 6600, due_date: iso(10), period_from: iso(-4), period_to: iso(10) },
      { title: 'المخرج الثالث', amount: 5000, due_date: iso(90) },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  contract = r.body;
  assert.equal(contract.company_id, A);
  assert.equal(contract.status, 'draft');
  assert.equal(contract.deliverables.length, 3);
  assert.equal(contract.total, 21600);
  assert.match(contract.contract_no, /\/CC\/\d{4}\/0001$/);
  // a second contract for the same consultant is allowed
  const r2 = await team('POST', '/api/consulting/contracts', { consultant_id: consultant.id, deliverables: [{ title: 'x', amount: 1, due_date: iso(5) }] });
  assert.equal(r2.status, 200);
  assert.match(r2.body.contract_no, /0002$/);
  // at least one deliverable, valid dates
  assert.equal((await team('POST', '/api/consulting/contracts', { consultant_id: consultant.id, deliverables: [] })).status, 400);
  assert.equal((await team('POST', '/api/consulting/contracts', { consultant_id: consultant.id, deliverables: [{ title: 'x', amount: 1 }] })).status, 400);
});

test('nothing becomes completed or paid by itself; overdue/upcoming show only after the contract leaves draft', async () => {
  let s = (await team('GET', '/api/consulting/summary?days=30')).body;
  assert.equal(s.overdue.filter((d) => d.contract_id === contract.id).length, 0, 'draft contracts are not followed up');
  await team('POST', `/api/consulting/contracts/${contract.id}/status`, { action: 'mark_sent', date: iso(-39) });
  const signed = await team('POST', `/api/consulting/contracts/${contract.id}/status`, { action: 'mark_signed', date: iso(-38) });
  assert.equal(signed.body.status, 'active');
  s = (await team('GET', '/api/consulting/summary?days=30')).body;
  const mine = (list) => list.filter((d) => d.contract_id === contract.id).map((d) => d.title);
  assert.deepEqual(mine(s.overdue), ['المخرج الأول']);
  assert.deepEqual(mine(s.upcoming), ['المخرج الثاني']);
  assert.ok(s.contracts_ending.some((c) => c.id === contract.id));
  const d1 = (await team('GET', `/api/consulting/contracts/${contract.id}`)).body.deliverables[0];
  assert.equal(d1.stage, 'in_progress');
  assert.equal(d1.payment_status, 'unpaid');
  // invalid transition
  assert.equal((await team('POST', `/api/consulting/contracts/${contract.id}/status`, { action: 'close' })).status, 200);
  assert.equal((await team('POST', `/api/consulting/contracts/${contract.id}/status`, { action: 'mark_sent' })).status, 409);
  assert.equal((await team('POST', `/api/consulting/contracts/${contract.id}/status`, { action: 'reopen' })).body.status, 'active');
});

test('official documents are refused until the Admin uploads the company template', async () => {
  const d1 = contract.deliverables[0];
  const g = await team('POST', `/api/consulting/contracts/${contract.id}/document`, {});
  assert.equal(g.status, 422);
  assert.equal(g.body.code, 'no_template');
  const c = await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5) });
  assert.equal(c.status, 422);
  assert.equal(c.body.code, 'no_template');
  const st = (await team('GET', '/api/consulting/templates')).body;
  assert.equal(st.contract, null);
  assert.equal(st.certificate, null);
});

test('admin uploads per-company templates; contract rows repeat per deliverable', async () => {
  const types = (await admin('GET', '/api/admin/letter-types')).body;
  const ct = types.find((t) => t.code === 'consulting_contract');
  const cert = types.find((t) => t.code === 'completion_certificate');
  assert.equal(ct.category, 'contract');
  // letter placeholders are not valid in a contract template
  const bad = await admin('POST', '/api/admin/templates', { letter_type_id: ct.id, file: { filename: 'c.docx', data: b64(makeDocx(['{{employee_name_ar}}'])) } });
  assert.equal(bad.status, 400);
  assert.equal((await team('POST', '/api/admin/templates', { letter_type_id: ct.id, file: { filename: 'c.docx', data: b64(makeDocx(['x'])) } })).status, 403);

  const tpl = makeDocx([
    ['عقد رقم {{contract_ref}} مع {{consultant_title_ar}} {{consultant_name_ar}} — آيبان {{consultant_iban}}'],
    ['من {{start_date:dash}} إلى {{end_date}} — الإجمالي {{contract_total}}'],
    { table: [['#', 'المخرج', 'القيمة', 'الاستحقاق'], ['{{d_no}}', ['{{d_ti', 'tle}}'], '{{d_amount}}', '{{d_due_date}}']] },
  ]);
  const up = await admin('POST', '/api/admin/templates', { letter_type_id: ct.id, file: { filename: 'عقد.docx', data: b64(tpl) } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const certTpl = makeDocx(['شهادة {{certificate_ref}} — {{consultant_name_ar}} — {{deliverable_title}} — {{deliverable_amount}} — {{deliverable_period_from:dash}} حتى {{deliverable_period_to:dash}} — {{supervisor_name}}', 'المعتمدون: {{approver_1_name}} / {{approver_2_name}} / {{approver_3_name}}']);
  const certUp = await admin('POST', '/api/admin/templates', { letter_type_id: cert.id, file: { filename: 'شهادة.docx', data: b64(certTpl) } });
  assert.equal(certUp.status, 200);
  // certificate templates are drafts until a trial and an explicit Admin approval
  assert.equal(certUp.body.draft, true);
  assert.equal((await admin('POST', `/api/admin/templates/${certUp.body.template_id}/trial`, { pdf: false })).status, 200);
  assert.equal((await admin('POST', `/api/admin/templates/${certUp.body.template_id}/approve`)).status, 200);

  const pre = await team('POST', `/api/consulting/contracts/${contract.id}/document/preview`, {});
  assert.equal(pre.status, 200);
  assert.deepEqual(pre.body.missing, [], JSON.stringify(pre.body.missing));
  const gen = await team('POST', `/api/consulting/contracts/${contract.id}/document`, {});
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  const file = await team('GET', `/api/consulting/contracts/${contract.id}/document`, undefined, { raw: true });
  const text = docText(file.body);
  assert.match(text, /المكرمة سارة الاستشارية/);
  assert.match(text, /SA0380000000608010167519/);
  assert.match(text, /الإجمالي 21,600/);
  for (const t of ['المخرج الأول', 'المخرج الثاني', 'المخرج الثالث', '10,000', '6,600']) assert.ok(text.includes(t), t);
  assert.equal((readZip(file.body).get('word/document.xml').toString().match(/<w:tr>/g) || []).length, 4, 'header + 3 deliverable rows');
  assert.doesNotMatch(text, /\{\{/);
});

test('certificate → sent date → payment confirmed by finance (each an explicit step)', async () => {
  const d1 = contract.deliverables[0];
  // completion date is required (issuing records completion explicitly)
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, {})).status, 400);
  // cannot record sending before a certificate exists
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate-sent`, { sent_at: iso(0) })).status, 409);
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5) })).body.code, 'approvers_required');
  const c = await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5), approvers: APPROVERS });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.match(c.body.certificate_ref, /\/CERT\/\d{4}\/0001$/);
  const cf = await team('GET', `/api/consulting/deliverables/${d1.id}/certificate`, undefined, { raw: true });
  assert.match(docText(cf.body), new RegExp(`المخرج الأول — 10,000 — ${iso(-40).split('-').reverse().join('-')} حتى`));
  // re-issue keeps the same number
  const again = await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-4), approvers: APPROVERS });
  assert.equal(again.body.certificate_ref, c.body.certificate_ref);

  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate-sent`, { sent_at: iso(3) })).status, 400, 'future date');
  const sent = await team('POST', `/api/consulting/deliverables/${d1.id}/certificate-sent`, { sent_at: iso(-1), sent_to: 'المالية' });
  assert.equal(sent.body.stage, 'certificate_sent');
  assert.equal(sent.body.payment_status, 'unpaid', 'sending a certificate does not mark it paid');

  const noConfirm = await team('POST', `/api/consulting/deliverables/${d1.id}/payments`, { amount: 4000, paid_at: iso(0) });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'finance_confirmation_required');
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/payments`, { amount: 20000, paid_at: iso(0), finance_confirmed: true })).status, 409, 'over remaining');
  const p1 = await team('POST', `/api/consulting/deliverables/${d1.id}/payments`, { amount: 4000, paid_at: iso(0), transfer_reference: 'TRX-1', finance_confirmed: true });
  assert.equal(p1.body.deliverable.payment_status, 'partial');
  assert.equal(p1.body.deliverable.remaining, 6000);
  const p2 = await team('POST', `/api/consulting/deliverables/${d1.id}/payments`, { amount: 6000, paid_at: iso(0), finance_confirmed: true });
  assert.equal(p2.body.deliverable.payment_status, 'paid');

  // a paid deliverable cannot be removed or reduced below what was paid
  const full = (await team('GET', `/api/consulting/contracts/${contract.id}`)).body;
  const keep = full.deliverables.slice(1).map((d) => ({ id: d.id, title: d.title, amount: d.amount, due_date: d.due_date }));
  assert.equal((await team('PATCH', `/api/consulting/contracts/${contract.id}`, { deliverables: keep })).status, 409);
  const reduced = full.deliverables.map((d) => ({ id: d.id, title: d.title, amount: d.seq === 1 ? 5000 : d.amount, due_date: d.due_date }));
  assert.equal((await team('PATCH', `/api/consulting/contracts/${contract.id}`, { deliverables: reduced })).status, 409);

  // cancelling an actual payment: Admin only, reason required, never deleted (kept as voided)
  assert.equal((await team('DELETE', `/api/consulting/payments/${p2.body.payment_id}`, { reason: 'x' })).status, 403);
  assert.equal((await admin('DELETE', `/api/consulting/payments/${p2.body.payment_id}`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/consulting/payments/${p2.body.payment_id}`, { reason: 'تسجيل مكرر' })).status, 200);
  const after2 = (await team('GET', `/api/consulting/contracts/${contract.id}`)).body;
  assert.equal(after2.paid, 4000);
  assert.ok(after2.payments.some((p) => p.id === p2.body.payment_id && p.voided_at && p.void_reason === 'تسجيل مكرر'), 'kept in history');
  assert.ok(after2.events.some((e) => e.event === 'payment_voided' && e.detail.includes('تسجيل مكرر')));
  const s = (await team('GET', '/api/consulting/summary')).body;
  assert.ok(s.awaiting_payment.some((d) => d.id === d1.id));
});

test('company B cannot see or touch company A consulting data', async () => {
  const t2 = await login('hcteam', creds.team);
  await t2.useCompany(B);
  assert.equal((await t2('GET', `/api/consulting/contracts/${contract.id}`)).status, 404);
  assert.ok((await t2('GET', '/api/consulting/contracts')).body.every((c) => c.id !== contract.id));
  const d1 = contract.deliverables[0];
  assert.equal((await t2('GET', `/api/consulting/deliverables/${d1.id}/certificate`)).status, 404);
  assert.equal((await t2('POST', `/api/consulting/deliverables/${d1.id}/payments`, { amount: 1, paid_at: iso(0), finance_confirmed: true })).status, 404);
  assert.equal((await t2('POST', '/api/consulting/contracts', { consultant_id: consultant.id, deliverables: [{ title: 'x', amount: 1, due_date: iso(1) }] })).status, 400, 'A consultant in B');
  // B has no templates even though A has
  const st = (await t2('GET', '/api/consulting/templates')).body;
  assert.equal(st.contract, null);
  // database level: a deliverable cannot point to another company's contract
  assert.throws(() => db.prepare('INSERT INTO contract_deliverables (company_id, contract_id, seq, title, amount, due_date) VALUES (?, ?, 1, ?, 1, ?)').run(B, contract.id, 'x', iso(1)), /FOREIGN KEY/);
  assert.throws(() => db.prepare('INSERT INTO deliverable_payments (company_id, deliverable_id, amount, paid_at, finance_confirmed) VALUES (?, ?, 1, ?, 1)').run(B, d1.id, iso(0)), /FOREIGN KEY/);
  assert.throws(() => db.prepare('INSERT INTO deliverable_payments (company_id, deliverable_id, amount, paid_at, finance_confirmed) VALUES (?, ?, 1, ?, 0)').run(A, d1.id, iso(0)), /CHECK/);
});
