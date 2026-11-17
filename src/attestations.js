// Chamber of Commerce attestations.
// Rule (configurable per company by the Admin): within each contract year of the
// employee, the first N non-cancelled requests are charged to the company and the
// rest to the employee. An employee charge is only *recorded* as a salary
// deduction after the team explicitly confirms it — nothing is deducted here.
// Confirmed or waived deductions are never changed automatically; if later edits
// would change them they are flagged for review instead.
import { HttpError } from './errors.js';
import { tx } from './db.js';

export const STATUS = { requested: 'مطلوب', in_progress: 'قيد التصديق', attested: 'تم التصديق', delivered: 'تم التسليم', cancelled: 'ملغي' };
export const DEDUCTION = { not_applicable: 'لا يوجد خصم', pending: 'بانتظار تأكيد الفريق', confirmed: 'تم تأكيد الخصم', waived: 'معفى' };
export const DOCUMENT_TYPES = ['تعريف بالراتب', 'تعريف بدون راتب', 'شهادة خبرة', 'عقد عمل', 'خطاب لجهة حكومية', 'أخرى'];
export const DEFAULT_POLICY = { free_per_year: 2, year_basis: 'hire_anniversary', default_fee: null, overdue_days: 7 };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, '0');
const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
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
  return Math.round(n * 100) / 100;
};

/** Contract year containing `day` for an employee hired on `hire` (both YYYY-MM-DD). */
export function contractYear(hire, day, basis = 'hire_anniversary') {
  if (basis === 'calendar') { const y = day.slice(0, 4); return { start: `${y}-01-01`, end: `${y}-12-31` }; }
  if (day < hire) throw new HttpError(400, 'تاريخ الطلب يسبق تاريخ مباشرة الموظف.');
  const [, hm, hd] = hire.split('-').map(Number);
  const anniversary = (y) => {
    const last = new Date(Date.UTC(y, hm, 0)).getUTCDate(); // 29 Feb → 28 Feb in non-leap years
    return `${y}-${pad(hm)}-${pad(Math.min(hd, last))}`;
  };
  let y = Number(day.slice(0, 4));
  let start = anniversary(y);
  if (start > day) start = anniversary(--y);
  return { start, end: addDays(anniversary(y + 1), -1) };
}

