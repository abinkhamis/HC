// Consulting contracts: consultants → contracts → deliverables → completion
// certificates → payments. Every function takes the session company and never
// trusts a company id from the caller, so the same service can be called from
// the web UI or, later, from an integration (e.g. Maha) without changes.
import { HttpError, mapDbError } from './errors.js';
import { readFile, saveFile } from './files.js';
import { renderDocx } from './docx/merge.js';
import { tx } from './db.js';
import { IMAGE_PLACEHOLDERS, fmtNum, fmtDate, todayParts, putDate } from './letters.js';
import { fillXlsx } from './xlsx-fill.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const ROW_PREFIX = 'd_';
export const DOC_CONTRACT = 'consulting_contract';
export const DOC_CERTIFICATE = 'completion_certificate';
export const DOC_PAYMENT_REQUEST = 'consultant_payment_request';
export const CERT_APPROVERS = 3;
export const MAX_REQUEST_APPROVERS = 5;
export const MAX_REQUEST_ITEMS = 10;
export const REQ_STATUS = { draft: 'مسودة', issued: 'صدر الطلب', sent: 'أُرسل للمالية', cancelled: 'ملغى' };

export const CONTRACT_STATUS = {
  draft: 'مسودة',
  sent: 'أُرسل للتوقيع',
  active: 'موقّع وساري',
  terminated: 'منهى',
  closed: 'مغلق',
};

// ---------- placeholder catalogues (what an official template may contain) ----------
const T = (key, label, group, extra = {}) => ({ key, label, group, ...extra });
const CONSULTANT_KEYS = [
  T('consultant_name_ar', 'اسم الاستشاري (عربي)', 'الاستشاري'),
  T('consultant_name_en', 'اسم الاستشاري (إنجليزي)', 'الاستشاري'),
  T('consultant_title_ar', 'المكرم / المكرمة', 'الاستشاري'),
  T('consultant_nationality_ar', 'الجنسية (عربي)', 'الاستشاري'),
  T('consultant_nationality_en', 'الجنسية (إنجليزي)', 'الاستشاري'),
  T('consultant_id_number', 'رقم الهوية / الإقامة', 'الاستشاري'),
  T('consultant_mobile', 'رقم الجوال', 'الاستشاري'),
  T('consultant_email', 'البريد الإلكتروني', 'الاستشاري'),
  T('consultant_bank_beneficiary', 'اسم المستفيد', 'الحساب البنكي'),
  T('consultant_bank_name', 'اسم البنك', 'الحساب البنكي'),
  T('consultant_iban', 'رقم الآيبان', 'الحساب البنكي'),
  T('consultant_swift', 'رمز السويفت', 'الحساب البنكي'),
];
const CONTRACT_KEYS = [
  T('contract_ref', 'رقم العقد', 'العقد'),
  T('contract_date', 'تاريخ العقد (ميلادي)', 'العقد', { date: true }),
  T('contract_date_hijri', 'تاريخ العقد (هجري)', 'العقد', { date: true }),
  T('project_name', 'اسم المشروع', 'العقد'),
  T('contract_scope', 'نطاق العمل', 'العقد'),
  T('department', 'الإدارة الطالبة', 'العقد'),
  T('supervisor_name', 'المدير المسؤول', 'العقد'),
  T('start_date', 'تاريخ البداية', 'العقد', { date: true }),
  T('end_date', 'تاريخ النهاية', 'العقد', { date: true }),
  T('duration_text', 'مدة العقد (نص)', 'العقد'),
  T('contract_total', 'إجمالي قيمة العقد', 'العقد'),
  T('deliverables_count', 'عدد المخرجات', 'العقد'),
];
const COMMON_KEYS = [
  T('date_gregorian', 'تاريخ الإصدار (ميلادي)', 'الإصدار', { date: true }),
  T('date_hijri', 'تاريخ الإصدار (هجري — أم القرى)', 'الإصدار', { date: true }),
  T('company_name_ar', 'اسم الشركة (عربي)', 'الشركة'),
  T('company_name_en', 'اسم الشركة (إنجليزي)', 'الشركة'),
  T('signatory_name', 'اسم صاحب التوقيع', 'التوقيع'),
  T('signatory_title', 'مسمى صاحب التوقيع', 'التوقيع'),
];
const ROW_KEYS = [
  T('d_no', 'رقم المخرج', 'صف المخرجات (يتكرر لكل مخرج)', { row: true }),
  T('d_title', 'وصف المخرج', 'صف المخرجات (يتكرر لكل مخرج)', { row: true }),
  T('d_amount', 'قيمة المخرج', 'صف المخرجات (يتكرر لكل مخرج)', { row: true }),
  T('d_due_date', 'تاريخ استحقاق المخرج', 'صف المخرجات (يتكرر لكل مخرج)', { row: true, date: true }),
  T('d_period_from', 'فترة التسليم — من', 'صف المخرجات (يتكرر لكل مخرج)', { row: true, date: true }),
  T('d_period_to', 'فترة التسليم — إلى', 'صف المخرجات (يتكرر لكل مخرج)', { row: true, date: true }),
];
const DELIVERABLE_KEYS = [
  T('certificate_ref', 'رقم شهادة الإنجاز', 'المخرج'),
  T('completion_date', 'تاريخ الإنجاز', 'المخرج', { date: true }),
  T('deliverable_no', 'رقم المخرج', 'المخرج'),
  T('deliverable_title', 'وصف المخرج', 'المخرج'),
  T('deliverable_amount', 'قيمة المخرج', 'المخرج'),
  T('certificate_total', 'إجمالي قيمة المخرجات المشمولة في الشهادة', 'المخرج'),
  T('deliverable_due_date', 'تاريخ الاستحقاق', 'المخرج', { date: true }),
  T('deliverable_period_from', 'فترة التسليم — من', 'المخرج', { date: true }),
  T('deliverable_period_to', 'فترة التسليم — إلى', 'المخرج', { date: true }),
];

const APPROVER_KEYS = (n) => Array.from({ length: n }, (_, i) => [
  T(`approver_${i + 1}_name`, `اسم المعتمد ${i + 1}`, 'المعتمدون'),
  T(`approver_${i + 1}_title`, `المسمى الوظيفي للمعتمد ${i + 1}`, 'المعتمدون'),
]).flat();
const REQUEST_KEYS = [
  T('request_no', 'رقم طلب الدفعة', 'طلب الدفعة'),
  T('request_date', 'تاريخ طلب الدفعة', 'طلب الدفعة', { date: true }),
  T('request_amount', 'المبلغ المطلوب (رقم)', 'طلب الدفعة'),
  T('items_count', 'عدد المخرجات في الطلب', 'طلب الدفعة'),
  T('contract_paid', 'المصروف سابقًا من العقد (رقم)', 'طلب الدفعة'),
  T('contract_remaining', 'المتبقي من العقد قبل هذا الطلب (رقم)', 'طلب الدفعة'),
];
const ITEM_KEYS = Array.from({ length: 10 }, (_, i) => [
  T(`item_${i + 1}_no`, `رقم المخرج — السطر ${i + 1}`, 'مخرجات الطلب (سطر لكل مخرج)'),
  T(`item_${i + 1}_title`, `وصف المخرج — السطر ${i + 1}`, 'مخرجات الطلب (سطر لكل مخرج)'),
  T(`item_${i + 1}_amount`, `المبلغ المطلوب — السطر ${i + 1}`, 'مخرجات الطلب (سطر لكل مخرج)'),
  T(`item_${i + 1}_due_date`, `تاريخ الاستحقاق — السطر ${i + 1}`, 'مخرجات الطلب (سطر لكل مخرج)', { date: true }),
  T(`item_${i + 1}_completion_date`, `تاريخ الإنجاز — السطر ${i + 1}`, 'مخرجات الطلب (سطر لكل مخرج)', { date: true }),
  T(`item_${i + 1}_certificate_ref`, `رقم شهادة الإنجاز — السطر ${i + 1}`, 'مخرجات الطلب (سطر لكل مخرج)'),
]).flat();

export const CONTRACT_CATALOG = { text: [...CONTRACT_KEYS, ...CONSULTANT_KEYS, ...COMMON_KEYS, ...ROW_KEYS], images: IMAGE_PLACEHOLDERS, rowPrefix: ROW_PREFIX };
export const CERTIFICATE_CATALOG = { text: [...DELIVERABLE_KEYS, ...APPROVER_KEYS(3), ...CONTRACT_KEYS, ...CONSULTANT_KEYS, ...COMMON_KEYS], images: IMAGE_PLACEHOLDERS };
// Excel template (no images; amounts are written as numbers so the template's formulas work).
export const PAYMENT_REQUEST_CATALOG = { text: [...REQUEST_KEYS, ...ITEM_KEYS, ...APPROVER_KEYS(5), ...CONTRACT_KEYS, ...CONSULTANT_KEYS, ...COMMON_KEYS.filter((p) => !p.key.startsWith('signatory'))], images: [] };
export const CATALOG_BY_CATEGORY = { contract: CONTRACT_CATALOG, certificate: CERTIFICATE_CATALOG, payment_request: PAYMENT_REQUEST_CATALOG };

// ---------- validation helpers ----------
const str = (v, max = 2000) => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, 'قيمة طويلة جدًا.');
  return s || null;
};
const date = (v, label, { required = false } = {}) => {
  const s = str(v, 10);
  if (!s) { if (required) throw new HttpError(400, `«${label}» مطلوب.`); return s; }
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, `«${label}» تاريخ غير صالح.`);
  return s;
};
const money = (v, label, { required = false } = {}) => {
  if (v === undefined || v === null || v === '') { if (required) throw new HttpError(400, `«${label}» مطلوب.`); return null; }
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `«${label}» يجب أن يكون مبلغًا صحيحًا.`);
  return Math.round(n * 100) / 100;
};
const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const EPS = 0.005;
// Placeholders that may stay empty in an official document (approver titles are optional).
const OPTIONAL_KEY = /^approver_\d+_title(:|$)/;

