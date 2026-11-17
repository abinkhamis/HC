// Company A employee record from recruitment to end of service + the active-employees
// Excel import. Fake data only, in a separate temporary test database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { buildXlsx } from '../src/xlsx.js';
import { writeZip } from '../src/docx/zip.js';
import { readWorkbook } from '../src/employee-import.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-emp-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin, adminB;
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });

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
const emp = (id) => db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
const countIn = (companyId) => db.prepare('SELECT COUNT(*) n FROM employees WHERE company_id = ?').get(companyId).n;

// A fake "active employees" workbook (headers as HR usually writes them).
const HEAD = ['الرقم الوظيفي', 'اسم الموظف', 'رقم الهوية', 'الجنسية', 'المسمى الوظيفي', 'الإدارة', 'تاريخ المباشرة'];
const xlsx = (rows, head = HEAD) => ({ filename: 'active-employees.xlsx', data: buildXlsx([{ name: 'النشطين', columns: head.map((h) => ({ header: h })), rows }]).toString('base64') });
const decisionsFrom = (preview, pick = {}) => Object.fromEntries(preview.rows.filter((r) => r.kind === 'review').map((r) => [r.row, pick[r.row] ?? r.default]));

before(async () => {
  ({ creds, db: seeded } = seed({ dbFile, storageDir, demo: false, writeCredentials: false }));
  server = createApp({ dbFile, storageDir });
  db = server.db;
  [A, B] = db.prepare('SELECT id FROM companies ORDER BY id').all().map((r) => r.id);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  team = await login('hcteam', creds.team);
  admin = await login('admin', creds.admin);
  adminB = await login('admin', creds.admin);
  await team.useCompany(A);
  await admin.useCompany(A);
  await adminB.useCompany(B);
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

let recruitWithNo, recruitNoNumber;

test('recruitment adds people before they start: «قيد الانضمام», visible in procedures, with or without a number', async () => {
  const c1 = ok(await team('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'سارة وهمية', employee_no: 'e 9001', national_id: '1000000001', nationality_ar: 'سعودي', hire_date: today }, case: {} }));
  recruitWithNo = c1.employee_id;
  assert.equal(emp(recruitWithNo).status, 'onboarding');
  assert.equal(emp(recruitWithNo).employee_no, 'E9001', 'number stored normalised (no spaces, upper case)');
  assert.equal(c1.employee.display_status_label, 'قيد الانضمام');
  assert.equal(c1.employee.can_confirm_start, true);
  // no number yet: saved on its internal id, the case is linked to it
  const c2 = ok(await team('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'خالد وهمي', national_id: '2000000002', nationality_ar: 'مصري', hire_date: today }, case: {} }));
  recruitNoNumber = c2.employee_id;
  assert.equal(emp(recruitNoNumber).employee_no, null);
  assert.equal(emp(recruitNoNumber).status, 'onboarding');
  const list = ok(await team('GET', '/api/procedures/cases'));
  assert.ok(list.some((c) => c.employee_id === recruitNoNumber), 'shown in procedures without being in any Excel file');
  const dir = ok(await team('GET', '/api/records/employees?status=onboarding'));
  assert.equal(dir.counts.onboarding, 2);
  assert.ok(dir.rows.every((r) => r.display_status === 'onboarding'));
});

test('employee number is unique per company across every status — clear refusal with the existing record', async () => {
  const before = countIn(A);
  // same number, different spacing / case / Arabic digits
  for (const no of ['E9001', 'e9001', ' E 9001 ', 'E٩٠٠١']) {
    const r = await team('POST', '/api/procedures/onboarding', { employee: { full_name_ar: 'شخص آخر', employee_no: no, hire_date: today }, case: {} });
    assert.equal(r.status, 409, no);
    assert.equal(r.body.code, 'employee_no_taken');
    assert.equal(r.body.details.employee_id, recruitWithNo, 'points to the existing record so it can be opened');
    assert.match(r.body.error, /قيد الانضمام/);
  }
  // the directory form is checked too (create and edit)
  assert.equal((await team('POST', '/api/records/employees', { full_name_ar: 'مكرر', employee_no: 'e9001' })).body.code, 'employee_no_taken');
  const other = ok(await team('POST', '/api/records/employees', { full_name_ar: 'موظف منتهي', employee_no: 'X-1', status: 'inactive' }));
  assert.equal((await team('PATCH', `/api/records/employees/${recruitNoNumber}`, { employee_no: 'x-1' })).body.code, 'employee_no_taken', 'ended employees count too');
  assert.equal(countIn(A), before + 1);
  // the database refuses it even if the app check were bypassed
  assert.throws(() => db.prepare("INSERT INTO employees (company_id, full_name_ar, employee_no) VALUES (?, 'تجاوز', 'e9001')").run(A), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE employees SET status = 'retired' WHERE id = ?").run(other.id), /CHECK/);
  // the same number is fine in the other company (separate data)
  ok(await adminB('POST', '/api/records/employees', { full_name_ar: 'موظف شركة ب', employee_no: 'E9001' }));
  db.prepare("INSERT INTO employees (company_id, full_name_ar, employee_no) VALUES (?, 'تجاوز ب', 'E9002')").run(B);
  assert.throws(() => db.prepare("INSERT INTO employees (company_id, full_name_ar, employee_no) VALUES (?, 'تجاوز ب٢', 'e 9002')").run(B), /UNIQUE/);
});

test('a number assigned later is checked, and copied to the procedure cases', async () => {
  const c = ok(await team('GET', '/api/procedures/cases')).find((x) => x.employee_id === recruitNoNumber);
  assert.equal((await team('POST', `/api/procedures/cases/${c.id}/employee-no`, { employee_no: 'E9001' })).body.code, 'employee_no_taken');
  const after = ok(await team('POST', `/api/procedures/cases/${c.id}/employee-no`, { employee_no: 'E9002' }));
  assert.equal(after.employee.employee_no, 'E9002');
  assert.equal(db.prepare('SELECT employee_no FROM proc_cases WHERE id = ?').get(c.id).employee_no, 'E9002');
  const h = ok(await team('GET', `/api/employees/${recruitNoNumber}/history`));
  assert.ok(h.events.some((e) => e.event === 'number_assigned'));
  // undo for the import scenario below: the recruit is matched by national ID instead
  db.prepare("UPDATE employees SET employee_no = NULL WHERE id = ?").run(recruitNoNumber);
});

let firstImport;
test('import preview: recruit appears later in the active file → same record, still «قيد الانضمام»; nothing saved by the preview', async () => {
  const bank = ok(await team('POST', '/api/records/bank_accounts', { employee_id: recruitWithNo, account_holder: 'سارة وهمية', bank_name: 'بنك وهمي', iban: 'SA0380000000608010167519' }));
  const file = xlsx([
    ['E9001', 'سارة وهمية', '1000000001', 'سعودي', 'محللة بيانات', 'إدارة الاختبار', today], // recruited with a number
    ['E9002', 'خالد وهمي', '2000000002', 'مصري', 'مطور', 'إدارة الاختبار', today], // recruited without a number (match by ID)
    ['E9100', 'موظف جديد وهمي', '3000000003', 'سعودي', 'محاسب', 'المالية', '2025-03-01'], // new
    ['', 'بلا رقم وهمي', '4000000004', 'سعودي', '', '', ''], // missing number
    ['E9200', 'مكرر أ', '', '', '', '', ''], ['E9200', 'مكرر ب', '', '', '', '', ''], // repeated in file
    ['X-1', 'اسم مختلف تمامًا', '', '', '', '', ''], // ended + different name → review
  ]);
  const n0 = countIn(A);
  const p = ok(await admin('POST', '/api/employees/import/preview', { file }));
  assert.equal(countIn(A), n0, 'preview saves nothing');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM employee_imports').get().n, 0);
  assert.equal(p.columns.find((c) => c.header === 'الرقم الوظيفي').field, 'employee_no', 'columns detected from Arabic headers');
  const byRow = Object.fromEntries(p.rows.map((r) => [r.employee_no || r.name, r]));
  assert.equal(byRow.E9001.kind, 'update');
  assert.equal(byRow.E9001.onboarding, true);
  assert.deepEqual(byRow.E9001.changes.map((c) => c.field).sort(), ['department', 'job_title']);
  assert.equal(byRow.E9002.kind, 'review');
  assert.equal(byRow.E9002.reason, 'link_candidate');
  assert.equal(byRow.E9002.default, `link:${recruitNoNumber}`, 'suggested: link to the recruit record');
  assert.equal(byRow.E9100.kind, 'create');
  assert.equal(byRow['بلا رقم وهمي'].reason, 'no_number');
  assert.equal(byRow['بلا رقم وهمي'].default, 'skip');
  assert.ok(p.rows.filter((r) => r.employee_no === 'E9200').every((r) => r.reason === 'dup_in_file' && r.default === 'skip'));
  assert.equal(byRow['X-1'].reason, 'conflict');
  assert.equal(p.summary.create, 1);
  firstImport = { file, p, bank };
});

test('import: updates, links, creates — never activates, never touches cases, bank accounts or other companies', async () => {
  const { file, p, bank } = firstImport;
  const casesBefore = db.prepare('SELECT * FROM proc_cases ORDER BY id').all();
  const stepsBefore = db.prepare('SELECT COUNT(*) n FROM proc_case_steps').get().n;
  const bOut = countIn(B);
  const r = ok(await admin('POST', '/api/employees/import/apply', { file, sha256: p.sha256, decisions: decisionsFrom(p) }));
  assert.deepEqual({ c: r.summary.create, u: r.summary.update, l: r.summary.linked, e: r.summary.error }, { c: 1, u: 1, l: 1, e: 0 });
  // recruited with a number: same record updated, still onboarding
  const s = emp(recruitWithNo);
  assert.equal(s.status, 'onboarding', 'the import never changes a status');
  assert.equal(s.job_title, 'محللة بيانات');
  // recruited without a number: linked (number added) — no duplicate record
  const k = emp(recruitNoNumber);
  assert.equal(k.employee_no, 'E9002');
  assert.equal(k.status, 'onboarding');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM employees WHERE company_id = ? AND national_id = '2000000002'").get(A).n, 1);
  // a new record from the file
  const created = db.prepare("SELECT * FROM employees WHERE company_id = ? AND employee_no = 'E9100'").get(A);
  assert.equal(created.status, 'active');
  assert.equal(created.hire_date, '2025-03-01');
  // skipped rows created nothing; the ended employee kept its status and name
  assert.equal(db.prepare("SELECT COUNT(*) n FROM employees WHERE employee_no = 'E9200'").get().n, 0);
  assert.equal(db.prepare("SELECT status, full_name_ar FROM employees WHERE company_id = ? AND employee_no = 'X-1'").get(A).status, 'inactive');
  // linked data kept
  assert.equal(db.prepare('SELECT employee_id FROM bank_accounts WHERE id = ?').get(bank.id).employee_id, recruitWithNo);
  const casesAfter = db.prepare('SELECT * FROM proc_cases ORDER BY id').all();
  assert.equal(casesAfter.length, casesBefore.length);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proc_case_steps').get().n, stepsBefore);
  assert.equal(casesAfter.find((c) => c.employee_id === recruitNoNumber).employee_no, 'E9002', 'case shows the new number');
  assert.equal(countIn(B), bOut, 'the other company is untouched');
  // history records each change with the import
  const h = ok(await admin('GET', `/api/employees/${recruitNoNumber}/history`));
  assert.ok(h.events.some((e) => e.event === 'import_linked' && e.import_id === r.import_id));
});

test('importing the same file twice changes nothing and says it was imported before', async () => {
  const { file } = firstImport;
  const snapshot = db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY id').all(A);
  const p2 = ok(await admin('POST', '/api/employees/import/preview', { file }));
  assert.ok(p2.previous_import, 'warns: this exact file was imported before');
  assert.equal(p2.summary.create, 0);
  assert.equal(p2.summary.update, 0);
  assert.equal(p2.rows.filter((r) => r.kind === 'unchanged').length, 3);
  const r2 = ok(await admin('POST', '/api/employees/import/apply', { file, sha256: p2.sha256, decisions: decisionsFrom(p2) }));
  assert.equal(r2.summary.create + r2.summary.update + r2.summary.linked, 0);
  assert.deepEqual(db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY id').all(A), snapshot);
});

test('employees missing from the file are listed but not deleted or changed; empty cells never erase data', async () => {
  const file = xlsx([['E9100', 'موظف جديد وهمي', '', '', '', '', '']]);
  const before = db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY id').all(A);
  const p = ok(await admin('POST', '/api/employees/import/preview', { file }));
  assert.ok(p.not_in_file.some((e) => e.id === recruitWithNo));
  const r = ok(await admin('POST', '/api/employees/import/apply', { file, sha256: p.sha256, decisions: decisionsFrom(p) }));
  assert.equal(r.summary.update, 0);
  assert.deepEqual(db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY id').all(A), before);
});

test('only operations activate: «تأكيد المباشرة» then «قيد إنهاء الخدمة» / «تأكيد انتهاء الخدمة»', async () => {
  const c = ok(await team('GET', '/api/procedures/cases')).find((x) => x.employee_id === recruitWithNo && x.case_type === 'onboarding');
  assert.equal((await team('POST', `/api/procedures/cases/${c.id}/confirm-start`, {})).body.code, 'confirmation_required');
  const started = ok(await team('POST', `/api/procedures/cases/${c.id}/confirm-start`, { confirmed: true, start_date: today }));
  assert.equal(started.employee.status, 'active');
  assert.equal(emp(recruitWithNo).hire_date, today);
  assert.equal((await team('POST', `/api/procedures/cases/${c.id}/confirm-start`, { confirmed: true })).body.code, 'not_onboarding');
  // an open offboarding case shows «قيد إنهاء الخدمة» (not stored)
  const off = ok(await team('POST', '/api/procedures/cases', { case_type: 'offboarding', employee_id: recruitWithNo, key_date: today }));
  assert.equal(off.employee.display_status, 'offboarding');
  assert.equal(emp(recruitWithNo).status, 'active');
  const dir = ok(await team('GET', '/api/records/employees?status=offboarding'));
  assert.deepEqual(dir.rows.map((r) => r.id), [recruitWithNo]);
  const ended = ok(await team('POST', `/api/procedures/cases/${off.id}/confirm-end`, { confirmed: true, end_date: today }));
  assert.equal(ended.employee.status, 'inactive');
  assert.equal(emp(recruitWithNo).end_date, today);
  const ev = ok(await team('GET', `/api/employees/${recruitWithNo}/history`)).events.map((e) => e.event);
  assert.ok(ev.includes('start_confirmed') && ev.includes('end_confirmed'));
});

test('import is Admin-only and stays inside the selected company', async () => {
  const file = xlsx([['E9001', 'سارة وهمية', '', '', '', '', '']]);
  assert.equal((await team('POST', '/api/employees/import/preview', { file })).status, 403);
  // in Company B, E9001 is Company B's own employee: company Company A's record is never matched
  const p = ok(await adminB('POST', '/api/employees/import/preview', { file }));
  assert.equal(p.rows[0].employee.full_name_ar, 'موظف شركة ب');
  assert.equal(p.rows[0].reason, 'conflict', 'different name → manual review');
  // a file without an employee-number column is not imported
  const noNo = ok(await admin('POST', '/api/employees/import/preview', { file: xlsx([['اسم', 'قسم']], ['الاسم', 'الإدارة']) }));
  assert.equal(noNo.missing_employee_no, true);
  // a changed file after the preview is refused
  const p1 = ok(await admin('POST', '/api/employees/import/preview', { file }));
  assert.equal((await admin('POST', '/api/employees/import/apply', { file: xlsx([['E1', 'x', '', '', '', '', '']]), sha256: p1.sha256 })).body.code, 'file_changed');
});

test('reads real-world Excel cells: shared strings, numeric numbers, date-formatted cells, Arabic digits', () => {
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2"><v>1234</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" s="1"><v>45717</v></c></row>
<row r="3"><c r="A3" t="str"><f>"E"&amp;"55"</f><v>E55</v></c><c r="C3" t="inlineStr"><is><t>٠١/٠٣/٢٠٢٥</t></is></c></row></sheetData></worksheet>`;
  const buf = writeZip(new Map([
    ['xl/workbook.xml', Buffer.from('<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')],
    ['xl/sharedStrings.xml', Buffer.from('<sst><si><t>Employee No</t></si><si><t>Name</t></si><si><t>Joining Date</t></si><si><r><t>Fake</t></r><r><t> Person</t></r></si></sst>')],
    ['xl/styles.xml', Buffer.from('<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')],
    ['xl/worksheets/sheet1.xml', Buffer.from(sheet)],
  ]));
  const wb = readWorkbook(buf);
  assert.deepEqual(wb.rows[1].cells, [1234, 'Fake Person', '2025-03-01']);
  assert.deepEqual(wb.rows[2].cells.slice(0, 1), ['E55']);
  assert.equal(wb.rows[2].cells[2], '٠١/٠٣/٢٠٢٥');
});
