// Employee procedures tracking — all data here is fake and lives in a separate temporary test database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/seed.js';
import { createApp } from '../src/server.js';
import { readZip } from '../src/docx/zip.js';
import { makeDocx } from './fixtures.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchub-proc-'));
const dbFile = path.join(dir, 'hub.db');
const storageDir = path.join(dir, 'storage');
let server, base, creds, db, seeded, A, B, team, admin, saudi, expat, unknown;

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const b64 = (buf) => buf.toString('base64');

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
const ok = (r) => { assert.ok(r.status === 200, `${r.status} ${JSON.stringify(r.body)}`); return r.body; };
const mkEmp = async (who, data) => ok(await who('POST', '/api/records/employees', { department: 'إدارة اختبار', ...data }));
const step = (c, name) => c.steps.find((s) => s.name_ar === name);

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
  saudi = await mkEmp(team, { full_name_ar: 'اختبار سعودي', nationality_ar: 'سعودي', hire_date: shift(today, -3) });
  expat = await mkEmp(team, { full_name_ar: 'اختبار مقيم', nationality_ar: 'مصري', hire_date: shift(today, -2) });
  unknown = await mkEmp(team, { full_name_ar: 'اختبار بلا جنسية', hire_date: shift(today, -1) });
});
after(() => { server.close(); seeded.close(); db.close(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });

test('real installs start with no cases; each company gets its own copy of the initial checklists', async () => {
  assert.equal(seeded.prepare('SELECT COUNT(*) n FROM proc_cases').get().n, 0);
  const a = ok(await team('GET', '/api/procedures/checklists'));
  assert.deepEqual(a.filter((s) => s.case_type === 'onboarding').map((s) => s.name_ar), ['ملف الموظف', 'إنشاء البريد الإلكتروني', 'طلب الجهاز', 'إشعار المباشرة',
    'اتفاقية سرية المعلومات', 'التسجيل في جسر', 'التأمين الطبي', 'عقد قوى', 'التأمينات الاجتماعية', 'نقل الكفالة', 'التسجيل في الدعم', 'حركة الرواتب']);
  assert.deepEqual(a.filter((s) => s.case_type === 'offboarding').map((s) => s.name_ar), ['التصفية', 'إخلاء الطرف', 'إغلاق البريد الإلكتروني', 'إلغاء التأمين الصحي',
    'إلغاء التأمينات الاجتماعية', 'نقل الكفالة', 'إرسال التصفية إلى المالية', 'إقرار المستحقات', 'شهادة الخبرة']);
  assert.ok(a.every((s) => s.deadline_days === null), 'no default deadlines');
  assert.ok(!a.some((s) => /حملة|الإعلامية/.test(s.name_ar)), 'media campaign excluded');
  const lists = ok(await team('GET', '/api/procedures/lists'));
  assert.equal(lists.party.length, 0, 'responsible parties start empty (Admin fills them)');
  assert.equal(lists.project.length, 0, 'projects start empty (nothing copied from the old file)');
  assert.ok(lists.support_reason.some((r) => r.label === 'غير مسجل في طاقات'));
  // Company B has its own copy
  await admin.useCompany(B);
  const b = ok(await admin('GET', '/api/procedures/checklists'));
  assert.equal(b.length, a.length);
  assert.ok(b.every((s) => !a.some((x) => x.id === s.id)), 'separate rows per company');
  await admin.useCompany(A);
});

test('onboarding case: steps copied from the checklist, nationality-linked steps set automatically', async () => {
  const s = ok(await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: saudi.id }));
  assert.match(s.case_no, /^[A-Z0-9]+\/ONB\/\d{4}\/0001$/);
  assert.equal(s.key_date, saudi.hire_date, 'start date taken from the directory');
  assert.equal(s.employee_name, 'اختبار سعودي');
  assert.equal(step(s, 'نقل الكفالة').status, 'na');
  assert.equal(step(s, 'نقل الكفالة').auto_na, 1);
  assert.match(step(s, 'نقل الكفالة').na_reason, /سعودي/);
  assert.equal(step(s, 'التسجيل في الدعم').status, 'pending');
  assert.equal(s.progress.applicable, 11);
  assert.equal(s.progress.percent, 0);

  const e = ok(await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: expat.id }));
  assert.equal(step(e, 'نقل الكفالة').status, 'pending');
  assert.equal(step(e, 'التسجيل في الدعم').status, 'na');

  const u = ok(await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: unknown.id }));
  assert.ok(u.steps.every((x) => x.status === 'pending'), 'unknown nationality: nothing decided automatically');
  assert.ok(u.warnings.some((w) => w.includes('غير محددة')));
});

