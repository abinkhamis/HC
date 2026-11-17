// One record per employee, from recruitment to end of service.
//
// The directory table `employees` is the single record every tool links to
// (procedures, bank accounts, letters, air tickets, attestations) through its
// internal id. That id exists from the moment recruitment adds the person, so a
// case can be tracked before an employee number is assigned.
//
// Stored statuses:   onboarding (قيد الانضمام) → active (نشط) → inactive (منتهي الخدمة)
// Displayed status:  "قيد إنهاء الخدمة" = active with an open offboarding case (derived,
//                    never stored, so nothing changes by itself).
// Status changes only by an explicit user action (directory edit, «تأكيد المباشرة»,
// «تأكيد انتهاء الخدمة»); an Excel import never changes a status.
import { HttpError } from './errors.js';

export const EMPLOYEE_STATUS = { onboarding: 'قيد الانضمام', active: 'نشط', inactive: 'منتهي الخدمة' };
export const DISPLAY_STATUS = { onboarding: 'قيد الانضمام', active: 'نشط', offboarding: 'قيد إنهاء الخدمة', inactive: 'منتهي الخدمة' };

// The same normalisation as the database unique index (ux_employees_no_norm):
// spaces removed, upper case; Arabic-Indic digits are turned into 0-9 first.
export const latinDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06F0);
export function normEmployeeNo(v) {
  if (v === null || v === undefined) return null;
  let s = latinDigits(v);
  s = s.replace(/[\s ‎‏‪-‮]+/g, '').toUpperCase();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, ''); // 1234.0 from a numeric Excel cell
  return s || null;
}
export const EMPLOYEE_NO_SQL = "upper(replace(replace(replace(trim(employee_no), ' ', ''), char(9), ''), char(160), ''))";

/** The employee (any status) that already uses this number in the company, if any. */
export function employeeNoOwner(db, companyId, employeeNo, exceptId = null) {
  const no = normEmployeeNo(employeeNo);
  if (!no) return null;
  return db.prepare(`SELECT id, employee_no, full_name_ar, status FROM employees
                     WHERE company_id = ? AND employee_no IS NOT NULL AND ${EMPLOYEE_NO_SQL} = ? AND id IS NOT ?`)
    .get(companyId, no, exceptId === null || exceptId === undefined ? null : Number(exceptId)) || null;
}

/** Refuses a number already used by another employee — active, onboarding or ended. */
export function assertEmployeeNoFree(db, companyId, employeeNo, exceptId = null) {
  const owner = employeeNoOwner(db, companyId, employeeNo, exceptId);
  if (!owner) return;
  const company = db.prepare('SELECT name_ar FROM companies WHERE id = ?').get(companyId);
  throw new HttpError(409,
    `الرقم الوظيفي ${normEmployeeNo(employeeNo)} مستخدم مسبقًا في ${company?.name_ar ?? 'الشركة'} للموظف ${owner.full_name_ar} (${EMPLOYEE_STATUS[owner.status] ?? owner.status}). لا يمكن حفظ سجل مكرر — افتح السجل الموجود.`,
    'employee_no_taken', { employee_id: owner.id, full_name_ar: owner.full_name_ar, employee_no: owner.employee_no, status: owner.status, status_label: EMPLOYEE_STATUS[owner.status] ?? owner.status });
}

/** Status shown to users: adds "قيد إنهاء الخدمة" for an active employee with an open offboarding case. */
export function displayStatus(employee, hasOpenOffboarding) {
  if (employee.status === 'active' && hasOpenOffboarding) return 'offboarding';
  return EMPLOYEE_STATUS[employee.status] ? employee.status : 'active';
}

/** Adds display_status / open case ids to directory rows (one query for the whole list). */
export function annotateEmployees(db, companyId, rows) {
  const open = db.prepare(`SELECT employee_id, case_type, id FROM proc_cases WHERE company_id = ? AND status = 'open'`).all(companyId);
  const by = new Map();
  for (const c of open) {
    const m = by.get(c.employee_id) || {};
    m[c.case_type] = c.id;
    by.set(c.employee_id, m);
  }
  return rows.map((r) => {
    const m = by.get(r.id) || {};
    const ds = displayStatus(r, !!m.offboarding);
    return { ...r, display_status: ds, display_status_label: DISPLAY_STATUS[ds], open_onboarding_case: m.onboarding ?? null, open_offboarding_case: m.offboarding ?? null };
  });
}

/** Counts per displayed status for the directory header. */
export function statusCounts(db, companyId) {
  const rows = annotateEmployees(db, companyId, db.prepare('SELECT id, status FROM employees WHERE company_id = ?').all(companyId));
  const out = { onboarding: 0, active: 0, offboarding: 0, inactive: 0 };
  for (const r of rows) out[r.display_status]++;
  return out;
}

// History of a directory record (who changed what, from which screen or import).
export function logEmployeeEvent(db, companyId, employeeId, event, detail, changes, userId, importId = null) {
  db.prepare(`INSERT INTO employee_events (company_id, employee_id, event, detail, changes_json, import_id, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(companyId, employeeId, event, detail ?? null, changes ? JSON.stringify(changes) : null, importId, userId ?? null);
}
