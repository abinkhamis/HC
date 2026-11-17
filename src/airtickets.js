// Air tickets for non-Saudi employees.
//
// Entitlements are never stored. They are calculated on every read from:
//   - the hire date in the employee directory,
//   - the company's versioned policy (one periodic entitlement every N months, 11 by default),
//   - the effective-dated number of family members covered with each entitlement,
//   - the disbursements actually recorded (historical or new).
// An entitlement only counts as used when a disbursement is recorded for it.
// The employee's periodic entitlement and the family tickets are counted
// separately, so a trip with the employee and three family members uses one
// entitlement and three family tickets, never four entitlements.
// A balance stays "provisional" until the Admin approves the opening balance
// after reviewing the historical records; the approval freezes everything up
// to its date until it is revoked.
import { HttpError } from './errors.js';
import { tx } from './db.js';
import { buildXlsx } from './xlsx.js';

export const DEFAULT_POLICY = { cycle_months: 11, due_soon_days: 60, tracking_start: null };
export const SOURCES = { historical: 'سجل تاريخي', current: 'صرف جديد' };
export const BALANCE_STATUS = {
  provisional: 'رصيد مبدئي — يحتاج مراجعة',
  approved: 'رصيد افتتاحي معتمد',
  not_required: 'نهائي — لا يحتاج رصيدًا افتتاحيًا',
  needs_review: 'تغيّرت البيانات بعد الاعتماد — يحتاج مراجعة',
};
export const ELIGIBILITY = {
  non_saudi: 'غير سعودي — مشمول',
  saudi: 'سعودي — غير مشمول',
  unknown: 'الجنسية غير محددة في دليل الموظفين',
  no_hire_date: 'لا يوجد تاريخ مباشرة في دليل الموظفين',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const round2 = (n) => Math.round(n * 100) / 100;
const str = (v, max = 2000) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, 'قيمة طويلة جدًا.');
  return s || null;
};
const date = (v, label, { required = false } = {}) => {
  const s = str(v, 10);
  if (!s) { if (required) throw new HttpError(400, `«${label}» مطلوب.`); return s ?? null; }
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `«${label}» تاريخ غير صالح.`);
  return s;
};
const money = (v, label) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `«${label}» يجب أن يكون مبلغًا صحيحًا.`);
  return round2(n);
};
const int = (v, label, min, max, def) => {
  if (v === undefined || v === null || v === '') { if (def !== undefined) return def; throw new HttpError(400, `«${label}» مطلوب.`); }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `«${label}» يجب أن يكون رقمًا صحيحًا من ${min} إلى ${max}.`);
  return n;
};

/** Adds whole months to an ISO date; the day is clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = m - 1 + months;
  const ty = y + Math.floor(t / 12);
  const tm = ((t % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(d, last))}`;
}

/** 'saudi' | 'non_saudi' | 'unknown', from the directory's nationality fields. */
export function nationalityClass(e) {
  const ar = String(e?.nationality_ar || '').trim();
  const en = String(e?.nationality_en || '').trim();
  if (!ar && !en) return 'unknown';
  if (/غير\s*سعود/.test(ar) || /non[-\s]?saudi/i.test(en)) return 'non_saudi';
  if (/سعود/.test(ar) || /\bsaudi\b|\bksa\b/i.test(en)) return 'saudi';
  return 'non_saudi';
}

const byDate = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : (a.version ?? a.id) - (b.version ?? b.id));

/**
 * Pure entitlement calculation (also used by the tests and, later, by Maha).
 * Entitlement n falls due when the cumulative cycle months since the hire date
 * are reached; the cycle length is the policy in force at the previous due date.
 * Entitlements end at the end-of-service date when there is one.
 */
export function computeEntitlements({ hireDate, endDate = null, asOf, policies, family = [], disbursements = [] }) {
  const pols = [...policies].sort(byDate('effective_from'));
  if (!pols.length) throw new Error('no policy');
  const policyAt = (d) => { let p = pols[0]; for (const x of pols) if (x.effective_from <= d) p = x; return p; };
  const fam = [...family].sort(byDate('effective_from'));
  const familyAt = (d) => { let n = 0; for (const f of fam) if (f.effective_from <= d) n = f.family_count; return n; };
  const limit = endDate && endDate < asOf ? endDate : asOf;
  const periods = [];
  let months = 0;
  let prev = hireDate;
  let nextDue = null;
  for (let i = 1; i <= 600; i++) {
    const cycle = policyAt(prev).cycle_months;
    months += cycle;
    const due = addMonths(hireDate, months);
    if (due > limit) { if (!endDate || due <= endDate) nextDue = due; break; }
    periods.push({ n: i, due_date: due, cycle_months: cycle, family_entitled: familyAt(due) });
    prev = due;
  }
  const counted = disbursements.filter((d) => d.disbursed_on <= asOf);
  const sum = (k) => counted.reduce((s, d) => s + (d[k] || 0), 0);
  const used = sum('entitlements_used');
  const familyUsed = sum('family_count');
  let left = used;
  for (const p of periods) { p.status = left > 0 ? 'used' : 'available'; if (left > 0) left--; }
  const accrued = periods.length;
  const familyAccrued = periods.reduce((s, p) => s + p.family_entitled, 0);
  return {
    as_of: asOf, accrued, used, remaining: accrued - used,
    family_accrued: familyAccrued, family_used: familyUsed, family_remaining: familyAccrued - familyUsed,
    next_due: nextDue, next_family_entitled: nextDue ? familyAt(nextDue) : null,
    current_cycle_months: policyAt(limit).cycle_months, periods,
    money: {
      ticket_amount: round2(sum('ticket_amount')), exit_reentry_fee: round2(sum('exit_reentry_fee')),
      total: round2(sum('ticket_amount') + sum('exit_reentry_fee')),
      beneficiaries: counted.reduce((s, d) => s + d.employee_included + d.family_count, 0),
      missing_amounts: counted.filter((d) => d.ticket_amount === null).length,
    },
  };
}

