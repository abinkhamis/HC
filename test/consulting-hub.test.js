// Consultants & consulting contracts hub: one-step consultant + contract, certificate
// approvers, payment requests (Excel), void/correct of payments. Fake data, separate temp DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { readZip, writeZip } from '../src/docx/zip.js';
import { makeDocx } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-cc-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const iso = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const b64 = (buf) => buf.toString('base64');
const APPROVERS = [{ name: 'معتمد أ', title: 'مدير المشاريع' }, { name: 'معتمد ب' }, { name: 'معتمد ج', title: 'المدير المالي' }];

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
const ok = (r) => { assert.ok(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

// A small but real .xlsx: shared strings, one inline string, a formula and a style.
function makeXlsx(cells) {
  const shared = [];
  const sheetCells = cells.map(([ref, v]) => {
    if (v && typeof v === 'object' && v.f) return `<c r="${ref}"><f>${v.f}</f></c>`;
    if (v && typeof v === 'object' && v.inline) return `<c r="${ref}" t="inlineStr"><is><t>${v.inline}</t></is></c>`;
    shared.push(v);
    return `<c r="${ref}" s="1" t="s"><v>${shared.length - 1}</v></c>`;
  });
  const rows = {};
  cells.forEach(([ref], i) => { const r = ref.match(/\d+/)[0]; (rows[r] ||= []).push(sheetCells[i]); });
  const e = new Map();
  e.set('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'));
  e.set('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'));
  e.set('xl/workbook.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="طلب" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  e.set('xl/_rels/workbook.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
  e.set('xl/styles.xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>'));
  e.set('xl/sharedStrings.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}</sst>`));
  e.set('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Object.entries(rows).sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.join('')}</row>`).join('')}</sheetData></worksheet>`));
  return writeZip(e);
}
const sheetXml = (buf) => readZip(buf).get('xl/worksheets/sheet1.xml').toString('utf8');

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

const deliverables = [
  { title: 'مخرج اختبار ١', amount: 10000, due_date: iso(-20) },
  { title: 'مخرج اختبار ٢', amount: 5000, due_date: iso(10) },
  { title: 'مخرج اختبار ٣', amount: 8000, due_date: iso(40) },
];
let contract, consultantId;

test('new consultant + contract in one step; duplicates prevented; all or nothing', async () => {
  const k0 = count('consultants'), c0 = count('consulting_contracts');
  // the contract fails (deliverable without amount) → the consultant is not saved either
  const bad = await team('POST', '/api/consulting/contracts-with-consultant', { consultant: { full_name_ar: 'استشاري اختبار', id_number: '1000000001' }, contract: { deliverables: [{ title: 'x', due_date: iso(1) }] } });
  assert.equal(bad.status, 400);
  assert.equal(count('consultants'), k0);
  assert.equal(count('consulting_contracts'), c0);
  const c = ok(await team('POST', '/api/consulting/contracts-with-consultant', {
    consultant: { full_name_ar: 'استشاري اختبار', id_number: '1000000001', mobile: '0500000001', iban: 'SA0380000000608010167519', bank_name: 'بنك اختبار' },
    contract: { project_name: 'مشروع اختبار', deliverables },
  }));
  contract = c; consultantId = c.consultant.id;
  assert.equal(count('consultants'), k0 + 1);
  assert.equal(c.deliverables.length, 3);
  assert.ok(c.events.some((e) => e.event === 'consultant_created'));
  // same ID → refused; same name / mobile / IBAN → needs confirmation
  assert.equal((await team('POST', '/api/consulting/contracts-with-consultant', { consultant: { full_name_ar: 'آخر', id_number: ' 1000000001 ' }, contract: { deliverables } })).body.code, 'consultant_exists');
  assert.equal((await team('POST', '/api/consulting/contracts-with-consultant', { consultant: { full_name_ar: 'استشاري  اختبار' }, contract: { deliverables } })).body.code, 'possible_duplicate');
  assert.equal((await team('POST', '/api/consulting/contracts-with-consultant', { consultant: { full_name_ar: 'اسم مختلف', mobile: '+966 50 000 0001' }, contract: { deliverables } })).body.code, 'possible_duplicate');
  assert.equal(count('consultants'), k0 + 1);
  const m = ok(await team('GET', '/api/consulting/consultant-match?iban=sa0380000000608010167519'));
  assert.deepEqual(m[0].matched_by, ['iban']);
  // existing consultant picked directly: a second contract, no new consultant
  ok(await team('POST', '/api/consulting/contracts', { consultant_id: consultantId, project_name: 'عقد ثان', deliverables: [{ title: 'مخرج', amount: 1000, due_date: iso(5) }] }));
  assert.equal(count('consultants'), k0 + 1);
  const k = ok(await team('GET', `/api/consulting/consultants/${consultantId}`));
  assert.equal(k.contracts.length, 2, 'several contracts per consultant');
  const list = ok(await team('GET', '/api/consulting/consultants'));
  assert.equal(list.find((x) => x.id === consultantId).contracts, 2);
});

test('certificate: official template only, three approvers entered each time, signatures left blank', async () => {
  const d1 = contract.deliverables[0];
  await team('POST', `/api/consulting/contracts/${contract.id}/status`, { action: 'mark_signed', date: iso(-30) });
  // no template → refused even with approvers
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5), approvers: APPROVERS })).body.code, 'no_template');
  const type = ok(await admin('GET', '/api/admin/letter-types')).find((t) => t.code === 'completion_certificate');
  const certUp = ok(await admin('POST', '/api/admin/templates', { letter_type_id: type.id, file: { filename: 'test-cert.docx', data: b64(makeDocx([
    'شهادة {{certificate_ref}} — {{consultant_name_ar}} — {{deliverable_title}} — {{deliverable_amount}} — الإنجاز {{completion_date}} — الإصدار {{date_gregorian}}',
    'المعتمد الأول: {{approver_1_name}} {{approver_1_title}} التوقيع: ______ التاريخ: ______',
    'المعتمد الثاني: {{approver_2_name}} {{approver_2_title}} التوقيع: ______ التاريخ: ______',
    'المعتمد الثالث: {{approver_3_name}} {{approver_3_title}} التوقيع: ______ التاريخ: ______',
  ])) } }));
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5), approvers: APPROVERS })).body.code, 'no_template', 'a draft is not used');
  ok(await admin('POST', `/api/admin/templates/${certUp.template_id}/trial`, { pdf: false }));
  ok(await admin('POST', `/api/admin/templates/${certUp.template_id}/approve`));
  const pv = ok(await team('POST', `/api/consulting/deliverables/${d1.id}/certificate/preview`, { completion_date: iso(-5) }));
  assert.ok(pv.missing.includes('اسم المعتمد 1'), 'preview flags missing approvers');
  assert.equal((await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5), approvers: APPROVERS.slice(0, 2) })).body.code, 'approvers_required');
  const c = ok(await team('POST', `/api/consulting/deliverables/${d1.id}/certificate`, { completion_date: iso(-5), approvers: APPROVERS }));
  const file = await team('GET', `/api/consulting/deliverables/${d1.id}/certificate`, undefined, { raw: true });
  const text = readZip(file.body).get('word/document.xml').toString('utf8').replace(/<[^>]+>/g, '');
  assert.ok(text.includes('معتمد أ') && text.includes('مدير المشاريع') && text.includes('معتمد ب') && text.includes('المدير المالي'));
  assert.ok(text.includes(iso(-5).split('-').reverse().join('/')), 'completion date filled');
  assert.equal((text.match(/التوقيع: ______ التاريخ: ______/g) || []).length, 3, 'signatures and signature dates stay blank');
  assert.ok(!/\{\{/.test(text));
  const hist = ok(await team('GET', `/api/consulting/deliverables/${d1.id}/certificates`));
  assert.equal(hist[0].certificate_ref, c.certificate_ref);
  assert.equal(hist[0].approvers[2].name, 'معتمد ج');
  const sug = ok(await team('GET', '/api/consulting/approver-suggestions'));
  assert.deepEqual(sug.map((x) => x.name).sort(), ['معتمد أ', 'معتمد ب', 'معتمد ج'].sort());
  // issue the second certificate too (used by the payment request below)
  ok(await team('POST', `/api/consulting/deliverables/${contract.deliverables[1].id}/certificate`, { completion_date: iso(-1), approvers: APPROVERS }));
});

