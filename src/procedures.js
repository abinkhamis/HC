// Employee procedures tracking: onboarding and offboarding cases.
//
// Each case is a tracking file for one employee of the selected company. When it
// is opened, the company's current checklist for that case type is copied into
// it; every step is then updated on its own (status, responsible party, person,
// dates, reference, notes). Nothing is completed or closed automatically. The
// only automatic choice is "not applicable" for steps limited to Saudis or
// non-Saudis, shown with its reason and changeable (with a reason) by the user.
// Closing a case never touches the employee directory.
import { HttpError } from './errors.js';
import { tx } from './db.js';
import { nationalityClass } from './airtickets.js';
import { buildXlsx } from './xlsx.js';
import { normEmployeeNo, assertEmployeeNoFree, EMPLOYEE_STATUS, DISPLAY_STATUS, displayStatus } from './employees.js';

export const CASE_TYPES = { onboarding: 'مباشرة موظف جديد', offboarding: 'استقالة / إنهاء خدمات' };
export const CASE_STATUS = { open: 'مفتوحة', closed: 'مغلقة', cancelled: 'ملغاة' };
export const STEP_STATUS = { done: 'مكتمل', pending: 'لم يكتمل', in_progress: 'قيد التنفيذ', na: 'لا ينطبق' };
export const APPLIES_TO = { all: 'جميع الموظفين', saudi: 'السعوديون فقط', non_saudi: 'غير السعوديين فقط' };
export const LISTS = { party: 'الجهات المسؤولة', project: 'المشاريع', offboarding_reason: 'أسباب الخروج', support_reason: 'أسباب عدم الإضافة في الدعم' };

// Initial checklists (copied once per company; Admin edits each company's own copy).
const DEFAULT_STEPS = {
  onboarding: [
    { code: 'employee_file', name_ar: 'ملف الموظف' },
    { code: 'email_create', name_ar: 'إنشاء البريد الإلكتروني' },
    { code: 'device_request', name_ar: 'طلب الجهاز' },
    { code: 'start_notice', name_ar: 'إشعار المباشرة' },
    { code: 'nda', name_ar: 'اتفاقية سرية المعلومات' },
    { code: 'jisr', name_ar: 'التسجيل في جسر' },
    { code: 'medical_insurance', name_ar: 'التأمين الطبي' },
    { code: 'qiwa_contract', name_ar: 'عقد قوى', reference_label: 'رقم العقد في قوى / رابط السجل' },
    { code: 'gosi', name_ar: 'التأمينات الاجتماعية' },
    { code: 'sponsorship_transfer', name_ar: 'نقل الكفالة', applies_to: 'non_saudi' },
    { code: 'support_registration', name_ar: 'التسجيل في الدعم', applies_to: 'saudi', na_reason_list: 'support_reason' },
    { code: 'payroll_change', name_ar: 'حركة الرواتب', date_label: 'تاريخ حركة الرواتب' },
  ],
  offboarding: [
    { code: 'clearance', name_ar: 'التصفية' },
    { code: 'clearance_letter', name_ar: 'إخلاء الطرف', letter: 'clearance' },
    { code: 'email_close', name_ar: 'إغلاق البريد الإلكتروني' },
    { code: 'health_insurance_cancel', name_ar: 'إلغاء التأمين الصحي' },
    { code: 'gosi_cancel', name_ar: 'إلغاء التأمينات الاجتماعية' },
    { code: 'sponsorship_transfer', name_ar: 'نقل الكفالة', applies_to: 'non_saudi' },
    { code: 'clearance_to_finance', name_ar: 'إرسال التصفية إلى المالية' },
    { code: 'dues_ack', name_ar: 'إقرار المستحقات' },
    { code: 'experience_certificate', name_ar: 'شهادة الخبرة', letter: 'experience_certificate' },
  ],
};
const DEFAULT_LISTS = {
  support_reason: ['لا ينطبق على الشروط', 'مسجل في الدعم سابقًا', 'غير مسجل في طاقات', 'لديه سجل تجاري', 'مسجل في أكثر من منشأة', 'موظف حكومي', 'أخرى'],
  offboarding_reason: ['استقالة', 'إنهاء خدمات', 'انتهاء عقد', 'أخرى'],
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
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
const intOrNull = (v, label, min, max) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `«${label}» يجب أن يكون رقمًا صحيحًا من ${min} إلى ${max}.`);
  return n;
};
const NAT_LABEL = { saudi: 'سعودي', non_saudi: 'غير سعودي' };

