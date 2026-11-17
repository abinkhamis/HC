// Chamber of Commerce attestations — all data here is fake and lives in a temp DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { contractYear, createAttestationService } from '../src/attestations.js';
import { tenantRepo } from '../src/tenancy.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-att-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin, emp, empB;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const ago = (n) => shift(today, -n);

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
  // fake employees (test DB only): hired so that the current contract year started 100 days ago
  const hire = shift(ago(100), -730);
  emp = (await team('POST', '/api/records/employees', { full_name_ar: 'موظف اختبار', department: 'إدارة اختبار', hire_date: hire })).body;
  await team.useCompany(B);
  empB = (await team('POST', '/api/records/employees', { full_name_ar: 'موظف اختبار ب', department: 'إدارة ب', hire_date: hire })).body;
  await team.useCompany(A);
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('real installs start empty: no demo employees or attestations unless asked for', () => {
  assert.equal(seeded.prepare('SELECT COUNT(*) n FROM chamber_attestations').get().n, 0);
  assert.equal(seeded.prepare("SELECT COUNT(*) n FROM employees WHERE full_name_ar LIKE '%تجريبي%'").get().n, 0);
});

test('contract year calculation', () => {
  assert.deepEqual(contractYear('2023-03-15', '2026-03-14'), { start: '2025-03-15', end: '2026-03-14' });
  assert.deepEqual(contractYear('2023-03-15', '2026-03-15'), { start: '2026-03-15', end: '2027-03-14' });
  assert.deepEqual(contractYear('2024-02-29', '2025-03-01'), { start: '2025-02-28', end: '2026-02-27' });
  assert.deepEqual(contractYear('2024-02-29', '2028-02-29'), { start: '2028-02-29', end: '2029-02-27' });
  assert.deepEqual(contractYear('2023-03-15', '2026-07-01', 'calendar'), { start: '2026-01-01', end: '2026-12-31' });
  assert.throws(() => contractYear('2026-05-01', '2026-04-30'), /يسبق/);
});

let r1, r2, r3, r4;
test('employee data is pulled from the directory; fee is required while the policy has no default', async () => {
  const st = (await team('GET', `/api/attestations/employee-status?employee_id=${emp.id}`)).body;
  assert.equal(st.employee.full_name_ar, 'موظف اختبار');
  assert.equal(st.employee.department, 'إدارة اختبار');
  assert.equal(st.employee.company, 'شركة أ');
  assert.equal(st.contract_year.start, ago(100));
  assert.equal(st.next_charged_to, 'company');
  const noFee = await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'تعريف بالراتب', request_date: ago(90) });
  assert.equal(noFee.status, 400);
  assert.match(noFee.body.error, /رسوم/);
  r1 = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'تعريف بالراتب', request_date: ago(90), fee_amount: 100, employee_name: 'محاولة تزوير' })).body;
  assert.equal(r1.employee_name, 'موظف اختبار', 'name always comes from the directory');
  assert.equal(r1.department, 'إدارة اختبار');
  assert.equal(r1.hire_date, emp.hire_date);
  assert.equal(r1.company_id, A);
  assert.match(r1.request_no, /\/ATT\/\d{4}\/0001$/);
  // employee without hire date / from another company
  const noHire = (await team('POST', '/api/records/employees', { full_name_ar: 'بلا مباشرة' })).body;
  assert.equal((await team('POST', '/api/attestations', { employee_id: noHire.id, document_type: 'x', request_date: ago(1), fee_amount: 1 })).status, 400);
  assert.equal((await team('POST', '/api/attestations', { employee_id: empB.id, document_type: 'x', request_date: ago(1), fee_amount: 1 })).status, 404);
  assert.equal((await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'x', request_date: shift(today, 1), fee_amount: 1 })).status, 400, 'future');
});

