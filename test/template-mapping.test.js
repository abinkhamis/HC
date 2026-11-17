// Certificate template set-up without editing Word. Uses a FAKE filled certificate with
// the same structure as a real one (label/value table, 3-line bank box, image next to
// amounts, approvals table) — no real people or accounts. Separate temporary database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { readZip, writeZip } from '../src/docx/zip.js';
import { analyzeDocx, applyMapping, verifyFormatting, documentText } from '../src/docx/template-mapping.js';
import { PNG_1x1 } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-tpl-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin, certType;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const iso = (n) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const b64 = (buf) => buf.toString('base64');
const OLD = { name: 'استشاري سابق وهمي', bank: 'مصرف وهمي سابق', iban: 'SA9900000000000000000001', desc: 'وصف مخرج سابق وهمي', amount: '7,777', a1: 'معتمد سابق أول', a2: 'معتمد سابق ثان', a3: 'معتمد سابق ثالث' };

// ---------- a fake filled certificate (same structure as the real one) ----------
const rtl = '<w:rPr><w:rFonts w:ascii="Arial" w:cs="DIN Next LT Arabic"/><w:b/><w:color w:val="5F1042"/><w:sz w:val="22"/><w:rtl/></w:rPr>';
const ltr = '<w:rPr><w:rFonts w:ascii="Arial" w:cs="DIN Next LT Arabic"/><w:sz w:val="22"/></w:rPr>';
const r = (t, rPr = rtl) => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (runs, align = 'center') => `<w:p><w:pPr><w:bidi/><w:jc w:val="${align}"/></w:pPr>${runs}</w:p>`;
const img = (id) => `<w:r><w:drawing><wp:inline><wp:extent cx="200000" cy="200000"/><wp:docPr id="${id}" name="riyal"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const cell = (content, shade) => `<w:tc><w:tcPr><w:tcW w:w="4500" w:type="dxa"/>${shade ? '<w:shd w:val="clear" w:fill="5F1042"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${content}</w:tc>`;
const row = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
function fakeCertificate() {
  const t1 = `<w:tbl><w:tblPr><w:bidiVisual/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="4500"/><w:gridCol w:w="4500"/></w:tblGrid>
    ${row(cell(p(r(OLD.name))), cell(p(r('Employee Name / اسم الموظف')), true))}
    ${row(cell(p(r('تحويل بنكي ')) + p(r(OLD.bank)) + p(r(OLD.iban, ltr))), cell(p(r('وصف التسليم / Deliverable Description')), true))}
    ${row(cell(p(r('01-10-2026', ltr) + r(' حتى ') + r('31-10-2026', ltr))), cell(p(r('فترة التسليم / Delivery date')), true))}
    ${row(cell(p(r(OLD.desc))), cell(p(r('المخرجات /Delivery details')), true))}
    ${row(cell(p(img(11) + r('7', ltr) + r(',', ltr) + r('777', ltr))), cell(p(r('قيمة المخرجات /Delivery amount')), true))}
    ${row(cell(p(img(12) + r(OLD.amount, ltr))), cell(p(r('الإجمالي/ Total Amount')), true))}</w:tbl>`;
  const t2 = `<w:tbl><w:tblPr><w:bidiVisual/></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid>
    <w:tr>${`<w:tc><w:tcPr><w:gridSpan w:val="4"/></w:tcPr>${p(r('اعتماد الوثيقة  / Approvals'))}</w:tc>`}</w:tr>
    ${row(cell(p(r('الاسم / Full Name')), true), cell(p(r(OLD.a1))), cell(p(r(OLD.a2))), cell(p(r(OLD.a3))))}
    ${row(cell(p(r('التوقيع / Signature')), true), cell(p('')), cell(p('')), cell(p('')))}
    ${row(cell(p(r('التاريخ / Date')), true), cell(p('')), cell(p('')), cell(p('')))}</w:tbl>`;
  const body = `${p(img(10) + r('شهادة إنجاز خدمات استشارية'))}${p(r('معلومات التسليمات / Deliverable(s) Information'), 'right')}${t1}${p('')}${p(r('الموافقة والاعتماد / Signoff'), 'right')}${t2}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const e = new Map();
  e.set('[Content_Types].xml', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'));
  e.set('_rels/.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  e.set('word/document.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`));
  e.set('word/_rels/document.xml.rels', Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'));
  e.set('word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`));
  e.set('word/media/image1.png', PNG_1x1);
  return writeZip(e);
}

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body, { raw = false } = {}) => {
    const x = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}) }, body: body && JSON.stringify(body) });
    return { status: x.status, body: raw ? Buffer.from(await x.arrayBuffer()) : await x.json().catch(() => null) };
  };
  call.useCompany = async (id) => { await call('POST', '/api/session/company', { company_id: id }); companyId = id; };
  return call;
}
const ok = (x) => { assert.ok(x.status === 200, `${x.status} ${JSON.stringify(x.body)}`); return x.body; };
const mappingFrom = (analysis) => Object.fromEntries(analysis.slots.map((s) => [s.id, { mode: s.suggestion.mode, pattern: s.suggestion.pattern }]));