export function createAttestationService(db) {
  const log = (companyId, row, ev, detail, changes, userId) =>
    db.prepare('INSERT INTO attestation_events (company_id, attestation_id, request_no, event, detail, changes_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, row?.id ?? null, row?.request_no ?? null, ev, detail ?? null, changes ? JSON.stringify(changes) : null, userId ?? null);

  // ---------- policy ----------
  function currentPolicy(company, userId = null) {
    let p = db.prepare('SELECT * FROM attestation_policies WHERE company_id = ? ORDER BY version DESC LIMIT 1').get(company.id);
    if (!p) {
      db.prepare(`INSERT INTO attestation_policies (company_id, version, free_per_year, year_basis, default_fee, overdue_days, note, effective_from, created_by)
                  VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(company.id, DEFAULT_POLICY.free_per_year, DEFAULT_POLICY.year_basis, DEFAULT_POLICY.default_fee,
        DEFAULT_POLICY.overdue_days, 'السياسة الأولية: أول تصديقين في سنة العقد على الشركة.', riyadhToday(), userId);
      p = db.prepare('SELECT * FROM attestation_policies WHERE company_id = ? ORDER BY version DESC LIMIT 1').get(company.id);
    }
    return p;
  }

  function policyInfo(company) {
    const current = currentPolicy(company);
    const history = db.prepare(`SELECT p.*, u.display_name AS created_by_name FROM attestation_policies p LEFT JOIN users u ON u.id = p.created_by
                                WHERE p.company_id = ? ORDER BY p.version DESC`).all(company.id);
    return { current, history };
  }

  function updatePolicy(company, input, userId) {
    const cur = currentPolicy(company, userId);
    const free = input.free_per_year === undefined ? cur.free_per_year : Number(input.free_per_year);
    if (!Number.isInteger(free) || free < 0 || free > 50) throw new HttpError(400, 'عدد التصديقات على الشركة يجب أن يكون رقمًا صحيحًا من 0 إلى 50.');
    const basis = input.year_basis ?? cur.year_basis;
    if (!['hire_anniversary', 'calendar'].includes(basis)) throw new HttpError(400, 'أساس السنة غير صالح.');
    const fee = input.default_fee === undefined ? cur.default_fee : money(input.default_fee, 'الرسوم الافتراضية');
    const overdue = input.overdue_days === undefined ? cur.overdue_days : Number(input.overdue_days);
    if (!Number.isInteger(overdue) || overdue < 1 || overdue > 365) throw new HttpError(400, 'مدة التنبيه يجب أن تكون من 1 إلى 365 يومًا.');
    const note = str(input.note, 1000) ?? null;
    return tx(db, () => {
      db.prepare(`INSERT INTO attestation_policies (company_id, version, free_per_year, year_basis, default_fee, overdue_days, note, effective_from, created_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(company.id, cur.version + 1, free, basis, fee, overdue, note, riyadhToday(), userId);
      log(company.id, null, 'policy_changed', `الإصدار ${cur.version + 1}${note ? ' — ' + note : ''}`, {
        free_per_year: [cur.free_per_year, free], year_basis: [cur.year_basis, basis], default_fee: [cur.default_fee, fee], overdue_days: [cur.overdue_days, overdue],
      }, userId);
      return policyInfo(company);
    });
  }

  // ---------- calculation ----------
  // Re-sequences one employee's contract year. Only rows whose deduction is still
  // open are updated; confirmed/waived rows keep their values and get flagged if
  // the new calculation disagrees.
  function recalcYear(companyId, employeeId, yearStart, userId) {
    const rows = db.prepare(`SELECT * FROM chamber_attestations WHERE company_id = ? AND employee_id = ? AND contract_year_start = ?
                             ORDER BY request_date, id`).all(companyId, employeeId, yearStart);
    let seq = 0;
    for (const r of rows) {
      const locked = r.deduction_status === 'confirmed' || r.deduction_status === 'waived';
      let next;
      if (r.status === 'cancelled') {
        next = { seq_in_year: null, charged_to: null, deduction_amount: 0, deduction_status: 'not_applicable' };
      } else {
        seq += 1;
        const charged = seq <= r.free_limit ? 'company' : 'employee';
        next = { seq_in_year: seq, charged_to: charged, deduction_amount: charged === 'employee' ? r.fee_amount : 0, deduction_status: charged === 'employee' ? 'pending' : 'not_applicable' };
      }
      if (locked) {
        let review = null;
        if (r.status === 'cancelled') review = 'الطلب ملغي وعليه خصم معتمد.';
        else if (next.charged_to !== 'employee') review = `بعد التعديلات أصبح هذا الطلب رقم ${next.seq_in_year} في سنة العقد (ضمن المسموح على الشركة) وعليه خصم معتمد.`;
        db.prepare(`UPDATE chamber_attestations SET seq_in_year = ?, needs_review = ?, review_reason = ? WHERE company_id = ? AND id = ?`)
          .run(next.seq_in_year, review ? 1 : 0, review, companyId, r.id);
        if (review && !r.needs_review) log(companyId, r, 'needs_review', review, null, userId);
        continue;
      }
      const changed = r.seq_in_year !== next.seq_in_year || r.charged_to !== next.charged_to || r.deduction_status !== next.deduction_status || r.deduction_amount !== next.deduction_amount;
      if (!changed && !r.needs_review) continue;
      db.prepare(`UPDATE chamber_attestations SET seq_in_year = ?, charged_to = ?, deduction_amount = ?, deduction_status = ?, needs_review = 0, review_reason = NULL,
                  updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(next.seq_in_year, next.charged_to, next.deduction_amount, next.deduction_status, companyId, r.id);
      if (changed && r.charged_to !== null && r.charged_to !== next.charged_to) {
        log(companyId, r, 'recalculated', `أصبح الطلب رقم ${next.seq_in_year ?? '—'} في سنة العقد — ${next.charged_to === 'employee' ? 'على الموظف' : next.charged_to === 'company' ? 'على الشركة' : 'لا يُحتسب'}`,
          { charged_to: [r.charged_to, next.charged_to], seq_in_year: [r.seq_in_year, next.seq_in_year] }, userId);
      }
    }
  }

  // What the next request on `day` would cost (shown when picking an employee).
  function employeeStatus(company, tenant, employeeId, day) {
    const e = tenant.get('employees', employeeId);
    const p = currentPolicy(company);
    day = date(day, 'التاريخ') || riyadhToday();
    const base = { employee: { id: e.id, full_name_ar: e.full_name_ar, department: e.department, hire_date: e.hire_date, company: company.name_ar } };
    if (!e.hire_date) return { ...base, error: 'لا يوجد تاريخ مباشرة لهذا الموظف في دليل الموظفين؛ أضفه أولًا لاحتساب سنة العقد.' };
    const cy = contractYear(e.hire_date, day, p.year_basis);
    const used = db.prepare(`SELECT COUNT(*) n FROM chamber_attestations WHERE company_id = ? AND employee_id = ? AND contract_year_start = ? AND status != 'cancelled'`)
      .get(company.id, e.id, cy.start).n;
    return {
      ...base, contract_year: cy, used, free_limit: p.free_per_year,
      free_remaining: Math.max(0, p.free_per_year - used),
      next_seq: used + 1, next_charged_to: used + 1 <= p.free_per_year ? 'company' : 'employee', default_fee: p.default_fee,
    };
  }

  // ---------- reads ----------
  const loadRow = (companyId, id) => {
    const r = db.prepare('SELECT * FROM chamber_attestations WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!r) throw new HttpError(404, 'طلب التصديق غير موجود في الشركة الحالية.');
    return r;
  };

  function list(company, f = {}) {
    const where = ['a.company_id = ?'];
    const p = [company.id];
    const add = (sql, v) => { where.push(sql); p.push(v); };
    if (f.status && STATUS[f.status]) add('a.status = ?', f.status);
    if (f.charged_to === 'company' || f.charged_to === 'employee') add('a.charged_to = ?', f.charged_to);
    if (f.deduction_status && DEDUCTION[f.deduction_status]) add('a.deduction_status = ?', f.deduction_status);
    if (f.employee_id) add('a.employee_id = ?', Number(f.employee_id));
    if (f.from && DATE_RE.test(f.from)) add('a.request_date >= ?', f.from);
    if (f.to && DATE_RE.test(f.to)) add('a.request_date <= ?', f.to);
    if (f.needs_review === '1') where.push('a.needs_review = 1');
    if (f.q) {
      where.push('(a.request_no LIKE ? OR a.employee_name LIKE ? OR a.document_type LIKE ? OR a.department LIKE ?)');
      p.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    return db.prepare(`SELECT a.*, e.employee_no, u.display_name AS confirmed_by_name FROM chamber_attestations a
                       JOIN employees e ON e.company_id = a.company_id AND e.id = a.employee_id
                       LEFT JOIN users u ON u.id = a.deduction_confirmed_by
                       WHERE ${where.join(' AND ')} ORDER BY a.request_date DESC, a.id DESC LIMIT 2000`).all(...p);
  }

  function get(company, id) {
    const r = loadRow(company.id, id);
    const events = db.prepare(`SELECT ev.*, u.display_name AS user_name FROM attestation_events ev LEFT JOIN users u ON u.id = ev.user_id
                               WHERE ev.company_id = ? AND ev.attestation_id = ? ORDER BY ev.id DESC`).all(company.id, r.id);
    const policy = db.prepare('SELECT version, free_per_year, year_basis FROM attestation_policies WHERE company_id = ? AND id = ?').get(company.id, r.policy_id);
    return { ...r, policy, events };
  }

  // ---------- writes ----------
  const nextRequestNo = (company) => {
    const prefix = `${company.code.toUpperCase()}/ATT/${riyadhToday().slice(0, 4)}/`;
    const last = db.prepare('SELECT request_no r FROM chamber_attestations WHERE company_id = ? AND request_no LIKE ? ORDER BY request_no DESC LIMIT 1').get(company.id, `${prefix}%`);
    return prefix + String(last ? Number(last.r.slice(prefix.length)) + 1 : 1).padStart(4, '0');
  };

  function employeeSnapshot(tenant, employeeId) {
    if (!employeeId) throw new HttpError(400, 'اختر الموظف.');
    const e = tenant.get('employees', employeeId); // 404 if the employee belongs to another company
    if (!e.hire_date) throw new HttpError(400, `لا يوجد تاريخ مباشرة لـ ${e.full_name_ar} في دليل الموظفين؛ أضفه أولًا لاحتساب سنة العقد.`);
    return { employee_id: e.id, employee_name: e.full_name_ar, department: e.department ?? null, hire_date: e.hire_date };
  }

  function cleanCommon(input) {
    const out = {
      document_type: str(input.document_type, 200),
      purpose: str(input.purpose, 500),
      chamber_reference: str(input.chamber_reference, 100),
      notes: str(input.notes, 2000),
    };
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  }

  function create(company, tenant, input, userId) {
    input = input || {};
    const emp = employeeSnapshot(tenant, input.employee_id);
    const common = cleanCommon(input);
    if (!common.document_type) throw new HttpError(400, 'نوع المستند مطلوب.');
    const requestDate = date(input.request_date, 'تاريخ الطلب', { required: true });
    if (requestDate > riyadhToday()) throw new HttpError(400, 'تاريخ الطلب لا يمكن أن يكون في المستقبل.');
    return tx(db, () => {
      const policy = currentPolicy(company, userId);
      const fee = money(input.fee_amount, 'رسوم التصديق') ?? policy.default_fee;
      if (fee === null || fee === undefined) throw new HttpError(400, 'أدخل رسوم التصديق — لا توجد رسوم افتراضية في سياسة الشركة.');
      const cy = contractYear(emp.hire_date, requestDate, policy.year_basis);
      const row = {
        request_no: nextRequestNo(company), ...emp, ...common, request_date: requestDate, fee_amount: fee,
        policy_id: policy.id, free_limit: policy.free_per_year, year_basis: policy.year_basis,
        contract_year_start: cy.start, contract_year_end: cy.end,
      };
      const keys = Object.keys(row);
      const r = db.prepare(`INSERT INTO chamber_attestations (company_id, created_by, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
        .run(company.id, userId ?? null, ...keys.map((k) => row[k] ?? null));
      const id = Number(r.lastInsertRowid);
      recalcYear(company.id, emp.employee_id, cy.start, userId);
      const saved = loadRow(company.id, id);
      log(company.id, saved, 'created', `${saved.employee_name} — ${saved.document_type} — التصديق رقم ${saved.seq_in_year} في سنة العقد (${saved.charged_to === 'employee' ? 'على الموظف' : 'على الشركة'})`, null, userId);
      return get(company, id);
    });
  }

  const LOCKED_FIELDS = ['employee_id', 'request_date', 'fee_amount'];

  function update(company, tenant, id, input, userId) {
    input = input || {};
    return tx(db, () => {
      const old = loadRow(company.id, id);
      const set = cleanCommon(input);
      if ('document_type' in set && !set.document_type) throw new HttpError(400, 'نوع المستند مطلوب.');
      if (input.employee_id !== undefined && Number(input.employee_id) !== old.employee_id) Object.assign(set, employeeSnapshot(tenant, input.employee_id));
      if (input.request_date !== undefined) {
        set.request_date = date(input.request_date, 'تاريخ الطلب', { required: true });
        if (set.request_date > riyadhToday()) throw new HttpError(400, 'تاريخ الطلب لا يمكن أن يكون في المستقبل.');
      }
      if (input.fee_amount !== undefined) {
        set.fee_amount = money(input.fee_amount, 'رسوم التصديق');
        if (set.fee_amount === null) throw new HttpError(400, 'رسوم التصديق مطلوبة.');
      }
      for (const k of ['submitted_at', 'attested_at', 'delivered_at']) if (input[k] !== undefined) set[k] = date(input[k], 'التاريخ');
      const changes = {};
      for (const [k, v] of Object.entries(set)) if ((old[k] ?? null) !== (v ?? null)) changes[k] = [old[k] ?? null, v ?? null];
      delete changes.employee_name; delete changes.department; delete changes.hire_date;
      if (!Object.keys(changes).length) return get(company, old.id);
      const lockedDeduction = old.deduction_status === 'confirmed' || old.deduction_status === 'waived';
      if (lockedDeduction && LOCKED_FIELDS.some((k) => k in changes)) {
        throw new HttpError(409, 'الخصم على هذا الطلب مؤكد/معفى؛ لا يمكن تعديل الموظف أو تاريخ الطلب أو الرسوم. يمكن للمسؤول إلغاء تأكيد الخصم أولًا.', 'deduction_locked');
      }
      const empHire = set.hire_date ?? old.hire_date;
      const reqDate = set.request_date ?? old.request_date;
      const cy = contractYear(empHire, reqDate, old.year_basis);
      Object.assign(set, { contract_year_start: cy.start, contract_year_end: cy.end });
      const keys = Object.keys(set);
      db.prepare(`UPDATE chamber_attestations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(...keys.map((k) => set[k] ?? null), company.id, old.id);
      log(company.id, old, 'updated', null, changes, userId);
      recalcYear(company.id, old.employee_id, old.contract_year_start, userId);
      recalcYear(company.id, set.employee_id ?? old.employee_id, cy.start, userId);
      return get(company, old.id);
    });
  }

  const STATUS_ACTIONS = {
    submit: { from: ['requested'], to: 'in_progress', field: 'submitted_at', label: 'إرسال للتصديق' },
    attest: { from: ['requested', 'in_progress'], to: 'attested', field: 'attested_at', label: 'تم التصديق' },
    deliver: { from: ['attested'], to: 'delivered', field: 'delivered_at', label: 'تم التسليم' },
    cancel: { from: ['requested', 'in_progress', 'attested'], to: 'cancelled', field: 'cancelled_at', label: 'إلغاء الطلب' },
    reopen: { from: ['cancelled'], to: 'requested', field: null, label: 'إعادة فتح الطلب' },
  };

  function setStatus(company, id, input, userId) {
    const a = STATUS_ACTIONS[input?.action];
    if (!a) throw new HttpError(400, 'إجراء غير معروف.');
    return tx(db, () => {
      const r = loadRow(company.id, id);
      if (!a.from.includes(r.status)) throw new HttpError(409, `لا يمكن «${a.label}» والطلب بحالة «${STATUS[r.status]}».`);
      const when = date(input.date, 'التاريخ') || riyadhToday();
      if (when > riyadhToday()) throw new HttpError(400, 'التاريخ لا يمكن أن يكون في المستقبل.');
      const set = { status: a.to };
      if (a.field) set[a.field] = when;
      if (input.action === 'attest' && input.chamber_reference !== undefined) set.chamber_reference = str(input.chamber_reference, 100) ?? null;
      if (input.action === 'cancel') {
        const reason = str(input.reason, 500);
        if (!reason) throw new HttpError(400, 'سبب الإلغاء مطلوب.');
        set.cancel_reason = reason;
      }
      if (input.action === 'reopen') Object.assign(set, { cancelled_at: null, cancel_reason: null });
      const keys = Object.keys(set);
      db.prepare(`UPDATE chamber_attestations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(...keys.map((k) => set[k]), company.id, r.id);
      log(company.id, r, `status:${input.action}`, [when, input.reason].filter(Boolean).join(' — '), { status: [r.status, a.to] }, userId);
      if (input.action === 'cancel' || input.action === 'reopen') recalcYear(company.id, r.employee_id, r.contract_year_start, userId);
      return get(company, r.id);
    });
  }

  // Admin only (checked by the route). Confirmed deductions must be reverted first.
  function remove(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الحذف مطلوب.');
    return tx(db, () => {
      const r = loadRow(company.id, id);
      if (r.deduction_status === 'confirmed') throw new HttpError(409, 'لا يمكن حذف طلب عليه خصم مؤكد. ألغِ تأكيد الخصم أولًا.', 'deduction_locked');
      log(company.id, r, 'deleted', reason, { snapshot: r }, userId);
      db.prepare('DELETE FROM chamber_attestations WHERE company_id = ? AND id = ?').run(company.id, r.id);
      recalcYear(company.id, r.employee_id, r.contract_year_start, userId);
      return { ok: true };
    });
  }

  // ---------- salary deduction (recorded only after explicit team confirmation) ----------
  function confirmDeduction(company, id, input, userId) {
    if (input?.team_confirmed !== true) throw new HttpError(400, 'يجب تأكيد مراجعة الفريق قبل تسجيل الخصم.', 'team_confirmation_required');
    const month = str(input.payroll_month, 7);
    if (!month || !MONTH_RE.test(month)) throw new HttpError(400, 'حدد شهر مسير الرواتب (YYYY-MM).');
    return tx(db, () => {
      const r = loadRow(company.id, id);
      if (r.deduction_status !== 'pending') throw new HttpError(409, `لا يوجد خصم بانتظار التأكيد على هذا الطلب (${DEDUCTION[r.deduction_status]}).`);
      db.prepare(`UPDATE chamber_attestations SET deduction_status = 'confirmed', deduction_confirmed_at = datetime('now'), deduction_payroll_month = ?,
                  deduction_confirmed_by = ?, deduction_note = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(month, userId ?? null, str(input.note, 500) ?? null, company.id, r.id);
      log(company.id, r, 'deduction_confirmed', `${r.deduction_amount} ريال — مسير ${month}`, null, userId);
      return get(company, r.id);
    });
  }

  function revertDeduction(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب إلغاء التأكيد مطلوب.');
    return tx(db, () => {
      const r = loadRow(company.id, id);
      if (r.deduction_status !== 'confirmed' && r.deduction_status !== 'waived') throw new HttpError(409, 'لا يوجد خصم مؤكد أو إعفاء لإلغائه.');
      db.prepare(`UPDATE chamber_attestations SET deduction_status = 'pending', deduction_confirmed_at = NULL, deduction_payroll_month = NULL,
                  deduction_confirmed_by = NULL, deduction_note = NULL, updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(company.id, r.id);
      log(company.id, r, r.deduction_status === 'waived' ? 'waiver_reverted' : 'deduction_reverted', reason, null, userId);
      recalcYear(company.id, r.employee_id, r.contract_year_start, userId);
      return get(company, r.id);
    });
  }

  function waiveDeduction(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الإعفاء مطلوب.');
    return tx(db, () => {
      const r = loadRow(company.id, id);
      if (r.deduction_status !== 'pending') throw new HttpError(409, 'الإعفاء متاح فقط لخصم بانتظار التأكيد.');
      db.prepare(`UPDATE chamber_attestations SET deduction_status = 'waived', deduction_confirmed_at = datetime('now'), deduction_confirmed_by = ?,
                  deduction_note = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(userId ?? null, reason, company.id, r.id);
      log(company.id, r, 'deduction_waived', reason, null, userId);
      return get(company, r.id);
    });
  }

  // ---------- reports & alerts ----------
  function summary(company, { from, to } = {}) {
    const today = riyadhToday();
    from = DATE_RE.test(from || '') ? from : `${today.slice(0, 4)}-01-01`;
    to = DATE_RE.test(to || '') ? to : today;
    const p = currentPolicy(company);
    const rows = list(company, { from, to });
    const active = rows.filter((r) => r.status !== 'cancelled');
    const sum = (arr, k) => Math.round(arr.reduce((s, r) => s + (r[k] || 0), 0) * 100) / 100;
    const group = (key) => Object.values(active.reduce((m, r) => {
      const k = r[key] || '—';
      m[k] ||= { key: k, count: 0, company: 0, employee: 0, fees: 0 };
      m[k].count++; m[k][r.charged_to]++; m[k].fees += r.fee_amount;
      return m;
    }, {})).sort((a, b) => b.count - a.count);
    const byEmployee = Object.values(active.reduce((m, r) => {
      m[r.employee_id] ||= { employee_id: r.employee_id, employee_name: r.employee_name, department: r.department, count: 0, employee_charged: 0, deductions: 0 };
      const e = m[r.employee_id]; e.count++;
      if (r.charged_to === 'employee') { e.employee_charged++; if (r.deduction_status !== 'waived') e.deductions += r.deduction_amount; }
      return m;
    }, {})).sort((a, b) => b.count - a.count);
    const overdueBefore = addDays(today, -p.overdue_days);
    const all = list(company, {});
    return {
      from, to, policy: { version: p.version, free_per_year: p.free_per_year, year_basis: p.year_basis, overdue_days: p.overdue_days },
      totals: {
        requests: active.length, cancelled: rows.length - active.length,
        by_status: Object.fromEntries(Object.keys(STATUS).map((s) => [s, rows.filter((r) => r.status === s).length])),
        company_charged: active.filter((r) => r.charged_to === 'company').length,
        employee_charged: active.filter((r) => r.charged_to === 'employee').length,
        company_cost: sum(active.filter((r) => r.charged_to === 'company'), 'fee_amount'),
        deductions_pending: sum(active.filter((r) => r.deduction_status === 'pending'), 'deduction_amount'),
        deductions_confirmed: sum(active.filter((r) => r.deduction_status === 'confirmed'), 'deduction_amount'),
        deductions_waived: sum(active.filter((r) => r.deduction_status === 'waived'), 'deduction_amount'),
      },
      by_department: group('department'),
      by_document_type: group('document_type'),
      by_employee: byEmployee,
      alerts: {
        pending_deductions: all.filter((r) => r.deduction_status === 'pending'),
        overdue_requests: all.filter((r) => ['requested', 'in_progress'].includes(r.status) && r.request_date <= overdueBefore),
        needs_review: all.filter((r) => r.needs_review),
      },
    };
  }

  function events(company, { limit = 300 } = {}) {
    return db.prepare(`SELECT ev.*, u.display_name AS user_name FROM attestation_events ev LEFT JOIN users u ON u.id = ev.user_id
                       WHERE ev.company_id = ? ORDER BY ev.id DESC LIMIT ?`).all(company.id, Math.min(Number(limit) || 300, 2000));
  }

  // CSV (UTF-8 with BOM so Excel shows Arabic correctly).
  function exportCsv(company, filters) {
    const rows = list(company, filters);
    const cols = [
      ['request_no', 'رقم الطلب'], ['employee_no', 'الرقم الوظيفي'], ['employee_name', 'الموظف'], ['department', 'الإدارة'], ['hire_date', 'تاريخ المباشرة'],
      ['document_type', 'نوع المستند'], ['purpose', 'الغرض / الجهة'], ['request_date', 'تاريخ الطلب'], ['status', 'الحالة'], ['attested_at', 'تاريخ التصديق'],
      ['chamber_reference', 'مرجع الغرفة'], ['contract_year_start', 'بداية سنة العقد'], ['contract_year_end', 'نهاية سنة العقد'], ['seq_in_year', 'الترتيب في سنة العقد'],
      ['charged_to', 'على حساب'], ['fee_amount', 'الرسوم'], ['deduction_amount', 'مبلغ الخصم'], ['deduction_status', 'حالة الخصم'], ['deduction_payroll_month', 'شهر المسير'],
    ];
    const label = (k, v) => (k === 'status' ? STATUS[v] : k === 'deduction_status' ? DEDUCTION[v] : k === 'charged_to' ? ({ company: 'الشركة', employee: 'الموظف' })[v] ?? '' : v);
    const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.map((c) => cell(c[1])).join(','), ...rows.map((r) => cols.map(([k]) => cell(label(k, r[k]))).join(','))];
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  // Future Excel import: rows are validated by the same rules as manual entry.
  // Only dry runs are exposed now (nothing is saved); a real import will reuse this.
  function importRows(company, tenant, rows, { dryRun = true, userId = null } = {}) {
    if (!dryRun) throw new HttpError(400, 'الاستيراد الفعلي غير مفعّل حاليًا.');
    if (!Array.isArray(rows)) throw new HttpError(400, 'صيغة غير صالحة.');
    const results = [];
    db.exec('SAVEPOINT att_import');
    try {
      rows.forEach((row, i) => {
        try { const r = create(company, tenant, row, userId); results.push({ row: i + 1, ok: true, seq_in_year: r.seq_in_year, charged_to: r.charged_to }); }
        catch (e) { results.push({ row: i + 1, ok: false, error: e.message }); }
      });
    } finally {
      db.exec('ROLLBACK TO att_import');
      db.exec('RELEASE att_import');
    }
    return { dry_run: true, total: rows.length, valid: results.filter((r) => r.ok).length, results };
  }

  return {
    currentPolicy, policyInfo, updatePolicy, employeeStatus, list, get, create, update, setStatus, remove,
    confirmDeduction, revertDeduction, waiveDeduction, summary, events, exportCsv, importRows,
    meta: () => ({ status: STATUS, deduction: DEDUCTION, document_types: DOCUMENT_TYPES }),
  };
}
