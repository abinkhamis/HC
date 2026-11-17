// Air tickets — all data here is fake and lives in a separate temporary test database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { addMonths, nationalityClass, computeEntitlements } from '../src/airtickets.js';
import { readZip } from '../src/docx/zip.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-air-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const ago = (n) => shift(today, -n);
const POL = [{ version: 1, cycle_months: 11, effective_from: '2000-01-01' }];

async function login(username, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'hub' }, body: JSON.stringify({ username, password }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  let companyId;
  const call = async (method, url, body, { raw = false, headers = {} } = {}) => {
    const r = await fetch(base + url, { method, headers: { cookie, 'X-Requested-With': 'hub', 'Content-Type': 'application/json', ...(companyId ? { 'X-Company-Id': String(companyId) } : {}), ...headers }, body: body && JSON.stringify(body) });
    return { status: r.status, headers: r.headers, body: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => null) };
  };
  call.useCompany = async (id) => { await call('POST', '/api/session/company', { company_id: id }); companyId = id; };
  return call;
}
const mkEmp = async (who, data) => {
  const r = await who('POST', '/api/records/employees', { department: 'إدارة اختبار', ...data });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};
const balance = async (who, id) => (await who('GET', `/api/air-tickets/employees/${id}`)).body;

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

// ---------------- pure calculation ----------------
test('real installs start with no air-ticket operational data', () => {
  for (const t of ['air_ticket_disbursements', 'air_ticket_profiles', 'air_ticket_family_entitlements', 'air_ticket_balance_approvals']) {
    assert.equal(seeded.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, t);
  }
});

test('month arithmetic clamps to the end of the month', () => {
  assert.equal(addMonths('2024-01-15', 11), '2024-12-15');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2025-01-31', 13), '2026-02-28');
  assert.equal(addMonths('2024-03-31', 11), '2025-02-28');
  assert.equal(addMonths('2024-03-31', 22), '2026-01-31', 'anchored on the hire date, no drift');
});

test('nationality classification', () => {
  assert.equal(nationalityClass({ nationality_ar: 'سعودي' }), 'saudi');
  assert.equal(nationalityClass({ nationality_ar: 'سعودية' }), 'saudi');
  assert.equal(nationalityClass({ nationality_en: 'Saudi Arabian' }), 'saudi');
  assert.equal(nationalityClass({ nationality_ar: 'غير سعودي' }), 'non_saudi');
  assert.equal(nationalityClass({ nationality_ar: 'مصري' }), 'non_saudi');
  assert.equal(nationalityClass({ nationality_en: 'Indian' }), 'non_saudi');
  assert.equal(nationalityClass({}), 'unknown');
});

test('entitlement every 11 months from the hire date, with accumulation', () => {
  const c = computeEntitlements({ hireDate: '2024-01-15', asOf: '2026-11-16', policies: POL });
  assert.deepEqual(c.periods.map((p) => p.due_date), ['2024-12-15', '2025-11-15', '2026-10-15']);
  assert.equal(c.accrued, 3);
  assert.equal(c.used, 0, 'nothing is used unless a disbursement is recorded');
  assert.equal(c.remaining, 3, 'unused entitlements accumulate');
  assert.equal(c.next_due, '2027-09-15');
  const onDue = computeEntitlements({ hireDate: '2024-01-15', asOf: '2024-12-15', policies: POL });
  assert.equal(onDue.accrued, 1, 'due on the day itself');
  assert.equal(computeEntitlements({ hireDate: '2024-01-15', asOf: '2024-12-14', policies: POL }).accrued, 0);
});

test('end of service stops accrual and the next due date', () => {
  const c = computeEntitlements({ hireDate: '2024-01-15', endDate: '2025-12-01', asOf: '2026-11-16', policies: POL });
  assert.equal(c.accrued, 2);
  assert.equal(c.next_due, null);
});

test('policy change applies from its effective date only', () => {
  const pols = [...POL, { version: 2, cycle_months: 12, effective_from: '2025-12-01' }];
  const c = computeEntitlements({ hireDate: '2024-01-15', asOf: '2027-12-31', policies: pols });
  // the cycle is the policy in force at the previous due date: v2 (12 months) applies only after 2025-12-01
  assert.deepEqual(c.periods.map((p) => p.due_date), ['2024-12-15', '2025-11-15', '2026-10-15', '2027-10-15']);
  assert.deepEqual(c.periods.map((p) => p.cycle_months), [11, 11, 11, 12]);
});