export function createProcedureService(db) {
  // Readable change log: codes and list ids are stored as their Arabic labels.
  const labelOf = (companyId, id) => (id === null || id === undefined ? null : db.prepare('SELECT label FROM proc_lists WHERE company_id = ? AND id = ?').get(companyId, id)?.label ?? id);
  const pretty = (companyId, changes) => {
    if (!changes || changes.snapshot) return changes;
    const map = {
      status: (v) => STEP_STATUS[v] ?? v, applies_to: (v) => APPLIES_TO[v] ?? v, is_active: (v) => (v === null ? null : v ? 'نعم' : 'لا'),
      owner_member_id: (v) => (v === null || v === undefined ? null : db.prepare('SELECT name FROM proc_team_members WHERE company_id = ? AND id = ?').get(companyId, v)?.name ?? v),
      party_id: (v) => labelOf(companyId, v), na_reason_id: (v) => labelOf(companyId, v), project_id: (v) => labelOf(companyId, v), offboarding_reason_id: (v) => labelOf(companyId, v),
      letter_type_id: (v) => (v ? db.prepare('SELECT name_ar FROM letter_types WHERE id = ?').get(v)?.name_ar ?? v : null),
      na_reason_list: (v) => (v ? LISTS[v] : null),
    };
    return Object.fromEntries(Object.entries(changes).map(([k, [a, b]]) => [k, map[k] ? [map[k](a), map[k](b)] : [a, b]]));
  };
  const log = (companyId, c, step, ev, detail, changes, userId) =>
    db.prepare('INSERT INTO proc_events (company_id, case_id, case_no, step_id, event, detail, changes_json, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, c?.id ?? null, c?.case_no ?? null, step?.id ?? null, ev, detail ?? null, changes ? JSON.stringify(pretty(companyId, changes)) : null, userId ?? null);

  // ---------- defaults (configuration, created once per company) ----------
  const letterTypeId = (code) => db.prepare('SELECT id FROM letter_types WHERE code = ?').get(code)?.id ?? null;
  function ensureDefaults(company) {
    const has = db.prepare('SELECT 1 FROM proc_checklist_steps WHERE company_id = ? LIMIT 1').get(company.id);
    const hasList = (l) => db.prepare('SELECT 1 FROM proc_lists WHERE company_id = ? AND list = ? LIMIT 1').get(company.id, l);
    if (has && hasList('support_reason') && hasList('offboarding_reason')) return;
    tx(db, () => {
      if (!db.prepare('SELECT 1 FROM proc_checklist_steps WHERE company_id = ? LIMIT 1').get(company.id)) {
        const ins = db.prepare(`INSERT INTO proc_checklist_steps (company_id, case_type, code, name_ar, sort, applies_to, letter_type_id, na_reason_list, date_label, reference_label)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const [type, steps] of Object.entries(DEFAULT_STEPS)) {
          steps.forEach((s, i) => ins.run(company.id, type, s.code, s.name_ar, (i + 1) * 10, s.applies_to || 'all', s.letter ? letterTypeId(s.letter) : null,
            s.na_reason_list || null, s.date_label || null, s.reference_label || null));
        }
      }
      for (const [list, labels] of Object.entries(DEFAULT_LISTS)) {
        if (hasList(list)) continue;
        labels.forEach((label, i) => db.prepare('INSERT INTO proc_lists (company_id, list, label, sort) VALUES (?, ?, ?, ?)').run(company.id, list, label, (i + 1) * 10));
      }
    });
  }

  // ---------- admin: lists ----------
  function lists(company) {
    ensureDefaults(company);
    const rows = db.prepare('SELECT * FROM proc_lists WHERE company_id = ? ORDER BY list, sort, id').all(company.id);
    const out = Object.fromEntries(Object.keys(LISTS).map((k) => [k, rows.filter((r) => r.list === k)]));
    out.members = db.prepare('SELECT * FROM proc_team_members WHERE company_id = ? ORDER BY sort, name').all(company.id);
    return out;
  }

  // ---------- admin: team members (owners of individual steps) ----------
  function addMember(company, input, userId) {
    const name = str(input?.name, 200);
    if (!name) throw new HttpError(400, 'اسم عضو الفريق مطلوب.');
    if (db.prepare('SELECT 1 FROM proc_team_members WHERE company_id = ? AND name = ?').get(company.id, name)) throw new HttpError(409, 'هذا الاسم موجود في قائمة الفريق.');
    const sort = (db.prepare('SELECT MAX(sort) m FROM proc_team_members WHERE company_id = ?').get(company.id).m || 0) + 10;
    db.prepare('INSERT INTO proc_team_members (company_id, name, sort) VALUES (?, ?, ?)').run(company.id, name, sort);
    log(company.id, null, null, 'member_added', name, null, userId);
    return lists(company);
  }
  function updateMember(company, id, input, userId) {
    const r = db.prepare('SELECT * FROM proc_team_members WHERE company_id = ? AND id = ?').get(company.id, Number(id));
    if (!r) throw new HttpError(404, 'عضو الفريق غير موجود في الشركة الحالية.');
    const set = {};
    if (input?.name !== undefined) { set.name = str(input.name, 200); if (!set.name) throw new HttpError(400, 'الاسم مطلوب.'); }
    if (input?.is_active !== undefined) set.is_active = input.is_active ? 1 : 0;
    const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => r[k] !== v).map(([k, v]) => [k, [r[k], v]]));
    if (!Object.keys(changes).length) return lists(company);
    try {
      db.prepare('UPDATE proc_team_members SET ' + Object.keys(set).map((k) => k + ' = ?').join(', ') + ' WHERE company_id = ? AND id = ?').run(...Object.values(set), company.id, r.id);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'هذا الاسم موجود في قائمة الفريق.'); throw e; }
    log(company.id, null, null, 'member_updated', r.name, changes, userId);
    return lists(company);
  }
  const memberItem = (companyId, id) => {
    if (id === undefined) return undefined;
    if (id === null || id === '') return null;
    const r = db.prepare('SELECT id FROM proc_team_members WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!r) throw new HttpError(400, 'عضو الفريق غير موجود في قائمة فريق الشركة الحالية.');
    return r.id;
  };
  function addListItem(company, input, userId) {
    const list = input?.list;
    if (!LISTS[list]) throw new HttpError(400, 'قائمة غير معروفة.');
    const label = str(input.label, 200);
    if (!label) throw new HttpError(400, 'الاسم مطلوب.');
    ensureDefaults(company);
    if (db.prepare('SELECT 1 FROM proc_lists WHERE company_id = ? AND list = ? AND label = ?').get(company.id, list, label)) throw new HttpError(409, 'هذا الاسم موجود في القائمة.');
    const sort = (db.prepare('SELECT MAX(sort) m FROM proc_lists WHERE company_id = ? AND list = ?').get(company.id, list).m || 0) + 10;
    db.prepare('INSERT INTO proc_lists (company_id, list, label, sort) VALUES (?, ?, ?, ?)').run(company.id, list, label, sort);
    log(company.id, null, null, 'list_item_added', `${LISTS[list]}: ${label}`, null, userId);
    return lists(company);
  }
  function updateListItem(company, id, input, userId) {
    const r = db.prepare('SELECT * FROM proc_lists WHERE company_id = ? AND id = ?').get(company.id, Number(id));
    if (!r) throw new HttpError(404, 'العنصر غير موجود في الشركة الحالية.');
    const set = {};
    if (input?.label !== undefined) { set.label = str(input.label, 200); if (!set.label) throw new HttpError(400, 'الاسم مطلوب.'); }
    if (input?.sort !== undefined) set.sort = intOrNull(input.sort, 'الترتيب', 0, 100000) ?? 0;
    if (input?.is_active !== undefined) set.is_active = input.is_active ? 1 : 0;
    const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => r[k] !== v).map(([k, v]) => [k, [r[k], v]]));
    if (!Object.keys(changes).length) return lists(company);
    try {
      db.prepare(`UPDATE proc_lists SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`).run(...Object.values(set), company.id, r.id);
    } catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'هذا الاسم موجود في القائمة.'); throw e; }
    log(company.id, null, null, 'list_item_updated', `${LISTS[r.list]}: ${r.label}`, changes, userId);
    return lists(company);
  }

  // ---------- admin: checklists ----------
  function checklist(company, type) {
    ensureDefaults(company);
    const where = type && CASE_TYPES[type] ? ' AND s.case_type = ?' : '';
    return db.prepare(`SELECT s.*, lt.name_ar AS letter_type_name FROM proc_checklist_steps s LEFT JOIN letter_types lt ON lt.id = s.letter_type_id
                       WHERE s.company_id = ?${where} ORDER BY s.case_type, s.sort, s.id`).all(...(where ? [company.id, type] : [company.id]));
  }
  function cleanChecklistInput(input, old) {
    const out = {};
    if (input.name_ar !== undefined || !old) { out.name_ar = str(input.name_ar, 200); if (!out.name_ar) throw new HttpError(400, 'اسم الإجراء مطلوب.'); }
    if (input.sort !== undefined) out.sort = intOrNull(input.sort, 'الترتيب', 0, 100000) ?? 0;
    if (input.applies_to !== undefined) { if (!APPLIES_TO[input.applies_to]) throw new HttpError(400, 'قيمة «ينطبق على» غير صالحة.'); out.applies_to = input.applies_to; }
    if (input.deadline_days !== undefined) out.deadline_days = intOrNull(input.deadline_days, 'المهلة (يوم)', -365, 365);
    if (input.letter_type_id !== undefined) {
      out.letter_type_id = input.letter_type_id ? Number(input.letter_type_id) : null;
      if (out.letter_type_id && !db.prepare("SELECT 1 FROM letter_types WHERE id = ? AND is_active = 1 AND category = 'letter'").get(out.letter_type_id)) throw new HttpError(400, 'نوع الخطاب غير موجود في مركز الخطابات.');
    }
    if (input.na_reason_list !== undefined) out.na_reason_list = input.na_reason_list === 'support_reason' ? 'support_reason' : null;
    for (const k of ['date_label', 'reference_label']) if (input[k] !== undefined) out[k] = str(input[k], 100) ?? null;
    if (input.is_active !== undefined) out.is_active = input.is_active ? 1 : 0;
    return out;
  }
  function saveChecklistStep(company, input, userId) {
    input = input || {};
    ensureDefaults(company);
    return tx(db, () => {
      if (input.id) {
        const old = db.prepare('SELECT * FROM proc_checklist_steps WHERE company_id = ? AND id = ?').get(company.id, Number(input.id));
        if (!old) throw new HttpError(404, 'الإجراء غير موجود في قائمة الشركة الحالية.');
        const set = cleanChecklistInput(input, old);
        const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => (old[k] ?? null) !== (v ?? null)).map(([k, v]) => [k, [old[k] ?? null, v ?? null]]));
        if (Object.keys(changes).length) {
          db.prepare(`UPDATE proc_checklist_steps SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
            .run(...Object.values(set), company.id, old.id);
          log(company.id, null, null, 'checklist_changed', `${CASE_TYPES[old.case_type]}: ${old.name_ar}`, changes, userId);
        }
      } else {
        if (!CASE_TYPES[input.case_type]) throw new HttpError(400, 'نوع القائمة غير صالح.');
        const set = cleanChecklistInput(input, null);
        if (set.sort === undefined) set.sort = (db.prepare('SELECT MAX(sort) m FROM proc_checklist_steps WHERE company_id = ? AND case_type = ?').get(company.id, input.case_type).m || 0) + 10;
        const keys = Object.keys(set);
        db.prepare(`INSERT INTO proc_checklist_steps (company_id, case_type, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
          .run(company.id, input.case_type, ...keys.map((k) => set[k]));
        log(company.id, null, null, 'checklist_added', `${CASE_TYPES[input.case_type]}: ${set.name_ar}`, null, userId);
      }
      return checklist(company);
    });
  }

  // ---------- helpers ----------
  const listItem = (companyId, id, list, label) => {
    if (id === undefined) return undefined;
    if (id === null || id === '') return null;
    const r = db.prepare('SELECT * FROM proc_lists WHERE company_id = ? AND id = ? AND list = ?').get(companyId, Number(id), list);
    if (!r) throw new HttpError(400, `«${label}» غير موجود في قوائم الشركة الحالية.`);
    return r.id;
  };
  const loadCase = (companyId, id) => {
    const c = db.prepare('SELECT * FROM proc_cases WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!c) throw new HttpError(404, 'حالة المتابعة غير موجودة في الشركة الحالية.');
    return c;
  };
  const loadStep = (companyId, id) => {
    const s = db.prepare('SELECT * FROM proc_case_steps WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!s) throw new HttpError(404, 'الإجراء غير موجود في الشركة الحالية.');
    return s;
  };
  const assertOpen = (c) => { if (c.status !== 'open') throw new HttpError(409, `الحالة ${c.case_no} ${CASE_STATUS[c.status]}؛ أعد فتحها أولًا لتعديلها.`, 'case_not_open'); };

  const STEP_SELECT = `SELECT s.*, m.name AS owner_name, p.label AS party_label, r.label AS na_reason_label, lt.name_ar AS letter_type_name, lt.code AS letter_type_code,
                         il.reference_no AS letter_reference, il.issued_at AS letter_issued_at, u.display_name AS updated_by_name
                       FROM proc_case_steps s
                       LEFT JOIN proc_team_members m ON m.company_id = s.company_id AND m.id = s.owner_member_id
                       LEFT JOIN proc_lists p ON p.company_id = s.company_id AND p.id = s.party_id
                       LEFT JOIN proc_lists r ON r.company_id = s.company_id AND r.id = s.na_reason_id
                       LEFT JOIN letter_types lt ON lt.id = s.letter_type_id
                       LEFT JOIN issued_letters il ON il.company_id = s.company_id AND il.id = s.issued_letter_id
                       LEFT JOIN users u ON u.id = s.updated_by`;

  function decorate(c, steps, today = riyadhToday()) {
    const stepsOut = steps.map((s) => ({ ...s, overdue: c.status === 'open' && ['pending', 'in_progress'].includes(s.status) && !!s.due_date && s.due_date < today }));
    const applicable = stepsOut.filter((s) => s.status !== 'na');
    const done = applicable.filter((s) => s.status === 'done').length;
    const pending = stepsOut.filter((s) => s.status === 'pending' || s.status === 'in_progress');
    return {
      ...c, steps: stepsOut,
      progress: {
        total: stepsOut.length, applicable: applicable.length, done, pending: pending.length,
        in_progress: stepsOut.filter((s) => s.status === 'in_progress').length, na: stepsOut.length - applicable.length,
        percent: applicable.length ? Math.round((done / applicable.length) * 100) : 100,
      },
      overdue_steps: stepsOut.filter((s) => s.overdue).length,
      overdue: stepsOut.some((s) => s.overdue),
    };
  }

  // ---------- cases: reads ----------
  function listCases(company, f = {}) {
    ensureDefaults(company);
    const where = ['c.company_id = ?'];
    const p = [company.id];
    if (f.case_type && CASE_TYPES[f.case_type]) { where.push('c.case_type = ?'); p.push(f.case_type); }
    if (f.status && CASE_STATUS[f.status]) { where.push('c.status = ?'); p.push(f.status); }
    if (f.employee_id) { where.push('c.employee_id = ?'); p.push(Number(f.employee_id)); }
    if (f.project_id) { where.push('c.project_id = ?'); p.push(Number(f.project_id)); }
    if (f.from && DATE_RE.test(f.from)) { where.push('c.key_date >= ?'); p.push(f.from); }
    if (f.to && DATE_RE.test(f.to)) { where.push('c.key_date <= ?'); p.push(f.to); }
    if (f.q) { where.push('(c.case_no LIKE ? OR c.employee_name LIKE ? OR c.employee_no LIKE ? OR c.department LIKE ?)'); p.push(...Array(4).fill(`%${f.q}%`)); }
    const cases = db.prepare(`SELECT c.*, pr.label AS project_label, rs.label AS offboarding_reason_label FROM proc_cases c
                              LEFT JOIN proc_lists pr ON pr.company_id = c.company_id AND pr.id = c.project_id
                              LEFT JOIN proc_lists rs ON rs.company_id = c.company_id AND rs.id = c.offboarding_reason_id
                              WHERE ${where.join(' AND ')} ORDER BY c.key_date DESC, c.id DESC LIMIT 2000`).all(...p);
    const steps = db.prepare(`${STEP_SELECT} WHERE s.company_id = ? ORDER BY s.sort, s.id`).all(company.id);
    const byCase = steps.reduce((m, s) => (m.get(s.case_id)?.push(s) ?? m.set(s.case_id, [s]), m), new Map());
    let rows = cases.map((c) => decorate(c, byCase.get(c.id) || []));
    if (f.overdue === '1') rows = rows.filter((c) => c.overdue);
    if (f.party_id) rows = rows.filter((c) => c.steps.some((s) => s.party_id === Number(f.party_id) && (s.status === 'pending' || s.status === 'in_progress')));
    if (f.light !== false) rows = rows.map(({ steps: st, ...c }) => ({ ...c, pending_steps: st.filter((s) => s.status === 'pending' || s.status === 'in_progress').map((s) => s.name_ar) }));
    return rows;
  }

  function getCase(company, id) {
    const c = db.prepare(`SELECT c.*, pr.label AS project_label, rs.label AS offboarding_reason_label, u.display_name AS closed_by_name, cu.display_name AS created_by_name
                          FROM proc_cases c
                          LEFT JOIN proc_lists pr ON pr.company_id = c.company_id AND pr.id = c.project_id
                          LEFT JOIN proc_lists rs ON rs.company_id = c.company_id AND rs.id = c.offboarding_reason_id
                          LEFT JOIN users u ON u.id = c.closed_by LEFT JOIN users cu ON cu.id = c.created_by
                          WHERE c.company_id = ? AND c.id = ?`).get(company.id, Number(id));
    if (!c) throw new HttpError(404, 'حالة المتابعة غير موجودة في الشركة الحالية.');
    const out = decorate(c, db.prepare(`${STEP_SELECT} WHERE s.company_id = ? AND s.case_id = ? ORDER BY s.sort, s.id`).all(company.id, c.id));
    const e = db.prepare('SELECT * FROM employees WHERE company_id = ? AND id = ?').get(company.id, c.employee_id);
    out.employee = { id: e.id, employee_no: e.employee_no, full_name_ar: e.full_name_ar, department: e.department, job_title: e.job_title,
      nationality_ar: e.nationality_ar, nationality_en: e.nationality_en, hire_date: e.hire_date, end_date: e.end_date, status: e.status,
      nationality_class: nationalityClass(e) };
    const openOff = db.prepare("SELECT 1 FROM proc_cases WHERE company_id = ? AND employee_id = ? AND case_type = 'offboarding' AND status = 'open'").get(company.id, e.id);
    out.employee.display_status = displayStatus(e, !!openOff);
    out.employee.display_status_label = DISPLAY_STATUS[out.employee.display_status];
    // explicit confirmations available on this case (never automatic)
    out.employee.can_confirm_start = c.case_type === 'onboarding' && e.status === 'onboarding';
    out.employee.can_confirm_end = c.case_type === 'offboarding' && e.status === 'active';
    out.warnings = [];
    if (c.nationality_class === 'unknown') out.warnings.push('جنسية الموظف غير محددة في دليل الموظفين عند فتح الحالة؛ الإجراءات المرتبطة بالجنسية تُركت «لم يكتمل» لتحديدها يدويًا.');
    if (out.employee.nationality_class !== c.nationality_class) out.warnings.push('تغيّرت جنسية الموظف في الدليل بعد فتح الحالة؛ راجع الإجراءات المرتبطة بالجنسية.');
    out.letters = letterInfo(company, out);
    out.other_cases = db.prepare('SELECT id, case_no, case_type, status, key_date FROM proc_cases WHERE company_id = ? AND employee_id = ? AND id != ? ORDER BY key_date DESC')
      .all(company.id, c.employee_id, c.id);
    out.events = events(company, { case_id: c.id });
    return out;
  }

  // Letter steps: is an official template uploaded, and which letters of that type were issued to this employee.
  function letterInfo(company, c) {
    const typeIds = [...new Set(c.steps.filter((s) => s.letter_type_id).map((s) => s.letter_type_id))];
    return Object.fromEntries(typeIds.map((tid) => {
      const template = db.prepare('SELECT id, version FROM letter_templates WHERE company_id = ? AND letter_type_id = ? AND is_active = 1').get(company.id, tid) || null;
      const issued = db.prepare(`SELECT id, reference_no, issued_at FROM issued_letters WHERE company_id = ? AND employee_id = ? AND letter_type_id = ? ORDER BY id DESC`)
        .all(company.id, c.employee_id, tid);
      return [tid, { template_available: !!template, template, issued }];
    }));
  }

  // ---------- cases: create / update ----------
  const nextCaseNo = (company, type) => {
    const prefix = `${company.code.toUpperCase()}/${type === 'onboarding' ? 'ONB' : 'OFB'}/${riyadhToday().slice(0, 4)}/`;
    const last = db.prepare('SELECT case_no n FROM proc_cases WHERE company_id = ? AND case_no LIKE ? ORDER BY case_no DESC LIMIT 1').get(company.id, `${prefix}%`);
    return prefix + String(last ? Number(last.n.slice(prefix.length)) + 1 : 1).padStart(4, '0');
  };

  function createCase(company, tenant, input, userId) {
    input = input || {};
    const type = input.case_type;
    if (!CASE_TYPES[type]) throw new HttpError(400, 'اختر نوع الحالة (مباشرة أو خروج).');
    if (!input.employee_id) throw new HttpError(400, 'اختر الموظف من دليل الموظفين.');
    const e = tenant.get('employees', input.employee_id); // 404 for another company's employee
    const keyLabel = type === 'onboarding' ? 'تاريخ المباشرة' : 'آخر يوم عمل';
    const keyDate = date(input.key_date ?? (type === 'onboarding' ? e.hire_date : e.end_date), keyLabel, { required: true });
    ensureDefaults(company);
    const projectId = listItem(company.id, input.project_id, 'project', 'المشروع') ?? null;
    const reasonId = listItem(company.id, input.offboarding_reason_id, 'offboarding_reason', 'سبب الخروج') ?? null;
    const notice = date(input.notice_date, 'تاريخ الإشعار') ?? null;
    return tx(db, () => {
      const dups = db.prepare(`SELECT case_no, status, key_date FROM proc_cases WHERE company_id = ? AND employee_id = ? AND case_type = ?
                               AND (status = 'open' OR (status = 'closed' AND key_date = ?))`).all(company.id, e.id, type, keyDate);
      if (dups.length && input.confirm_duplicate !== true) {
        throw new HttpError(409, `توجد حالة ${CASE_TYPES[type]} للموظف ${e.full_name_ar}: ${dups.map((d) => `${d.case_no} (${CASE_STATUS[d.status]} — ${d.key_date})`).join('، ')}. تأكد أنها ليست الحدث نفسه قبل فتح حالة جديدة.`, 'duplicate_case');
      }
      const nat = nationalityClass(e);
      const caseNo = nextCaseNo(company, type);
      const r = db.prepare(`INSERT INTO proc_cases (company_id, case_no, case_type, employee_id, employee_no, employee_name, department, job_title, nationality, nationality_class,
                              key_date, project_id, offboarding_reason_id, notice_date, owner_name, notes, created_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(company.id, caseNo, type, e.id, e.employee_no ?? null, e.full_name_ar, e.department ?? null, e.job_title ?? null, e.nationality_ar || e.nationality_en || null, nat,
          keyDate, projectId, type === 'offboarding' ? reasonId : null, type === 'offboarding' ? notice : null, str(input.owner_name, 200) ?? null, str(input.notes, 2000) ?? null, userId ?? null);
      const caseId = Number(r.lastInsertRowid);
      const steps = db.prepare('SELECT * FROM proc_checklist_steps WHERE company_id = ? AND case_type = ? AND is_active = 1 ORDER BY sort, id').all(company.id, type);
      const ins = db.prepare(`INSERT INTO proc_case_steps (company_id, case_id, checklist_step_id, name_ar, sort, applies_to, letter_type_id, na_reason_list, date_label, reference_label,
                                status, na_reason, auto_na, due_date, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      let autoNa = 0;
      for (const s of steps) {
        const notFor = s.applies_to !== 'all' && nat !== 'unknown' && s.applies_to !== nat;
        if (notFor) autoNa++;
        ins.run(company.id, caseId, s.id, s.name_ar, s.sort, s.applies_to, s.letter_type_id, s.na_reason_list, s.date_label, s.reference_label,
          notFor ? 'na' : 'pending', notFor ? `لا ينطبق حسب الجنسية — الموظف ${NAT_LABEL[nat]} (الإجراء ${APPLIES_TO[s.applies_to]})` : null, notFor ? 1 : 0,
          s.deadline_days === null || s.deadline_days === undefined ? null : addDays(keyDate, s.deadline_days), userId ?? null);
      }
      const c = loadCase(company.id, caseId);
      log(company.id, c, null, 'case_opened', `${CASE_TYPES[type]} — ${e.full_name_ar} — ${keyLabel} ${keyDate} — ${steps.length} إجراء${autoNa ? `، ${autoNa} لا ينطبق حسب الجنسية` : ''}${dups.length ? ' — فُتحت رغم وجود حالة سابقة بعد التأكيد' : ''}`, null, userId);
      return getCase(company, caseId);
    });
  }

  // ---------- new onboarding: pick an existing employee or create one ----------
  // Arabic-aware name comparison (alef forms, ya/alef maqsura, ta marbuta, tatweel, spaces).
  const normName = (s) => String(s || '').replace(/[ـً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  const normId = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

  // Employees of the current company that look like the one being entered.
  // All statuses are searched: onboarding, active and ended employees.
  function employeeMatch(company, q = {}) {
    const rows = db.prepare('SELECT id, employee_no, full_name_ar, full_name_en, national_id, department, hire_date, status FROM employees WHERE company_id = ?').all(company.id);
    const no = normEmployeeNo(q.employee_no), nid = normId(q.national_id), name = normName(q.full_name_ar);
    const openOnb = db.prepare("SELECT id, case_no FROM proc_cases WHERE company_id = ? AND employee_id = ? AND case_type = 'onboarding' AND status = 'open'");
    return rows.map((e) => {
      const by = [];
      if (no && normEmployeeNo(e.employee_no) === no) by.push('employee_no');
      if (nid && normId(e.national_id) === nid) by.push('national_id');
      if (name && normName(e.full_name_ar) === name) by.push('name');
      return by.length ? { id: e.id, employee_no: e.employee_no, full_name_ar: e.full_name_ar, department: e.department, hire_date: e.hire_date,
        status: e.status, status_label: EMPLOYEE_STATUS[e.status] ?? e.status, matched_by: by, open_onboarding: openOnb.get(company.id, e.id) || null } : null;
    }).filter(Boolean);
  }

  // Creates the directory record and opens its onboarding case in ONE transaction:
  // if anything fails, neither the employee nor the case is saved.
  function createOnboardingWithEmployee(company, tenant, input, userId) {
    input = input || {};
    const emp = input.employee || {};
    const cs = input.case || {};
    if (!str(emp.full_name_ar, 200)) throw new HttpError(400, 'اسم الموظف بالعربية مطلوب.');
    const hire = date(emp.hire_date, 'تاريخ المباشرة', { required: true });
    const matches = employeeMatch(company, emp);
    // the employee number is checked first, against every status (no duplicate record is saved)
    assertEmployeeNoFree(db, company.id, emp.employee_no);
    const hard = matches.find((m) => m.matched_by.includes('national_id'));
    if (hard) {
      throw new HttpError(409, `يوجد موظف بنفس رقم الهوية / الإقامة في دليل ${company.name_ar}: ${hard.full_name_ar}${hard.employee_no ? ` (${hard.employee_no})` : ''} — ${hard.status_label}. اختره من «موظف موجود» بدل إنشاء سجل جديد.`, 'employee_exists',
        { employee_id: hard.id, full_name_ar: hard.full_name_ar, employee_no: hard.employee_no, status: hard.status, status_label: hard.status_label });
    }
    if (matches.length && input.confirm_new_employee !== true) {
      throw new HttpError(409, `يوجد في دليل ${company.name_ar} موظف بالاسم نفسه: ${matches.map((m) => `${m.full_name_ar}${m.employee_no ? ` (${m.employee_no})` : ''}`).join('، ')}. اختره إن كان هو، أو أكّد أنه موظف مختلف.`, 'possible_duplicate');
    }
    const allowed = ['employee_no', 'full_name_ar', 'full_name_en', 'gender', 'national_id', 'nationality_ar', 'nationality_en', 'job_title', 'job_title_en', 'department'];
    const record = Object.fromEntries(allowed.filter((k) => emp[k] !== undefined).map((k) => [k, emp[k]]));
    return tx(db, () => {
      // «قيد الانضمام» until operations confirm the start (an Excel import never activates anyone)
      const e = tenant.create('employees', { ...record, hire_date: hire, status: 'onboarding' }, userId,
        { event: 'created', detail: 'أُضيف من متابعة الإجراءات (التوظيف) بحالة «قيد الانضمام»' }); // same validation as the employee directory
      const c = createCase(company, tenant, { ...cs, case_type: 'onboarding', employee_id: e.id, key_date: hire, confirm_duplicate: false }, userId);
      log(company.id, c, null, 'employee_created', `أُنشئ سجل ${e.full_name_ar} في دليل الموظفين من شاشة المباشرة — قيد الانضمام${e.employee_no ? '' : ' (بدون رقم وظيفي حتى الآن)'}`, null, userId);
      return getCase(company, c.id);
    });
  }

  function updateCase(company, id, input, userId) {
    input = input || {};
    return tx(db, () => {
      const c = loadCase(company.id, id);
      assertOpen(c);
      const set = {};
      if (input.key_date !== undefined) set.key_date = date(input.key_date, c.case_type === 'onboarding' ? 'تاريخ المباشرة' : 'آخر يوم عمل', { required: true });
      if (input.project_id !== undefined) set.project_id = listItem(company.id, input.project_id, 'project', 'المشروع');
      if (c.case_type === 'offboarding') {
        if (input.offboarding_reason_id !== undefined) set.offboarding_reason_id = listItem(company.id, input.offboarding_reason_id, 'offboarding_reason', 'سبب الخروج');
        if (input.notice_date !== undefined) set.notice_date = date(input.notice_date, 'تاريخ الإشعار');
      }
      for (const [k, max] of [['owner_name', 200], ['notes', 2000]]) if (input[k] !== undefined) set[k] = str(input[k], max) ?? null;
      const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => (c[k] ?? null) !== (v ?? null)).map(([k, v]) => [k, [c[k] ?? null, v ?? null]]));
      if (!Object.keys(changes).length) return getCase(company, c.id);
      db.prepare(`UPDATE proc_cases SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(...Object.values(set).map((v) => v ?? null), company.id, c.id);
      log(company.id, c, null, 'case_updated', null, changes, userId);
      return getCase(company, c.id);
    });
  }

  // ---------- steps ----------
  function updateStep(company, stepId, input, userId) {
    input = input || {};
    return tx(db, () => {
      const s = loadStep(company.id, stepId);
      const c = loadCase(company.id, s.case_id);
      assertOpen(c);
      const set = {};
      const today = riyadhToday();
      if (input.party_id !== undefined) set.party_id = listItem(company.id, input.party_id, 'party', 'الجهة المسؤولة');
      if (input.owner_member_id !== undefined) set.owner_member_id = memberItem(company.id, input.owner_member_id);
      for (const [k, max] of [['assignee_name', 200], ['reference', 500], ['notes', 2000]]) if (input[k] !== undefined) set[k] = str(input[k], max) ?? null;
      if (input.due_date !== undefined) set.due_date = date(input.due_date, 'المهلة');
      if (input.completed_on !== undefined) set.completed_on = date(input.completed_on, s.date_label || 'تاريخ الإنجاز');
      const reason = str(input.reason, 500);
      if (input.status !== undefined && input.status !== s.status) {
        if (!STEP_STATUS[input.status]) throw new HttpError(400, 'حالة الإجراء غير صالحة.');
        if (s.status === 'na' && !reason) {
          throw new HttpError(400, s.auto_na ? 'هذا الإجراء محدد «لا ينطبق» حسب الجنسية؛ اذكر سبب تغييره.' : 'اذكر سبب تغيير الإجراء من «لا ينطبق».', 'reason_required');
        }
        set.status = input.status;
        if (input.status === 'na') {
          const reasonId = s.na_reason_list ? listItem(company.id, input.na_reason_id, s.na_reason_list, 'سبب عدم الإضافة') : null;
          const text = str(input.na_reason, 500) ?? null;
          if (s.na_reason_list && !reasonId) throw new HttpError(400, 'اختر سبب عدم الإضافة من القائمة.', 'reason_required');
          if (!s.na_reason_list && !text) throw new HttpError(400, 'اذكر سبب «لا ينطبق».', 'reason_required');
          Object.assign(set, { na_reason: text, na_reason_id: reasonId, auto_na: 0, completed_on: null });
        } else {
          Object.assign(set, { na_reason: null, na_reason_id: null, auto_na: 0 });
          if (input.status === 'done') set.completed_on = set.completed_on ?? s.completed_on ?? today;
          else if (set.completed_on === undefined) set.completed_on = null;
        }
      } else if (s.status === 'na' && (input.na_reason !== undefined || input.na_reason_id !== undefined)) {
        if (s.na_reason_list) set.na_reason_id = listItem(company.id, input.na_reason_id, s.na_reason_list, 'سبب عدم الإضافة') ?? s.na_reason_id;
        if (input.na_reason !== undefined) set.na_reason = str(input.na_reason, 500) ?? null;
      }
      if (set.completed_on && set.completed_on > today) throw new HttpError(400, 'تاريخ الإنجاز لا يمكن أن يكون في المستقبل.');
      const changes = Object.fromEntries(Object.entries(set).filter(([k, v]) => (s[k] ?? null) !== (v ?? null)).map(([k, v]) => [k, [s[k] ?? null, v ?? null]]));
      delete changes.auto_na;
      if (!Object.keys(changes).length) return getCase(company, c.id);
      db.prepare(`UPDATE proc_case_steps SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, updated_by = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(...Object.values(set).map((v) => v ?? null), userId ?? null, company.id, s.id);
      db.prepare("UPDATE proc_cases SET updated_at = datetime('now') WHERE company_id = ? AND id = ?").run(company.id, c.id);
      const statusText = set.status ? `${STEP_STATUS[s.status]} ← ${STEP_STATUS[set.status]}` : null;
      log(company.id, c, s, 'step_updated', [s.name_ar, statusText, reason ? `السبب: ${reason}` : null].filter(Boolean).join(' — '), changes, userId);
      return getCase(company, c.id);
    });
  }

  function addStep(company, caseId, input, userId) {
    input = input || {};
    return tx(db, () => {
      const c = loadCase(company.id, caseId);
      assertOpen(c);
      const name = str(input.name_ar, 200);
      if (!name) throw new HttpError(400, 'اسم الإجراء مطلوب.');
      const sort = (db.prepare('SELECT MAX(sort) m FROM proc_case_steps WHERE company_id = ? AND case_id = ?').get(company.id, c.id).m || 0) + 10;
      const r = db.prepare('INSERT INTO proc_case_steps (company_id, case_id, name_ar, sort, due_date, owner_member_id, party_id, assignee_name, notes, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(company.id, c.id, name, sort, date(input.due_date, 'المهلة') ?? null, memberItem(company.id, input.owner_member_id) ?? null, listItem(company.id, input.party_id, 'party', 'الجهة المسؤولة') ?? null,
          str(input.assignee_name, 200) ?? null, str(input.notes, 2000) ?? null, userId ?? null);
      log(company.id, c, { id: Number(r.lastInsertRowid) }, 'step_added', `${name} (لهذه الحالة فقط)`, null, userId);
      return getCase(company, c.id);
    });
  }

  // Only steps added to the case itself can be removed; checklist steps are marked "not applicable" instead.
  function removeStep(company, stepId, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الحذف مطلوب.');
    return tx(db, () => {
      const s = loadStep(company.id, stepId);
      const c = loadCase(company.id, s.case_id);
      assertOpen(c);
      if (s.checklist_step_id) throw new HttpError(409, 'هذا الإجراء من قائمة الشركة؛ لا يُحذف من الحالة، بل يُحدد «لا ينطبق» مع السبب.');
      db.prepare('DELETE FROM proc_case_steps WHERE company_id = ? AND id = ?').run(company.id, s.id);
      log(company.id, c, s, 'step_removed', `${s.name_ar} — ${reason}`, { snapshot: s }, userId);
      return getCase(company, c.id);
    });
  }

  // Links a letter issued from the letters centre to the step. The step status is not changed.
  function linkLetter(company, stepId, input, userId) {
    return tx(db, () => {
      const s = loadStep(company.id, stepId);
      const c = loadCase(company.id, s.case_id);
      assertOpen(c);
      if (!s.letter_type_id) throw new HttpError(400, 'هذا الإجراء غير مرتبط بنوع خطاب.');
      if (input?.issued_letter_id === null) {
        const reason = str(input.reason, 500);
        if (!reason) throw new HttpError(400, 'سبب إلغاء الربط مطلوب.');
        db.prepare("UPDATE proc_case_steps SET issued_letter_id = NULL, updated_by = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?").run(userId ?? null, company.id, s.id);
        log(company.id, c, s, 'letter_unlinked', `${s.name_ar} — ${reason}`, null, userId);
        return getCase(company, c.id);
      }
      const l = db.prepare('SELECT * FROM issued_letters WHERE company_id = ? AND id = ?').get(company.id, Number(input?.issued_letter_id));
      if (!l) throw new HttpError(404, 'الخطاب غير موجود في سجل خطابات الشركة الحالية.');
      if (l.employee_id !== c.employee_id || l.letter_type_id !== s.letter_type_id) throw new HttpError(400, 'الخطاب ليس من نوع هذا الإجراء أو ليس لهذا الموظف.');
      db.prepare("UPDATE proc_case_steps SET issued_letter_id = ?, reference = COALESCE(reference, ?), updated_by = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?")
        .run(l.id, l.reference_no, userId ?? null, company.id, s.id);
      log(company.id, c, s, 'letter_linked', `${s.name_ar} — ${l.reference_no}`, null, userId);
      return getCase(company, c.id);
    });
  }

  // ---------- case lifecycle ----------
  function closeCase(company, id, input, userId) {
    input = input || {};
    if (input.confirmed !== true) throw new HttpError(400, 'يجب تأكيد مراجعة الإجراءات قبل إغلاق الحالة.', 'confirmation_required');
    return tx(db, () => {
      const c = loadCase(company.id, id);
      assertOpen(c);
      const open = db.prepare("SELECT name_ar FROM proc_case_steps WHERE company_id = ? AND case_id = ? AND status IN ('pending', 'in_progress') ORDER BY sort").all(company.id, c.id);
      if (open.length) throw new HttpError(409, `لا يمكن الإغلاق: ${open.length} إجراء لم يكتمل (${open.map((s) => s.name_ar).join('، ')}). حدّث كلًا منها إلى «مكتمل» أو «لا ينطبق» مع السبب.`, 'steps_pending');
      const closedOn = date(input.closed_on, 'تاريخ الإغلاق') || riyadhToday();
      if (closedOn > riyadhToday()) throw new HttpError(400, 'تاريخ الإغلاق لا يمكن أن يكون في المستقبل.');
      db.prepare(`UPDATE proc_cases SET status = 'closed', closed_on = ?, closed_by = ?, close_note = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(closedOn, userId ?? null, str(input.note, 1000) ?? null, company.id, c.id);
      log(company.id, c, null, 'case_closed', `${closedOn}${input.note ? ' — ' + str(input.note, 1000) : ''}`, null, userId);
      return getCase(company, c.id);
    });
  }

  function cancelCase(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الإلغاء مطلوب.');
    return tx(db, () => {
      const c = loadCase(company.id, id);
      assertOpen(c);
      db.prepare("UPDATE proc_cases SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?").run(reason, company.id, c.id);
      log(company.id, c, null, 'case_cancelled', reason, null, userId);
      return getCase(company, c.id);
    });
  }

  // Admin only (route).
  function reopenCase(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب إعادة الفتح مطلوب.');
    return tx(db, () => {
      const c = loadCase(company.id, id);
      if (c.status === 'open') throw new HttpError(409, 'الحالة مفتوحة بالفعل.');
      db.prepare("UPDATE proc_cases SET status = 'open', closed_on = NULL, closed_by = NULL, close_note = NULL, cancel_reason = NULL, updated_at = datetime('now') WHERE company_id = ? AND id = ?")
        .run(company.id, c.id);
      log(company.id, c, null, 'case_reopened', `${CASE_STATUS[c.status]}${c.closed_on ? ` (${c.closed_on})` : ''} — ${reason}`, null, userId);
      return getCase(company, c.id);
    });
  }

  // Admin only (route). The full case is kept in the change log.
  function deleteCase(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب الحذف مطلوب.');
    return tx(db, () => {
      const c = loadCase(company.id, id);
      const steps = db.prepare('SELECT * FROM proc_case_steps WHERE company_id = ? AND case_id = ?').all(company.id, c.id);
      log(company.id, c, null, 'case_deleted', reason, { snapshot: { case: c, steps } }, userId);
      db.prepare('DELETE FROM proc_case_steps WHERE company_id = ? AND case_id = ?').run(company.id, c.id);
      db.prepare('DELETE FROM proc_cases WHERE company_id = ? AND id = ?').run(company.id, c.id);
      return { ok: true };
    });
  }

  // ---------- follow-up ----------
  // Outstanding steps across open cases (the team's work list; also what Maha will read later).
  function outstanding(company, f = {}) {
    ensureDefaults(company);
    const today = riyadhToday();
    const where = ["c.company_id = ?", "c.status = 'open'", "s.status IN ('pending', 'in_progress')"];
    const p = [company.id];
    if (f.case_type && CASE_TYPES[f.case_type]) { where.push('c.case_type = ?'); p.push(f.case_type); }
    if (f.case_id) { where.push('c.id = ?'); p.push(Number(f.case_id)); }
    if (f.owner_member_id === 'none') where.push('s.owner_member_id IS NULL');
    else if (f.owner_member_id) { where.push('s.owner_member_id = ?'); p.push(Number(f.owner_member_id)); }
    if (f.party_id === 'none') where.push('s.party_id IS NULL');
    else if (f.party_id) { where.push('s.party_id = ?'); p.push(Number(f.party_id)); }
    let rows = db.prepare(`SELECT s.id, s.case_id, s.name_ar, s.status, s.due_date, s.party_id, s.owner_member_id, m.name AS owner_name, s.assignee_name, s.notes, s.letter_type_id, p.label AS party_label,
                             c.case_no, c.case_type, c.employee_id, c.employee_name, c.employee_no, c.department, c.key_date
                           FROM proc_case_steps s JOIN proc_cases c ON c.company_id = s.company_id AND c.id = s.case_id
                           LEFT JOIN proc_lists p ON p.company_id = s.company_id AND p.id = s.party_id
                           LEFT JOIN proc_team_members m ON m.company_id = s.company_id AND m.id = s.owner_member_id
                           WHERE ${where.join(' AND ')} ORDER BY (s.due_date IS NULL), s.due_date, c.key_date, s.sort`).all(...p)
      .map((r) => ({ ...r, overdue: !!r.due_date && r.due_date < today }));
    if (f.overdue === '1') rows = rows.filter((r) => r.overdue);
    return rows;
  }

  function summary(company) {
    const today = riyadhToday();
    const soon = addDays(today, 14);
    const all = listCases(company, {});
    const open = all.filter((c) => c.status === 'open');
    const out = outstanding(company);
    const byParty = Object.values(out.reduce((m, s) => {
      const k = s.party_id ?? 'none';
      m[k] ||= { party_id: s.party_id, label: s.party_label || 'بدون جهة محددة', pending: 0, overdue: 0 };
      m[k].pending++; if (s.overdue) m[k].overdue++;
      return m;
    }, {})).sort((a, b) => b.pending - a.pending);
    const byOwner = Object.values(out.reduce((m, s) => {
      const k = s.owner_member_id ?? 'none';
      m[k] ||= { owner_member_id: s.owner_member_id, label: s.owner_name || 'بدون مسؤول', pending: 0, overdue: 0 };
      m[k].pending++; if (s.overdue) m[k].overdue++;
      return m;
    }, {})).sort((a, b) => b.pending - a.pending);
    const light = (c) => ({ id: c.id, case_no: c.case_no, case_type: c.case_type, employee_name: c.employee_name, department: c.department, key_date: c.key_date,
      status: c.status, progress: c.progress, overdue: c.overdue, overdue_steps: c.overdue_steps, closed_on: c.closed_on, pending_steps: c.pending_steps });
    const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, c) => s + c.progress.percent, 0) / arr.length) : null);
    return {
      today,
      open: { total: open.length, onboarding: open.filter((c) => c.case_type === 'onboarding').length, offboarding: open.filter((c) => c.case_type === 'offboarding').length },
      overdue_cases: open.filter((c) => c.overdue).map(light),
      overdue_steps: out.filter((s) => s.overdue).length,
      pending_steps: out.length,
      average_progress: { all: avg(open), onboarding: avg(open.filter((c) => c.case_type === 'onboarding')), offboarding: avg(open.filter((c) => c.case_type === 'offboarding')) },
      by_party: byParty,
      by_owner: byOwner,
      upcoming: open.filter((c) => c.key_date >= today && c.key_date <= soon).sort((a, b) => (a.key_date < b.key_date ? -1 : 1)).map(light),
      open_cases: open.sort((a, b) => a.progress.percent - b.progress.percent).map(light),
      recently_closed: all.filter((c) => c.status === 'closed' && c.closed_on >= addDays(today, -30)).map(light),
      unknown_nationality: open.filter((c) => c.nationality_class === 'unknown').map(light),
    };
  }

  function events(company, { case_id = null, limit = 300 } = {}) {
    const f = case_id ? ' AND ev.case_id = ?' : '';
    const p = case_id ? [company.id, Number(case_id)] : [company.id];
    return db.prepare(`SELECT ev.*, u.display_name AS user_name FROM proc_events ev LEFT JOIN users u ON u.id = ev.user_id
                       WHERE ev.company_id = ?${f} ORDER BY ev.id DESC LIMIT ?`).all(...p, Math.min(Number(limit) || 300, 2000));
  }

  // Documents Maha (or the team) can prepare now: letter steps still open whose official template is uploaded.
  function documentsReady(company, caseId) {
    const c = getCase(company, caseId);
    return c.steps.filter((s) => s.letter_type_id && s.status !== 'done' && s.status !== 'na' && !s.issued_letter_id)
      .map((s) => ({ step_id: s.id, step: s.name_ar, letter_type_id: s.letter_type_id, letter_type: s.letter_type_name, template_available: c.letters[s.letter_type_id]?.template_available ?? false }));
  }

  function exportXlsx(company, f = {}) {
    const cases = listCases(company, { ...f, light: false });
    const today = riyadhToday();
    const caseSheet = {
      name: 'الحالات', title: `متابعة إجراءات الموظفين — ${company.name_ar} — ${today}`,
      columns: [
        { header: 'رقم الحالة', width: 20 }, { header: 'النوع', width: 18 }, { header: 'الرقم الوظيفي', width: 14 }, { header: 'الموظف', width: 30 },
        { header: 'الإدارة', width: 20 }, { header: 'المشروع', width: 20 }, { header: 'التاريخ (مباشرة / آخر يوم عمل)', width: 16 }, { header: 'سبب الخروج', width: 14 },
        { header: 'الحالة', width: 10 }, { header: 'نسبة الإنجاز %', type: 'int', width: 10 }, { header: 'مكتمل', type: 'int', width: 8 },
        { header: 'معلّق', type: 'int', width: 8 }, { header: 'لا ينطبق', type: 'int', width: 8 }, { header: 'متأخر', type: 'int', width: 8 },
        { header: 'تاريخ الإغلاق', width: 14 }, { header: 'الإجراءات المعلقة', width: 60 },
      ],
      rows: cases.map((c) => [c.case_no, CASE_TYPES[c.case_type], c.employee_no, c.employee_name, c.department, c.project_label, c.key_date, c.offboarding_reason_label,
        CASE_STATUS[c.status], c.progress.percent, c.progress.done, c.progress.pending, c.progress.na, c.overdue_steps, c.closed_on,
        c.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').map((s) => s.name_ar).join('، ')]),
    };
    const stepSheet = {
      name: 'الإجراءات', title: `تفاصيل الإجراءات — ${company.name_ar}`,
      columns: [
        { header: 'رقم الحالة', width: 20 }, { header: 'الموظف', width: 30 }, { header: 'الإجراء', width: 28 }, { header: 'الحالة', width: 12 },
        { header: 'المسؤول من الفريق', width: 18 }, { header: 'الجهة المسؤولة', width: 18 }, { header: 'المنفذ', width: 18 }, { header: 'المهلة', width: 12 }, { header: 'متأخر', width: 8 },
        { header: 'تاريخ الإنجاز', width: 12 }, { header: 'سبب لا ينطبق', width: 30 }, { header: 'المرجع', width: 18 }, { header: 'ملاحظات', width: 40 },
      ],
      rows: cases.flatMap((c) => c.steps.map((s) => [c.case_no, c.employee_name, s.name_ar, STEP_STATUS[s.status], s.owner_name, s.party_label, s.assignee_name, s.due_date,
        s.overdue ? 'نعم' : '', s.completed_on, s.na_reason_label || s.na_reason, s.letter_reference || s.reference, s.notes])),
    };
    return buildXlsx([caseSheet, stepSheet]);
  }

  // ---------- explicit status confirmations from a case (never automatic) ----------
  // «تأكيد المباشرة»: onboarding → active, with the actual start date.
  function confirmStart(company, tenant, id, input, userId) {
    input = input || {};
    if (input.confirmed !== true) throw new HttpError(400, 'أكّد أن الموظف باشر العمل فعليًا.', 'confirmation_required');
    return tx(db, () => {
      const c = loadCase(company.id, id);
      if (c.case_type !== 'onboarding') throw new HttpError(400, 'تأكيد المباشرة من حالة مباشرة فقط.');
      const e = tenant.get('employees', c.employee_id);
      if (e.status !== 'onboarding') throw new HttpError(409, `حالة الموظف في الدليل «${EMPLOYEE_STATUS[e.status] ?? e.status}» وليست «قيد الانضمام».`, 'not_onboarding');
      const start = date(input.start_date ?? c.key_date, 'تاريخ المباشرة الفعلي', { required: true });
      tenant.update('employees', e.id, { status: 'active', hire_date: start }, userId, { event: 'start_confirmed', detail: `تأكيد المباشرة من الحالة ${c.case_no} — ${start}` });
      log(company.id, c, null, 'employee_started', `تأكيد المباشرة: ${e.full_name_ar} — «قيد الانضمام» ← «نشط» — تاريخ المباشرة ${start}`, null, userId);
      return getCase(company, c.id);
    });
  }

  // «تأكيد انتهاء الخدمة»: active → ended, with the last working day.
  function confirmEnd(company, tenant, id, input, userId) {
    input = input || {};
    if (input.confirmed !== true) throw new HttpError(400, 'أكّد انتهاء خدمة الموظف فعليًا.', 'confirmation_required');
    return tx(db, () => {
      const c = loadCase(company.id, id);
      if (c.case_type !== 'offboarding') throw new HttpError(400, 'تأكيد انتهاء الخدمة من حالة خروج فقط.');
      const e = tenant.get('employees', c.employee_id);
      if (e.status !== 'active') throw new HttpError(409, `حالة الموظف في الدليل «${EMPLOYEE_STATUS[e.status] ?? e.status}» وليست «نشط».`, 'not_active');
      const end = date(input.end_date ?? c.key_date, 'آخر يوم عمل', { required: true });
      tenant.update('employees', e.id, { status: 'inactive', end_date: end }, userId, { event: 'end_confirmed', detail: `تأكيد انتهاء الخدمة من الحالة ${c.case_no} — ${end}` });
      log(company.id, c, null, 'employee_ended', `تأكيد انتهاء الخدمة: ${e.full_name_ar} — «نشط» ← «منتهي الخدمة» — آخر يوم عمل ${end}`, null, userId);
      return getCase(company, c.id);
    });
  }

  // Adds the employee number once it is assigned (checked against every status).
  function setEmployeeNo(company, tenant, id, input, userId) {
    return tx(db, () => {
      const c = loadCase(company.id, id);
      const e = tenant.get('employees', c.employee_id);
      if (e.employee_no) throw new HttpError(409, `للموظف رقم وظيفي (${e.employee_no}). يُعدَّل من سجلات الموظفين.`, 'has_number');
      const no = normEmployeeNo(input?.employee_no);
      if (!no) throw new HttpError(400, 'أدخل الرقم الوظيفي.');
      tenant.update('employees', e.id, { employee_no: no }, userId, { event: 'number_assigned', detail: `إضافة الرقم الوظيفي من الحالة ${c.case_no}` });
      log(company.id, c, null, 'employee_no_assigned', `الرقم الوظيفي ${no} — ${e.full_name_ar}`, null, userId);
      return getCase(company, c.id);
    });
  }

  return {
    confirmStart, confirmEnd, setEmployeeNo,
    ensureDefaults, lists, addListItem, updateListItem, addMember, updateMember, employeeMatch, createOnboardingWithEmployee, checklist, saveChecklistStep,
    listCases, getCase, createCase, updateCase, updateStep, addStep, removeStep, linkLetter,
    closeCase, cancelCase, reopenCase, deleteCase, outstanding, summary, events, documentsReady, exportXlsx,
    meta: () => ({ case_types: CASE_TYPES, case_status: CASE_STATUS, step_status: STEP_STATUS, applies_to: APPLIES_TO, lists: LISTS }),
  };
}