test('first two in the contract year are on the company, the third onward on the employee', async () => {
  r2 = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'شهادة خبرة', request_date: ago(80), fee_amount: 100 })).body;
  r3 = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'تعريف بالراتب', request_date: ago(70), fee_amount: 120 })).body;
  r4 = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'عقد عمل', request_date: ago(60), fee_amount: 150 })).body;
  const prev = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'تعريف بالراتب', request_date: ago(200), fee_amount: 100 })).body;
  assert.deepEqual([r1, r2, r3, r4].map((r) => [r.seq_in_year, r.charged_to]), [[1, 'company'], [2, 'company'], [3, 'employee'], [4, 'employee']]);
  const fresh = (await team('GET', `/api/attestations/${r1.id}`)).body;
  assert.equal(fresh.charged_to, 'company');
  assert.equal(r3.deduction_status, 'pending');
  assert.equal(r3.deduction_amount, 120, 'deduction = fee of that request');
  assert.equal(r1.deduction_amount, 0);
  assert.equal(prev.seq_in_year, 1, 'previous contract year counts separately');
  assert.equal(prev.charged_to, 'company');
  // a back-dated request re-orders the year; open (unconfirmed) charges follow
  const early = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'خطاب لجهة حكومية', request_date: ago(95), fee_amount: 90 })).body;
  assert.equal(early.seq_in_year, 1);
  const list = (await team('GET', `/api/attestations?employee_id=${emp.id}&from=${ago(100)}`)).body.sort((a, b) => a.seq_in_year - b.seq_in_year);
  assert.deepEqual(list.map((r) => r.charged_to), ['company', 'company', 'employee', 'employee', 'employee']);
  assert.equal(list.find((r) => r.id === r2.id).charged_to, 'employee', 'r2 moved to 3rd place');
  // remove it again (admin, with reason) — r2 goes back to the company
  assert.equal((await team('DELETE', `/api/attestations/${early.id}`, { reason: 'x' })).status, 403, 'team cannot delete');
  assert.equal((await admin('DELETE', `/api/attestations/${early.id}`, {})).status, 400, 'reason required');
  assert.equal((await admin('DELETE', `/api/attestations/${early.id}`, { reason: 'إدخال خاطئ' })).status, 200);
  assert.equal((await team('GET', `/api/attestations/${r2.id}`)).body.charged_to, 'company');
  const ev = (await team('GET', '/api/attestations/events')).body.find((e) => e.event === 'deleted' && e.attestation_id === early.id);
  assert.ok(ev && JSON.parse(ev.changes_json).snapshot.request_no === early.request_no, 'deleted record kept in the log');
});