test('employee entitlement and family tickets are counted separately (no double counting)', () => {
  const family = [{ id: 1, family_count: 3, effective_from: '2024-01-15' }];
  const disb = [{ disbursed_on: '2025-01-10', entitlements_used: 1, employee_included: 1, family_count: 3, ticket_amount: 8000, exit_reentry_fee: 800 }];
  const c = computeEntitlements({ hireDate: '2024-01-15', asOf: '2026-11-16', policies: POL, family, disbursements: disb });
  assert.equal(c.used, 1, 'one trip with 4 travellers uses ONE periodic entitlement');
  assert.equal(c.family_accrued, 9);
  assert.equal(c.family_used, 3);
  assert.equal(c.family_remaining, 6);
  assert.equal(c.money.beneficiaries, 4);
  assert.equal(c.money.total, 8800);
  assert.deepEqual(c.periods.map((p) => p.status), ['used', 'available', 'available']);
});

// ---------------- API ----------------
test('only non-Saudi employees are covered; nationality comes from the directory', async () => {
  const saudi = await mkEmp(team, { full_name_ar: 'اختبار سعودي', nationality_ar: 'سعودي', hire_date: ago(800) });
  const unknown = await mkEmp(team, { full_name_ar: 'اختبار بلا جنسية', hire_date: ago(800) });
  const noHire = await mkEmp(team, { full_name_ar: 'اختبار بلا مباشرة', nationality_ar: 'هندي' });
  const ok = await mkEmp(team, { full_name_ar: 'اختبار غير سعودي', nationality_ar: 'غير سعودي', hire_date: ago(800) });
  const list = (await team('GET', '/api/air-tickets/balances')).body;
  assert.ok(list.some((r) => r.employee.id === ok.id));
  assert.ok(!list.some((r) => [saudi.id, unknown.id, noHire.id].includes(r.employee.id)), 'excluded from the eligible list');
  const excluded = (await team('GET', '/api/air-tickets/balances?eligibility=excluded')).body;
  assert.equal(excluded.find((r) => r.employee.id === saudi.id).eligibility, 'saudi');
  assert.equal(excluded.find((r) => r.employee.id === unknown.id).eligibility, 'unknown');
  assert.equal(excluded.find((r) => r.employee.id === noHire.id).eligibility, 'no_hire_date');
  const body = { disbursed_on: ago(10), ticket_amount: 1000 };
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { ...body, employee_id: saudi.id })).body.code, 'not_eligible');
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { ...body, employee_id: unknown.id })).body.code, 'nationality_missing');
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { ...body, employee_id: noHire.id })).body.code, 'hire_date_missing');
  const s = (await team('GET', '/api/air-tickets/summary')).body;
  assert.ok(s.alerts.missing_nationality.some((e) => e.id === unknown.id), 'missing nationality is an alert');
});

test('historical entry recalculates totals, used, remaining and next due date', async () => {
  const hire = addMonths(today, -34); // 3 entitlements accrued
  const e = await mkEmp(team, { full_name_ar: 'اختبار تاريخي', nationality_ar: 'مصري', hire_date: hire });
  let b = await balance(team, e.id);
  assert.equal(b.accrued, 3);
  assert.equal(b.used, 0);
  assert.equal(b.remaining, 3);
  assert.equal(b.next_due, addMonths(hire, 44));
  assert.equal(b.balance_status, 'provisional');
  assert.equal(b.final, false);
  assert.ok(b.warnings.some((w) => w.includes('مبدئي')), 'provisional warning shown');
  assert.ok(b.warnings.some((w) => w.includes('لا تُعتبر مستخدمة')), 'unrecorded entitlements are not treated as used');

  // family entitlement: spouse + 2 children with every entitlement
  assert.equal((await team('POST', `/api/air-tickets/employees/${e.id}/family`, { family_count: 3, effective_from: hire })).status, 200);
  // historical record with unknown amounts is allowed (and flagged)
  const h1 = await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, source: 'historical', disbursed_on: addMonths(hire, 12),
    entitlements_used: 1, employee_included: true, family_count: 3, notes: 'سجل اختبار' });
  assert.equal(h1.status, 200, JSON.stringify(h1.body));
  assert.equal(h1.body.disbursement.ticket_amount, null);
  b = h1.body.balance;
  assert.equal(b.used, 1);
  assert.equal(b.remaining, 2);
  assert.equal(b.family_accrued, 9);
  assert.equal(b.family_used, 3);
  assert.equal(b.family_remaining, 6);
  assert.ok(b.warnings.some((w) => w.includes('بدون مبلغ')));

  // a new (current) disbursement needs the ticket amount
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: ago(5), entitlements_used: 1, employee_included: true })).status, 400);
  const c1 = await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: ago(5), entitlements_used: 1, employee_included: true,
    family_count: 2, ticket_amount: 7500, exit_reentry_fee: 600, reference: 'TST-1' });
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.balance.used, 2);
  assert.equal(c1.body.balance.remaining, 1);
  assert.equal(c1.body.balance.family_used, 5);
  assert.equal(c1.body.balance.money.total, 8100);

  // family-only trip: no periodic entitlement used
  const fam = await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: ago(3), entitlements_used: 0, family_count: 1, ticket_amount: 1500 });
  assert.equal(fam.status, 200, JSON.stringify(fam.body));
  assert.equal(fam.body.balance.used, 2, 'family-only tickets do not consume the employee entitlement');
  assert.equal(fam.body.balance.family_used, 6);
  // the employee travelling always consumes an entitlement
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: ago(3), entitlements_used: 0, employee_included: true, ticket_amount: 1 })).status, 400);
  // future dates and dates before hire are rejected
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: shift(today, 2), ticket_amount: 1 })).status, 400);
  assert.equal((await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, source: 'historical', disbursed_on: shift(hire, -1) })).status, 400);

  // editing a record recalculates
  const ed = await team('PATCH', `/api/air-tickets/disbursements/${c1.body.disbursement.id}`, { family_count: 1 });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.balance.family_used, 5);
  const ev = (await team('GET', `/api/air-tickets/events?employee_id=${e.id}`)).body;
  assert.ok(ev.some((x) => x.event === 'disbursement_updated' && JSON.parse(x.changes_json).family_count[0] === 2));
  assert.ok(ev.some((x) => x.event === 'historical_added'));
});