test('each step is updated on its own; "not applicable" needs a reason; auto N/A can be changed with a reason', async () => {
  const c = ok(await team('GET', '/api/procedures/cases?case_type=onboarding')).find((x) => x.employee_id === saudi.id);
  let full = ok(await team('GET', `/api/procedures/cases/${c.id}`));
  // responsible parties come from the Admin list
  assert.equal((await team('POST', '/api/admin/procedures/lists', { list: 'party', label: 'تقنية المعلومات' })).status, 403);
  const lists = ok(await admin('POST', '/api/admin/procedures/lists', { list: 'party', label: 'تقنية المعلومات' }));
  const it = lists.party[0];
  const email = step(full, 'إنشاء البريد الإلكتروني');
  full = ok(await team('PATCH', `/api/procedures/steps/${email.id}`, { status: 'in_progress', party_id: it.id, assignee_name: 'منفذ اختبار', due_date: shift(today, -1), notes: 'ملاحظة' }));
  assert.equal(step(full, 'إنشاء البريد الإلكتروني').party_label, 'تقنية المعلومات');
  assert.equal(step(full, 'إنشاء البريد الإلكتروني').overdue, true, 'past deadline and not complete → overdue');
  full = ok(await team('PATCH', `/api/procedures/steps/${email.id}`, { status: 'done' }));
  assert.equal(step(full, 'إنشاء البريد الإلكتروني').completed_on, today);
  assert.equal(step(full, 'إنشاء البريد الإلكتروني').overdue, false);
  assert.equal(full.progress.done, 1);
  assert.equal(full.progress.percent, Math.round(100 / 11));
  // a step with no deadline is never overdue
  assert.ok(full.steps.filter((x) => !x.due_date).every((x) => !x.overdue));
  // N/A without a reason is refused; support registration needs a reason from the list
  const dev = step(full, 'طلب الجهاز');
  assert.equal((await team('PATCH', `/api/procedures/steps/${dev.id}`, { status: 'na' })).body.code, 'reason_required');
  full = ok(await team('PATCH', `/api/procedures/steps/${dev.id}`, { status: 'na', na_reason: 'يعمل من جهازه' }));
  const sup = step(full, 'التسجيل في الدعم');
  assert.equal((await team('PATCH', `/api/procedures/steps/${sup.id}`, { status: 'na', na_reason: 'نص حر' })).body.code, 'reason_required');
  const reason = ok(await team('GET', '/api/procedures/lists')).support_reason.find((r) => r.label === 'مسجل في الدعم سابقًا');
  full = ok(await team('PATCH', `/api/procedures/steps/${sup.id}`, { status: 'na', na_reason_id: reason.id }));
  assert.equal(step(full, 'التسجيل في الدعم').na_reason_label, 'مسجل في الدعم سابقًا');
  // changing the automatic N/A needs a reason and is logged
  const spon = step(full, 'نقل الكفالة');
  assert.equal((await team('PATCH', `/api/procedures/steps/${spon.id}`, { status: 'pending' })).body.code, 'reason_required');
  full = ok(await team('PATCH', `/api/procedures/steps/${spon.id}`, { status: 'pending', reason: 'تصحيح اختبار' }));
  assert.equal(step(full, 'نقل الكفالة').auto_na, 0);
  assert.ok(full.events.some((ev) => ev.event === 'step_updated' && ev.detail.includes('تصحيح اختبار')));
  assert.equal((await team('PATCH', `/api/procedures/steps/${email.id}`, { completed_on: shift(today, 3) })).status, 400, 'no future completion date');
});