before(async () => {
  ({ creds, db: seeded } = seed({ dbFile, storageDir, demo: false, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((x) => x.id);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  team = await login('hcteam', creds.team);
  admin = await login('admin', creds.admin);
  await team.useCompany(A);
  await admin.useCompany(A);
  certType = ok(await admin('GET', '/api/admin/letter-types')).find((t) => t.code === 'completion_certificate');
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('analysis: every box is listed with an honest suggestion', () => {
  const a = analyzeDocx(fakeCertificate());
  const s = (id) => a.slots.find((x) => x.id === id).suggestion;
  assert.equal(a.tables, 2);
  assert.equal(s('t0.r0.c0').pattern, '{{consultant_name_ar}}');
  assert.equal(s('t0.r0.c0').confidence, 'check', 'label says "employee" → must be confirmed');
  assert.equal(s('t0.r1.c0').pattern, 'تحويل بنكي\n{{consultant_bank_name}}\n{{consultant_iban}}', 'fixed text kept, bank and IBAN linked');
  assert.equal(s('t0.r1.c0').confidence, 'check', 'bank data under a "description" label → must be confirmed');
  assert.equal(s('t0.r2.c0').pattern, '{{deliverable_period_from:dash}} حتى {{deliverable_period_to:dash}}');
  assert.equal(s('t0.r3.c0').pattern, '{{deliverable_title}}');
  assert.equal(s('t0.r4.c0').pattern, '{{deliverable_amount}}');
  assert.equal(s('t0.r5.c0').pattern, '{{certificate_total}}');
  assert.deepEqual(['t1.r1.c1', 't1.r1.c2', 't1.r1.c3'].map((id) => s(id).pattern), ['{{approver_1_name}}', '{{approver_2_name}}', '{{approver_3_name}}']);
  for (const id of ['t1.r2.c1', 't1.r2.c2', 't1.r2.c3', 't1.r3.c1', 't1.r3.c2', 't1.r3.c3']) assert.equal(s(id).mode, 'blank', 'signatures and dates stay blank');
  assert.equal(s('t0.r0.c1').mode, 'fixed', 'labels stay as they are');
});

test('applying links keeps everything else identical; tampering is detected', () => {
  const src = fakeCertificate();
  const mapping = mappingFrom(analyzeDocx(src));
  const out = applyMapping(src, mapping);
  const v = verifyFormatting(src, out, mapping);
  assert.deepEqual(v, { ok: true, problems: [] });
  const doc = readZip(out).get('word/document.xml').toString('utf8');
  assert.equal((doc.match(/<w:drawing>/g) || []).length, 3, 'logo and both riyal images kept');
  assert.ok(doc.includes('w:fill="5F1042"') && doc.includes('<w:bidiVisual/>') && doc.includes('w:pgMar'), 'shading, table direction, page setup kept');
  const text = documentText(out);
  for (const x of Object.values(OLD)) assert.ok(!text.includes(x), `old value removed: ${x}`);
  assert.ok(text.includes('تحويل بنكي') && text.includes('Employee Name / اسم الموظف'), 'official wording kept');
  // the period line keeps the number formatting for dates and the Arabic formatting for «حتى»
  assert.match(doc, /<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="DIN Next LT Arabic"\/><w:sz w:val="22"\/><\/w:rPr><w:t xml:space="preserve">\{\{deliverable_period_from:dash\}\}<\/w:t><\/w:r>/);
  // tampering: an image removed or a fixed box changed must be reported
  const z = readZip(out);
  z.set('word/document.xml', Buffer.from(doc.replace(/<w:r><w:drawing>[\s\S]*?<\/w:drawing><\/w:r>/, ''), 'utf8'));
  assert.equal(verifyFormatting(src, writeZip(z), mapping).ok, false);
  const z2 = readZip(out);
  z2.set('word/document.xml', Buffer.from(doc.replace('Employee Name / اسم الموظف', 'Employee'), 'utf8'));
  assert.ok(verifyFormatting(src, writeZip(z2), mapping).problems.some((x) => x.includes('غير مربوطة')));
});

let draftId, uploadedId;
test('upload: a certificate template is a draft — never active, not usable, not activatable', async () => {
  const up = ok(await admin('POST', '/api/admin/templates', { letter_type_id: certType.id, file: { filename: 'شهادة مكتملة (وهمية).docx', data: b64(fakeCertificate()) } }));
  uploadedId = up.template_id;
  assert.equal(up.draft, true);
  assert.deepEqual(up.placeholders, []);
  assert.equal(ok(await team('GET', '/api/consulting/templates')).certificate, null, 'not active');
  assert.equal((await admin('POST', `/api/admin/templates/${uploadedId}/activate`)).body.code, 'not_approved');
  const refused = await admin('POST', `/api/admin/templates/${uploadedId}/approve`);
  assert.equal(refused.body.code, 'not_ready');
  assert.match(refused.body.error, /لا يحتوي على أي خانة مربوطة/);
  assert.match(refused.body.error, /اسم الاستشاري/);
  assert.equal((await team('GET', `/api/admin/templates/${uploadedId}/analysis`)).status, 403, 'Admin only');
});

test('link boxes → new draft version; trial with fake data; approval only when everything passes', async () => {
  const an = ok(await admin('GET', `/api/admin/templates/${uploadedId}/analysis`));
  assert.ok(an.fields.some((f) => f.key === 'certificate_total'));
  assert.deepEqual(an.current.missing_required.length, 6);
  // invalid field refused; incomplete mapping saved but cannot be approved
  const bad = mappingFrom(an); bad['t0.r0.c0'] = { mode: 'field', pattern: '{{not_a_field}}' };
  assert.equal((await admin('POST', `/api/admin/templates/${uploadedId}/mapping`, { mapping: bad })).status, 400);
  const partial = mappingFrom(an); partial['t1.r1.c3'] = { mode: 'fixed' };
  const p1 = ok(await admin('POST', `/api/admin/templates/${uploadedId}/mapping`, { mapping: partial }));
  assert.deepEqual(p1.checks.missing_required, ['اسم المعتمد 3']);
  ok(await admin('POST', `/api/admin/templates/${p1.template_id}/trial`, { pdf: false }));
  const r1 = await admin('POST', `/api/admin/templates/${p1.template_id}/approve`);
  assert.match(r1.body.error, /اسم المعتمد 3/);
  // full mapping
  const m = ok(await admin('POST', `/api/admin/templates/${uploadedId}/mapping`, { mapping: mappingFrom(an) }));
  draftId = m.template_id;
  assert.equal(m.checks.format_ok, true);
  assert.deepEqual(m.checks.missing_required, []);
  assert.equal((await admin('POST', `/api/admin/templates/${draftId}/approve`)).body.code, 'not_ready', 'trial required first');
  const t = ok(await admin('POST', `/api/admin/templates/${draftId}/trial`, { pdf: false }));
  assert.equal(t.checks.trial_ok, true, JSON.stringify(t.checks));
  const trial = await admin('GET', `/api/admin/templates/${draftId}/trial/docx`, undefined, { raw: true });
  const text = documentText(trial.body);
  assert.ok(text.includes('استشاري تجريبي (وهمي)') && text.includes('معتمد تجريبي ١') && text.includes('SA0000000000000000000000'));
  for (const x of Object.values(OLD)) assert.ok(!text.includes(x), 'no data of the previous consultant');
  assert.equal(ok(await team('GET', '/api/consulting/templates')).certificate, null, 'still not active before approval');
  ok(await admin('POST', `/api/admin/templates/${draftId}/approve`));
  assert.ok(ok(await team('GET', '/api/consulting/templates')).certificate);
  // earlier versions kept untouched
  const versions = ok(await admin('GET', '/api/admin/templates')).filter((x) => x.letter_type_id === certType.id);
  assert.equal(versions.length, 3);
  assert.equal(versions.find((x) => x.id === uploadedId).review_state, 'draft');
  assert.equal(versions.filter((x) => x.is_active).length, 1);
});

test('issuing a real certificate with the linked template: right data, blank signatures, images kept', async () => {
  const c = ok(await team('POST', '/api/consulting/contracts-with-consultant', {
    consultant: { full_name_ar: 'استشاري اختبار جديد', id_number: '1777777777', bank_name: 'بنك اختبار', iban: 'SA1100000000000000000077' },
    contract: { deliverables: [{ title: 'مخرج اختبار الربط', amount: 4321, due_date: iso(-5), period_from: iso(-40), period_to: iso(-10) }] },
  }));
  await team('POST', `/api/consulting/contracts/${c.id}/status`, { action: 'mark_signed', date: iso(-30) });
  const d = c.deliverables[0];
  ok(await team('POST', `/api/consulting/deliverables/${d.id}/certificate`, { completion_date: iso(-1), approvers: [{ name: 'معتمد ألف' }, { name: 'معتمد باء' }, { name: 'معتمد جيم' }] }));
  const f = await team('GET', `/api/consulting/deliverables/${d.id}/certificate`, undefined, { raw: true });
  const text = documentText(f.body);
  for (const x of ['استشاري اختبار جديد', 'بنك اختبار', 'SA1100000000000000000077', 'مخرج اختبار الربط', '4,321', 'معتمد ألف', 'معتمد باء', 'معتمد جيم', 'تحويل بنكي']) assert.ok(text.includes(x), x);
  assert.ok(text.includes(`${iso(-40).split('-').reverse().join('-')} حتى ${iso(-10).split('-').reverse().join('-')}`), 'period filled');
  for (const x of Object.values(OLD)) assert.ok(!text.includes(x), 'nothing from the previous consultant');
  const doc = readZip(f.body).get('word/document.xml').toString('utf8');
  assert.equal((doc.match(/<w:drawing>/g) || []).length, 3);
  const a = analyzeDocx(f.body);
  for (const id of ['t1.r2.c1', 't1.r2.c2', 't1.r2.c3', 't1.r3.c1', 't1.r3.c2', 't1.r3.c3']) assert.equal(a.slots.find((x) => x.id === id).text, '', 'signature/date stay blank');
});

test('each company sets up its own templates', async () => {
  const t2 = await login('admin', creds.admin);
  await t2.useCompany(B);
  assert.equal((await t2('GET', `/api/admin/templates/${draftId}/analysis`)).status, 404);
  assert.equal((await t2('POST', `/api/admin/templates/${draftId}/approve`)).status, 404);
  assert.equal(ok(await t2('GET', '/api/admin/templates')).length, 0);
  const tb = await login('hcteam', creds.team);
  await tb.useCompany(B);
  assert.equal(ok(await tb('GET', '/api/consulting/templates')).certificate, null, 'Company A\'s approved template is not used by Company B');
});