test('exceeding the balance needs explicit confirmation', async () => {
  const e = await mkEmp(team, { full_name_ar: 'اختبار تجاوز', nationality_en: 'Filipino', hire_date: addMonths(today, -12) }); // 1 accrued
  const body = { employee_id: e.id, disbursed_on: ago(2), entitlements_used: 2, employee_included: true, ticket_amount: 3000 };
  const r = await team('POST', '/api/air-tickets/disbursements', body);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'exceeds_balance');
  assert.equal((await team('GET', `/api/air-tickets/disbursements?employee_id=${e.id}`)).body.length, 0, 'nothing saved without confirmation');
  const ok = await team('POST', '/api/air-tickets/disbursements', { ...body, confirm_exceed: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.balance.remaining, -1);
  assert.ok(ok.body.balance.warnings.some((w) => w.includes('تتجاوز')));
  assert.ok((await team('GET', '/api/air-tickets/summary')).body.alerts.over_used.some((x) => x.employee.id === e.id));
});

test('opening balance approval: admin only, after review, locks history and keeps a log', async () => {
  const hire = addMonths(today, -40);
  const e = await mkEmp(team, { full_name_ar: 'اختبار اعتماد', nationality_ar: 'أردني', hire_date: hire });
  const h = await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, source: 'historical', disbursed_on: addMonths(hire, 13), entitlements_used: 1, employee_included: true, ticket_amount: 2000 });
  const asOf = ago(30);
  assert.equal((await team('POST', `/api/air-tickets/employees/${e.id}/opening-balance/approve`, { reviewed: true, as_of: asOf })).status, 403, 'team cannot approve');
  assert.equal((await admin('POST', `/api/air-tickets/employees/${e.id}/opening-balance/approve`, { as_of: asOf })).body.code, 'review_required');
  const ap = await admin('POST', `/api/air-tickets/employees/${e.id}/opening-balance/approve`, { reviewed: true, as_of: asOf, note: 'تمت مراجعة اختبار' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.balance_status, 'approved');
  assert.equal(ap.body.final, true);
  assert.equal(ap.body.warnings.filter((w) => w.includes('مبدئي')).length, 0);
  assert.equal(ap.body.approvals[0].accrued, 3);
  assert.equal(ap.body.approvals[0].used, 1);
  assert.equal((await admin('POST', `/api/air-tickets/employees/${e.id}/opening-balance/approve`, { reviewed: true })).status, 409, 'no double approval');

  // history up to the approval date is locked
  const lockedAdd = await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, source: 'historical', disbursed_on: ago(60), entitlements_used: 1, employee_included: true });
  assert.equal(lockedAdd.body.code, 'opening_locked');
  assert.equal((await team('PATCH', `/api/air-tickets/disbursements/${h.body.disbursement.id}`, { ticket_amount: 1 })).body.code, 'opening_locked');
  assert.equal((await admin('DELETE', `/api/air-tickets/disbursements/${h.body.disbursement.id}`, { reason: 'x' })).body.code, 'opening_locked');
  assert.equal((await team('POST', `/api/air-tickets/employees/${e.id}/family`, { family_count: 2, effective_from: hire })).body.code, 'opening_locked');
  // moving a later record into the locked period is also refused
  const later = await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: ago(1), entitlements_used: 1, employee_included: true, ticket_amount: 2500 });
  assert.equal(later.status, 200, 'records after the approval date are allowed');
  assert.equal(later.body.balance.balance_status, 'approved');
  assert.equal((await team('PATCH', `/api/air-tickets/disbursements/${later.body.disbursement.id}`, { disbursed_on: ago(90) })).body.code, 'opening_locked');

  // changing the hire date in the directory after approval flags the balance for review
  await team('PATCH', `/api/records/employees/${e.id}`, { hire_date: addMonths(hire, -1) });
  let b = await balance(team, e.id);
  assert.equal(b.balance_status, 'needs_review');
  assert.equal(b.final, false);
  await team('PATCH', `/api/records/employees/${e.id}`, { hire_date: hire });
  assert.equal((await balance(team, e.id)).balance_status, 'approved');

  // revoke: admin only, reason required
  assert.equal((await team('POST', `/api/air-tickets/employees/${e.id}/opening-balance/revoke`, { reason: 'x' })).status, 403);
  assert.equal((await admin('POST', `/api/air-tickets/employees/${e.id}/opening-balance/revoke`, {})).status, 400);
  const rv = await admin('POST', `/api/air-tickets/employees/${e.id}/opening-balance/revoke`, { reason: 'تصحيح اختبار' });
  assert.equal(rv.status, 200);
  assert.equal(rv.body.balance_status, 'provisional');
  assert.equal(rv.body.approvals.length, 1);
  assert.equal(rv.body.approvals[0].status, 'revoked');
  b = await balance(team, e.id);
  const events = b.events.map((x) => x.event);
  assert.ok(events.includes('opening_approved') && events.includes('opening_revoked'));
  // unlocked again
  assert.equal((await team('PATCH', `/api/air-tickets/disbursements/${h.body.disbursement.id}`, { ticket_amount: 2100 })).status, 200);
});