test('duplicates: a second open case for the same event warns before opening', async () => {
  const r = await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: saudi.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'duplicate_case');
  const forced = ok(await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: saudi.id, confirm_duplicate: true }));
  assert.match(forced.case_no, /\/0004$/);
  assert.ok(forced.other_cases.length >= 1, 'other cases of the employee are shown');
  assert.equal((await team('POST', `/api/procedures/cases/${forced.id}/cancel`, {})).status, 400, 'cancel needs a reason');
  assert.equal(ok(await team('POST', `/api/procedures/cases/${forced.id}/cancel`, { reason: 'مكررة' })).status, 'cancelled');
});

test('offboarding: closing needs every step resolved and confirmation; directory end date is never changed', async () => {
  await admin('POST', '/api/admin/procedures/lists', { list: 'project', label: 'مشروع اختبار' });
  const l = ok(await team('GET', '/api/procedures/lists'));
  const lastDay = shift(today, 10);
  const c = ok(await team('POST', '/api/procedures/cases', { case_type: 'offboarding', employee_id: expat.id, key_date: lastDay, notice_date: today,
    offboarding_reason_id: l.offboarding_reason.find((x) => x.label === 'استقالة').id, project_id: l.project[0].id, owner_name: 'مسؤول اختبار' }));
  assert.match(c.case_no, /\/OFB\//);
  assert.equal(c.offboarding_reason_label, 'استقالة');
  assert.equal(c.project_label, 'مشروع اختبار');
  assert.equal(step(c, 'نقل الكفالة').status, 'pending', 'non-Saudi: sponsorship transfer applies');
  assert.equal((await team('POST', `/api/procedures/cases/${c.id}/close`, { confirmed: true })).body.code, 'steps_pending');
  for (const s of c.steps) await team('PATCH', `/api/procedures/steps/${s.id}`, s.letter_type_id ? { status: 'na', na_reason: 'اختبار' } : { status: 'done' });
  assert.equal((await team('POST', `/api/procedures/cases/${c.id}/close`, {})).body.code, 'confirmation_required');
  const closed = ok(await team('POST', `/api/procedures/cases/${c.id}/close`, { confirmed: true, note: 'تمت المراجعة' }));
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closed_on, today);
  assert.equal(closed.progress.percent, 100);
  const emp = ok(await team('GET', `/api/records/employees/${expat.id}`));
  assert.equal(emp.end_date ?? null, null, 'end-of-service date untouched');
  assert.equal(emp.status, 'active');
  // closed cases are read-only until the Admin reopens them
  assert.equal((await team('PATCH', `/api/procedures/steps/${c.steps[0].id}`, { notes: 'x' })).body.code, 'case_not_open');
  assert.equal((await team('POST', `/api/procedures/cases/${c.id}/reopen`, { reason: 'x' })).status, 403);
  assert.equal(ok(await admin('POST', `/api/procedures/cases/${c.id}/reopen`, { reason: 'مراجعة اختبار' })).status, 'open');
  // a new offboarding for the same employee warns (open case exists)
  assert.equal((await team('POST', '/api/procedures/cases', { case_type: 'offboarding', employee_id: expat.id, key_date: lastDay })).body.code, 'duplicate_case');
});