let reqId;
test('payment request: requested amounts, duplicate-claim warning, no issue without the official Excel template', async () => {
  const [d1, d2] = contract.deliverables;
  const r = ok(await team('POST', '/api/consulting/payment-requests', { contract_id: contract.id, items: [{ deliverable_id: d1.id, amount: 10000 }, { deliverable_id: d2.id, amount: 3000 }], notes: 'طلب اختبار' }));
  reqId = r.id;
  assert.match(r.request_no, /\/PR\/\d{4}\/0001$/);
  assert.equal(r.status, 'draft');
  assert.equal(r.requested, 13000);
  assert.equal(r.paid, 0, 'requested is not paid');
  // claiming the same amount again warns; amounts above the unpaid balance are refused
  const dup = await team('POST', '/api/consulting/payment-requests', { contract_id: contract.id, items: [{ deliverable_id: d1.id, amount: 1000 }] });
  assert.equal(dup.body.code, 'already_requested');
  assert.match(dup.body.error, /PR\/\d{4}\/0001/);
  assert.equal((await team('POST', '/api/consulting/payment-requests', { contract_id: contract.id, items: [{ deliverable_id: d1.id, amount: 10001 }] })).body.code, 'exceeds_remaining');
  const able = ok(await team('GET', `/api/consulting/contracts/${contract.id}/requestable`));
  assert.equal(able.find((d) => d.id === d2.id).claimable, 2000, 'partial request leaves the rest claimable');
  // no official template → no document
  assert.equal((await team('POST', `/api/consulting/payment-requests/${reqId}/document`, { approvers: APPROVERS })).body.code, 'no_template');
  assert.equal((await team('POST', `/api/consulting/payment-requests/${reqId}/payments`, { amount: 1, paid_at: today, finance_confirmed: true })).status, 409, 'no payment before the request is issued');
});