test('deleting a disbursement: admin only, reason required, kept in the log', async () => {
  const e = await mkEmp(team, { full_name_ar: 'اختبار حذف', nationality_ar: 'سوداني', hire_date: addMonths(today, -24) });
  const d = (await team('POST', '/api/air-tickets/disbursements', { employee_id: e.id, disbursed_on: ago(4), entitlements_used: 1, employee_included: true, ticket_amount: 900 })).body.disbursement;
  assert.equal((await team('DELETE', `/api/air-tickets/disbursements/${d.id}`, { reason: 'x' })).status, 403);
  assert.equal((await admin('DELETE', `/api/air-tickets/disbursements/${d.id}`, {})).status, 400);
  assert.equal((await admin('DELETE', `/api/air-tickets/disbursements/${d.id}`, { reason: 'إدخال خاطئ' })).status, 200);
  const b = await balance(team, e.id);
  assert.equal(b.used, 0);
  const del = b.events.find((x) => x.event === 'disbursement_deleted');
  assert.ok(del && del.detail.includes('إدخال خاطئ'));
  assert.equal(JSON.parse(del.changes_json).snapshot.ticket_amount, 900);
});

test('policy: admin only, versioned, never retroactive; tracking start makes new hires final', async () => {
  assert.equal((await team('POST', '/api/admin/air-tickets/policy', { cycle_months: 12 })).status, 403);
  assert.equal((await admin('POST', '/api/admin/air-tickets/policy', { cycle_months: 12, effective_from: ago(1) })).status, 400, 'no retroactive policy');
  assert.equal((await admin('POST', '/api/admin/air-tickets/policy', { cycle_months: 0 })).status, 400);
  const p = await admin('POST', '/api/admin/air-tickets/policy', { tracking_start: ago(30), note: 'اختبار' });
  assert.equal(p.status, 200);
  assert.equal(p.body.current.version, 2);
  assert.equal(p.body.current.cycle_months, 11);
  assert.equal(p.body.history.length, 2);
  const newHire = await mkEmp(team, { full_name_ar: 'اختبار موظف جديد', nationality_ar: 'باكستاني', hire_date: ago(10) });
  const b = await balance(team, newHire.id);
  assert.equal(b.balance_status, 'not_required');
  assert.equal(b.final, true);
  assert.equal(b.next_due, addMonths(ago(10), 11));
  // company B keeps its own policy
  await admin.useCompany(B);
  assert.equal((await admin('GET', '/api/air-tickets/policy')).body.current.version, 1);
  await admin.useCompany(A);
  await admin('POST', '/api/admin/air-tickets/policy', { tracking_start: null });
});