test('letter steps link to the existing letters centre; nothing is issued without an official template', async () => {
  const c = ok(await team('POST', '/api/procedures/cases', { case_type: 'offboarding', employee_id: saudi.id, key_date: today }));
  const cert = step(c, 'شهادة الخبرة');
  assert.ok(cert.letter_type_id);
  assert.equal(c.letters[cert.letter_type_id].template_available, false);
  const ready = ok(await team('GET', `/api/procedures/cases/${c.id}/documents-ready`));
  assert.ok(ready.some((d) => d.step === 'شهادة الخبرة' && d.template_available === false));
  // issuing through the letters centre is still refused without a template (unchanged behaviour)
  assert.equal((await team('POST', '/api/letters/issue', { letter_type_id: cert.letter_type_id, employee_id: saudi.id })).status, 422);
  // Admin uploads a (test) template; the letter is issued from the letters centre and linked to the step
  ok(await admin('POST', '/api/admin/templates', { letter_type_id: cert.letter_type_id, file: { filename: 'test.docx', data: b64(makeDocx(['{{employee_name_ar}}'])) } }));
  const issued = ok(await team('POST', '/api/letters/issue', { letter_type_id: cert.letter_type_id, employee_id: saudi.id }));
  const after1 = ok(await team('GET', `/api/procedures/cases/${c.id}`));
  assert.equal(after1.letters[cert.letter_type_id].template_available, true);
  assert.equal(after1.letters[cert.letter_type_id].issued[0].id, issued.id);
  const linked = ok(await team('POST', `/api/procedures/steps/${cert.id}/letter`, { issued_letter_id: issued.id }));
  assert.equal(step(linked, 'شهادة الخبرة').issued_letter_id, issued.id);
  assert.equal(step(linked, 'شهادة الخبرة').status, 'pending', 'linking does not complete the step');
  // a letter of another employee or another type cannot be linked
  const clearance = step(linked, 'إخلاء الطرف');
  assert.equal((await team('POST', `/api/procedures/steps/${clearance.id}/letter`, { issued_letter_id: issued.id })).status, 400);
});