test('Admin uploads the Excel template; issuing fills it and keeps its design', async () => {
  const type = ok(await admin('GET', '/api/admin/letter-types')).find((t) => t.code === 'consultant_payment_request');
  assert.equal(type.category, 'payment_request');
  const bad = await admin('POST', '/api/admin/templates', { letter_type_id: type.id, file: { filename: 'x.xlsx', data: b64(makeXlsx([['A1', '{{unknown_key}}']])) } });
  assert.equal(bad.body.code, 'unknown_placeholders');
  assert.equal((await admin('POST', '/api/admin/templates', { letter_type_id: type.id, file: { filename: 'x.docx', data: b64(makeDocx(['x'])) } })).status, 400, 'Word file refused for an Excel template');
  assert.equal((await team('POST', '/api/admin/templates', { letter_type_id: type.id, file: { filename: 'x.xlsx', data: b64(makeXlsx([['A1', 'x']])) } })).status, 403);
  const tpl = makeXlsx([
    ['A1', 'طلب صرف دفعة رقم {{request_no}}'], ['B1', { inline: '{{consultant_name_ar}}' }],
    ['A2', 'التاريخ'], ['B2', '{{request_date}}'],
    ['A4', '{{item_1_title}}'], ['B4', '{{item_1_amount}}'],
    ['A5', '{{item_2_title}}'], ['B5', '{{item_2_amount}}'],
    ['A6', '{{item_3_title}}'], ['B6', '{{item_3_amount}}'],
    ['A7', 'الإجمالي'], ['B7', { f: 'SUM(B4:B6)' }], ['C7', '{{request_amount}}'],
    ['A9', 'المعتمد 1: {{approver_1_name}} ({{approver_1_title}})'], ['A10', 'المعتمد 2: {{approver_2_name}}'],
    ['A12', 'الآيبان: {{consultant_iban}}'],
  ]);
  ok(await admin('POST', '/api/admin/templates', { letter_type_id: type.id, file: { filename: 'نموذج طلب دفعة (اختبار).xlsx', data: b64(tpl) } }));
  const pv = ok(await team('POST', `/api/consulting/payment-requests/${reqId}/document/preview`, {}));
  assert.equal(pv.approver_slots, 2, 'approvers follow the template');
  assert.ok(pv.missing.includes('اسم المعتمد 1'));
  assert.equal((await team('POST', `/api/consulting/payment-requests/${reqId}/document`, { approvers: [{ name: 'فقط واحد' }] })).body.code, 'approvers_required');
  const iss = ok(await team('POST', `/api/consulting/payment-requests/${reqId}/document`, { approvers: [{ name: 'معتمد أ', title: 'مدير المشاريع' }, { name: 'معتمد ب' }] }));
  assert.match(iss.filename, /\.xlsx$/);
  const out = await team('GET', `/api/consulting/payment-requests/${reqId}/document`, undefined, { raw: true });
  const x = sheetXml(out.body);
  assert.ok(x.includes('<c r="B4" s="1"><v>10000</v></c>'), 'amount written as a number, style kept');
  assert.ok(x.includes('<c r="B5" s="1"><v>3000</v></c>'));
  assert.ok(x.includes('<c r="B6" s="1"/>'), 'unused line left empty');
  assert.ok(x.includes('<c r="B7"><f>SUM(B4:B6)</f></c>'), 'formula kept');
  assert.ok(x.includes('<v>13000</v>'));
  assert.ok(x.includes('مخرج اختبار ١') && x.includes('استشاري اختبار') && x.includes('معتمد أ (مدير المشاريع)'));
  assert.ok(x.includes('SA0380000000608010167519'));
  assert.ok(x.includes('<c r="A2" s="1" t="s"><v>'), 'cells without placeholders untouched');
  assert.ok(!x.includes('{{'));
  assert.match(readZip(out.body).get('xl/workbook.xml').toString('utf8'), /<\/sheets><calcPr fullCalcOnLoad="1"\/>/);
  const r = ok(await team('GET', `/api/consulting/payment-requests/${reqId}`));
  assert.equal(r.status, 'issued');
  assert.equal(r.approvers[0].name, 'معتمد أ');
  assert.equal((await team('PATCH', `/api/consulting/payment-requests/${reqId}`, { notes: 'x' })).body.code, 'request_locked');
});