export function createAirTicketService(db) {
  const log = (companyId, { employeeId = null, disbursementId = null } = {}, ev, detail, changes, userId) =>
    db.prepare('INSERT INTO air_ticket_events (company_id, employee_id, disbursement_id, event, detail, changes_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, employeeId, disbursementId, ev, detail ?? null, changes ? JSON.stringify(changes) : null, userId ?? null);

  // ---------- policy ----------
  function currentPolicy(company, userId = null) {
    const q = () => db.prepare('SELECT * FROM air_ticket_policies WHERE company_id = ? ORDER BY version DESC LIMIT 1').get(company.id);
    let p = q();
    if (!p) {
      db.prepare(`INSERT INTO air_ticket_policies (company_id, version, cycle_months, due_soon_days, tracking_start, note, effective_from, created_by)
                  VALUES (?, 1, ?, ?, ?, ?, ?, ?)`).run(company.id, DEFAULT_POLICY.cycle_months, DEFAULT_POLICY.due_soon_days, DEFAULT_POLICY.tracking_start,
        'السياسة الأولية: استحقاق تذكرة كل 11 شهرًا من تاريخ المباشرة.', riyadhToday(), userId);
      p = q();
    }
    return p;
  }
  const allPolicies = (company) => { currentPolicy(company); return db.prepare('SELECT * FROM air_ticket_policies WHERE company_id = ? ORDER BY version').all(company.id); };

  function policyInfo(company) {
    const current = currentPolicy(company);
    const history = db.prepare(`SELECT p.*, u.display_name AS created_by_name FROM air_ticket_policies p LEFT JOIN users u ON u.id = p.created_by
                                WHERE p.company_id = ? ORDER BY p.version DESC`).all(company.id);
    return { current, history };
  }

  // A new version applies from its effective date onwards; it never changes past entitlements.
  function updatePolicy(company, input, userId) {
    input = input || {};
    const cur = currentPolicy(company, userId);
    const cycle = input.cycle_months === undefined ? cur.cycle_months : int(input.cycle_months, 'مدة دورة الاستحقاق', 1, 60);
    const soon = input.due_soon_days === undefined ? cur.due_soon_days : int(input.due_soon_days, 'مدة التنبيه المسبق', 1, 365);
    const tracking = input.tracking_start === undefined ? cur.tracking_start : date(input.tracking_start, 'تاريخ بدء التشغيل');
    const effective = date(input.effective_from, 'تاريخ السريان') || riyadhToday();
    if (effective < riyadhToday()) throw new HttpError(400, 'تاريخ السريان لا يمكن أن يكون في الماضي؛ السياسة الجديدة لا تغيّر الاستحقاقات السابقة.');
    const note = str(input.note, 1000) ?? null;
    return tx(db, () => {
      db.prepare(`INSERT INTO air_ticket_policies (company_id, version, cycle_months, due_soon_days, tracking_start, note, effective_from, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(company.id, cur.version + 1, cycle, soon, tracking, note, effective, userId);
      log(company.id, {}, 'policy_changed', `الإصدار ${cur.version + 1} — يسري من ${effective}${note ? ' — ' + note : ''}`, {
        cycle_months: [cur.cycle_months, cycle], due_soon_days: [cur.due_soon_days, soon], tracking_start: [cur.tracking_start, tracking],
      }, userId);
      return policyInfo(company);
    });
  }

  // ---------- data loading ----------
  const groupBy = (rows) => rows.reduce((m, r) => (m.get(r.employee_id)?.push(r) ?? m.set(r.employee_id, [r]), m), new Map());
  function load(company, employeeId = null) {
    const f = employeeId ? ' AND employee_id = ?' : '';
    const p = employeeId ? [company.id, employeeId] : [company.id];
    return {
      policies: allPolicies(company),
      family: groupBy(db.prepare(`SELECT * FROM air_ticket_family_entitlements WHERE company_id = ?${f} ORDER BY effective_from, id`).all(...p)),
      disb: groupBy(db.prepare(`SELECT * FROM air_ticket_disbursements WHERE company_id = ?${f} ORDER BY disbursed_on, id`).all(...p)),
      approvals: new Map(db.prepare(`SELECT a.*, u.display_name AS approved_by_name FROM air_ticket_balance_approvals a LEFT JOIN users u ON u.id = a.approved_by
                                     WHERE a.company_id = ? AND a.status = 'active'${f.replace('employee_id', 'a.employee_id')}`).all(...p).map((a) => [a.employee_id, a])),
      profiles: new Map(db.prepare(`SELECT * FROM air_ticket_profiles WHERE company_id = ?${f}`).all(...p).map((r) => [r.employee_id, r])),
    };
  }

  const employeeView = (e) => ({
    id: e.id, employee_no: e.employee_no, full_name_ar: e.full_name_ar, full_name_en: e.full_name_en, department: e.department,
    job_title: e.job_title, nationality_ar: e.nationality_ar, nationality_en: e.nationality_en, hire_date: e.hire_date,
    end_date: e.end_date, status: e.status,
  });

  function eligibilityOf(e) {
    const cls = nationalityClass(e);
    if (cls !== 'non_saudi') return cls;
    return e.hire_date ? 'non_saudi' : 'no_hire_date';
  }

  // Full balance of one employee as of today.
  function evaluate(company, e, data, { withPeriods = false } = {}) {
    const today = riyadhToday();
    const disb = data.disb.get(e.id) || [];
    const eligibility = eligibilityOf(e);
    const base = { employee: employeeView(e), eligibility, eligible: eligibility === 'non_saudi', profile: data.profiles.get(e.id) || null, records: disb.length };
    if (!base.eligible) return base;
    const input = { hireDate: e.hire_date, endDate: e.end_date || null, policies: data.policies, family: data.family.get(e.id) || [], disbursements: disb };
    const calc = computeEntitlements({ ...input, asOf: today });
    const policy = data.policies[data.policies.length - 1];
    const approval = data.approvals.get(e.id) || null;
    let status;
    let changed = null;
    if (approval) {
      const at = computeEntitlements({ ...input, asOf: approval.as_of });
      const diff = ['accrued', 'used', 'family_accrued', 'family_used'].filter((k) => at[k] !== approval[k]);
      if (approval.hire_date !== e.hire_date) diff.unshift('hire_date');
      status = diff.length ? 'needs_review' : 'approved';
      if (diff.length) changed = diff;
    } else if (policy.tracking_start && e.hire_date >= policy.tracking_start) status = 'not_required';
    else status = 'provisional';

    const historical = disb.filter((d) => d.source === 'historical').length;
    const warnings = [];
    if (status === 'provisional') {
      warnings.push('الرصيد مبدئي وليس نهائيًا: لم يعتمد المسؤول الرصيد الافتتاحي بعد مراجعة سجلات الصرف التاريخية.');
      if (!historical && calc.accrued > 0) warnings.push(`لا توجد سجلات صرف تاريخية؛ ${calc.accrued} استحقاق منذ المباشرة تُحتسب متبقية ولا تُعتبر مستخدمة حتى تُسجَّل.`);
      else if (calc.remaining > 0) warnings.push(`${calc.remaining} استحقاق بلا سجل صرف — تُحتسب متبقية ولا تُعتبر مستخدمة.`);
    }
    if (status === 'needs_review') {
      warnings.push(`تغيّرت بيانات تؤثر على الرصيد حتى تاريخ الاعتماد (${approval.as_of}) بعد اعتماده${changed.includes('hire_date') ? ' — تاريخ المباشرة في دليل الموظفين' : ''}؛ يحتاج مراجعة وإعادة اعتماد.`);
    }
    if (calc.money.missing_amounts) warnings.push(`${calc.money.missing_amounts} سجل صرف بدون مبلغ التذاكر — إجماليات المبالغ غير مكتملة.`);
    if (calc.remaining < 0) warnings.push(`الاستحقاقات المسجلة كمستخدمة (${calc.used}) تتجاوز المستحق (${calc.accrued}).`);
    if (calc.family_remaining < 0) warnings.push(`تذاكر الأسرة المصروفة (${calc.family_used}) تتجاوز المستحق (${calc.family_accrued}).`);
    if (disb.some((d) => d.disbursed_on < e.hire_date)) warnings.push('يوجد سجل صرف بتاريخ يسبق تاريخ المباشرة الحالي في دليل الموظفين.');
    if (e.status === 'inactive' && !e.end_date) warnings.push('الموظف منتهية خدماته في الدليل دون تاريخ انتهاء خدمة؛ الاستحقاق محسوب حتى اليوم.');
    const last = disb.length ? disb[disb.length - 1] : null;
    const out = {
      ...base, balance_status: status, final: status === 'approved' || status === 'not_required', approval, warnings, historical_records: historical,
      accrued: calc.accrued, used: calc.used, remaining: calc.remaining,
      family_accrued: calc.family_accrued, family_used: calc.family_used, family_remaining: calc.family_remaining,
      next_due: calc.next_due, cycle_months: calc.current_cycle_months, money: calc.money, last_disbursed_on: last?.disbursed_on ?? null,
    };
    // family members covered by the next entitlement (or the latest one already in force)
    out.family_per_entitlement = calc.next_family_entitled ?? (input.family.filter((f) => f.effective_from <= today).at(-1)?.family_count ?? 0);
    if (withPeriods) out.periods = calc.periods;
    return out;
  }

  const employeesOf = (company) => db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY full_name_ar').all(company.id);

  function eligibleEmployee(company, tenant, employeeId) {
    if (!employeeId) throw new HttpError(400, 'اختر الموظف.');
    const e = tenant.get('employees', employeeId); // 404 for an employee of another company
    const el = eligibilityOf(e);
    if (el === 'saudi') throw new HttpError(400, `أداة تذاكر الطيران للموظفين غير السعوديين فقط؛ ${e.full_name_ar} مسجل في دليل الموظفين بجنسية سعودية.`, 'not_eligible');
    if (el === 'unknown') throw new HttpError(400, `حدد جنسية ${e.full_name_ar} في دليل الموظفين أولًا.`, 'nationality_missing');
    if (el === 'no_hire_date') throw new HttpError(400, `أضف تاريخ مباشرة ${e.full_name_ar} في دليل الموظفين أولًا لاحتساب الاستحقاق.`, 'hire_date_missing');
    return e;
  }

  // ---------- reads ----------
  function balances(company, f = {}) {
    const data = load(company);
    let rows = employeesOf(company).map((e) => evaluate(company, e, data));
    const which = f.eligibility || 'eligible';
    if (which === 'eligible') rows = rows.filter((r) => r.eligible);
    else if (which === 'excluded') rows = rows.filter((r) => !r.eligible);
    if (f.balance_status && BALANCE_STATUS[f.balance_status]) rows = rows.filter((r) => r.balance_status === f.balance_status);
    if (f.employee_status === 'active' || f.employee_status === 'inactive') rows = rows.filter((r) => r.employee.status === f.employee_status);
    if (f.q) {
      const q = String(f.q).trim();
      rows = rows.filter((r) => [r.employee.full_name_ar, r.employee.full_name_en, r.employee.employee_no, r.employee.department].some((v) => v && String(v).includes(q)));
    }
    return rows;
  }

  function employee(company, tenant, employeeId) {
    const e = tenant.get('employees', employeeId);
    const data = load(company, e.id);
    const out = evaluate(company, e, data, { withPeriods: true });
    out.family_history = data.family.get(e.id) || [];
    out.disbursements = listDisbursements(company, { employee_id: e.id });
    out.approvals = db.prepare(`SELECT a.*, u.display_name AS approved_by_name, r.display_name AS revoked_by_name FROM air_ticket_balance_approvals a
                                LEFT JOIN users u ON u.id = a.approved_by LEFT JOIN users r ON r.id = a.revoked_by
                                WHERE a.company_id = ? AND a.employee_id = ? ORDER BY a.id DESC`).all(company.id, e.id);
    out.events = events(company, { employee_id: e.id });
    out.policy = data.policies[data.policies.length - 1];
    return out;
  }

  function listDisbursements(company, f = {}) {
    const where = ['d.company_id = ?'];
    const p = [company.id];
    const add = (sql, v) => { where.push(sql); p.push(v); };
    if (f.employee_id) add('d.employee_id = ?', Number(f.employee_id));
    if (f.source && SOURCES[f.source]) add('d.source = ?', f.source);
    if (f.from && DATE_RE.test(f.from)) add('d.disbursed_on >= ?', f.from);
    if (f.to && DATE_RE.test(f.to)) add('d.disbursed_on <= ?', f.to);
    if (f.q) { where.push('(e.full_name_ar LIKE ? OR e.employee_no LIKE ? OR d.reference LIKE ?)'); p.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    return db.prepare(`SELECT d.*, e.full_name_ar AS employee_name, e.employee_no, e.department,
                         d.employee_included + d.family_count AS beneficiaries,
                         CASE WHEN d.ticket_amount IS NULL AND d.exit_reentry_fee IS NULL THEN NULL ELSE COALESCE(d.ticket_amount, 0) + COALESCE(d.exit_reentry_fee, 0) END AS total_amount,
                         u.display_name AS created_by_name
                       FROM air_ticket_disbursements d JOIN employees e ON e.company_id = d.company_id AND e.id = d.employee_id
                       LEFT JOIN users u ON u.id = d.created_by
                       WHERE ${where.join(' AND ')} ORDER BY d.disbursed_on DESC, d.id DESC LIMIT 5000`).all(...p);
  }

  function events(company, { employee_id = null, limit = 300 } = {}) {
    const f = employee_id ? ' AND ev.employee_id = ?' : '';
    const p = employee_id ? [company.id, Number(employee_id)] : [company.id];
    return db.prepare(`SELECT ev.*, u.display_name AS user_name, e.full_name_ar AS employee_name FROM air_ticket_events ev
                       LEFT JOIN users u ON u.id = ev.user_id LEFT JOIN employees e ON e.company_id = ev.company_id AND e.id = ev.employee_id
                       WHERE ev.company_id = ?${f} ORDER BY ev.id DESC LIMIT ?`).all(...p, Math.min(Number(limit) || 300, 2000));
  }

  // ---------- opening-balance lock ----------
  const activeApproval = (companyId, employeeId) =>
    db.prepare("SELECT * FROM air_ticket_balance_approvals WHERE company_id = ? AND employee_id = ? AND status = 'active'").get(companyId, employeeId);
  function assertUnlocked(companyId, employeeId, ...dates) {
    const a = activeApproval(companyId, employeeId);
    if (a && dates.some((d) => d && d <= a.as_of)) {
      throw new HttpError(409, `هذا التعديل يقع ضمن الرصيد الافتتاحي المعتمد حتى ${a.as_of}؛ يلزم أن يلغي المسؤول الاعتماد أولًا ثم يعيد الاعتماد بعد المراجعة.`, 'opening_locked');
    }
  }

  // ---------- profile & family ----------
  function updateProfile(company, tenant, employeeId, input, userId) {
    input = input || {};
    const e = eligibleEmployee(company, tenant, employeeId);
    const set = { destination: str(input.destination, 200), travel_class: str(input.travel_class, 100), notes: str(input.notes, 2000) };
    for (const k of Object.keys(set)) if (set[k] === undefined) delete set[k];
    return tx(db, () => {
      const old = db.prepare('SELECT * FROM air_ticket_profiles WHERE company_id = ? AND employee_id = ?').get(company.id, e.id);
      const changes = {};
      for (const [k, v] of Object.entries(set)) if ((old?.[k] ?? null) !== (v ?? null)) changes[k] = [old?.[k] ?? null, v ?? null];
      if (!Object.keys(changes).length) return employee(company, tenant, e.id);
      if (old) {
        const keys = Object.keys(set);
        db.prepare(`UPDATE air_ticket_profiles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
          .run(...keys.map((k) => set[k] ?? null), company.id, old.id);
      } else {
        db.prepare('INSERT INTO air_ticket_profiles (company_id, employee_id, destination, travel_class, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(company.id, e.id, set.destination ?? null, set.travel_class ?? null, set.notes ?? null, userId ?? null);
      }
      log(company.id, { employeeId: e.id }, 'profile_updated', null, changes, userId);
      return employee(company, tenant, e.id);
    });
  }

  function addFamily(company, tenant, employeeId, input, userId) {
    input = input || {};
    const e = eligibleEmployee(company, tenant, employeeId);
    const count = int(input.family_count, 'عدد المستفيدين من الأسرة', 0, 20);
    const from = date(input.effective_from, 'يسري من', { required: true });
    if (from < e.hire_date) throw new HttpError(400, 'تاريخ السريان يسبق تاريخ مباشرة الموظف.');
    return tx(db, () => {
      assertUnlocked(company.id, e.id, from);
      if (db.prepare('SELECT 1 FROM air_ticket_family_entitlements WHERE company_id = ? AND employee_id = ? AND effective_from = ?').get(company.id, e.id, from)) {
        throw new HttpError(409, 'يوجد استحقاق أسرة بنفس تاريخ السريان؛ احذفه أولًا أو اختر تاريخًا آخر.');
      }
      db.prepare('INSERT INTO air_ticket_family_entitlements (company_id, employee_id, family_count, effective_from, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(company.id, e.id, count, from, str(input.note, 500) ?? null, userId ?? null);
      log(company.id, { employeeId: e.id }, 'family_set', `${count} من أفراد الأسرة مع كل استحقاق — يسري من ${from}`, null, userId);
      return employee(company, tenant, e.id);
    });
  }

  function deleteFamily(company, tenant, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الحذف مطلوب.');
    return tx(db, () => {
      const r = db.prepare('SELECT * FROM air_ticket_family_entitlements WHERE company_id = ? AND id = ?').get(company.id, Number(id));
      if (!r) throw new HttpError(404, 'السجل غير موجود في الشركة الحالية.');
      assertUnlocked(company.id, r.employee_id, r.effective_from);
      db.prepare('DELETE FROM air_ticket_family_entitlements WHERE company_id = ? AND id = ?').run(company.id, r.id);
      log(company.id, { employeeId: r.employee_id }, 'family_deleted', `${r.family_count} من أفراد الأسرة — كان يسري من ${r.effective_from} — ${reason}`, null, userId);
      return employee(company, tenant, r.employee_id);
    });
  }

  // ---------- disbursements ----------
  const loadDisb = (companyId, id) => {
    const r = db.prepare('SELECT * FROM air_ticket_disbursements WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!r) throw new HttpError(404, 'سجل الصرف غير موجود في الشركة الحالية.');
    return r;
  };

  function cleanDisbursement(input, old, e) {
    const merged = { ...(old || {}), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
    const source = old ? old.source : (merged.source === 'historical' ? 'historical' : 'current');
    const out = {
      source,
      disbursed_on: date(merged.disbursed_on, 'تاريخ الصرف', { required: true }),
      entitlements_used: int(merged.entitlements_used, 'عدد الاستحقاقات الدورية المستخدمة', 0, 10, 1),
      employee_included: merged.employee_included === true || merged.employee_included === 1 || merged.employee_included === '1' || merged.employee_included === 'true' ? 1 : 0,
      family_count: int(merged.family_count, 'عدد المستفيدين من الأسرة', 0, 20, 0),
      ticket_amount: money(merged.ticket_amount, 'مبلغ التذاكر'),
      exit_reentry_fee: money(merged.exit_reentry_fee, 'رسوم الخروج والعودة'),
      reference: str(merged.reference, 200) ?? null,
      notes: str(merged.notes, 2000) ?? null,
    };
    if (out.disbursed_on > riyadhToday()) throw new HttpError(400, 'تاريخ الصرف لا يمكن أن يكون في المستقبل.');
    if (out.disbursed_on < e.hire_date) throw new HttpError(400, 'تاريخ الصرف يسبق تاريخ مباشرة الموظف.');
    if (out.entitlements_used === 0 && out.employee_included) throw new HttpError(400, 'تذكرة الموظف نفسه تُخصم من استحقاقه الدوري؛ حدد استحقاقًا واحدًا على الأقل أو ألغِ إدراج الموظف ضمن المستفيدين.');
    if (out.entitlements_used + out.family_count === 0) throw new HttpError(400, 'سجل الصرف يجب أن يتضمن استحقاقًا دوريًا للموظف أو تذاكر لأفراد الأسرة.');
    if (source === 'current') {
      if (out.ticket_amount === null) throw new HttpError(400, 'مبلغ التذاكر مطلوب.');
      if (out.exit_reentry_fee === null) out.exit_reentry_fee = 0;
    }
    return out;
  }

  // Fails (and rolls back) when the change pushes the balance below zero without explicit confirmation.
  function checkBalance(company, e, before, confirmExceed) {
    const after = evaluate(company, e, load(company, e.id));
    const worse = (k) => after[k] < 0 && after[k] < before[k];
    if (!confirmExceed && (worse('remaining') || worse('family_remaining'))) {
      const parts = [];
      if (worse('remaining')) parts.push(`الاستحقاقات الدورية: المستحق ${after.accrued} والمسجل كمستخدم سيصبح ${after.used}`);
      if (worse('family_remaining')) parts.push(`تذاكر الأسرة: المستحق ${after.family_accrued} والمصروف سيصبح ${after.family_used}`);
      throw new HttpError(409, `هذا الصرف يتجاوز الرصيد المستحق (${parts.join('؛ ')}). أكّد إن كان صحيحًا.`, 'exceeds_balance');
    }
    return after;
  }

  const describe = (d) => `${d.disbursed_on} — ${d.entitlements_used} استحقاق دوري${d.employee_included ? ' (الموظف مسافر)' : ''}، ${d.family_count} من الأسرة${d.ticket_amount !== null ? ` — ${d.ticket_amount} ريال` : ''}${d.exit_reentry_fee ? ` + رسوم خروج وعودة ${d.exit_reentry_fee}` : ''}`;

  function createDisbursement(company, tenant, input, userId) {
    input = input || {};
    const e = eligibleEmployee(company, tenant, input.employee_id);
    const row = cleanDisbursement(input, null, e);
    return tx(db, () => {
      assertUnlocked(company.id, e.id, row.disbursed_on);
      const before = evaluate(company, e, load(company, e.id));
      const keys = Object.keys(row);
      const r = db.prepare(`INSERT INTO air_ticket_disbursements (company_id, employee_id, created_by, updated_by, ${keys.join(', ')}) VALUES (?, ?, ?, ?, ${keys.map(() => '?').join(', ')})`)
        .run(company.id, e.id, userId ?? null, userId ?? null, ...keys.map((k) => row[k]));
      const id = Number(r.lastInsertRowid);
      checkBalance(company, e, before, input.confirm_exceed === true);
      log(company.id, { employeeId: e.id, disbursementId: id }, row.source === 'historical' ? 'historical_added' : 'disbursement_added', describe(row), null, userId);
      return { disbursement: loadDisb(company.id, id), balance: evaluate(company, e, load(company, e.id)) };
    });
  }

  function updateDisbursement(company, tenant, id, input, userId) {
    input = input || {};
    return tx(db, () => {
      const old = loadDisb(company.id, id);
      if (input.employee_id !== undefined && Number(input.employee_id) !== old.employee_id) throw new HttpError(400, 'لا يمكن نقل سجل الصرف إلى موظف آخر؛ احذفه وأنشئ سجلًا جديدًا.');
      const e = eligibleEmployee(company, tenant, old.employee_id);
      const next = cleanDisbursement(input, old, e);
      const changes = {};
      for (const [k, v] of Object.entries(next)) if ((old[k] ?? null) !== (v ?? null)) changes[k] = [old[k] ?? null, v ?? null];
      if (!Object.keys(changes).length) return { disbursement: old, balance: evaluate(company, e, load(company, e.id)) };
      assertUnlocked(company.id, e.id, old.disbursed_on, next.disbursed_on);
      const before = evaluate(company, e, load(company, e.id));
      const keys = Object.keys(next);
      db.prepare(`UPDATE air_ticket_disbursements SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(...keys.map((k) => next[k]), userId ?? null, company.id, old.id);
      checkBalance(company, e, before, input.confirm_exceed === true);
      log(company.id, { employeeId: e.id, disbursementId: old.id }, 'disbursement_updated', null, changes, userId);
      return { disbursement: loadDisb(company.id, old.id), balance: evaluate(company, e, load(company, e.id)) };
    });
  }

  // Admin only (checked by the route). The deleted row is kept in the change log.
  function deleteDisbursement(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الحذف مطلوب.');
    return tx(db, () => {
      const r = loadDisb(company.id, id);
      assertUnlocked(company.id, r.employee_id, r.disbursed_on);
      log(company.id, { employeeId: r.employee_id, disbursementId: r.id }, 'disbursement_deleted', `${describe(r)} — ${reason}`, { snapshot: r }, userId);
      db.prepare('DELETE FROM air_ticket_disbursements WHERE company_id = ? AND id = ?').run(company.id, r.id);
      return { ok: true };
    });
  }

  // ---------- opening balance approval (Admin only, checked by the route) ----------
  function approveOpening(company, tenant, employeeId, input, userId) {
    input = input || {};
    if (input.reviewed !== true) throw new HttpError(400, 'يجب تأكيد مراجعة سجلات الصرف التاريخية قبل اعتماد الرصيد الافتتاحي.', 'review_required');
    const e = eligibleEmployee(company, tenant, employeeId);
    const asOf = date(input.as_of, 'تاريخ الاعتماد') || riyadhToday();
    if (asOf > riyadhToday()) throw new HttpError(400, 'تاريخ الاعتماد لا يمكن أن يكون في المستقبل.');
    if (asOf < e.hire_date) throw new HttpError(400, 'تاريخ الاعتماد يسبق تاريخ المباشرة.');
    return tx(db, () => {
      if (activeApproval(company.id, e.id)) throw new HttpError(409, 'الرصيد الافتتاحي معتمد بالفعل؛ ألغِ الاعتماد الحالي أولًا لإعادة الاعتماد.');
      const data = load(company, e.id);
      const c = computeEntitlements({ hireDate: e.hire_date, endDate: e.end_date || null, asOf, policies: data.policies, family: data.family.get(e.id) || [], disbursements: data.disb.get(e.id) || [] });
      db.prepare(`INSERT INTO air_ticket_balance_approvals (company_id, employee_id, as_of, accrued, used, remaining, family_accrued, family_used, family_remaining, hire_date, note, approved_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(company.id, e.id, asOf, c.accrued, c.used, c.remaining, c.family_accrued, c.family_used, c.family_remaining, e.hire_date, str(input.note, 1000) ?? null, userId ?? null);
      log(company.id, { employeeId: e.id }, 'opening_approved',
        `حتى ${asOf}: المستحق ${c.accrued}، المستخدم ${c.used}، المتبقي ${c.remaining} — الأسرة: المستحق ${c.family_accrued}، المصروف ${c.family_used}، المتبقي ${c.family_remaining}${input.note ? ' — ' + str(input.note, 1000) : ''}`, null, userId);
      return employee(company, tenant, e.id);
    });
  }

  function revokeOpening(company, tenant, employeeId, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب إلغاء الاعتماد مطلوب.');
    const e = tenant.get('employees', employeeId);
    return tx(db, () => {
      const a = activeApproval(company.id, e.id);
      if (!a) throw new HttpError(409, 'لا يوجد رصيد افتتاحي معتمد لإلغائه.');
      db.prepare(`UPDATE air_ticket_balance_approvals SET status = 'revoked', revoked_by = ?, revoked_at = datetime('now'), revoke_reason = ? WHERE company_id = ? AND id = ?`)
        .run(userId ?? null, reason, company.id, a.id);
      log(company.id, { employeeId: e.id }, 'opening_revoked', `اعتماد ${a.as_of} — ${reason}`, null, userId);
      return employee(company, tenant, e.id);
    });
  }

  // ---------- dashboard & reports ----------
  function summary(company, { from, to } = {}) {
    const today = riyadhToday();
    from = DATE_RE.test(from || '') ? from : `${today.slice(0, 4)}-01-01`;
    to = DATE_RE.test(to || '') ? to : today;
    const policy = currentPolicy(company);
    const all = balances(company, { eligibility: 'all' });
    const eligible = all.filter((r) => r.eligible);
    const soonLimit = addDays(today, policy.due_soon_days);
    const light = (r) => ({
      employee: r.employee, balance_status: r.balance_status, final: r.final, accrued: r.accrued, used: r.used, remaining: r.remaining,
      family_accrued: r.family_accrued, family_used: r.family_used, family_remaining: r.family_remaining, family_per_entitlement: r.family_per_entitlement,
      next_due: r.next_due, last_disbursed_on: r.last_disbursed_on,
    });
    const disb = listDisbursements(company, { from, to });
    const s = (k) => round2(disb.reduce((x, d) => x + (d[k] || 0), 0));
    const byMonth = Object.values(disb.reduce((m, d) => {
      const k = d.disbursed_on.slice(0, 7);
      m[k] ||= { month: k, count: 0, entitlements: 0, beneficiaries: 0, total: 0 };
      m[k].count++; m[k].entitlements += d.entitlements_used; m[k].beneficiaries += d.beneficiaries; m[k].total = round2(m[k].total + (d.total_amount || 0));
      return m;
    }, {})).sort((a, b) => (a.month < b.month ? -1 : 1));
    const sumE = (k) => eligible.reduce((x, r) => x + r[k], 0);
    return {
      today, from, to,
      policy: { version: policy.version, cycle_months: policy.cycle_months, due_soon_days: policy.due_soon_days, tracking_start: policy.tracking_start },
      employees: {
        eligible: eligible.length, active_eligible: eligible.filter((r) => r.employee.status !== 'inactive').length,
        saudi: all.filter((r) => r.eligibility === 'saudi').length,
        unknown_nationality: all.filter((r) => r.eligibility === 'unknown').length,
        no_hire_date: all.filter((r) => r.eligibility === 'no_hire_date').length,
      },
      totals: {
        accrued: sumE('accrued'), used: sumE('used'), remaining: sumE('remaining'),
        family_accrued: sumE('family_accrued'), family_used: sumE('family_used'), family_remaining: sumE('family_remaining'),
        provisional: eligible.filter((r) => !r.final).length,
      },
      disbursed: {
        count: disb.length, entitlements: disb.reduce((x, d) => x + d.entitlements_used, 0),
        family_tickets: disb.reduce((x, d) => x + d.family_count, 0), beneficiaries: disb.reduce((x, d) => x + d.beneficiaries, 0),
        ticket_amount: s('ticket_amount'), exit_reentry_fee: s('exit_reentry_fee'), total: round2(s('ticket_amount') + s('exit_reentry_fee')),
        missing_amounts: disb.filter((d) => d.ticket_amount === null).length, by_month: byMonth,
        by_source: Object.fromEntries(Object.keys(SOURCES).map((k) => [k, disb.filter((d) => d.source === k).length])),
      },
      due_soon: eligible.filter((r) => r.next_due && r.next_due <= soonLimit && r.employee.status !== 'inactive').sort((a, b) => (a.next_due < b.next_due ? -1 : 1)).map(light),
      accumulated: eligible.filter((r) => r.remaining >= 1).sort((a, b) => b.remaining - a.remaining).map(light),
      alerts: {
        provisional: eligible.filter((r) => r.balance_status === 'provisional').map(light),
        needs_review: eligible.filter((r) => r.balance_status === 'needs_review').map(light),
        over_used: eligible.filter((r) => r.remaining < 0 || r.family_remaining < 0).map(light),
        missing_nationality: all.filter((r) => r.eligibility === 'unknown').map((r) => r.employee),
        missing_hire_date: all.filter((r) => r.eligibility === 'no_hire_date').map((r) => r.employee),
        excluded_with_records: all.filter((r) => !r.eligible && r.records > 0).map((r) => ({ ...r.employee, records: r.records, eligibility: r.eligibility })),
      },
    };
  }

  function exportXlsx(company, { from, to } = {}) {
    const s = summary(company, { from, to });
    const rows = balances(company, { eligibility: 'eligible' });
    const disb = listDisbursements(company, { from: s.from, to: s.to });
    const yesNo = (v) => (v ? 'نعم' : 'لا');
    const empStatus = (e) => (e.status === 'inactive' ? 'منتهية خدماته' : 'على رأس العمل');
    const balanceSheet = {
      name: 'الأرصدة', title: `أرصدة تذاكر الطيران — ${company.name_ar} — حتى ${s.today}`,
      columns: [
        { header: 'الرقم الوظيفي', width: 14 }, { header: 'الموظف', width: 30 }, { header: 'الإدارة', width: 20 }, { header: 'الجنسية', width: 14 },
        { header: 'تاريخ المباشرة', width: 14 }, { header: 'حالة الموظف', width: 14 }, { header: 'دورة الاستحقاق (شهر)', type: 'int', width: 12 },
        { header: 'الاستحقاقات المستحقة', type: 'int', width: 12 }, { header: 'المستخدم', type: 'int', width: 10 }, { header: 'المتبقي', type: 'int', width: 10 },
        { header: 'أفراد الأسرة مع كل استحقاق', type: 'int', width: 14 }, { header: 'تذاكر الأسرة المستحقة', type: 'int', width: 12 },
        { header: 'تذاكر الأسرة المصروفة', type: 'int', width: 12 }, { header: 'تذاكر الأسرة المتبقية', type: 'int', width: 12 },
        { header: 'الاستحقاق القادم', width: 14 }, { header: 'آخر صرف', width: 14 }, { header: 'إجمالي المصروف (ر.س)', type: 'money', width: 16 },
        { header: 'حالة الرصيد', width: 30 }, { header: 'تنبيهات', width: 60 },
      ],
      rows: rows.map((r) => [r.employee.employee_no, r.employee.full_name_ar, r.employee.department, r.employee.nationality_ar || r.employee.nationality_en,
        r.employee.hire_date, empStatus(r.employee), r.cycle_months, r.accrued, r.used, r.remaining, r.family_per_entitlement, r.family_accrued, r.family_used,
        r.family_remaining, r.next_due, r.last_disbursed_on, r.money.total, BALANCE_STATUS[r.balance_status], r.warnings.join(' | ')]),
    };
    const disbSheet = {
      name: 'سجل الصرف', title: `سجل صرف تذاكر الطيران — ${company.name_ar} — من ${s.from} إلى ${s.to}`,
      columns: [
        { header: 'الرقم الوظيفي', width: 14 }, { header: 'الموظف', width: 30 }, { header: 'الإدارة', width: 20 }, { header: 'تاريخ الصرف', width: 14 },
        { header: 'نوع السجل', width: 12 }, { header: 'استحقاقات دورية مستخدمة', type: 'int', width: 12 }, { header: 'الموظف ضمن المستفيدين', width: 12 },
        { header: 'مستفيدون من الأسرة', type: 'int', width: 12 }, { header: 'إجمالي المستفيدين', type: 'int', width: 12 },
        { header: 'مبلغ التذاكر (ر.س)', type: 'money', width: 14 }, { header: 'رسوم الخروج والعودة (ر.س)', type: 'money', width: 14 },
        { header: 'الإجمالي (ر.س)', type: 'money', width: 14 }, { header: 'المرجع', width: 16 }, { header: 'ملاحظات', width: 40 },
      ],
      rows: disb.map((d) => [d.employee_no, d.employee_name, d.department, d.disbursed_on, SOURCES[d.source], d.entitlements_used, yesNo(d.employee_included),
        d.family_count, d.beneficiaries, d.ticket_amount, d.exit_reentry_fee, d.total_amount, d.reference, d.notes]),
    };
    const upcomingSheet = {
      name: 'القادمة والمتراكمة', title: `الاستحقاقات القادمة خلال ${s.policy.due_soon_days} يومًا والأرصدة المتراكمة — ${company.name_ar}`,
      columns: [
        { header: 'التصنيف', width: 16 }, { header: 'الرقم الوظيفي', width: 14 }, { header: 'الموظف', width: 30 }, { header: 'الإدارة', width: 20 },
        { header: 'الاستحقاق القادم', width: 14 }, { header: 'المتبقي', type: 'int', width: 10 }, { header: 'تذاكر الأسرة المتبقية', type: 'int', width: 12 },
        { header: 'حالة الرصيد', width: 30 },
      ],
      rows: [
        ...s.due_soon.map((r) => ['يستحق قريبًا', r.employee.employee_no, r.employee.full_name_ar, r.employee.department, r.next_due, r.remaining, r.family_remaining, BALANCE_STATUS[r.balance_status]]),
        ...s.accumulated.map((r) => ['رصيد متراكم', r.employee.employee_no, r.employee.full_name_ar, r.employee.department, r.next_due, r.remaining, r.family_remaining, BALANCE_STATUS[r.balance_status]]),
      ],
    };
    const t = s.totals;
    const summarySheet = {
      name: 'ملخص', title: `ملخص تذاكر الطيران — ${company.name_ar} (${company.name_en})`,
      columns: [{ header: 'البند', width: 44 }, { header: 'القيمة', width: 22 }],
      rows: [
        ['تاريخ التقرير', s.today], ['فترة سجل الصرف', `${s.from} — ${s.to}`],
        ['السياسة', `الإصدار ${s.policy.version}: استحقاق كل ${s.policy.cycle_months} شهرًا من تاريخ المباشرة`],
        ['الموظفون غير السعوديين المشمولون', s.employees.eligible], ['موظفون بلا جنسية محددة (غير مشمولين حتى تحديدها)', s.employees.unknown_nationality],
        ['إجمالي الاستحقاقات المستحقة', t.accrued], ['المستخدم', t.used], ['المتبقي', t.remaining],
        ['تذاكر الأسرة المستحقة', t.family_accrued], ['تذاكر الأسرة المصروفة', t.family_used], ['تذاكر الأسرة المتبقية', t.family_remaining],
        ['أرصدة غير نهائية (مبدئية أو تحتاج مراجعة)', t.provisional],
        ['عدد سجلات الصرف في الفترة', s.disbursed.count], ['مبلغ التذاكر في الفترة (ر.س)', s.disbursed.ticket_amount],
        ['رسوم الخروج والعودة في الفترة (ر.س)', s.disbursed.exit_reentry_fee], ['الإجمالي في الفترة (ر.س)', s.disbursed.total],
        ['تنبيه', t.provisional ? 'الأرصدة المبدئية ليست نهائية ولا معتمدة؛ تُعتمد من المسؤول بعد مراجعة السجلات التاريخية.' : 'جميع الأرصدة نهائية أو معتمدة.'],
      ],
    };
    summarySheet.columns[1].type = 'auto';
    return buildXlsx([summarySheet, balanceSheet, disbSheet, upcomingSheet]);
  }

  return {
    currentPolicy, policyInfo, updatePolicy, balances, employee, listDisbursements, events,
    updateProfile, addFamily, deleteFamily, createDisbursement, updateDisbursement, deleteDisbursement,
    approveOpening, revokeOpening, summary, exportXlsx,
    meta: () => ({ sources: SOURCES, balance_status: BALANCE_STATUS, eligibility: ELIGIBILITY }),
  };
}