test('steps added to one case; checklist edits affect new cases only', async () => {
  const c = ok(await team('GET', '/api/procedures/cases?case_type=onboarding&status=open')).find((x) => x.employee_id === expat.id);
  let full = ok(await team('POST', `/api/procedures/cases/${c.id}/steps`, { name_ar: 'إجراء إضافي للاختبار' }));
  const extra = step(full, 'إجراء إضافي للاختبار');
  assert.equal(extra.checklist_step_id, null);
  assert.equal((await team('DELETE', `/api/procedures/steps/${step(full, 'ملف الموظف').id}`, { reason: 'x' })).status, 409, 'checklist steps are not deleted from a case');
  full = ok(await team('DELETE', `/api/procedures/steps/${extra.id}`, { reason: 'إضافة خاطئة' }));
  assert.ok(!step(full, 'إجراء إضافي للاختبار'));

  // Admin edits the checklist: deadline, new step, deactivate a step
  assert.equal((await team('POST', '/api/admin/procedures/checklists', { case_type: 'onboarding', name_ar: 'x' })).status, 403);
  const list = ok(await admin('GET', '/api/procedures/checklists?case_type=onboarding'));
  const device = list.find((s) => s.name_ar === 'طلب الجهاز');
  ok(await admin('POST', '/api/admin/procedures/checklists', { id: device.id, deadline_days: 5 }));
  ok(await admin('POST', '/api/admin/procedures/checklists', { id: list.find((s) => s.name_ar === 'حركة الرواتب').id, is_active: false }));
  ok(await admin('POST', '/api/admin/procedures/checklists', { case_type: 'onboarding', name_ar: 'بطاقة الدخول', applies_to: 'all' }));
  const before1 = ok(await team('GET', `/api/procedures/cases/${c.id}`));
  assert.equal(step(before1, 'طلب الجهاز').due_date, null, 'existing case unchanged');
  assert.ok(step(before1, 'حركة الرواتب'));
  const emp = await mkEmp(team, { full_name_ar: 'اختبار بعد التعديل', nationality_ar: 'سعودي', hire_date: today });
  const n = ok(await team('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: emp.id }));
  assert.equal(step(n, 'طلب الجهاز').due_date, shift(today, 5));
  assert.ok(!step(n, 'حركة الرواتب'));
  assert.ok(step(n, 'بطاقة الدخول'));
  // Company B's checklist is untouched
  await admin.useCompany(B);
  const b = ok(await admin('GET', '/api/procedures/checklists?case_type=onboarding'));
  assert.ok(!b.some((s) => s.name_ar === 'بطاقة الدخول'));
  assert.equal(b.find((s) => s.name_ar === 'طلب الجهاز').deadline_days, null);
  await admin.useCompany(A);
  const ev = ok(await admin('GET', '/api/procedures/events'));
  assert.ok(ev.some((x) => x.event === 'checklist_changed') && ev.some((x) => x.event === 'checklist_added'));
});

test('dashboard, outstanding list, Excel export', async () => {
  const s = ok(await team('GET', '/api/procedures/summary'));
  assert.ok(s.open.onboarding >= 3);
  assert.ok(s.pending_steps > 0);
  assert.ok(s.average_progress.all >= 0 && s.average_progress.all <= 100);
  assert.ok(s.by_party.some((p) => p.label === 'بدون جهة محددة'));
  assert.ok(s.upcoming.some((c) => c.case_type === 'offboarding'), 'leaving within 14 days');
  assert.ok(s.unknown_nationality.length >= 1);
  const out = ok(await team('GET', '/api/procedures/outstanding?case_type=onboarding'));
  assert.ok(out.length > 0 && out.every((x) => x.case_type === 'onboarding'));
  const x = await team('GET', '/api/procedures/export.xlsx', undefined, { raw: true });
  assert.equal(x.status, 200);
  const z = readZip(x.body);
  assert.ok(z.get('xl/workbook.xml').toString('utf8').includes('الحالات'));
  assert.ok(z.get('xl/worksheets/sheet1.xml').toString('utf8').includes('اختبار سعودي'));
});

test('deleting a case: Admin only, reason required, kept in the log', async () => {
  const c = ok(await team('GET', '/api/procedures/cases?status=cancelled'))[0];
  assert.equal((await team('DELETE', `/api/procedures/cases/${c.id}`, { reason: 'x' })).status, 403);
  assert.equal((await admin('DELETE', `/api/procedures/cases/${c.id}`, {})).status, 400);
  ok(await admin('DELETE', `/api/procedures/cases/${c.id}`, { reason: 'حذف اختبار' }));
  assert.equal((await team('GET', `/api/procedures/cases/${c.id}`)).status, 404);
  const ev = ok(await admin('GET', '/api/procedures/events')).find((e) => e.event === 'case_deleted');
  assert.equal(JSON.parse(ev.changes_json).snapshot.case.case_no, c.case_no);
});

test('company separation: Company A and Company B never see or touch each other\'s cases', async () => {
  const aCase = ok(await team('GET', '/api/procedures/cases'))[0];
  const aStep = ok(await team('GET', `/api/procedures/cases/${aCase.id}`)).steps[0];
  const aParty = ok(await team('GET', '/api/procedures/lists')).party[0];
  const t2 = await login('hcteam', creds.team);
  await t2.useCompany(B);
  assert.equal(ok(await t2('GET', '/api/procedures/cases')).length, 0);
  assert.equal(ok(await t2('GET', '/api/procedures/outstanding')).length, 0);
  assert.equal(ok(await t2('GET', '/api/procedures/events')).length, 0);
  assert.equal((await t2('GET', `/api/procedures/cases/${aCase.id}`)).status, 404);
  assert.equal((await t2('PATCH', `/api/procedures/steps/${aStep.id}`, { status: 'done' })).status, 404);
  assert.equal((await t2('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: saudi.id })).status, 404, 'employee of the other company');
  const bEmp = await mkEmp(t2, { full_name_ar: 'اختبار ب', nationality_ar: 'سعودي', hire_date: today });
  assert.equal((await t2('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: bEmp.id, project_id: aParty.id })).status, 400, 'list item of the other company');
  const bc = ok(await t2('POST', '/api/procedures/cases', { case_type: 'onboarding', employee_id: bEmp.id }));
  assert.equal((await t2('PATCH', `/api/procedures/steps/${bc.steps[0].id}`, { party_id: aParty.id })).status, 400);
  assert.equal((await t2('GET', '/api/procedures/cases', undefined, { headers: { 'X-Company-Id': String(A) } })).status, 409, 'stale tab refused');
  assert.throws(() => db.prepare("INSERT INTO proc_cases (company_id, case_no, case_type, employee_id, employee_name, nationality_class, key_date) VALUES (?, 'X', 'onboarding', ?, 'x', 'saudi', ?)")
    .run(B, saudi.id, today), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE proc_cases SET company_id = ? WHERE id = ?').run(B, aCase.id), /immutable/);
});