test('deductions are only recorded after explicit team confirmation, and confirmed ones never change automatically', async () => {
  const noConfirm = await team('POST', `/api/attestations/${r3.id}/deduction/confirm`, { payroll_month: today.slice(0, 7) });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.body.code, 'team_confirmation_required');
  assert.equal((await team('POST', `/api/attestations/${r3.id}/deduction/confirm`, { team_confirmed: true, payroll_month: '2026-13' })).status, 400);
  assert.equal((await team('POST', `/api/attestations/${r1.id}/deduction/confirm`, { team_confirmed: true, payroll_month: '2026-11' })).status, 409, 'company-charged has no deduction');
  const ok = await team('POST', `/api/attestations/${r3.id}/deduction/confirm`, { team_confirmed: true, payroll_month: '2026-11', note: 'مسير نوفمبر' });
  assert.equal(ok.body.deduction_status, 'confirmed');
  assert.equal(ok.body.deduction_payroll_month, '2026-11');

  // locked fields
  const locked = await team('PATCH', `/api/attestations/${r3.id}`, { fee_amount: 200 });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.code, 'deduction_locked');
  assert.equal((await team('PATCH', `/api/attestations/${r3.id}`, { notes: 'ملاحظة' })).status, 200, 'other fields stay editable');
  assert.equal((await admin('DELETE', `/api/attestations/${r3.id}`, { reason: 'x' })).status, 409);

  // cancelling an earlier request: r3 would now be inside the free allowance, but it is confirmed → kept and flagged
  assert.equal((await team('POST', `/api/attestations/${r1.id}/status`, { action: 'cancel' })).status, 400, 'reason required');
  await team('POST', `/api/attestations/${r1.id}/status`, { action: 'cancel', reason: 'تراجع الموظف' });
  const after3 = (await team('GET', `/api/attestations/${r3.id}`)).body;
  assert.equal(after3.deduction_status, 'confirmed');
  assert.equal(after3.charged_to, 'employee');
  assert.equal(after3.needs_review, 1);
  const after4 = (await team('GET', `/api/attestations/${r4.id}`)).body;
  assert.equal(after4.charged_to, 'employee', 'r4 is now 3rd → still employee');
  assert.equal(after4.seq_in_year, 3);
  const s = (await team('GET', '/api/attestations/summary')).body;
  assert.ok(s.alerts.needs_review.some((r) => r.id === r3.id));
  assert.ok(s.alerts.pending_deductions.some((r) => r.id === r4.id));

  // only the Admin can revert or waive
  assert.equal((await team('POST', `/api/attestations/${r3.id}/deduction/revert`, { reason: 'x' })).status, 403);
  assert.equal((await team('POST', `/api/attestations/${r4.id}/deduction/waive`, { reason: 'x' })).status, 403);
  const rev = await admin('POST', `/api/attestations/${r3.id}/deduction/revert`, { reason: 'مراجعة بعد إلغاء الطلب الأول' });
  assert.equal(rev.body.charged_to, 'company', 'after revert the open record follows the current count');
  assert.equal(rev.body.deduction_status, 'not_applicable');
  assert.equal(rev.body.needs_review, 0);
  const w = await admin('POST', `/api/attestations/${r4.id}/deduction/waive`, { reason: 'ظرف خاص' });
  assert.equal(w.body.deduction_status, 'waived');
  // reopening r1 → r4 would move back but it is waived → stays, no silent change
  await team('POST', `/api/attestations/${r1.id}/status`, { action: 'reopen' });
  assert.equal((await team('GET', `/api/attestations/${r4.id}`)).body.deduction_status, 'waived');
  const log = (await team('GET', `/api/attestations/${r3.id}`)).body.events.map((e) => e.event);
  for (const e of ['created', 'deduction_confirmed', 'updated', 'deduction_reverted']) assert.ok(log.includes(e), e);
});

test('policy changes are versioned, Admin-only, and do not touch existing requests', async () => {
  assert.equal((await team('POST', '/api/admin/attestations/policy', { free_per_year: 5 })).status, 403);
  const before = (await team('GET', `/api/attestations?employee_id=${emp.id}`)).body.map((r) => [r.id, r.charged_to, r.deduction_status, r.free_limit]);
  const p = await admin('POST', '/api/admin/attestations/policy', { free_per_year: 3, default_fee: 110, note: 'تعديل اختبار' });
  assert.equal(p.status, 200);
  assert.equal(p.body.current.version, 2);
  assert.equal(p.body.history.length, 2);
  const afterRows = (await team('GET', `/api/attestations?employee_id=${emp.id}`)).body.map((r) => [r.id, r.charged_to, r.deduction_status, r.free_limit]);
  assert.deepEqual(afterRows, before, 'existing records unchanged');
  const n = (await team('POST', '/api/attestations', { employee_id: emp.id, document_type: 'تعريف بالراتب', request_date: ago(10) })).body;
  assert.equal(n.fee_amount, 110, 'new default fee applies to new requests');
  assert.equal(n.free_limit, 3);
  assert.equal(n.policy.version, 2);
});