test('actual payments only after Finance confirms; partial; requested vs paid kept apart; void/correct by Admin only', async () => {
  ok(await team('POST', `/api/consulting/payment-requests/${reqId}/sent`, { sent_at: today, sent_to: 'المالية' }));
  assert.equal((await team('POST', `/api/consulting/payment-requests/${reqId}/payments`, { amount: 5000, paid_at: today })).body.code, 'finance_confirmation_required');
  assert.equal((await team('POST', `/api/consulting/payment-requests/${reqId}/payments`, { amount: 13001, paid_at: today, finance_confirmed: true })).status, 409);
  let r = ok(await team('POST', `/api/consulting/payment-requests/${reqId}/payments`, { amount: 11000, paid_at: today, transfer_reference: 'TRX-T1', finance_confirmed: true }));
  assert.equal(r.recorded_payment_ids.length, 2, 'split over the request lines in order');
  assert.equal(r.paid, 11000);
  assert.equal(r.outstanding, 2000);
  assert.equal(r.payment_state, 'partial');
  assert.equal(r.requested, 13000, 'requested amount unchanged by payments');
  assert.equal((await team('POST', `/api/consulting/payment-requests/${reqId}/cancel`, { reason: 'x' })).status, 409, 'cannot cancel a request with payments');
  const c = ok(await team('GET', `/api/consulting/contracts/${contract.id}`));
  assert.equal(c.paid, 11000);
  const p2 = r.payments.find((p) => p.deliverable_seq === 2);
  // void / correct: Admin only, reason required, history kept
  assert.equal((await team('POST', `/api/consulting/payments/${p2.id}/void`, { reason: 'x' })).status, 403);
  assert.equal((await team('POST', `/api/consulting/payments/${p2.id}/correct`, { reason: 'x', amount: 500, paid_at: today, finance_confirmed: true })).status, 403);
  assert.equal((await admin('POST', `/api/consulting/payments/${p2.id}/correct`, { amount: 500, paid_at: today, finance_confirmed: true })).status, 400);
  const fix = ok(await admin('POST', `/api/consulting/payments/${p2.id}/correct`, { reason: 'المبلغ الصحيح 500', amount: 500, paid_at: today, finance_confirmed: true }));
  r = ok(await team('GET', `/api/consulting/payment-requests/${reqId}`));
  assert.equal(r.paid, 10500);
  assert.ok(r.payments.some((p) => p.id === p2.id && p.voided_at && p.void_reason.includes('المبلغ الصحيح')), 'original kept as voided');
  assert.ok(r.payments.some((p) => p.id === fix.payment_id && p.replaces_payment_id === p2.id && !p.voided_at), 'correction linked to the request');
  ok(await admin('POST', `/api/consulting/payments/${fix.payment_id}/void`, { reason: 'إلغاء اختبار' }));
  assert.equal((await admin('POST', `/api/consulting/payments/${fix.payment_id}/void`, { reason: 'مرة أخرى' })).status, 409);
  r = ok(await team('GET', `/api/consulting/payment-requests/${reqId}`));
  assert.equal(r.paid, 10000);
  assert.ok(r.events.some((e) => e.event === 'payment_corrected') && r.events.some((e) => e.event === 'payment_voided'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM deliverable_payments WHERE company_id = ?').get(A).n, 3, 'nothing deleted');
});

test('deliverables across contracts and what is ready to prepare (for the team now, Maha later)', async () => {
  const all = ok(await team('GET', '/api/consulting/deliverables'));
  assert.ok(all.length >= 4);
  const toSend = ok(await team('GET', '/api/consulting/deliverables?state=not_sent'));
  assert.equal(toSend.length, 2);
  const awaiting = ok(await team('GET', '/api/consulting/deliverables?state=awaiting_payment'));
  assert.ok(awaiting.some((d) => d.id === contract.deliverables[1].id && d.open_claim === 3000));
  const ready = ok(await team('GET', '/api/consulting/ready'));
  assert.equal(ready.templates.payment_request, true);
  assert.ok(Array.isArray(ready.certificates) && Array.isArray(ready.payment_requests));
});

test('company separation for consultants, requests and payments', async () => {
  const t2 = await login('hcteam', creds.team);
  await t2.useCompany(B);
  assert.equal(ok(await t2('GET', '/api/consulting/consultants')).length, 0);
  assert.equal(ok(await t2('GET', '/api/consulting/payment-requests')).length, 0);
  assert.equal(ok(await t2('GET', '/api/consulting/consultant-match?id_number=1000000001')).length, 0, 'duplicate check stays inside the company');
  assert.equal((await t2('GET', `/api/consulting/payment-requests/${reqId}`)).status, 404);
  assert.equal((await t2('POST', '/api/consulting/payment-requests', { contract_id: contract.id, items: [{ deliverable_id: contract.deliverables[2].id, amount: 1 }] })).status, 404);
  assert.equal((await t2('POST', `/api/consulting/payment-requests/${reqId}/payments`, { amount: 1, paid_at: today, finance_confirmed: true })).status, 404);
  assert.equal(ok(await t2('GET', '/api/consulting/approver-suggestions')).length, 0);
  const bk = ok(await t2('POST', '/api/consulting/contracts-with-consultant', { consultant: { full_name_ar: 'استشاري اختبار', id_number: '1000000001' }, contract: { deliverables: [{ title: 'م', amount: 1, due_date: iso(1) }] } }));
  assert.notEqual(bk.consultant.id, consultantId, 'same ID allowed in the other company (separate register)');
  assert.throws(() => db.prepare('INSERT INTO payment_request_items (company_id, request_id, deliverable_id, amount) VALUES (?, ?, ?, 1)').run(B, reqId, contract.deliverables[2].id), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE payment_requests SET company_id = ? WHERE id = ?').run(B, reqId), /immutable/);
});