test('dashboard: upcoming, accumulated, disbursed', async () => {
  const soon = await mkEmp(team, { full_name_ar: 'اختبار قريب', nationality_ar: 'يمني', hire_date: shift(addMonths(today, -11), 20) });
  const s = (await team('GET', `/api/air-tickets/summary?from=${ago(400)}&to=${today}`)).body;
  assert.ok(s.due_soon.some((r) => r.employee.id === soon.id), 'due within the alert window');
  assert.ok(s.accumulated.length >= 1);
  assert.ok(s.accumulated.every((r) => r.remaining >= 1));
  assert.ok(s.disbursed.count >= 3);
  assert.ok(s.disbursed.total > 0);
  assert.ok(s.totals.provisional >= 1);
  assert.equal(s.totals.remaining, (await team('GET', '/api/air-tickets/balances')).body.reduce((x, r) => x + r.remaining, 0));
});

test('Excel export is a real workbook scoped to the company', async () => {
  const r = await team('GET', `/api/air-tickets/export.xlsx?from=${ago(2000)}&to=${today}`, undefined, { raw: true });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const z = readZip(r.body);
  assert.ok(z.has('xl/workbook.xml') && z.has('[Content_Types].xml'));
  const wb = z.get('xl/workbook.xml').toString('utf8');
  for (const n of ['ملخص', 'الأرصدة', 'سجل الصرف', 'القادمة والمتراكمة']) assert.ok(wb.includes(n), n);
  const balances = z.get('xl/worksheets/sheet2.xml').toString('utf8');
  assert.ok(balances.includes('rightToLeft="1"'));
  assert.ok(balances.includes('اختبار تاريخي'));
  assert.ok(!balances.includes('اختبار سعودي'), 'Saudi employees are not in the report');
  assert.ok(z.get('xl/worksheets/sheet3.xml').toString('utf8').includes('TST-1'));
});

test('company separation: Company A and Company B never see or touch each other\'s data', async () => {
  const aEmp = (await team('GET', '/api/air-tickets/balances')).body.find((r) => r.employee.full_name_ar === 'اختبار تاريخي');
  const aDisb = (await team('GET', `/api/air-tickets/disbursements?employee_id=${aEmp.employee.id}`)).body[0];
  const aFam = (await balance(team, aEmp.employee.id)).family_history[0];
  const t2 = await login('hcteam', creds.team);
  await t2.useCompany(B);
  const bEmp = await mkEmp(t2, { full_name_ar: 'اختبار شركة ب', nationality_ar: 'مصري', hire_date: addMonths(today, -23) });
  assert.equal((await t2('GET', '/api/air-tickets/balances')).body.length, 1);
  assert.equal((await t2('GET', '/api/air-tickets/disbursements')).body.length, 0);
  assert.equal((await t2('GET', `/api/air-tickets/employees/${aEmp.employee.id}`)).status, 404);
  assert.equal((await t2('POST', '/api/air-tickets/disbursements', { employee_id: aEmp.employee.id, disbursed_on: ago(1), ticket_amount: 1 })).status, 404);
  assert.equal((await t2('PATCH', `/api/air-tickets/disbursements/${aDisb.id}`, { notes: 'x' })).status, 404);
  assert.equal((await t2('DELETE', `/api/air-tickets/family/${aFam.id}`, { reason: 'x' })).status, 404);
  assert.equal((await t2('GET', '/api/air-tickets/events')).body.length, 0);
  const s = (await t2('GET', '/api/air-tickets/summary')).body;
  assert.equal(s.employees.eligible, 1);
  assert.equal(s.disbursed.count, 0);
  const x = readZip((await t2('GET', '/api/air-tickets/export.xlsx', undefined, { raw: true })).body);
  assert.ok(!x.get('xl/worksheets/sheet2.xml').toString('utf8').includes('اختبار تاريخي'));
  // a stale tab still pointing at the other company is refused
  assert.equal((await t2('GET', '/api/air-tickets/balances', undefined, { headers: { 'X-Company-Id': String(A) } })).status, 409);
  // the database itself refuses cross-company links
  assert.throws(() => db.prepare("INSERT INTO air_ticket_disbursements (company_id, employee_id, source, disbursed_on, entitlements_used, employee_included) VALUES (?, ?, 'current', ?, 1, 1)")
    .run(B, aEmp.employee.id, today), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE air_ticket_disbursements SET company_id = ? WHERE id = ?').run(B, aDisb.id), /immutable/);
  void bEmp;
});