test('status flow', async () => {
  const id = r2.id;
  assert.equal((await team('POST', `/api/attestations/${id}/status`, { action: 'deliver' })).status, 409);
  assert.equal((await team('POST', `/api/attestations/${id}/status`, { action: 'submit', date: shift(today, 2) })).status, 400);
  assert.equal((await team('POST', `/api/attestations/${id}/status`, { action: 'submit', date: ago(79) })).body.status, 'in_progress');
  const at = (await team('POST', `/api/attestations/${id}/status`, { action: 'attest', date: ago(75), chamber_reference: 'CH-123' })).body;
  assert.equal(at.status, 'attested');
  assert.equal(at.chamber_reference, 'CH-123');
  assert.equal((await team('POST', `/api/attestations/${id}/status`, { action: 'deliver' })).body.status, 'delivered');
});

test('reports, alerts and CSV export', async () => {
  const s = (await team('GET', `/api/attestations/summary?from=${ago(365)}&to=${today}`)).body;
  assert.ok(s.totals.requests >= 5);
  assert.equal(s.totals.company_charged + s.totals.employee_charged, s.totals.requests);
  assert.ok(s.by_department.some((d) => d.key === 'إدارة اختبار'));
  assert.ok(s.by_employee[0].employee_name.startsWith('موظف اختبار'));
  assert.ok(s.alerts.overdue_requests.length >= 1, 'old open requests are flagged');
  const csv = await team('GET', '/api/attestations/export.csv', undefined, { raw: true });
  assert.equal(csv.status, 200);
  assert.deepEqual([...csv.body.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel shows Arabic');
  assert.ok(csv.body.subarray(3).toString('utf8').startsWith('رقم الطلب,'));
  assert.ok(csv.body.toString('utf8').includes('موظف اختبار'));
});

test('future Excel import: dry run validates with the same rules and saves nothing', () => {
  const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(A);
  const svc = createAttestationService(db);
  const before = db.prepare('SELECT COUNT(*) n FROM chamber_attestations').get().n;
  const r = svc.importRows(company, tenantRepo(db, A), [
    { employee_id: emp.id, document_type: 'تعريف بالراتب', request_date: ago(5), fee_amount: 100 },
    { employee_id: empB.id, document_type: 'تعريف بالراتب', request_date: ago(5), fee_amount: 100 },
    { employee_id: emp.id, request_date: ago(5) },
  ]);
  assert.equal(r.valid, 1);
  assert.equal(r.results[1].ok, false, 'other company employee rejected');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM chamber_attestations').get().n, before);
  assert.throws(() => svc.importRows(company, tenantRepo(db, A), [], { dryRun: false }), /غير مفعّل/);
});

test('company separation for attestations', async () => {
  const t2 = await login('hcteam', creds.team);
  await t2.useCompany(B);
  assert.deepEqual((await t2('GET', '/api/attestations')).body, []);
  assert.equal((await t2('GET', `/api/attestations/${r1.id}`)).status, 404);
  assert.equal((await t2('POST', `/api/attestations/${r4.id}/deduction/confirm`, { team_confirmed: true, payroll_month: '2026-11' })).status, 404);
  const pB = (await t2('GET', '/api/attestations/policy')).body;
  assert.equal(pB.current.version, 1, 'B keeps its own policy');
  assert.equal(pB.current.free_per_year, 2);
  const rb = (await t2('POST', '/api/attestations', { employee_id: empB.id, document_type: 'تعريف بالراتب', request_date: ago(30), fee_amount: 100 })).body;
  assert.equal(rb.company_id, B);
  assert.match(rb.request_no, /0001$/, 'numbering is per company');
  assert.ok(!(await t2('GET', '/api/attestations/events')).body.some((e) => e.company_id === A));
  const polA = db.prepare('SELECT id FROM attestation_policies WHERE company_id = ?').get(A).id;
  assert.throws(() => db.prepare(`INSERT INTO chamber_attestations (company_id, request_no, employee_id, employee_name, hire_date, document_type, request_date, fee_amount, policy_id, free_limit, year_basis, contract_year_start, contract_year_end)
    VALUES (?, 'X', ?, 'x', '2020-01-01', 'x', '2026-01-01', 1, ?, 2, 'calendar', '2026-01-01', '2026-12-31')`).run(B, emp.id, polA), /FOREIGN KEY/);
});
