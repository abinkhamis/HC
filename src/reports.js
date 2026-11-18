// Reports centre: one activity feed built from the tools' own logs (who did what, when),
// the weekly team report, and directory reports. Output as Excel (.xlsx) or as a printable
// page the browser saves as PDF (no Word needed, so it also works on a hosted server).
// Everything is read-only and scoped to one company.
import { buildXlsx } from './xlsx.js';
import { annotateEmployees, DISPLAY_STATUS } from './employees.js';
import { HttpError } from './errors.js';

const SOURCE = {
  employees: 'الموظفون', procedures: 'متابعة الإجراءات', air_tickets: 'تذاكر الطيران',
  attestations: 'تصديقات الغرفة التجارية', consulting: 'الاستشاريون والعقود', letters: 'الخطابات',
};

// Arabic names of the logged events (same wording as the tools' own logs)
const LABELS = {
  employees: { created: 'إضافة موظف', updated: 'تعديل بيانات موظف', imported: 'إنشاء من ملف النشطين', import_updated: 'تحديث من ملف النشطين',
    import_linked: 'ربط بملف النشطين', start_confirmed: 'تأكيد المباشرة', end_confirmed: 'تأكيد انتهاء الخدمة', number_assigned: 'إضافة الرقم الوظيفي' },
  procedures: { case_opened: 'فتح حالة', case_updated: 'تعديل بيانات الحالة', case_closed: 'إغلاق الحالة', case_cancelled: 'إلغاء الحالة', case_reopened: 'إعادة فتح',
    case_deleted: 'حذف الحالة', step_updated: 'تحديث إجراء', step_done: 'إنجاز إجراء', step_added: 'إضافة إجراء للحالة', step_removed: 'حذف إجراء من الحالة',
    letter_linked: 'ربط خطاب', letter_unlinked: 'إلغاء ربط خطاب', checklist_changed: 'تعديل قائمة الإجراءات', checklist_added: 'إضافة إجراء للقائمة',
    list_item_added: 'إضافة عنصر قائمة', list_item_updated: 'تعديل عنصر قائمة', member_added: 'إضافة عضو فريق', member_updated: 'تعديل عضو فريق',
    employee_created: 'إنشاء سجل الموظف', employee_started: 'تأكيد المباشرة', employee_ended: 'تأكيد انتهاء الخدمة', employee_no_assigned: 'إضافة الرقم الوظيفي' },
  air_tickets: { historical_added: 'إدخال سجل تاريخي', disbursement_added: 'تسجيل صرف تذكرة', disbursement_updated: 'تعديل سجل صرف', disbursement_deleted: 'حذف سجل صرف',
    family_set: 'تحديد عدد أفراد الأسرة', family_deleted: 'حذف استحقاق الأسرة', profile_updated: 'تعديل بيانات التذاكر',
    opening_approved: 'اعتماد الرصيد الافتتاحي', opening_revoked: 'إلغاء اعتماد الرصيد', policy_changed: 'تعديل سياسة التذاكر' },
  attestations: { created: 'إنشاء طلب تصديق', updated: 'تعديل طلب تصديق', deleted: 'حذف طلب تصديق', recalculated: 'إعادة احتساب', needs_review: 'يحتاج مراجعة',
    'status:submit': 'إرسال للتصديق', 'status:attest': 'تم التصديق', 'status:deliver': 'تم التسليم', 'status:cancel': 'إلغاء طلب', 'status:reopen': 'إعادة فتح طلب',
    deduction_confirmed: 'تأكيد الخصم', deduction_reverted: 'إلغاء تأكيد الخصم', deduction_waived: 'إعفاء من الخصم', waiver_reverted: 'إلغاء الإعفاء', policy_changed: 'تعديل سياسة التصديقات' },
  consulting: { created: 'إنشاء عقد', updated: 'تعديل بيانات عقد', contract_generated: 'إصدار ملف العقد', signed_copy_uploaded: 'رفع النسخة الموقعة',
    'status:mark_sent': 'تسجيل إرسال العقد للتوقيع', 'status:mark_signed': 'تسجيل توقيع العقد', 'status:terminate': 'إنهاء عقد', 'status:close': 'إغلاق عقد', 'status:reopen': 'إعادة فتح عقد',
    certificate_issued: 'إصدار شهادة إنجاز', certificate_reissued: 'إعادة إصدار شهادة إنجاز', certificate_sent: 'تسجيل إرسال الشهادة',
    payment_recorded: 'تسجيل صرف دفعة', payment_deleted: 'حذف دفعة', payment_voided: 'إلغاء صرف', payment_corrected: 'تصحيح صرف', consultant_created: 'إضافة استشاري مع العقد',
    payment_request_created: 'إنشاء طلب دفعة', payment_request_updated: 'تعديل طلب دفعة', payment_request_issued: 'إصدار طلب الدفعة', payment_request_reissued: 'إعادة إصدار طلب الدفعة',
    payment_request_sent: 'إرسال طلب الدفعة للمالية', payment_request_cancelled: 'إلغاء طلب الدفعة', payment_request_paid: 'تسجيل صرف على الطلب' },
  letters: { issued: 'إصدار خطاب' },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
// Riyadh is UTC+3 all year: a Riyadh calendar day maps to a fixed UTC window.
const utcStart = (d) => `${addDays(d, -1)} 21:00:00`;
const toRiyadh = (utc) => { const t = new Date(String(utc).replace(' ', 'T') + 'Z'); t.setUTCHours(t.getUTCHours() + 3); return t.toISOString().slice(0, 16).replace('T', ' '); };
const fmtDate = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

/** Week = Sunday to Saturday (the Saudi work week starts on Sunday). */
export function weekOf(dateStr) {
  const d = DATE.test(String(dateStr || '')) ? dateStr : riyadhToday();
  const dow = new Date(d + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  const from = addDays(d, -dow);
  return { from, to: addDays(from, 6) };
}

function period(q) {
  let from = String(q.get?.('from') ?? q.from ?? '').trim();
  let to = String(q.get?.('to') ?? q.to ?? '').trim();
  if (!from && !to) return weekOf(q.get?.('week') ?? q.week);
  if (!DATE.test(from) || !DATE.test(to)) throw new HttpError(400, 'حدد تاريخ البداية والنهاية.');
  if (to < from) [from, to] = [to, from];
  if (addDays(from, 370) < to) throw new HttpError(400, 'أقصى فترة للتقرير سنة واحدة.');
  return { from, to };
}

export function createReports(db) {
  // ---------- activity feed ----------
  function activity(company, { from, to }) {
    const a = utcStart(from), b = utcStart(addDays(to, 1));
    const p = [company.id, a, b];
    const rows = db.prepare(`
      SELECT 'employees' AS source, e.event, e.detail, e.user_id, e.created_at, emp.full_name_ar AS subject, e.changes_json
        FROM employee_events e LEFT JOIN employees emp ON emp.company_id = e.company_id AND emp.id = e.employee_id
       WHERE e.company_id = ? AND e.created_at >= ? AND e.created_at < ?
      UNION ALL
      SELECT 'procedures', e.event, e.detail, e.user_id, e.created_at,
             COALESCE(c.employee_name, e.case_no), e.changes_json
        FROM proc_events e LEFT JOIN proc_cases c ON c.company_id = e.company_id AND c.id = e.case_id
       WHERE e.company_id = ? AND e.created_at >= ? AND e.created_at < ?
      UNION ALL
      SELECT 'air_tickets', e.event, e.detail, e.user_id, e.created_at, emp.full_name_ar, e.changes_json
        FROM air_ticket_events e LEFT JOIN employees emp ON emp.company_id = e.company_id AND emp.id = e.employee_id
       WHERE e.company_id = ? AND e.created_at >= ? AND e.created_at < ?
      UNION ALL
      SELECT 'attestations', e.event, e.detail, e.user_id, e.created_at, e.request_no, e.changes_json
        FROM attestation_events e WHERE e.company_id = ? AND e.created_at >= ? AND e.created_at < ?
      UNION ALL
      SELECT 'consulting', e.event, e.detail, e.user_id, e.created_at, k.contract_no, NULL
        FROM contract_events e LEFT JOIN consulting_contracts k ON k.company_id = e.company_id AND k.id = e.contract_id
       WHERE e.company_id = ? AND e.created_at >= ? AND e.created_at < ?
      UNION ALL
      SELECT 'letters', 'issued', lt.name_ar || ' — ' || l.reference_no, l.issued_by, l.issued_at, emp.full_name_ar, NULL
        FROM issued_letters l LEFT JOIN letter_types lt ON lt.id = l.letter_type_id
        LEFT JOIN employees emp ON emp.company_id = l.company_id AND emp.id = l.employee_id
       WHERE l.company_id = ? AND l.issued_at >= ? AND l.issued_at < ?
      ORDER BY 5 DESC`).all(...p, ...p, ...p, ...p, ...p, ...p);
    const users = new Map(db.prepare('SELECT id, display_name FROM users').all().map((u) => [u.id, u.display_name]));
    return rows.map((r) => {
      let event = r.event;
      // a step marked done is reported as a finished task
      if (r.source === 'procedures' && event === 'step_updated' && /"status":\[[^\]]*"مكتمل"\]/.test(r.changes_json || '')) event = 'step_done';
      return {
        at: toRiyadh(r.created_at), source: r.source, source_label: SOURCE[r.source],
        event, action: LABELS[r.source]?.[event] || event, subject: r.subject || '', detail: r.detail || '',
        user_id: r.user_id, user: r.user_id ? users.get(r.user_id) || '—' : 'النظام',
      };
    });
  }

  // ---------- weekly team report ----------
  function weekly(company, query) {
    const range = period(query);
    const items = activity(company, range);
    const people = new Map();
    for (const it of items) {
      const k = it.user;
      if (!people.has(k)) people.set(k, { user: k, total: 0, done_tasks: 0, by_source: {}, items: [] });
      const p = people.get(k);
      p.total++;
      if (it.event === 'step_done') p.done_tasks++;
      p.by_source[it.source_label] = (p.by_source[it.source_label] || 0) + 1;
      p.items.push(it);
    }
    // open procedure tasks (steps of open cases) and who owns them
    const today = riyadhToday();
    const open = db.prepare(`SELECT s.name_ar AS task, s.due_date, c.case_no, c.employee_name, c.case_type, m.name AS owner
                               FROM proc_case_steps s JOIN proc_cases c ON c.company_id = s.company_id AND c.id = s.case_id
                               LEFT JOIN proc_team_members m ON m.company_id = s.company_id AND m.id = s.owner_member_id
                              WHERE s.company_id = ? AND c.status = 'open' AND s.status IN ('pending', 'in_progress')
                              ORDER BY s.due_date IS NULL, s.due_date, c.case_no`).all(company.id)
      .map((t) => ({ ...t, owner: t.owner || 'بدون مسؤول', overdue: !!t.due_date && t.due_date < today, case_label: t.case_type === 'onboarding' ? 'انضمام' : 'إنهاء خدمة' }));
    const ownerSummary = [...open.reduce((m, t) => {
      const o = m.get(t.owner) || { owner: t.owner, open: 0, overdue: 0 };
      o.open++; if (t.overdue) o.overdue++;
      return m.set(t.owner, o);
    }, new Map()).values()].sort((x, y) => y.open - x.open);
    return {
      company: { name_ar: company.name_ar, name_en: company.name_en }, ...range, generated_at: toRiyadh(new Date().toISOString().slice(0, 19).replace('T', ' ')),
      totals: { actions: items.length, people: people.size, done_tasks: items.filter((i) => i.event === 'step_done').length, open_tasks: open.length, overdue: open.filter((t) => t.overdue).length },
      people: [...people.values()].sort((x, y) => y.total - x.total),
      open_tasks: open, owners: ownerSummary,
    };
  }

  function weeklyXlsx(company, query) {
    const w = weekly(company, query);
    const t = `${company.name_ar} — من ${fmtDate(w.from)} إلى ${fmtDate(w.to)}`;
    return buildXlsx([
      { name: 'ملخص الفريق', title: `التقرير الأسبوعي للفريق — ${t}`,
        columns: [{ header: 'الموظف', width: 28 }, { header: 'عدد العمليات', type: 'int', width: 14 }, { header: 'مهام أنجزها', type: 'int', width: 14 }, { header: 'التوزيع حسب الأداة', width: 70 }],
        rows: w.people.map((p) => [p.user, p.total, p.done_tasks, Object.entries(p.by_source).map(([k, v]) => `${k}: ${v}`).join(' · ')]) },
      { name: 'العمليات', title: `كل العمليات — ${t}`,
        columns: [{ header: 'الوقت (الرياض)', width: 18 }, { header: 'الموظف', width: 24 }, { header: 'الأداة', width: 22 }, { header: 'العملية', width: 28 }, { header: 'على', width: 28 }, { header: 'التفاصيل', width: 60 }],
        rows: w.people.flatMap((p) => p.items).sort((x, y) => (x.at < y.at ? 1 : -1)).map((i) => [i.at, i.user, i.source_label, i.action, i.subject, i.detail]) },
      { name: 'المهام المفتوحة', title: `المهام المفتوحة ومسؤولوها — حتى ${fmtDate(riyadhToday())}`,
        columns: [{ header: 'المسؤول', width: 24 }, { header: 'المهمة', width: 34 }, { header: 'الموظف', width: 28 }, { header: 'نوع الحالة', width: 14 }, { header: 'رقم الحالة', width: 16 }, { header: 'الموعد', width: 14 }, { header: 'متأخرة', width: 10 }],
        rows: w.open_tasks.map((o) => [o.owner, o.task, o.employee_name, o.case_label, o.case_no, fmtDate(o.due_date), o.overdue ? 'نعم' : '']) },
    ]);
  }

  // ---------- directory reports ----------
  function employees(company, query) {
    const status = String(query.get?.('status') ?? query.status ?? '');
    let rows = annotateEmployees(db, company.id, db.prepare('SELECT * FROM employees WHERE company_id = ? ORDER BY full_name_ar').all(company.id));
    if (status && DISPLAY_STATUS[status]) rows = rows.filter((e) => e.display_status === status);
    return rows.map((e) => ({ employee_no: e.employee_no, full_name_ar: e.full_name_ar, department: e.department, job_title: e.job_title,
      nationality: e.nationality_ar || e.nationality_en, hire_date: e.hire_date, end_date: e.end_date, status: DISPLAY_STATUS[e.display_status] }));
  }
  function movements(company, query) {
    const r = period(query);
    const joiners = db.prepare('SELECT * FROM employees WHERE company_id = ? AND hire_date BETWEEN ? AND ? ORDER BY hire_date').all(company.id, r.from, r.to);
    const leavers = db.prepare('SELECT * FROM employees WHERE company_id = ? AND end_date BETWEEN ? AND ? ORDER BY end_date').all(company.id, r.from, r.to);
    const pick = (e) => ({ employee_no: e.employee_no, full_name_ar: e.full_name_ar, department: e.department, job_title: e.job_title, hire_date: e.hire_date, end_date: e.end_date });
    return { ...r, joiners: joiners.map(pick), leavers: leavers.map(pick) };
  }

  const EMP_COLS = [{ header: 'الرقم الوظيفي', width: 14 }, { header: 'الاسم', width: 30 }, { header: 'الإدارة', width: 20 }, { header: 'المسمى', width: 22 }];
  function employeesXlsx(company, query) {
    const rows = employees(company, query);
    return buildXlsx([{ name: 'الموظفون', title: `دليل الموظفين — ${company.name_ar} — ${fmtDate(riyadhToday())}`,
      columns: [...EMP_COLS, { header: 'الجنسية', width: 14 }, { header: 'تاريخ المباشرة', width: 14 }, { header: 'آخر يوم عمل', width: 14 }, { header: 'الحالة', width: 16 }],
      rows: rows.map((e) => [e.employee_no, e.full_name_ar, e.department, e.job_title, e.nationality, fmtDate(e.hire_date), fmtDate(e.end_date), e.status]) }]);
  }
  function movementsXlsx(company, query) {
    const m = movements(company, query);
    const t = `${company.name_ar} — من ${fmtDate(m.from)} إلى ${fmtDate(m.to)}`;
    return buildXlsx([
      { name: 'المباشرون', title: `المباشرون — ${t}`, columns: [...EMP_COLS, { header: 'تاريخ المباشرة', width: 14 }], rows: m.joiners.map((e) => [e.employee_no, e.full_name_ar, e.department, e.job_title, fmtDate(e.hire_date)]) },
      { name: 'المنتهية خدماتهم', title: `المنتهية خدماتهم — ${t}`, columns: [...EMP_COLS, { header: 'آخر يوم عمل', width: 14 }], rows: m.leavers.map((e) => [e.employee_no, e.full_name_ar, e.department, e.job_title, fmtDate(e.end_date)]) },
    ]);
  }
  function activityXlsx(company, query) {
    const r = period(query);
    const items = activity(company, r);
    return buildXlsx([{ name: 'سجل النشاط', title: `سجل نشاط المنصة — ${company.name_ar} — من ${fmtDate(r.from)} إلى ${fmtDate(r.to)}`,
      columns: [{ header: 'الوقت (الرياض)', width: 18 }, { header: 'الموظف', width: 24 }, { header: 'الأداة', width: 22 }, { header: 'العملية', width: 28 }, { header: 'على', width: 28 }, { header: 'التفاصيل', width: 60 }],
      rows: items.map((i) => [i.at, i.user, i.source_label, i.action, i.subject, i.detail]) }]);
  }

  return { activity: (c, q) => { const r = period(q); return { ...r, items: activity(c, r) }; }, weekly, weeklyXlsx, employees, employeesXlsx, movements, movementsXlsx, activityXlsx };
}

// ---------- printable pages (the browser's «حفظ بتنسيق PDF») ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export function printPage(title, subtitle, sections, brand = '#3d4654') {
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
@page { size: A4; margin: 14mm 12mm; }
body { font-family: 'DIN Next LT Arabic', 'Itf Huwiya Arabic', 'Segoe UI', Tahoma, sans-serif; color: #222; margin: 0; padding: 24px; font-size: 12.5px; }
header { border-bottom: 3px solid ${esc(brand)}; padding-bottom: 10px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; color: ${esc(brand)}; } .sub { color: #666; margin-top: 4px; }
h2 { font-size: 15px; margin: 20px 0 8px; color: ${esc(brand)}; }
table { width: 100%; border-collapse: collapse; margin-bottom: 8px; } th, td { border: 1px solid #ddd; padding: 5px 7px; text-align: right; vertical-align: top; }
th { background: #f3f3f3; font-weight: 600; } tr { page-break-inside: avoid; }
.cards { display: flex; gap: 10px; flex-wrap: wrap; } .card { border: 1px solid #ddd; border-radius: 8px; padding: 8px 14px; min-width: 110px; }
.card b { display: block; font-size: 20px; } .muted { color: #777; } .late { color: #b42318; font-weight: 600; }
.bar { position: sticky; top: 0; background: #fff; padding: 8px 0 12px; } .bar button { font: inherit; padding: 7px 16px; border-radius: 8px; border: 1px solid #ccc; background: ${esc(brand)}; color: #fff; cursor: pointer; }
@media print { .bar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="bar"><button onclick="window.print()">حفظ PDF / طباعة</button> <span class="muted">اختر «حفظ بتنسيق PDF» في نافذة الطباعة.</span></div>
<header><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></header>
${sections.join('\n')}
<script>setTimeout(() => window.print(), 400);</script>
</body></html>`;
}
export const htmlTable = (headers, rows) => rows.length
  ? `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => (c && typeof c === 'object' && 'html' in c ? `<td>${c.html}</td>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="muted">لا يوجد.</p>';
export { esc as escHtml, fmtDate };
