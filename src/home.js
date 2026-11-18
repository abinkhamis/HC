// Home page data: what matters today for one company — this month's starters and leavers,
// tickets and consulting deliverables due this month, and the tasks that need action.
// Read-only; everything comes from the tools' own records.
const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const monthBounds = (today) => {
  const from = today.slice(0, 8) + '01';
  const t = new Date(from + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + 1); t.setUTCDate(0);
  return { from, to: t.toISOString().slice(0, 10) };
};

export function createHome(db, { airTickets } = {}) {
  function progressOf(companyId, caseId) {
    const r = db.prepare(`SELECT COUNT(*) total, SUM(status IN ('done', 'na')) finished FROM proc_case_steps WHERE company_id = ? AND case_id = ?`).get(companyId, caseId);
    return { total: r.total || 0, finished: r.finished || 0 };
  }

  function summary(company, user) {
    const today = riyadhToday();
    const week = addDays(today, 7);
    const month = monthBounds(today);
    const cid = company.id;

    // ---- starters this month (hire date in the month), with their onboarding progress
    const starters = db.prepare(`SELECT e.id, e.full_name_ar, e.job_title, e.department, e.hire_date, e.status,
                                        (SELECT c.id FROM proc_cases c WHERE c.company_id = e.company_id AND c.employee_id = e.id AND c.case_type = 'onboarding' AND c.status != 'cancelled' ORDER BY c.id DESC LIMIT 1) AS case_id
                                   FROM employees e WHERE e.company_id = ? AND e.hire_date BETWEEN ? AND ? ORDER BY e.hire_date, e.full_name_ar`)
      .all(cid, month.from, month.to)
      .map((e) => ({ ...e, started: e.status === 'active', awaiting_confirmation: e.status === 'onboarding' && e.hire_date <= today, progress: e.case_id ? progressOf(cid, e.case_id) : null }));

    // ---- leavers this month: last working day in the month (directory end date or an offboarding case)
    const leaverRows = db.prepare(`
      SELECT e.id, e.full_name_ar, e.job_title, e.department, COALESCE(c.key_date, e.end_date) AS last_day, e.status, c.id AS case_id
        FROM employees e
        LEFT JOIN proc_cases c ON c.company_id = e.company_id AND c.employee_id = e.id AND c.case_type = 'offboarding' AND c.status != 'cancelled'
       WHERE e.company_id = ? AND (c.key_date BETWEEN ? AND ? OR (c.id IS NULL AND e.end_date BETWEEN ? AND ?))
       ORDER BY last_day, e.full_name_ar`).all(cid, month.from, month.to, month.from, month.to);
    const seen = new Set();
    const leavers = leaverRows.filter((r) => !seen.has(r.id) && seen.add(r.id))
      .map((r) => ({ ...r, progress: r.case_id ? progressOf(cid, r.case_id) : null }));

    // ---- consulting deliverables (active contracts, not yet completed)
    const openDeliverables = db.prepare(`SELECT d.id, d.title, d.due_date, k.id AS contract_id, k.contract_no
                                           FROM contract_deliverables d JOIN consulting_contracts k ON k.company_id = d.company_id AND k.id = d.contract_id
                                          WHERE d.company_id = ? AND k.status = 'active' AND d.completion_date IS NULL`).all(cid);
    const dueThisMonth = openDeliverables.filter((d) => d.due_date >= month.from && d.due_date <= month.to);

    // ---- air tickets falling due this month (current, eligible employees)
    let ticketsDue = [];
    try {
      ticketsDue = (airTickets?.balances(company, { eligibility: 'eligible' }) || [])
        .filter((r) => r.employee.status !== 'inactive' && r.next_due && r.next_due >= month.from && r.next_due <= month.to)
        .map((r) => ({ employee_id: r.employee.id, full_name_ar: r.employee.full_name_ar, next_due: r.next_due }));
    } catch { ticketsDue = []; }

    // ---- tasks that need action, most urgent first
    const tasks = [];
    const when = (d) => (!d ? 'later' : d < today ? 'late' : d === today ? 'today' : d <= week ? 'week' : 'later');
    // procedure steps of open cases, with a due date up to a week ahead (or overdue)
    for (const s of db.prepare(`SELECT s.id, s.name_ar, s.due_date, c.id AS case_id, c.case_no, c.case_type, c.employee_name, m.name AS owner
                                  FROM proc_case_steps s JOIN proc_cases c ON c.company_id = s.company_id AND c.id = s.case_id
                                  LEFT JOIN proc_team_members m ON m.company_id = s.company_id AND m.id = s.owner_member_id
                                 WHERE s.company_id = ? AND c.status = 'open' AND s.status IN ('pending', 'in_progress') AND s.due_date IS NOT NULL AND s.due_date <= ?`).all(cid, week)) {
      tasks.push({ kind: 'step', title: s.name_ar, sub: `${s.case_type === 'onboarding' ? 'انضمام' : 'إنهاء خدمة'} · ${s.employee_name}${s.owner ? ` · المسؤول: ${s.owner}` : ''}`,
        date: s.due_date, when: when(s.due_date), link: `#/procedures/case/${s.case_id}`, action: 'متابعة' });
    }
    // starters whose start date has come but the start is not confirmed yet
    for (const c of db.prepare(`SELECT c.id, c.key_date, c.employee_name FROM proc_cases c JOIN employees e ON e.company_id = c.company_id AND e.id = c.employee_id
                                 WHERE c.company_id = ? AND c.case_type = 'onboarding' AND c.status = 'open' AND e.status = 'onboarding' AND c.key_date <= ?`).all(cid, today)) {
      tasks.push({ kind: 'confirm_start', title: `تأكيد مباشرة ${c.employee_name}`, sub: 'حلّ تاريخ المباشرة ولم تُؤكَّد بعد', date: c.key_date, when: c.key_date < today ? 'late' : 'today', link: `#/procedures/case/${c.id}`, action: 'تأكيد المباشرة' });
    }
    // consulting deliverables overdue or due within a week
    for (const d of openDeliverables.filter((x) => x.due_date <= week)) {
      tasks.push({ kind: 'deliverable', title: `مخرج «${d.title}»`, sub: `عقد ${d.contract_no} · ${d.due_date < today ? 'لم يُسلَّم وتجاوز موعده' : 'يستحق قريبًا'}`, date: d.due_date, when: when(d.due_date), link: `#/contracts/${d.contract_id}`, action: 'فتح العقد' });
    }
    // completion certificates issued but not recorded as sent
    for (const d of db.prepare(`SELECT d.title, d.certificate_issued_at, k.id AS contract_id, k.contract_no FROM contract_deliverables d JOIN consulting_contracts k ON k.company_id = d.company_id AND k.id = d.contract_id
                                 WHERE d.company_id = ? AND d.certificate_issued_at IS NOT NULL AND d.certificate_sent_at IS NULL`).all(cid)) {
      const issued = String(d.certificate_issued_at).slice(0, 10);
      tasks.push({ kind: 'certificate', title: `شهادة إنجاز لم تُسجَّل كمرسلة`, sub: `«${d.title}» · عقد ${d.contract_no}`, date: issued, when: issued <= addDays(today, -3) ? 'late' : 'today', link: `#/contracts/${d.contract_id}`, action: 'تسجيل الإرسال' });
    }
    const rank = { late: 0, today: 1, week: 2, later: 3 };
    tasks.sort((a, b) => rank[a.when] - rank[b.when] || String(a.date).localeCompare(String(b.date)));

    // greet with the name from the company team list when the account is linked to it
    const member = user ? db.prepare('SELECT name FROM proc_team_members WHERE company_id = ? AND user_id = ?').get(cid, user.id) : null;
    return {
      today, month, greeting_name: String(member?.name || user?.display_name || '').trim().split(/\s+/)[0],
      counts: {
        starters: starters.length, starters_started: starters.filter((s) => s.started).length,
        starters_upcoming: starters.filter((s) => s.hire_date > today).length,
        leavers: leavers.length, tickets_due: ticketsDue.length,
        deliverables_due: dueThisMonth.length, deliverables_late: openDeliverables.filter((d) => d.due_date < today).length,
        tasks_today: tasks.filter((t) => t.when === 'late' || t.when === 'today').length,
        tasks_late: tasks.filter((t) => t.when === 'late').length,
      },
      starters, leavers, tickets_due: ticketsDue, tasks,
    };
  }
  return { summary };
}