export function createConsultingService(db, storageDir) {
  // actor stays 'user'; 'assistant' is reserved for Maha later (always with the confirming user).
  const event = (companyId, contractId, deliverableId, ev, detail, userId, requestId = null) =>
    db.prepare('INSERT INTO contract_events (company_id, contract_id, deliverable_id, event, detail, user_id, payment_request_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(companyId, contractId, deliverableId ?? null, ev, detail ?? null, userId ?? null, requestId);

  const nextRef = (company, table, column, kind) => {
    const year = todayParts().year;
    const prefix = `${company.code.toUpperCase()}/${kind}/${year}/`;
    const last = db.prepare(`SELECT ${column} AS r FROM ${table} WHERE company_id = ? AND ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`).get(company.id, `${prefix}%`);
    const n = last ? Number(String(last.r).slice(prefix.length)) + 1 : 1;
    return prefix + String(n).padStart(4, '0');
  };

  // ---------- derived state ----------
  function decorateDeliverable(d, today = riyadhToday(), days = 30) {
    const paid = Math.round((d.paid_total || 0) * 100) / 100;
    const remaining = Math.max(0, Math.round((d.amount - paid) * 100) / 100);
    const payment_status = remaining <= EPS ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
    const stage = d.certificate_sent_at ? 'certificate_sent' : d.certificate_issued_at ? 'certificate_issued' : d.completion_date ? 'completed' : 'in_progress';
    let due_state = null;
    if (payment_status !== 'paid') {
      if (d.due_date < today) due_state = 'overdue';
      else if (d.due_date <= addDays(today, days)) due_state = 'upcoming';
    }
    return { ...d, paid_total: paid, remaining, payment_status, stage, due_state };
  }

  function effectiveStatus(c, today = riyadhToday(), days = 30) {
    if (c.status === 'active' && c.end_date && c.end_date < today) return { effective_status: 'expired', ending_soon: false };
    const ending_soon = c.status === 'active' && !!c.end_date && c.end_date <= addDays(today, days);
    return { effective_status: c.status, ending_soon };
  }

  const deliverablesOf = (companyId, contractId) =>
    db.prepare('SELECT * FROM v_deliverables WHERE company_id = ? AND contract_id = ? ORDER BY seq, id').all(companyId, contractId).map((d) => decorateDeliverable(d));

  function loadContractRow(companyId, id) {
    const c = db.prepare('SELECT * FROM consulting_contracts WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!c) throw new HttpError(404, 'العقد غير موجود في الشركة الحالية.');
    return c;
  }
  function loadDeliverable(companyId, id) {
    const d = db.prepare('SELECT * FROM v_deliverables WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!d) throw new HttpError(404, 'المخرج غير موجود في الشركة الحالية.');
    return decorateDeliverable(d);
  }
  const consultantOf = (companyId, id) => {
    const k = db.prepare('SELECT * FROM consultants WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!k) throw new HttpError(400, 'الاستشاري غير موجود في الشركة الحالية.');
    return k;
  };

  // ---------- contracts ----------
  function listContracts(company, { status, q } = {}) {
    const params = [company.id];
    let where = 'c.company_id = ?';
    if (status && CONTRACT_STATUS[status]) { where += ' AND c.status = ?'; params.push(status); }
    if (q) { where += ' AND (c.contract_no LIKE ? OR k.full_name_ar LIKE ? OR c.project_name LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const rows = db.prepare(`
      SELECT c.id, c.contract_no, c.project_name, c.status, c.start_date, c.end_date, c.consultant_id, c.updated_at,
             k.full_name_ar AS consultant_name,
             COALESCE(SUM(d.amount), 0) AS total, COALESCE(SUM(d.paid_total), 0) AS paid, COUNT(d.id) AS deliverables,
             MIN(CASE WHEN d.amount - d.paid_total > ${EPS} THEN d.due_date END) AS next_due
      FROM consulting_contracts c
      JOIN consultants k ON k.company_id = c.company_id AND k.id = c.consultant_id
      LEFT JOIN v_deliverables d ON d.company_id = c.company_id AND d.contract_id = c.id
      WHERE ${where} GROUP BY c.id ORDER BY c.id DESC LIMIT 500`).all(...params);
    return rows.map((r) => ({ ...r, remaining: Math.max(0, Math.round((r.total - r.paid) * 100) / 100), ...effectiveStatus(r) }));
  }

  function getContract(company, id) {
    const c = loadContractRow(company.id, id);
    const consultant = consultantOf(company.id, c.consultant_id);
    // open_claim: requested in open payment requests and not yet paid through them
    const deliverables = deliverablesOf(company.id, c.id).map((d) => ({ ...d, open_claim: openClaim(company.id, d.id).amount }));
    const payments = db.prepare(`SELECT p.*, d.seq AS deliverable_seq, d.title AS deliverable_title, u.display_name AS recorded_by_name, v.display_name AS voided_by_name,
                                        (SELECT r.request_no FROM payment_request_payments rp JOIN payment_requests r ON r.company_id = rp.company_id AND r.id = rp.request_id
                                         WHERE rp.company_id = p.company_id AND rp.payment_id = p.id) AS request_no
                                 FROM deliverable_payments p
                                 JOIN contract_deliverables d ON d.company_id = p.company_id AND d.id = p.deliverable_id
                                 LEFT JOIN users u ON u.id = p.recorded_by LEFT JOIN users v ON v.id = p.voided_by
                                 WHERE p.company_id = ? AND d.contract_id = ? ORDER BY p.paid_at DESC, p.id DESC`).all(company.id, c.id);
    const events = db.prepare(`SELECT e.*, u.display_name AS user_name FROM contract_events e LEFT JOIN users u ON u.id = e.user_id
                               WHERE e.company_id = ? AND e.contract_id = ? ORDER BY e.id DESC LIMIT 100`).all(company.id, c.id);
    const total = deliverables.reduce((s, d) => s + d.amount, 0);
    const paid = deliverables.reduce((s, d) => s + d.paid_total, 0);
    return {
      ...c, ...effectiveStatus(c), consultant, deliverables, payments, events,
      total, paid, remaining: Math.max(0, Math.round((total - paid) * 100) / 100),
      has_generated: !!c.generated_file_id, has_signed: !!c.signed_file_id,
    };
  }

  function cleanContract(input, { partial = false } = {}) {
    const out = {
      consultant_id: input.consultant_id === undefined ? undefined : Number(input.consultant_id),
      contract_no: str(input.contract_no, 60),
      project_name: str(input.project_name, 300),
      scope: str(input.scope, 4000),
      department: str(input.department, 200),
      supervisor_name: str(input.supervisor_name, 200),
      contract_date: date(input.contract_date, 'تاريخ العقد'),
      start_date: date(input.start_date, 'تاريخ البداية'),
      end_date: date(input.end_date, 'تاريخ النهاية'),
      duration_text: str(input.duration_text, 100),
      notes: str(input.notes, 4000),
    };
    if (!partial && !Number.isSafeInteger(out.consultant_id)) throw new HttpError(400, 'اختر الاستشاري.');
    if (out.start_date && out.end_date && out.end_date < out.start_date) throw new HttpError(400, 'تاريخ النهاية يسبق تاريخ البداية.');
    return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
  }

  function cleanDeliverables(list) {
    if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'أضف مخرجًا واحدًا على الأقل.');
    if (list.length > 200) throw new HttpError(400, 'عدد المخرجات كبير جدًا.');
    return list.map((d, i) => {
      const n = i + 1;
      const row = {
        id: d.id ? Number(d.id) : null,
        title: str(d.title, 1000) ?? null,
        amount: money(d.amount, `قيمة المخرج ${n}`, { required: true }),
        due_date: date(d.due_date, `تاريخ استحقاق المخرج ${n}`, { required: true }),
        period_from: date(d.period_from, `بداية فترة المخرج ${n}`) ?? null,
        period_to: date(d.period_to, `نهاية فترة المخرج ${n}`) ?? null,
        notes: str(d.notes, 2000) ?? null,
      };
      if (!row.title) throw new HttpError(400, `وصف المخرج ${n} مطلوب.`);
      if (row.period_from && row.period_to && row.period_to < row.period_from) throw new HttpError(400, `فترة المخرج ${n}: النهاية تسبق البداية.`);
      return row;
    });
  }

  function createContract(company, input, userId) {
    const c = cleanContract(input || {});
    consultantOf(company.id, c.consultant_id);
    const items = cleanDeliverables(input.deliverables);
    try {
      return tx(db, () => {
        if (!c.contract_no) c.contract_no = nextRef(company, 'consulting_contracts', 'contract_no', 'CC');
        const keys = Object.keys(c);
        const r = db.prepare(`INSERT INTO consulting_contracts (company_id, created_by, ${keys.join(', ')}) VALUES (?, ?, ${keys.map(() => '?').join(', ')})`)
          .run(company.id, userId ?? null, ...keys.map((k) => c[k]));
        const id = Number(r.lastInsertRowid);
        items.forEach((d, i) => insertDeliverable(company.id, id, i + 1, d));
        event(company.id, id, null, 'created', `${items.length} مخرج`, userId);
        return getContract(company, id);
      });
    } catch (e) { throw mapDbError(e); }
  }

  function insertDeliverable(companyId, contractId, seq, d) {
    db.prepare(`INSERT INTO contract_deliverables (company_id, contract_id, seq, title, amount, due_date, period_from, period_to, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, contractId, seq, d.title, d.amount, d.due_date, d.period_from, d.period_to, d.notes);
  }

  function updateContract(company, id, input, userId) {
    const existing = loadContractRow(company.id, id);
    const c = cleanContract(input || {}, { partial: true });
    if (c.consultant_id !== undefined) consultantOf(company.id, c.consultant_id);
    const start = c.start_date !== undefined ? c.start_date : existing.start_date;
    const end = c.end_date !== undefined ? c.end_date : existing.end_date;
    if (start && end && end < start) throw new HttpError(400, 'تاريخ النهاية يسبق تاريخ البداية.');
    try {
      return tx(db, () => {
        const keys = Object.keys(c);
        if (keys.length) {
          db.prepare(`UPDATE consulting_contracts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
            .run(...keys.map((k) => c[k]), company.id, existing.id);
        }
        if (input.deliverables !== undefined) syncDeliverables(company, existing.id, cleanDeliverables(input.deliverables));
        event(company.id, existing.id, null, 'updated', null, userId);
        return getContract(company, existing.id);
      });
    } catch (e) { throw mapDbError(e); }
  }

  // Keeps deliverables that already have a certificate or payments safe.
  function syncDeliverables(company, contractId, items) {
    const current = deliverablesOf(company.id, contractId);
    const byId = new Map(current.map((d) => [d.id, d]));
    const keep = new Set(items.filter((d) => d.id).map((d) => d.id));
    for (const d of current) {
      if (keep.has(d.id)) continue;
      if (d.certificate_issued_at || d.paid_total > 0) throw new HttpError(409, `لا يمكن حذف المخرج «${d.title}» لأنه صدرت له شهادة أو سُجّلت له دفعة.`);
      db.prepare('DELETE FROM contract_deliverables WHERE company_id = ? AND id = ?').run(company.id, d.id);
    }
    items.forEach((d, i) => {
      if (d.id) {
        const old = byId.get(d.id);
        if (!old) throw new HttpError(400, 'مخرج غير تابع لهذا العقد.');
        if (d.amount + EPS < old.paid_total) throw new HttpError(409, `قيمة المخرج «${d.title}» أقل من المبلغ المدفوع له (${fmtNum(old.paid_total)}).`);
        db.prepare(`UPDATE contract_deliverables SET seq = ?, title = ?, amount = ?, due_date = ?, period_from = ?, period_to = ?, notes = ?, updated_at = datetime('now')
                    WHERE company_id = ? AND id = ? AND contract_id = ?`).run(i + 1, d.title, d.amount, d.due_date, d.period_from, d.period_to, d.notes, company.id, d.id, contractId);
      } else {
        insertDeliverable(company.id, contractId, i + 1, d);
      }
    });
  }

  const TRANSITIONS = {
    mark_sent: { from: ['draft', 'sent'], to: 'sent', label: 'أُرسل للتوقيع' },
    mark_signed: { from: ['draft', 'sent', 'active'], to: 'active', label: 'تم التوقيع' },
    terminate: { from: ['sent', 'active'], to: 'terminated', label: 'إنهاء العقد' },
    close: { from: ['active', 'terminated'], to: 'closed', label: 'إغلاق العقد' },
    reopen: { from: ['closed', 'terminated'], to: 'active', label: 'إعادة فتح العقد' },
  };

  // Status changes are explicit user actions; nothing changes on its own.
  function changeStatus(company, id, input, userId) {
    const c = loadContractRow(company.id, id);
    const t = TRANSITIONS[input?.action];
    if (!t) throw new HttpError(400, 'إجراء غير معروف.');
    if (!t.from.includes(c.status)) throw new HttpError(409, `لا يمكن «${t.label}» والعقد بحالة «${CONTRACT_STATUS[c.status]}».`);
    const when = date(input.date, 'التاريخ') || riyadhToday();
    return tx(db, () => {
      const set = { status: t.to };
      if (input.action === 'mark_sent') set.sent_at = when;
      if (input.action === 'mark_signed') {
        set.signed_at = when;
        if (input.file) {
          const buf = Buffer.from(String(input.file.data || ''), 'base64');
          set.signed_file_id = saveFile(db, storageDir, { companyId: company.id, kind: 'signed-contract', filename: input.file.filename, buffer: buf, allowed: ['pdf', 'docx', 'png', 'jpg'], userId });
        }
      }
      if (input.action === 'terminate') {
        const reason = str(input.reason, 1000);
        if (!reason) throw new HttpError(400, 'سبب الإنهاء مطلوب.');
        Object.assign(set, { terminated_at: when, termination_reason: reason });
      }
      const keys = Object.keys(set);
      db.prepare(`UPDATE consulting_contracts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
        .run(...keys.map((k) => set[k]), company.id, c.id);
      event(company.id, c.id, null, `status:${input.action}`, [fmtDate(when), input.reason].filter(Boolean).join(' — '), userId);
      return getContract(company, c.id);
    });
  }

  function attachSigned(company, id, input, userId) {
    const c = loadContractRow(company.id, id);
    if (!input?.file) throw new HttpError(400, 'لم يتم إرفاق ملف.');
    return tx(db, () => {
      const buf = Buffer.from(String(input.file.data || ''), 'base64');
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: 'signed-contract', filename: input.file.filename, buffer: buf, allowed: ['pdf', 'docx', 'png', 'jpg'], userId });
      db.prepare(`UPDATE consulting_contracts SET signed_file_id = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(fileId, company.id, c.id);
      event(company.id, c.id, null, 'signed_copy_uploaded', input.file.filename, userId);
      return getContract(company, c.id);
    });
  }

  // ---------- official documents (contract / certificate) ----------
  function activeTemplate(company, code, label) {
    const t = db.prepare(`SELECT t.*, f.original_name, lt.name_ar AS type_name FROM letter_templates t
                          JOIN letter_types lt ON lt.id = t.letter_type_id
                          JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                          WHERE t.company_id = ? AND lt.code = ? AND t.is_active = 1`).get(company.id, code);
    if (!t) throw new HttpError(422, `${label} الرسمي غير متوفر لـ ${company.name_ar}. لا يمكن إصدار مستند رسمي قبل أن يرفعه مسؤول النظام من «نماذج المستندات».`, 'no_template');
    return t;
  }

  function templateStatus(company) {
    const row = (code) => db.prepare(`SELECT t.version, f.original_name FROM letter_templates t JOIN letter_types lt ON lt.id = t.letter_type_id
                                      JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                                      WHERE t.company_id = ? AND lt.code = ? AND t.is_active = 1`).get(company.id, code) || null;
    const assets = db.prepare('SELECT id, kind, label, signatory_name FROM brand_assets WHERE company_id = ? AND is_active = 1 ORDER BY id').all(company.id);
    return {
      contract: row(DOC_CONTRACT), certificate: row(DOC_CERTIFICATE), payment_request: row(DOC_PAYMENT_REQUEST), has_logo: !!company.logo_file_id,
      signatures: assets.filter((a) => a.kind === 'signature'), stamps: assets.filter((a) => a.kind === 'stamp'),
    };
  }

  function pickAsset(company, kind, id) {
    const row = id
      ? db.prepare('SELECT * FROM brand_assets WHERE company_id = ? AND kind = ? AND id = ? AND is_active = 1').get(company.id, kind, Number(id))
      : db.prepare('SELECT * FROM brand_assets WHERE company_id = ? AND kind = ? AND is_active = 1 ORDER BY id LIMIT 1').get(company.id, kind);
    if (!row) throw new HttpError(422, kind === 'signature' ? `لا يوجد توقيع معتمد لـ ${company.name_ar}.` : `لا يوجد ختم معتمد لـ ${company.name_ar}.`);
    return row;
  }

  function baseValues(company, contract, consultant, signature) {
    const v = {};
    const today = todayParts();
    v.date_gregorian = today.gregorian; v['date_gregorian:dash'] = today.gregorian.replace(/\//g, '-');
    v.date_hijri = today.hijri; v['date_hijri:dash'] = today.hijri.replace(/\//g, '-');
    v.company_name_ar = company.legal_name_ar || company.name_ar;
    v.company_name_en = company.legal_name_en || company.name_en;
    v.signatory_name = signature?.signatory_name ?? null;
    v.signatory_title = signature?.signatory_title ?? null;
    Object.assign(v, {
      consultant_name_ar: consultant.full_name_ar, consultant_name_en: consultant.full_name_en,
      consultant_title_ar: ({ male: 'المكرم', female: 'المكرمة' })[consultant.gender] ?? null,
      consultant_nationality_ar: consultant.nationality_ar, consultant_nationality_en: consultant.nationality_en,
      consultant_id_number: consultant.id_number, consultant_mobile: consultant.mobile, consultant_email: consultant.email,
      consultant_bank_beneficiary: consultant.bank_beneficiary, consultant_bank_name: consultant.bank_name,
      consultant_iban: consultant.iban, consultant_swift: consultant.swift_code,
      contract_ref: contract.contract_no, project_name: contract.project_name, contract_scope: contract.scope,
      department: contract.department, supervisor_name: contract.supervisor_name, duration_text: contract.duration_text,
    });
    putDate(v, 'contract_date', contract.contract_date);
    if (contract.contract_date) {
      const h = todayParts(new Date(`${contract.contract_date}T12:00:00Z`)).hijri;
      v.contract_date_hijri = h; v['contract_date_hijri:dash'] = h.replace(/\//g, '-');
    } else { v.contract_date_hijri = null; v['contract_date_hijri:dash'] = null; }
    putDate(v, 'start_date', contract.start_date);
    putDate(v, 'end_date', contract.end_date);
    return v;
  }

  const rowValues = (d) => {
    const v = { d_no: String(d.seq), d_title: d.title, d_amount: fmtNum(d.amount) };
    putDate(v, 'd_due_date', d.due_date); putDate(v, 'd_period_from', d.period_from); putDate(v, 'd_period_to', d.period_to);
    return v;
  };

  const labelOf = (catalog, key) => catalog.text.find((p) => p.key === key.split(':')[0])?.label || key;

  // Shared by preview and issue: lists exactly what goes into the template.
  function buildDocument(company, { template, catalog, values, rows, input }) {
    const used = JSON.parse(template.placeholders || '[]');
    const textKeys = used.filter((k) => !IMAGE_PLACEHOLDERS.some((p) => p.key === k));
    const rowKeys = textKeys.filter((k) => k.startsWith(ROW_PREFIX));
    const fields = textKeys.filter((k) => !k.startsWith(ROW_PREFIX)).map((k) => {
      const v = values[k];
      return { key: k, label: labelOf(catalog, k), value: v ?? null, missing: v === null || v === undefined || v === '' };
    });
    const missing = fields.filter((f) => f.missing).map((f) => f.label);
    if (rowKeys.length) {
      if (!rows?.length) missing.push('المخرجات');
      rows?.forEach((r, i) => rowKeys.forEach((k) => { if (!r[k]) missing.push(`${labelOf(catalog, k)} (المخرج ${i + 1})`); }));
    }
    const images = IMAGE_PLACEHOLDERS.filter((p) => used.includes(p.key)).map((p) => ({ key: p.key, label: p.label, included: !!input[`include_${p.key}`] }));
    return { used, fields, missing, images, rowKeys };
  }

  function renderOfficial(company, { template, values, rows, input, signature, stamp }) {
    const used = JSON.parse(template.placeholders || '[]');
    const imgs = {};
    const files = { logo: input.include_logo ? company.logo_file_id : null, signature: input.include_signature ? signature?.file_id : null, stamp: input.include_stamp ? stamp?.file_id : null };
    for (const p of IMAGE_PLACEHOLDERS) {
      if (!used.includes(p.key)) continue;
      imgs[p.key] = files[p.key] ? { buffer: readFile(db, storageDir, company.id, files[p.key]).buffer, maxHeightCm: p.maxHeightCm, maxWidthCm: p.maxWidthCm } : null;
    }
    const tpl = readFile(db, storageDir, company.id, template.file_id).buffer;
    try {
      return renderDocx(tpl, values, imgs, rows ? { rows: { prefix: ROW_PREFIX, items: rows } } : {});
    } catch (e) {
      if (e.message === 'IMAGE_FORMAT') throw new HttpError(422, 'صيغة صورة الشعار/التوقيع/الختم غير مدعومة في Word. استخدم PNG أو JPG.');
      throw e;
    }
  }

  function resolveAssets(company, template, input) {
    const used = JSON.parse(template.placeholders || '[]');
    const needSig = !!input.include_signature || used.includes('signatory_name') || used.includes('signatory_title');
    if (input.include_logo && !company.logo_file_id) throw new HttpError(422, `لا يوجد شعار معتمد لـ ${company.name_ar}.`);
    return {
      signature: needSig ? pickAsset(company, 'signature', input.signature_id) : null,
      stamp: input.include_stamp ? pickAsset(company, 'stamp', input.stamp_id) : null,
    };
  }

  function contractDocument(company, id, input = {}) {
    const contract = loadContractRow(company.id, id);
    const consultant = consultantOf(company.id, contract.consultant_id);
    const deliverables = deliverablesOf(company.id, contract.id);
    const template = activeTemplate(company, DOC_CONTRACT, 'نموذج العقد');
    const { signature, stamp } = resolveAssets(company, template, input);
    const values = baseValues(company, contract, consultant, signature);
    values.contract_total = fmtNum(deliverables.reduce((s, d) => s + d.amount, 0));
    values.deliverables_count = String(deliverables.length);
    const rows = deliverables.map(rowValues);
    const doc = buildDocument(company, { template, catalog: CONTRACT_CATALOG, values, rows, input });
    return { contract, consultant, template, signature, stamp, values, rows, doc };
  }

  function previewContract(company, id, input) {
    const r = contractDocument(company, id, input || {});
    return { template: { version: r.template.version, file: r.template.original_name }, fields: r.doc.fields, images: r.doc.images, missing: r.doc.missing, rows: r.doc.rowKeys.length ? r.rows : [] };
  }

  function generateContract(company, id, input, userId) {
    input = input || {};
    const r = contractDocument(company, id, input);
    if (r.doc.missing.length) throw new HttpError(422, `بيانات ناقصة مطلوبة في نموذج العقد: ${r.doc.missing.join('، ')}.`, 'missing_fields');
    const out = renderOfficial(company, { template: r.template, values: r.values, rows: r.rows, input, signature: r.signature, stamp: r.stamp });
    return tx(db, () => {
      const filename = `عقد خدمات استشارية - ${safeName(r.consultant.full_name_ar)} - ${safeName(r.contract.contract_no)}.docx`;
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: 'contract', filename, buffer: out, allowed: ['docx'], userId });
      db.prepare(`UPDATE consulting_contracts SET generated_file_id = ?, generated_at = datetime('now'), updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(fileId, company.id, r.contract.id);
      event(company.id, r.contract.id, null, 'contract_generated', `النموذج الإصدار ${r.template.version}`, userId);
      return { filename, contract_id: r.contract.id };
    });
  }

  function certificateDocument(company, deliverableId, input = {}) {
    const d = loadDeliverable(company.id, deliverableId);
    const contract = loadContractRow(company.id, d.contract_id);
    const consultant = consultantOf(company.id, contract.consultant_id);
    const template = activeTemplate(company, DOC_CERTIFICATE, 'نموذج شهادة الإنجاز');
    const { signature, stamp } = resolveAssets(company, template, input);
    const completion = date(input.completion_date, 'تاريخ الإنجاز') || d.completion_date;
    const values = baseValues(company, contract, consultant, signature);
    Object.assign(values, {
      certificate_ref: d.certificate_ref || input.__ref || '(يُحدَّد عند الإصدار)',
      deliverable_no: String(d.seq), deliverable_title: d.title, deliverable_amount: fmtNum(d.amount), certificate_total: fmtNum(d.amount),
    });
    // The three approvers' names (and optional titles) are entered at every issue;
    // their signatures and signature dates stay blank in the document.
    const approvers = cleanApprovers(input.approvers, CERT_APPROVERS);
    putApprovers(values, approvers);
    putDate(values, 'completion_date', completion);
    putDate(values, 'deliverable_due_date', d.due_date);
    putDate(values, 'deliverable_period_from', d.period_from);
    putDate(values, 'deliverable_period_to', d.period_to);
    const doc = buildDocument(company, { template, catalog: CERTIFICATE_CATALOG, values, rows: null, input });
    // approver titles are optional: an empty title is left blank, not reported as missing
    for (const f of doc.fields) if (OPTIONAL_KEY.test(f.key)) f.missing = false;
    doc.missing = doc.fields.filter((f) => f.missing).map((f) => f.label);
    const warnings = [];
    if (!['active', 'terminated', 'closed'].includes(contract.status)) warnings.push(`حالة العقد «${CONTRACT_STATUS[contract.status]}» — لم يُسجَّل توقيعه بعد.`);
    if (d.certificate_issued_at) warnings.push('صدرت شهادة لهذا المخرج سابقًا؛ الإصدار الجديد يستبدل الملف بنفس الرقم.');
    return { d, contract, consultant, template, signature, stamp, values, doc, completion, warnings, approvers };
  }

  function previewCertificate(company, deliverableId, input) {
    const r = certificateDocument(company, deliverableId, input || {});
    const missing = [...r.doc.missing];
    if (!r.completion) missing.unshift('تاريخ الإنجاز');
    r.approvers.forEach((a, i) => { if (!a.name) missing.push(`اسم المعتمد ${i + 1}`); });
    return { template: { version: r.template.version, file: r.template.original_name }, fields: r.doc.fields, images: r.doc.images, missing: [...new Set(missing)], warnings: r.warnings };
  }

  // Issuing the certificate is the explicit act that records completion.
  function issueCertificate(company, deliverableId, input, userId) {
    input = input || {};
    if (!date(input.completion_date, 'تاريخ الإنجاز', { required: true })) throw new HttpError(400, 'تاريخ الإنجاز مطلوب.');
    return tx(db, () => {
      const pre = loadDeliverable(company.id, deliverableId);
      const ref = pre.certificate_ref || nextRef(company, 'contract_deliverables', 'certificate_ref', 'CERT');
      const r = certificateDocument(company, deliverableId, { ...input, __ref: ref }); // no template → 422 first
      const approvers = cleanApprovers(input.approvers, CERT_APPROVERS, { required: true });
      if (r.doc.missing.length) throw new HttpError(422, `بيانات ناقصة مطلوبة في نموذج الشهادة: ${r.doc.missing.join('، ')}.`, 'missing_fields');
      const out = renderOfficial(company, { template: r.template, values: r.values, rows: null, input, signature: r.signature, stamp: r.stamp });
      const filename = `شهادة إنجاز - ${safeName(r.consultant.full_name_ar)} - المخرج ${r.d.seq} - ${safeName(ref)}.docx`;
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: 'certificate', filename, buffer: out, allowed: ['docx'], userId });
      db.prepare(`UPDATE contract_deliverables SET completion_date = ?, certificate_ref = ?, certificate_file_id = ?, certificate_issued_at = datetime('now'),
                  certificate_issued_by = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(r.completion, ref, fileId, userId ?? null, company.id, r.d.id);
      db.prepare(`INSERT INTO certificate_issues (company_id, deliverable_id, certificate_ref, completion_date, approvers_json, file_id, template_version, issued_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(company.id, r.d.id, ref, r.completion, JSON.stringify(approvers), fileId, r.template.version, userId ?? null);
      event(company.id, r.contract.id, r.d.id, pre.certificate_issued_at ? 'certificate_reissued' : 'certificate_issued', `${ref} — المخرج ${r.d.seq} — المعتمدون: ${approvers.map((a) => a.name).join('، ')}`, userId);
      return { filename, certificate_ref: ref, deliverable_id: r.d.id, contract_id: r.contract.id };
    });
  }

  function markCertificateSent(company, deliverableId, input, userId) {
    const d = loadDeliverable(company.id, deliverableId);
    if (!d.certificate_issued_at) throw new HttpError(409, 'لم تصدر شهادة إنجاز لهذا المخرج بعد.');
    const sentAt = date(input?.sent_at, 'تاريخ الإرسال', { required: true });
    if (sentAt > riyadhToday()) throw new HttpError(400, 'تاريخ الإرسال لا يمكن أن يكون في المستقبل.');
    const sentTo = str(input?.sent_to, 300) ?? null;
    db.prepare(`UPDATE contract_deliverables SET certificate_sent_at = ?, certificate_sent_to = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
      .run(sentAt, sentTo, company.id, d.id);
    event(company.id, d.contract_id, d.id, 'certificate_sent', [fmtDate(sentAt), sentTo].filter(Boolean).join(' — '), userId);
    return loadDeliverable(company.id, d.id);
  }

  // Recorded only after the finance department confirms the actual transfer.
  function recordPayment(company, deliverableId, input, userId) {
    input = input || {};
    if (input.finance_confirmed !== true) throw new HttpError(400, 'يجب تأكيد أن الإدارة المالية أكدت التحويل الفعلي قبل تسجيل الدفعة.', 'finance_confirmation_required');
    const amount = money(input.amount, 'المبلغ المدفوع', { required: true });
    if (!(amount > 0)) throw new HttpError(400, 'المبلغ المدفوع يجب أن يكون أكبر من صفر.');
    const paidAt = date(input.paid_at, 'تاريخ الدفع', { required: true });
    if (paidAt > riyadhToday()) throw new HttpError(400, 'تاريخ الدفع لا يمكن أن يكون في المستقبل.');
    return tx(db, () => {
      const d = loadDeliverable(company.id, deliverableId);
      if (amount > d.remaining + EPS) throw new HttpError(409, `المبلغ أكبر من المتبقي على المخرج (${fmtNum(d.remaining)}).`);
      const r = db.prepare(`INSERT INTO deliverable_payments (company_id, deliverable_id, amount, paid_at, transfer_reference, note, finance_confirmed, recorded_by)
                            VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(company.id, d.id, amount, paidAt, str(input.transfer_reference, 120) ?? null, str(input.note, 1000) ?? null, userId ?? null);
      event(company.id, d.contract_id, d.id, 'payment_recorded', `${fmtNum(amount)} — ${fmtDate(paidAt)}`, userId);
      return { payment_id: Number(r.lastInsertRowid), deliverable: loadDeliverable(company.id, d.id) };
    });
  }


  // ======================================================================
  // Consultants overview, new consultant + contract in one step
  // ======================================================================
  const normName = (s) => String(s || '').replace(/[ـً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();
  const normCode = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();
  const normMobile = (s) => String(s || '').replace(/\D/g, '').slice(-9);

  function listConsultants(company, { q } = {}) {
    const rows = db.prepare(`SELECT k.*, COUNT(DISTINCT c.id) AS contracts,
                               COALESCE((SELECT SUM(d.amount) FROM v_deliverables d JOIN consulting_contracts c2 ON c2.company_id = d.company_id AND c2.id = d.contract_id
                                         WHERE c2.company_id = k.company_id AND c2.consultant_id = k.id AND c2.status != 'draft'), 0) AS total,
                               COALESCE((SELECT SUM(d.paid_total) FROM v_deliverables d JOIN consulting_contracts c2 ON c2.company_id = d.company_id AND c2.id = d.contract_id
                                         WHERE c2.company_id = k.company_id AND c2.consultant_id = k.id), 0) AS paid
                             FROM consultants k LEFT JOIN consulting_contracts c ON c.company_id = k.company_id AND c.consultant_id = k.id
                             WHERE k.company_id = ? GROUP BY k.id ORDER BY k.full_name_ar`).all(company.id)
      .map((k) => ({ ...k, remaining: Math.max(0, Math.round((k.total - k.paid) * 100) / 100) }));
    if (!q) return rows;
    const t = String(q).trim();
    return rows.filter((k) => [k.full_name_ar, k.full_name_en, k.id_number, k.mobile, k.email].some((v) => v && String(v).includes(t)));
  }

  function getConsultant(company, id) {
    const k = consultantOf(company.id, id);
    const contracts = listContracts(company).filter((c) => c.consultant_id === k.id);
    const requests = listRequests(company, {}).filter((r) => r.consultant_id === k.id);
    return { ...k, contracts, requests };
  }

  // Consultants of the current company that look like the one being entered.
  function consultantMatch(company, q = {}) {
    const id = normCode(q.id_number), iban = normCode(q.iban), mob = normMobile(q.mobile), name = normName(q.full_name_ar);
    return db.prepare('SELECT id, full_name_ar, id_number, mobile, iban FROM consultants WHERE company_id = ?').all(company.id).map((k) => {
      const by = [];
      if (id && normCode(k.id_number) === id) by.push('id_number');
      if (iban && normCode(k.iban) === iban) by.push('iban');
      if (mob.length >= 9 && normMobile(k.mobile) === mob) by.push('mobile');
      if (name && normName(k.full_name_ar) === name) by.push('name');
      if (!by.length) return null;
      const contracts = db.prepare('SELECT COUNT(*) n FROM consulting_contracts WHERE company_id = ? AND consultant_id = ?').get(company.id, k.id).n;
      return { id: k.id, full_name_ar: k.full_name_ar, id_number: k.id_number, matched_by: by, contracts };
    }).filter(Boolean);
  }

  // Creates the consultant and the contract in ONE transaction: if the contract
  // fails (e.g. a missing deliverable amount), the consultant is not saved either.
  function createContractWithConsultant(company, tenant, input, userId) {
    input = input || {};
    const k = input.consultant || {};
    if (!str(k.full_name_ar, 200)) throw new HttpError(400, 'اسم الاستشاري بالعربية مطلوب.');
    const matches = consultantMatch(company, k);
    const hard = matches.find((m) => m.matched_by.includes('id_number'));
    if (hard) throw new HttpError(409, `يوجد استشاري بنفس رقم الهوية في ${company.name_ar}: ${hard.full_name_ar}. اختره من «استشاري موجود» بدل إنشاء سجل جديد.`, 'consultant_exists');
    if (matches.length && input.confirm_new_consultant !== true) {
      const BY = { iban: 'الآيبان', mobile: 'الجوال', name: 'الاسم' };
      throw new HttpError(409, `يوجد استشاري مشابه في ${company.name_ar}: ${matches.map((m) => `${m.full_name_ar} (${m.matched_by.map((b) => BY[b]).join('، ')})`).join('؛ ')}. اختره إن كان هو، أو أكّد أنه استشاري مختلف.`, 'possible_duplicate');
    }
    const allowed = ['full_name_ar', 'full_name_en', 'gender', 'nationality_ar', 'nationality_en', 'id_number', 'mobile', 'email', 'bank_beneficiary', 'bank_name', 'iban', 'swift_code', 'notes'];
    const record = Object.fromEntries(allowed.filter((f) => k[f] !== undefined).map((f) => [f, k[f]]));
    return tx(db, () => {
      const created = tenant.create('consultants', record, userId); // same validation as the consultants register
      const c = createContract(company, { ...(input.contract || {}), consultant_id: created.id }, userId);
      event(company.id, c.id, null, 'consultant_created', `أُنشئ سجل الاستشاري ${created.full_name_ar} مع العقد`, userId);
      return getContract(company, c.id);
    });
  }

  // ======================================================================
  // Approvers (free text; previous names are suggested)
  // ======================================================================
  function cleanApprovers(list, count, { required = false } = {}) {
    const arr = Array.isArray(list) ? list : [];
    const out = Array.from({ length: count }, (_, i) => ({ name: str(arr[i]?.name, 200) ?? null, title: str(arr[i]?.title, 200) ?? null }));
    if (required) {
      const miss = out.map((a, i) => (a.name ? null : i + 1)).filter(Boolean);
      if (miss.length) throw new HttpError(400, `أدخل اسم المعتمد ${miss.join(' و')} قبل الإصدار.`, 'approvers_required');
    }
    return out;
  }
  const putApprovers = (values, approvers) => approvers.forEach((a, i) => { values[`approver_${i + 1}_name`] = a.name; values[`approver_${i + 1}_title`] = a.title; });

  function approverSuggestions(company) {
    const seen = new Map();
    const add = (json) => { try { for (const a of JSON.parse(json || '[]')) if (a?.name && !seen.has(a.name)) seen.set(a.name, a.title || null); } catch {} };
    db.prepare('SELECT approvers_json FROM certificate_issues WHERE company_id = ? ORDER BY id DESC LIMIT 500').all(company.id).forEach((r) => add(r.approvers_json));
    db.prepare('SELECT approvers_json FROM payment_requests WHERE company_id = ? ORDER BY id DESC LIMIT 500').all(company.id).forEach((r) => add(r.approvers_json));
    return [...seen].map(([name, title]) => ({ name, title }));
  }

  function certificateHistory(company, deliverableId) {
    return db.prepare(`SELECT ci.*, u.display_name AS issued_by_name FROM certificate_issues ci LEFT JOIN users u ON u.id = ci.issued_by
                       WHERE ci.company_id = ? AND ci.deliverable_id = ? ORDER BY ci.id DESC`).all(company.id, Number(deliverableId))
      .map((r) => ({ ...r, approvers: JSON.parse(r.approvers_json) }));
  }

  // ======================================================================
  // Payments are never deleted: Admin voids or corrects them with a reason
  // ======================================================================
  const requestOfPayment = (companyId, paymentId) => db.prepare('SELECT request_id FROM payment_request_payments WHERE company_id = ? AND payment_id = ?').get(companyId, paymentId)?.request_id ?? null;
  function loadPayment(companyId, id) {
    const p = db.prepare(`SELECT p.*, d.contract_id, d.seq FROM deliverable_payments p JOIN contract_deliverables d ON d.company_id = p.company_id AND d.id = p.deliverable_id
                          WHERE p.company_id = ? AND p.id = ?`).get(companyId, Number(id));
    if (!p) throw new HttpError(404, 'الدفعة غير موجودة في الشركة الحالية.');
    return p;
  }

  function voidPayment(company, paymentId, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب إلغاء الدفعة مطلوب.');
    return tx(db, () => {
      const p = loadPayment(company.id, paymentId);
      if (p.voided_at) throw new HttpError(409, 'هذه الدفعة ملغاة بالفعل.');
      db.prepare(`UPDATE deliverable_payments SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE company_id = ? AND id = ?`).run(userId ?? null, reason, company.id, p.id);
      event(company.id, p.contract_id, p.deliverable_id, 'payment_voided', `${fmtNum(p.amount)} — ${fmtDate(p.paid_at)}${p.transfer_reference ? ` — ${p.transfer_reference}` : ''} — السبب: ${reason}`, userId, requestOfPayment(company.id, p.id));
      return { ok: true, payment_id: p.id };
    });
  }

  // Voids the original and records the corrected payment (finance-confirmed) in one step.
  function correctPayment(company, paymentId, input, userId) {
    input = input || {};
    const reason = str(input.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب التصحيح مطلوب.');
    if (input.finance_confirmed !== true) throw new HttpError(400, 'يجب تأكيد أن الإدارة المالية أكدت المبلغ الصحيح.', 'finance_confirmation_required');
    return tx(db, () => {
      const p = loadPayment(company.id, paymentId);
      if (p.voided_at) throw new HttpError(409, 'لا يمكن تصحيح دفعة ملغاة.');
      const reqId = requestOfPayment(company.id, p.id);
      db.prepare(`UPDATE deliverable_payments SET voided_at = datetime('now'), voided_by = ?, void_reason = ? WHERE company_id = ? AND id = ?`).run(userId ?? null, `تصحيح: ${reason}`, company.id, p.id);
      const r = recordPayment(company, p.deliverable_id, {
        amount: input.amount, paid_at: input.paid_at, transfer_reference: input.transfer_reference ?? p.transfer_reference, note: input.note ?? p.note, finance_confirmed: true,
      }, userId);
      db.prepare('UPDATE deliverable_payments SET replaces_payment_id = ? WHERE company_id = ? AND id = ?').run(p.id, company.id, r.payment_id);
      if (reqId) db.prepare('INSERT INTO payment_request_payments (company_id, request_id, payment_id) VALUES (?, ?, ?)').run(company.id, reqId, r.payment_id);
      const n = loadPayment(company.id, r.payment_id);
      event(company.id, p.contract_id, p.deliverable_id, 'payment_corrected', `${fmtNum(p.amount)} (${fmtDate(p.paid_at)}) ← ${fmtNum(n.amount)} (${fmtDate(n.paid_at)}) — السبب: ${reason}`, userId, reqId);
      return { ok: true, payment_id: n.id, replaced_payment_id: p.id };
    });
  }

  // ======================================================================
  // Consultant payment requests (amounts REQUESTED; actual payments stay separate)
  // ======================================================================
  const REQ_EDITABLE = ['draft'];
  const paidVia = (companyId, requestId, deliverableId) => db.prepare(`SELECT COALESCE(SUM(p.amount), 0) s FROM payment_request_payments rp
      JOIN deliverable_payments p ON p.company_id = rp.company_id AND p.id = rp.payment_id
      WHERE rp.company_id = ? AND rp.request_id = ? AND p.deliverable_id = ? AND p.voided_at IS NULL`).get(companyId, requestId, deliverableId).s;

  // Amount of a deliverable already requested in other open (not cancelled) requests and not yet paid through them.
  function openClaim(companyId, deliverableId, excludeRequestId = null) {
    const items = db.prepare(`SELECT i.request_id, i.amount, r.request_no FROM payment_request_items i
                              JOIN payment_requests r ON r.company_id = i.company_id AND r.id = i.request_id
                              WHERE i.company_id = ? AND i.deliverable_id = ? AND r.status != 'cancelled' AND r.id IS NOT ?`).all(companyId, deliverableId, excludeRequestId);
    let total = 0;
    const requests = [];
    for (const it of items) {
      const open = Math.max(0, Math.round((it.amount - paidVia(companyId, it.request_id, deliverableId)) * 100) / 100);
      if (open > EPS) { total += open; requests.push(it.request_no); }
    }
    return { amount: Math.round(total * 100) / 100, requests };
  }

  function requestable(company, contractId, excludeRequestId = null) {
    const c = loadContractRow(company.id, contractId);
    return deliverablesOf(company.id, c.id).map((d) => {
      const claim = openClaim(company.id, d.id, excludeRequestId);
      return { ...d, open_claim: claim.amount, open_requests: claim.requests, claimable: Math.max(0, Math.round((d.remaining - claim.amount) * 100) / 100) };
    });
  }

  function loadRequest(companyId, id) {
    const r = db.prepare('SELECT * FROM payment_requests WHERE company_id = ? AND id = ?').get(companyId, Number(id));
    if (!r) throw new HttpError(404, 'طلب الدفعة غير موجود في الشركة الحالية.');
    return r;
  }

  function requestTotals(companyId, r) {
    const items = db.prepare(`SELECT i.*, d.seq, d.title, d.amount AS deliverable_amount, d.due_date, d.certificate_ref, d.completion_date, d.paid_total AS deliverable_paid
                              FROM payment_request_items i JOIN v_deliverables d ON d.company_id = i.company_id AND d.id = i.deliverable_id
                              WHERE i.company_id = ? AND i.request_id = ? ORDER BY d.seq`).all(companyId, r.id)
      .map((i) => { const paid = paidVia(companyId, r.id, i.deliverable_id); return { ...i, paid, outstanding: Math.max(0, Math.round((i.amount - paid) * 100) / 100) }; });
    const requested = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    const paid = Math.round(items.reduce((s, i) => s + i.paid, 0) * 100) / 100;
    const payment_state = paid <= EPS ? 'unpaid' : paid + EPS >= requested ? 'paid' : 'partial';
    return { items, requested, paid, outstanding: Math.max(0, Math.round((requested - paid) * 100) / 100), payment_state };
  }

  function listRequests(company, f = {}) {
    const where = ['r.company_id = ?'];
    const p = [company.id];
    if (f.status && ['draft', 'issued', 'sent', 'cancelled'].includes(f.status)) { where.push('r.status = ?'); p.push(f.status); }
    if (f.contract_id) { where.push('r.contract_id = ?'); p.push(Number(f.contract_id)); }
    if (f.q) { where.push('(r.request_no LIKE ? OR k.full_name_ar LIKE ? OR c.contract_no LIKE ?)'); p.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
    return db.prepare(`SELECT r.*, c.contract_no, c.consultant_id, k.full_name_ar AS consultant_name FROM payment_requests r
                       JOIN consulting_contracts c ON c.company_id = r.company_id AND c.id = r.contract_id
                       JOIN consultants k ON k.company_id = c.company_id AND k.id = c.consultant_id
                       WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 1000`).all(...p)
      .map((r) => { const t = requestTotals(company.id, r); return { ...r, approvers: JSON.parse(r.approvers_json || '[]'), requested: t.requested, paid: t.paid, outstanding: t.outstanding, payment_state: t.payment_state, items_count: t.items.length }; });
  }

  function requestTemplateInfo(company) {
    const t = db.prepare(`SELECT t.version, t.placeholders, f.original_name FROM letter_templates t JOIN letter_types lt ON lt.id = t.letter_type_id
                          JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                          WHERE t.company_id = ? AND lt.code = ? AND t.is_active = 1`).get(company.id, DOC_PAYMENT_REQUEST);
    if (!t) return null;
    const used = JSON.parse(t.placeholders || '[]');
    const max = (re) => used.reduce((m, k) => { const x = k.match(re); return x ? Math.max(m, Number(x[1])) : m; }, 0);
    return { version: t.version, file: t.original_name, approver_slots: max(/^approver_(\d+)_/), item_slots: max(/^item_(\d+)_/) };
  }

  function getRequest(company, id) {
    const r = loadRequest(company.id, id);
    const c = loadContractRow(company.id, r.contract_id);
    const k = consultantOf(company.id, c.consultant_id);
    const t = requestTotals(company.id, r);
    const payments = db.prepare(`SELECT p.*, d.seq AS deliverable_seq, u.display_name AS recorded_by_name, v.display_name AS voided_by_name FROM payment_request_payments rp
                                 JOIN deliverable_payments p ON p.company_id = rp.company_id AND p.id = rp.payment_id
                                 JOIN contract_deliverables d ON d.company_id = p.company_id AND d.id = p.deliverable_id
                                 LEFT JOIN users u ON u.id = p.recorded_by LEFT JOIN users v ON v.id = p.voided_by
                                 WHERE rp.company_id = ? AND rp.request_id = ? ORDER BY p.paid_at DESC, p.id DESC`).all(company.id, r.id);
    const events = db.prepare(`SELECT e.*, u.display_name AS user_name FROM contract_events e LEFT JOIN users u ON u.id = e.user_id
                               WHERE e.company_id = ? AND e.payment_request_id = ? ORDER BY e.id DESC`).all(company.id, r.id);
    return { ...r, approvers: JSON.parse(r.approvers_json || '[]'), contract: { id: c.id, contract_no: c.contract_no, status: c.status, project_name: c.project_name },
      consultant: { id: k.id, full_name_ar: k.full_name_ar, iban: k.iban, bank_name: k.bank_name }, ...t, payments, events, has_file: !!r.file_id, template: requestTemplateInfo(company) };
  }

  // Validates request lines; amounts above what is still claimable need explicit confirmation.
  function checkItems(company, contract, items, { excludeRequestId = null, confirm = false } = {}) {
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'اختر مخرجًا واحدًا على الأقل.');
    if (items.length > MAX_REQUEST_ITEMS) throw new HttpError(400, `الحد الأقصى ${MAX_REQUEST_ITEMS} مخرجات في الطلب الواحد.`);
    const avail = new Map(requestable(company, contract.id, excludeRequestId).map((d) => [d.id, d]));
    const seen = new Set();
    const warnings = [];
    const clean = items.map((it) => {
      const d = avail.get(Number(it.deliverable_id));
      if (!d) throw new HttpError(400, 'المخرج غير موجود في هذا العقد.');
      if (seen.has(d.id)) throw new HttpError(400, `المخرج ${d.seq} مكرر في الطلب.`);
      seen.add(d.id);
      const amount = money(it.amount, `مبلغ المخرج ${d.seq}`, { required: true });
      if (!(amount > 0)) throw new HttpError(400, `مبلغ المخرج ${d.seq} يجب أن يكون أكبر من صفر.`);
      if (amount > d.remaining + EPS) throw new HttpError(409, `المبلغ المطلوب للمخرج ${d.seq} (${fmtNum(amount)}) أكبر من المتبقي غير المصروف (${fmtNum(d.remaining)}).`, 'exceeds_remaining');
      if (amount > d.claimable + EPS) warnings.push(`المخرج ${d.seq}: مطلوب سابقًا ${fmtNum(d.open_claim)} في ${d.open_requests.join('، ')} ولم يُصرف بعد؛ المتاح للطلب ${fmtNum(d.claimable)}`);
      return { deliverable_id: d.id, amount };
    });
    if (warnings.length && !confirm) throw new HttpError(409, `تنبيه تكرار مطالبة: ${warnings.join('؛ ')}. أكّد إن كان الطلب صحيحًا.`, 'already_requested');
    return { clean, warnings };
  }

  function createRequest(company, input, userId) {
    input = input || {};
    const c = loadContractRow(company.id, input.contract_id);
    if (!['active', 'terminated', 'closed'].includes(c.status)) throw new HttpError(409, `لا يمكن طلب دفعة لعقد بحالة «${CONTRACT_STATUS[c.status]}»؛ سجّل توقيع العقد أولًا.`);
    const requestDate = date(input.request_date, 'تاريخ الطلب') || riyadhToday();
    return tx(db, () => {
      const { clean, warnings } = checkItems(company, c, input.items, { confirm: input.confirm_duplicate === true });
      const no = nextRef(company, 'payment_requests', 'request_no', 'PR');
      const approvers = cleanApprovers(input.approvers, MAX_REQUEST_APPROVERS).filter((a, i, all) => a.name || all.slice(i).some((x) => x.name));
      const r = db.prepare(`INSERT INTO payment_requests (company_id, request_no, contract_id, request_date, approvers_json, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(company.id, no, c.id, requestDate, JSON.stringify(approvers), str(input.notes, 2000) ?? null, userId ?? null);
      const id = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO payment_request_items (company_id, request_id, deliverable_id, amount) VALUES (?, ?, ?, ?)');
      clean.forEach((it) => ins.run(company.id, id, it.deliverable_id, it.amount));
      event(company.id, c.id, null, 'payment_request_created', `${no} — ${fmtNum(clean.reduce((s, x) => s + x.amount, 0))}${warnings.length ? ' — بعد تأكيد تنبيه تكرار المطالبة' : ''}`, userId, id);
      return getRequest(company, id);
    });
  }

  function updateRequest(company, id, input, userId) {
    input = input || {};
    return tx(db, () => {
      const r = loadRequest(company.id, id);
      if (!REQ_EDITABLE.includes(r.status)) throw new HttpError(409, 'يمكن تعديل الطلب وهو مسودة فقط؛ ألغِه وأنشئ طلبًا جديدًا إن لزم.', 'request_locked');
      const c = loadContractRow(company.id, r.contract_id);
      if (input.items !== undefined) {
        const { clean } = checkItems(company, c, input.items, { excludeRequestId: r.id, confirm: input.confirm_duplicate === true });
        db.prepare('DELETE FROM payment_request_items WHERE company_id = ? AND request_id = ?').run(company.id, r.id);
        const ins = db.prepare('INSERT INTO payment_request_items (company_id, request_id, deliverable_id, amount) VALUES (?, ?, ?, ?)');
        clean.forEach((it) => ins.run(company.id, r.id, it.deliverable_id, it.amount));
      }
      const set = {};
      if (input.notes !== undefined) set.notes = str(input.notes, 2000) ?? null;
      if (input.request_date !== undefined) set.request_date = date(input.request_date, 'تاريخ الطلب', { required: true });
      if (input.approvers !== undefined) set.approvers_json = JSON.stringify(cleanApprovers(input.approvers, MAX_REQUEST_APPROVERS));
      if (Object.keys(set).length) db.prepare(`UPDATE payment_requests SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(...Object.values(set), company.id, r.id);
      event(company.id, r.contract_id, null, 'payment_request_updated', r.request_no, userId, r.id);
      return getRequest(company, r.id);
    });
  }

  function requestDocument(company, id, input = {}) {
    const r = loadRequest(company.id, id);
    const contract = loadContractRow(company.id, r.contract_id);
    const consultant = consultantOf(company.id, contract.consultant_id);
    const template = activeTemplate(company, DOC_PAYMENT_REQUEST, 'نموذج طلب دفعة الاستشاري');
    const info = requestTemplateInfo(company);
    const t = requestTotals(company.id, r);
    const all = deliverablesOf(company.id, contract.id);
    const values = baseValues(company, contract, consultant, null);
    const approvers = cleanApprovers(input.approvers ?? JSON.parse(r.approvers_json || '[]'), Math.max(info.approver_slots, 0));
    putApprovers(values, approvers);
    values.request_no = r.request_no;
    putDate(values, 'request_date', r.request_date);
    values.request_amount = t.requested;
    values.items_count = String(t.items.length);
    values.contract_total = Math.round(all.reduce((s, d) => s + d.amount, 0) * 100) / 100;
    values.contract_paid = Math.round(all.reduce((s, d) => s + d.paid_total, 0) * 100) / 100;
    values.contract_remaining = Math.max(0, Math.round((values.contract_total - values.contract_paid) * 100) / 100);
    for (let n = 1; n <= MAX_REQUEST_ITEMS; n++) {
      const it = t.items[n - 1];
      values[`item_${n}_no`] = it ? String(it.seq) : null;
      values[`item_${n}_title`] = it ? it.title : null;
      values[`item_${n}_amount`] = it ? it.amount : null;
      values[`item_${n}_certificate_ref`] = it ? it.certificate_ref : null;
      putDate(values, `item_${n}_due_date`, it ? it.due_date : null);
      putDate(values, `item_${n}_completion_date`, it ? it.completion_date : null);
    }
    const used = JSON.parse(template.placeholders || '[]');
    // item slots beyond the number of requested lines are intentionally left empty
    const optional = (k) => /^item_(\d+)_/.test(k) && Number(k.match(/^item_(\d+)_/)[1]) > t.items.length;
    const fields = used.filter((k) => !optional(k)).map((k) => {
      const v = values[k];
      const label = PAYMENT_REQUEST_CATALOG.text.find((p) => p.key === k.split(':')[0])?.label || k;
      return { key: k, label, value: v === null || v === undefined ? null : typeof v === 'number' ? fmtNum(v) : v, missing: (v === null || v === undefined || v === '') && !OPTIONAL_KEY.test(k) };
    });
    const missing = fields.filter((f) => f.missing).map((f) => f.label);
    if (info.item_slots && t.items.length > info.item_slots) missing.push(`النموذج يتسع لـ ${info.item_slots} مخرجات فقط والطلب فيه ${t.items.length}`);
    return { r, template, info, values, approvers, fields, missing: [...new Set(missing)], totals: t };
  }

  function previewRequest(company, id, input) {
    const x = requestDocument(company, id, input || {});
    return { template: { version: x.template.version, file: x.template.original_name }, approver_slots: x.info.approver_slots, item_slots: x.info.item_slots,
      approvers: x.approvers, fields: x.fields, missing: x.missing, images: [], warnings: x.r.status === 'cancelled' ? ['الطلب ملغى.'] : [] };
  }

  function issueRequest(company, id, input, userId) {
    input = input || {};
    return tx(db, () => {
      const pre = loadRequest(company.id, id);
      if (!['draft', 'issued'].includes(pre.status)) throw new HttpError(409, `لا يمكن إصدار طلب بحالة «${REQ_STATUS[pre.status]}».`);
      const x = requestDocument(company, id, input);
      cleanApprovers(input.approvers ?? x.approvers, x.info.approver_slots, { required: true });
      if (x.missing.length) throw new HttpError(422, `بيانات ناقصة مطلوبة في نموذج طلب الدفعة: ${x.missing.join('، ')}.`, 'missing_fields');
      const numeric = new Set(['request_amount', 'contract_total', 'contract_paid', 'contract_remaining', ...Array.from({ length: MAX_REQUEST_ITEMS }, (_, i) => `item_${i + 1}_amount`)]);
      const out = fillXlsx(readFile(db, storageDir, company.id, x.template.file_id).buffer, x.values, numeric);
      const consultant = consultantOf(company.id, loadContractRow(company.id, pre.contract_id).consultant_id);
      const filename = `طلب دفعة - ${safeName(consultant.full_name_ar)} - ${safeName(pre.request_no)}.xlsx`;
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: 'payment-request', filename, buffer: out, allowed: ['xlsx'], userId });
      db.prepare(`UPDATE payment_requests SET status = 'issued', approvers_json = ?, file_id = ?, template_version = ?, issued_at = datetime('now'), issued_by = ?, updated_at = datetime('now')
                  WHERE company_id = ? AND id = ?`).run(JSON.stringify(x.approvers), fileId, x.template.version, userId ?? null, company.id, pre.id);
      event(company.id, pre.contract_id, null, pre.issued_at ? 'payment_request_reissued' : 'payment_request_issued', `${pre.request_no} — ${fmtNum(x.totals.requested)} — المعتمدون: ${x.approvers.map((a) => a.name).join('، ')}`, userId, pre.id);
      return { filename, request_id: pre.id, request_no: pre.request_no };
    });
  }

  function markRequestSent(company, id, input, userId) {
    const r = loadRequest(company.id, id);
    if (r.status !== 'issued' && r.status !== 'sent') throw new HttpError(409, 'أصدر طلب الدفعة أولًا قبل تسجيل إرساله.');
    const sentAt = date(input?.sent_at, 'تاريخ الإرسال', { required: true });
    if (sentAt > riyadhToday()) throw new HttpError(400, 'تاريخ الإرسال لا يمكن أن يكون في المستقبل.');
    db.prepare(`UPDATE payment_requests SET status = 'sent', sent_at = ?, sent_to = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`)
      .run(sentAt, str(input?.sent_to, 300) ?? null, company.id, r.id);
    event(company.id, r.contract_id, null, 'payment_request_sent', [r.request_no, fmtDate(sentAt), str(input?.sent_to, 300)].filter(Boolean).join(' — '), userId, r.id);
    return getRequest(company, r.id);
  }

  function cancelRequest(company, id, input, userId) {
    const reason = str(input?.reason, 500);
    if (!reason) throw new HttpError(400, 'سبب إلغاء الطلب مطلوب.');
    return tx(db, () => {
      const r = loadRequest(company.id, id);
      if (r.status === 'cancelled') throw new HttpError(409, 'الطلب ملغى بالفعل.');
      if (requestTotals(company.id, r).paid > EPS) throw new HttpError(409, 'سُجّلت دفعات على هذا الطلب؛ لا يمكن إلغاؤه. يمكن للمسؤول إلغاء الدفعات أولًا.');
      db.prepare(`UPDATE payment_requests SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?, updated_at = datetime('now') WHERE company_id = ? AND id = ?`).run(reason, company.id, r.id);
      event(company.id, r.contract_id, null, 'payment_request_cancelled', `${r.request_no} — ${reason}`, userId, r.id);
      return getRequest(company, r.id);
    });
  }

  // Records what Finance actually transferred against a request; split over its
  // lines in order, never more than requested or than what is still unpaid.
  function recordRequestPayment(company, id, input, userId) {
    input = input || {};
    if (input.finance_confirmed !== true) throw new HttpError(400, 'يجب تأكيد أن الإدارة المالية أكدت التحويل الفعلي قبل تسجيل الدفعة.', 'finance_confirmation_required');
    const amount = money(input.amount, 'المبلغ المصروف', { required: true });
    if (!(amount > 0)) throw new HttpError(400, 'المبلغ المصروف يجب أن يكون أكبر من صفر.');
    return tx(db, () => {
      const r = loadRequest(company.id, id);
      if (!['issued', 'sent'].includes(r.status)) throw new HttpError(409, 'سجّل الصرف بعد إصدار طلب الدفعة.');
      const t = requestTotals(company.id, r);
      const plan = [];
      let left = amount;
      for (const it of t.items) {
        if (left <= EPS) break;
        const d = loadDeliverable(company.id, it.deliverable_id);
        const cap = Math.min(it.outstanding, d.remaining);
        const a = Math.round(Math.min(cap, left) * 100) / 100;
        if (a > EPS) { plan.push([it.deliverable_id, a]); left = Math.round((left - a) * 100) / 100; }
      }
      if (left > EPS) throw new HttpError(409, `المبلغ أكبر من المتبقي غير المصروف على الطلب (${fmtNum(Math.round((amount - left) * 100) / 100)}).`);
      const ids = plan.map(([did, a]) => {
        const p = recordPayment(company, did, { amount: a, paid_at: input.paid_at, transfer_reference: input.transfer_reference, note: input.note ?? r.request_no, finance_confirmed: true }, userId);
        db.prepare('INSERT INTO payment_request_payments (company_id, request_id, payment_id) VALUES (?, ?, ?)').run(company.id, r.id, p.payment_id);
        return p.payment_id;
      });
      event(company.id, r.contract_id, null, 'payment_request_paid', `${r.request_no} — ${fmtNum(amount)} — ${fmtDate(input.paid_at)}`, userId, r.id);
      return { ...getRequest(company, r.id), recorded_payment_ids: ids };
    });
  }

  function requestFile(company, id) {
    const r = loadRequest(company.id, id);
    if (!r.file_id) throw new HttpError(404, 'لم يُصدر ملف طلب الدفعة بعد.');
    return readFile(db, storageDir, company.id, r.file_id);
  }

  // ======================================================================
  // Deliverables across contracts, and what can be prepared (also for Maha)
  // ======================================================================
  function listDeliverables(company, f = {}) {
    const today = riyadhToday();
    const rows = db.prepare(`SELECT d.*, c.contract_no, c.status AS contract_status, c.consultant_id, k.full_name_ar AS consultant_name FROM v_deliverables d
                             JOIN consulting_contracts c ON c.company_id = d.company_id AND c.id = d.contract_id
                             JOIN consultants k ON k.company_id = c.company_id AND k.id = c.consultant_id
                             WHERE d.company_id = ? ORDER BY d.due_date, c.contract_no, d.seq`).all(company.id)
      .map((d) => { const x = decorateDeliverable(d, today); const claim = openClaim(company.id, d.id); return { ...x, open_claim: claim.amount, open_requests: claim.requests, claimable: Math.max(0, Math.round((x.remaining - claim.amount) * 100) / 100) }; });
    const pick = {
      overdue: (d) => d.contract_status !== 'draft' && d.due_state === 'overdue',
      upcoming: (d) => d.contract_status !== 'draft' && d.due_state === 'upcoming',
      no_certificate: (d) => d.contract_status !== 'draft' && !d.certificate_issued_at,
      not_sent: (d) => !!d.certificate_issued_at && !d.certificate_sent_at,
      to_request: (d) => !!d.certificate_issued_at && d.claimable > EPS,
      awaiting_payment: (d) => d.open_claim > EPS,
      paid: (d) => d.payment_status === 'paid',
    }[f.state];
    let out = pick ? rows.filter(pick) : rows;
    if (f.contract_id) out = out.filter((d) => d.contract_id === Number(f.contract_id));
    if (f.q) { const q = String(f.q).trim(); out = out.filter((d) => [d.title, d.contract_no, d.consultant_name, d.certificate_ref].some((v) => v && String(v).includes(q))); }
    return out;
  }

  // What could be prepared now; Maha will read this later and still needs the user's confirmation to issue.
  function ready(company) {
    const tpl = templateStatus(company);
    const d = listDeliverables(company, {});
    return {
      templates: { certificate: !!tpl.certificate, payment_request: !!tpl.payment_request },
      certificates: d.filter((x) => ['active', 'terminated', 'closed'].includes(x.contract_status) && !x.certificate_issued_at && x.due_date <= addDays(riyadhToday(), 30))
        .map((x) => ({ deliverable_id: x.id, contract_id: x.contract_id, contract_no: x.contract_no, consultant_name: x.consultant_name, seq: x.seq, title: x.title, due_date: x.due_date })),
      payment_requests: d.filter((x) => x.certificate_issued_at && x.claimable > EPS)
        .map((x) => ({ deliverable_id: x.id, contract_id: x.contract_id, contract_no: x.contract_no, consultant_name: x.consultant_name, seq: x.seq, title: x.title, claimable: x.claimable })),
    };
  }

  // ---------- follow-up dashboard ----------
  function summary(company, { days = 30 } = {}) {
    days = Math.min(Math.max(Number(days) || 30, 1), 365);
    const today = riyadhToday();
    const horizon = addDays(today, days);
    const base = `SELECT d.*, c.contract_no, c.status AS contract_status, k.full_name_ar AS consultant_name
                  FROM v_deliverables d
                  JOIN consulting_contracts c ON c.company_id = d.company_id AND c.id = d.contract_id
                  JOIN consultants k ON k.company_id = c.company_id AND k.id = c.consultant_id
                  WHERE d.company_id = ? AND c.status != 'draft'`;
    const unpaid = `AND d.amount - d.paid_total > ${EPS}`;
    const dec = (rows) => rows.map((d) => decorateDeliverable(d, today, days));
    const totals = db.prepare(`SELECT COALESCE(SUM(d.amount), 0) AS total, COALESCE(SUM(d.paid_total), 0) AS paid
                               FROM v_deliverables d JOIN consulting_contracts c ON c.company_id = d.company_id AND c.id = d.contract_id
                               WHERE d.company_id = ? AND c.status != 'draft'`).get(company.id);
    const contracts = db.prepare(`SELECT c.id, c.contract_no, c.end_date, c.status, k.full_name_ar AS consultant_name FROM consulting_contracts c
                                  JOIN consultants k ON k.company_id = c.company_id AND k.id = c.consultant_id
                                  WHERE c.company_id = ? AND c.status = 'active' AND c.end_date IS NOT NULL AND c.end_date <= ? ORDER BY c.end_date`).all(company.id, horizon);
    return {
      today, days,
      counts: {
        active: db.prepare(`SELECT COUNT(*) n FROM consulting_contracts WHERE company_id = ? AND status = 'active'`).get(company.id).n,
        draft: db.prepare(`SELECT COUNT(*) n FROM consulting_contracts WHERE company_id = ? AND status IN ('draft', 'sent')`).get(company.id).n,
      },
      money: { total: totals.total, paid: totals.paid, outstanding: Math.max(0, Math.round((totals.total - totals.paid) * 100) / 100) },
      overdue: dec(db.prepare(`${base} ${unpaid} AND d.due_date < ? ORDER BY d.due_date`).all(company.id, today)),
      upcoming: dec(db.prepare(`${base} ${unpaid} AND d.due_date BETWEEN ? AND ? ORDER BY d.due_date`).all(company.id, today, horizon)),
      certificates_to_send: dec(db.prepare(`${base} AND d.certificate_issued_at IS NOT NULL AND d.certificate_sent_at IS NULL ORDER BY d.certificate_issued_at`).all(company.id)),
      awaiting_payment: dec(db.prepare(`${base} ${unpaid} AND d.certificate_sent_at IS NOT NULL ORDER BY d.certificate_sent_at`).all(company.id)),
      contracts_ending: contracts.filter((c) => c.end_date >= today),
      contracts_expired: contracts.filter((c) => c.end_date < today),
    };
  }

  function file(company, kind, id) {
    if (kind === 'contract' || kind === 'signed') {
      const c = loadContractRow(company.id, id);
      const fid = kind === 'contract' ? c.generated_file_id : c.signed_file_id;
      if (!fid) throw new HttpError(404, kind === 'contract' ? 'لم يُصدر ملف العقد بعد.' : 'لم تُرفع النسخة الموقعة بعد.');
      return readFile(db, storageDir, company.id, fid);
    }
    const d = loadDeliverable(company.id, id);
    if (!d.certificate_file_id) throw new HttpError(404, 'لم تصدر شهادة لهذا المخرج بعد.');
    return readFile(db, storageDir, company.id, d.certificate_file_id);
  }

  return {
    listContracts, getContract, createContract, updateContract, changeStatus, attachSigned,
    templateStatus, previewContract, generateContract,
    previewCertificate, issueCertificate, markCertificateSent, recordPayment, deletePayment: voidPayment, voidPayment, correctPayment,
    summary, file, listConsultants, getConsultant, consultantMatch, createContractWithConsultant, approverSuggestions, certificateHistory,
    requestable, listRequests, getRequest, createRequest, updateRequest, previewRequest, issueRequest, markRequestSent, cancelRequest,
    recordRequestPayment, requestFile, listDeliverables, ready,
  };
}

const safeName = (s) => String(s ?? '').replace(/[\\/:*?"<>|]+/g, '-').trim();
