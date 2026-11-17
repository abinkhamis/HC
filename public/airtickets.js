// Air tickets UI (non-Saudi employees): dashboard, balances, historical entry,
// disbursements, reports, change log and policy. All data is scoped to the
// selected company by the server; every number shown is calculated by the server.

const STATUS_PILL = { provisional: 'warn', approved: 'ok', not_required: 'ok', needs_review: 'danger' };
const EVENTS = {
  historical_added: 'إدخال سجل تاريخي', disbursement_added: 'تسجيل صرف', disbursement_updated: 'تعديل سجل صرف', disbursement_deleted: 'حذف سجل صرف',
  family_set: 'تحديد عدد أفراد الأسرة', family_deleted: 'حذف استحقاق الأسرة', profile_updated: 'تعديل بيانات التذاكر',
  opening_approved: 'اعتماد الرصيد الافتتاحي', opening_revoked: 'إلغاء اعتماد الرصيد', policy_changed: 'تعديل السياسة',
};
const FIELD_LABELS = {
  disbursed_on: 'تاريخ الصرف', entitlements_used: 'استحقاقات دورية', employee_included: 'الموظف ضمن المستفيدين', family_count: 'من الأسرة',
  ticket_amount: 'مبلغ التذاكر', exit_reentry_fee: 'رسوم الخروج والعودة', reference: 'المرجع', notes: 'ملاحظات', destination: 'وجهة السفر',
  travel_class: 'درجة السفر', cycle_months: 'دورة الاستحقاق (شهر)', due_soon_days: 'التنبيه المسبق (يوم)', tracking_start: 'تاريخ بدء التشغيل',
};

export function createAirTicketViews(ctx) {
  const { api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, state } = ctx;
  const isAdmin = () => state.session?.user.role === 'admin';
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const num = (n) => `<span class="ltr">${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>`;
  const money = (n) => (n === null || n === undefined ? '<span class="muted small">غير مسجل</span>' : `${num(n)} <span class="muted small">ر.س</span>`);
  const dmy = (iso) => (iso ? `<span class="ltr">${esc(iso.split('-').reverse().join('/'))}</span>` : '<span class="muted">—</span>');
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
  let META;
  const meta = async () => (META ||= await api('/api/air-tickets/meta'));
  const statusPill = (m, r) => pill(STATUS_PILL[r.balance_status], m.balance_status[r.balance_status]);
  const signed = (n) => (n < 0 ? `<b style="color:var(--danger)">${num(n)}</b>` : `<b>${num(n)}</b>`);
  const xlsxName = () => `تذاكر الطيران ${state.company.name_ar}.xlsx`;
  const exportXlsx = (qs = '') => download(`/api/air-tickets/export.xlsx${qs}`, xlsxName()).catch((e) => toast(e.message, 'error'));

  // ---------- home alerts ----------
  async function dashboardSection(el) {
    const s = await api('/api/air-tickets/summary');
    const a = s.alerts;
    const cards = [
      s.due_soon.length && `<a class="card stat" href="#/air-tickets"><span class="muted small">استحقاقات خلال ${s.policy.due_soon_days} يومًا</span><span class="num">${s.due_soon.length}</span></a>`,
      s.totals.remaining > 0 && `<a class="card stat" href="#/air-tickets/balances"><span class="muted small">استحقاقات متبقية (متراكمة)</span><span class="num">${s.totals.remaining}</span><span class="small muted">لدى ${s.accumulated.length} موظف</span></a>`,
      s.totals.provisional && `<a class="card stat" href="#/air-tickets/history"><span class="muted small">أرصدة مبدئية تحتاج مراجعة واعتماد</span><span class="num" style="color:var(--warn-text)">${s.totals.provisional}</span></a>`,
      a.missing_nationality.length && `<a class="card stat" href="#/air-tickets/balances"><span class="muted small">موظفون بلا جنسية في الدليل</span><span class="num" style="color:var(--danger)">${a.missing_nationality.length}</span></a>`,
      a.over_used.length && `<a class="card stat" href="#/air-tickets"><span class="muted small">أرصدة بالسالب</span><span class="num" style="color:var(--danger)">${a.over_used.length}</span></a>`,
    ].filter(Boolean);
    el.innerHTML = `
      <div class="spread" style="margin:28px 0 12px"><h2>تذاكر الطيران</h2><a class="btn small" href="#/air-tickets">فتح الأداة</a></div>
      ${cards.length ? `<div class="grid cols-3">${cards.join('')}</div>` : '<div class="card muted small">لا توجد تنبيهات على تذاكر الطيران.</div>'}`;
  }

  // ---------- shell ----------
  async function view(main, tab = 'dashboard', sub) {
    if (tab === 'employee' && sub) return employeePage(main, Number(sub));
    const tabs = [['dashboard', 'لوحة المتابعة'], ['balances', 'الأرصدة'], ['history', 'السجل التاريخي'], ['disbursements', 'سجل الصرف'], ['reports', 'التقارير'], ['log', 'سجل التعديلات'], ['policy', 'السياسة']];
    main.innerHTML = workspaceHead('تذاكر الطيران', '<button class="btn" id="air-xlsx">تصدير Excel</button><button class="btn primary" id="air-new">+ تسجيل صرف</button>') + `
      <p class="small muted" style="margin:-8px 0 12px">للموظفين غير السعوديين في دليل موظفي ${esc(state.company.name_ar)} — الأرقام محسوبة من تاريخ المباشرة وسياسة الشركة وسجل الصرف المسجل فقط.</p>
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<a role="tab" href="#/air-tickets/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div id="air-body"></div>`;
    const reload = () => view(main, tab);
    $('#air-new').addEventListener('click', () => disbursementForm({ source: 'current' }, reload));
    $('#air-xlsx').addEventListener('click', () => exportXlsx());
    const fn = { dashboard: dashboardTab, balances: balancesTab, history: historyTab, disbursements: disbursementsTab, reports: reportsTab, log: logTab, policy: policyTab }[tab] || dashboardTab;
    await fn($('#air-body'), reload);
  }

  const employeeTable = (rows, m, extra = { head: '', cell: () => '' }) => (rows.length ? `<div class="table-wrap"><table><thead><tr>
      <th>الموظف</th><th>الإدارة</th><th>تاريخ المباشرة</th><th>المستحق</th><th>المستخدم</th><th>المتبقي</th><th>تذاكر الأسرة المتبقية</th><th>الاستحقاق القادم</th><th>حالة الرصيد</th>${extra.head}</tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-emp="${r.employee.id}">
      <td>${esc(r.employee.full_name_ar)}${r.employee.employee_no ? ` <span class="muted small ltr">${esc(r.employee.employee_no)}</span>` : ''}${r.employee.status === 'inactive' ? ' ' + pill('off', 'منتهية خدماته') : ''}</td>
      <td>${esc(r.employee.department || '—')}</td><td>${dmy(r.employee.hire_date)}</td><td>${num(r.accrued)}</td><td>${num(r.used)}</td><td>${signed(r.remaining)}</td>
      <td>${r.family_accrued || r.family_used ? signed(r.family_remaining) : '<span class="muted small">—</span>'}</td><td>${dmy(r.next_due)}</td><td>${statusPill(m, r)}</td>${extra.cell(r)}</tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">لا يوجد.</div>');
  const bindRows = (el) => $$('[data-emp]', el).forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('button')) location.hash = `#/air-tickets/employee/${tr.dataset.emp}`; }));

  // ---------- dashboard ----------
  async function dashboardTab(el) {
    const m = await meta();
    const s = await api('/api/air-tickets/summary');
    const t = s.totals;
    const a = s.alerts;
    const empList = (rows) => rows.map((e) => `<a href="#/records/employees">${esc(e.full_name_ar)}</a>`).join('، ');
    el.innerHTML = `
      ${t.provisional ? `<div class="notice" style="margin-bottom:16px"><b>${t.provisional} رصيد غير نهائي.</b> الأرصدة المبدئية محسوبة من سجل الصرف المُدخل فقط، وما لم يُسجَّل يُحتسب متبقيًا. لا تُعتبر نهائية حتى يعتمد المسؤول الرصيد الافتتاحي بعد مراجعة السجلات التاريخية.</div>` : ''}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card stat"><span class="muted small">الموظفون غير السعوديين المشمولون</span><span class="num">${s.employees.eligible}</span><span class="small muted">على رأس العمل: ${s.employees.active_eligible}</span></div>
        <div class="card stat"><span class="muted small">الاستحقاقات المتبقية (المتراكمة)</span><span class="num">${num(t.remaining)}</span><span class="small muted">المستحق ${num(t.accrued)} · المستخدم ${num(t.used)}</span></div>
        <div class="card stat"><span class="muted small">تذاكر الأسرة المتبقية</span><span class="num">${num(t.family_remaining)}</span><span class="small muted">المستحق ${num(t.family_accrued)} · المصروف ${num(t.family_used)}</span></div>
        <div class="card stat"><span class="muted small">المصروف منذ ${dmy(s.from)}</span><span class="num small-num">${money(s.disbursed.total)}</span><span class="small muted">${s.disbursed.count} سجل · ${s.disbursed.beneficiaries} مستفيد</span></div>
      </div>
      <div class="stack">
        <div class="card stack"><div class="spread"><h2>الاستحقاقات القادمة خلال ${s.policy.due_soon_days} يومًا</h2><span class="pill info">${s.due_soon.length}</span></div>
          ${employeeTable(s.due_soon, m)}</div>
        <div class="card stack"><div class="spread"><h2>الأرصدة المتراكمة</h2><span class="pill info">${s.accumulated.length}</span></div>
          <p class="small muted" style="margin:0">موظفون لديهم استحقاق واحد أو أكثر لم يُسجَّل صرفه.</p>
          ${employeeTable(s.accumulated, m)}</div>
        ${a.over_used.length ? `<div class="card stack"><div class="spread"><h2>أرصدة بالسالب</h2><span class="pill danger">${a.over_used.length}</span></div>
          <p class="small muted" style="margin:0">المسجل كمصروف يتجاوز المستحق؛ راجع سجلات الصرف أو استحقاق الأسرة.</p>${employeeTable(a.over_used, m)}</div>` : ''}
        ${a.needs_review.length ? `<div class="card stack"><div class="spread"><h2>أرصدة معتمدة تغيّرت بياناتها</h2><span class="pill danger">${a.needs_review.length}</span></div>${employeeTable(a.needs_review, m)}</div>` : ''}
        ${a.missing_nationality.length || a.missing_hire_date.length || a.excluded_with_records.length ? `<div class="card stack"><h2>بيانات ناقصة في دليل الموظفين</h2>
          ${a.missing_nationality.length ? `<p class="small" style="margin:0"><b>بلا جنسية (لا يمكن تحديد الشمول):</b> ${empList(a.missing_nationality)}</p>` : ''}
          ${a.missing_hire_date.length ? `<p class="small" style="margin:0"><b>غير سعوديين بلا تاريخ مباشرة:</b> ${empList(a.missing_hire_date)}</p>` : ''}
          ${a.excluded_with_records.length ? `<p class="small" style="margin:0"><b>لديهم سجلات صرف لكنهم غير مشمولين حاليًا:</b> ${empList(a.excluded_with_records)}</p>` : ''}</div>` : ''}
      </div>`;
    bindRows(el);
  }

  // ---------- balances ----------
  async function balancesTab(el) {
    const m = await meta();
    el.innerHTML = `
      <div class="toolbar">
        <input type="search" id="b-q" placeholder="بحث بالاسم أو الرقم الوظيفي أو الإدارة…" style="max-width:280px">
        <select id="b-status" style="max-width:220px"><option value="">كل حالات الرصيد</option>${Object.entries(m.balance_status).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <select id="b-emp" style="max-width:170px"><option value="">كل الموظفين</option><option value="active">على رأس العمل</option><option value="inactive">منتهية خدماته</option></select>
        <select id="b-elig" style="max-width:220px"><option value="eligible">غير السعوديين (المشمولون)</option><option value="excluded">غير المشمولين / بيانات ناقصة</option></select>
      </div><div id="b-tbl"><div class="empty">جارٍ التحميل…</div></div>`;
    const load = async () => {
      const qs = new URLSearchParams(Object.fromEntries([['q', $('#b-q').value], ['balance_status', $('#b-status').value], ['employee_status', $('#b-emp').value], ['eligibility', $('#b-elig').value]].filter(([, v]) => v)));
      const rows = await api(`/api/air-tickets/balances?${qs}`);
      if ($('#b-elig').value === 'excluded') {
        $('#b-tbl').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>الإدارة</th><th>الجنسية</th><th>تاريخ المباشرة</th><th>السبب</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td>${esc(r.employee.full_name_ar)}</td><td>${esc(r.employee.department || '—')}</td><td>${esc(r.employee.nationality_ar || r.employee.nationality_en || '—')}</td>
            <td>${dmy(r.employee.hire_date)}</td><td>${pill(r.eligibility === 'saudi' ? 'off' : 'warn', m.eligibility[r.eligibility])}</td></tr>`).join('')}</tbody></table></div>
          <p class="small muted">تُعدَّل الجنسية وتاريخ المباشرة من <a href="#/records/employees">دليل الموظفين</a>.</p>` : '<div class="empty">لا يوجد.</div>';
        return;
      }
      $('#b-tbl').innerHTML = rows.length ? employeeTable(rows, m) : `<div class="empty">لا يوجد موظفون غير سعوديين${qs.toString() ? ' مطابقون للبحث' : ''} في ${esc(state.company.name_ar)}. تُحدَّد الجنسية من دليل الموظفين.</div>`;
      bindRows($('#b-tbl'));
    };
    let t; $('#b-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    ['#b-status', '#b-emp', '#b-elig'].forEach((s) => $(s).addEventListener('change', load));
    await load();
  }

  // ---------- historical entry ----------
  async function historyTab(el, reload) {
    const m = await meta();
    const rows = (await api('/api/air-tickets/balances')).filter((r) => !r.final);
    el.innerHTML = `
      <div class="card stack" style="margin-bottom:16px"><h2>إدخال سجل الصرف التاريخي</h2>
        <p class="small" style="margin:0">سجّل التذاكر والمبالغ التي صُرفت سابقًا لكل موظف. بعد كل إدخال يُعاد احتساب المستحق والمستخدم والمتبقي والاستحقاق القادم تلقائيًا.
        الاستحقاق الذي لا يوجد له سجل صرف لا يُعتبر مستخدمًا. عند اكتمال المراجعة يعتمد المسؤول الرصيد الافتتاحي للموظف من صفحته.</p></div>
      ${rows.length ? employeeTable(rows, m, {
        head: '<th>سجلات تاريخية</th><th></th>',
        cell: (r) => `<td>${num(r.historical_records)}</td><td><button class="btn small primary" data-hist="${r.employee.id}">+ سجل تاريخي</button></td>`,
      }) : '<div class="empty">لا توجد أرصدة مبدئية — جميع الأرصدة معتمدة أو نهائية.</div>'}`;
    bindRows(el);
    $$('[data-hist]', el).forEach((b) => b.addEventListener('click', () => disbursementForm({ source: 'historical', employee_id: Number(b.dataset.hist) }, reload)));
  }

  // ---------- disbursements ----------
  const disbTable = (rows, { showEmployee = true, actions = true, lockedUntil = null } = {}) => (rows.length ? `<div class="table-wrap"><table><thead><tr>
      ${showEmployee ? '<th>الموظف</th>' : ''}<th>تاريخ الصرف</th><th>النوع</th><th>استحقاقات دورية</th><th>المستفيدون</th><th>مبلغ التذاكر</th><th>رسوم الخروج والعودة</th><th>الإجمالي</th><th>المرجع / ملاحظات</th>${actions ? '<th></th>' : ''}</tr></thead><tbody>
    ${rows.map((d) => `<tr>
      ${showEmployee ? `<td><a href="#/air-tickets/employee/${d.employee_id}">${esc(d.employee_name)}</a></td>` : ''}
      <td>${dmy(d.disbursed_on)}</td><td>${pill(d.source === 'historical' ? 'off' : 'info', d.source === 'historical' ? 'تاريخي' : 'جديد')}</td>
      <td>${num(d.entitlements_used)}</td>
      <td>${d.employee_included ? 'الموظف' : '<span class="muted">—</span>'}${d.family_count ? ` + ${num(d.family_count)} من الأسرة` : ''} <span class="muted small">(${num(d.beneficiaries ?? (d.employee_included + d.family_count))})</span></td>
      <td>${money(d.ticket_amount)}</td><td>${money(d.exit_reentry_fee)}</td><td>${money(d.total_amount ?? (d.ticket_amount === null && d.exit_reentry_fee === null ? null : (d.ticket_amount || 0) + (d.exit_reentry_fee || 0)))}</td>
      <td class="small" style="white-space:normal">${esc([d.reference, d.notes].filter(Boolean).join(' — ')) || '<span class="muted">—</span>'}</td>
      ${actions ? `<td style="white-space:nowrap">${lockedUntil && d.disbursed_on <= lockedUntil ? '<span class="pill off" title="ضمن الرصيد الافتتاحي المعتمد">مقفل</span>' : `<button class="btn small" data-edit="${d.id}">تعديل</button>${isAdmin() ? ` <button class="btn small" data-del="${d.id}">حذف</button>` : ''}`}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">لا توجد سجلات صرف.</div>');
  const bindDisb = (el, rows, reload) => {
    $$('[data-edit]', el).forEach((b) => b.addEventListener('click', () => disbursementForm(rows.find((r) => r.id === Number(b.dataset.edit)), reload)));
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => reasonDialog('حذف سجل صرف', 'سبب الحذف', 'حذف السجل',
      (reason) => api(`/api/air-tickets/disbursements/${b.dataset.del}`, { method: 'DELETE', body: { reason } }), reload,
      '<p class="small muted" style="margin:0">يُحفظ السجل المحذوف في سجل التعديلات، ويُعاد احتساب الرصيد.</p>')));
  };

  async function disbursementsTab(el, reload) {
    el.innerHTML = `<div class="toolbar">
        <input type="search" id="d-q" placeholder="بحث بالموظف أو المرجع…" style="max-width:260px">
        <select id="d-src" style="max-width:160px"><option value="">كل السجلات</option><option value="historical">تاريخية</option><option value="current">جديدة</option></select>
        <label class="row small muted">من <input type="date" id="d-from" style="width:auto"></label>
        <label class="row small muted">إلى <input type="date" id="d-to" style="width:auto"></label>
      </div><div id="d-tbl"><div class="empty">جارٍ التحميل…</div></div>`;
    const load = async () => {
      const qs = new URLSearchParams(Object.fromEntries([['q', $('#d-q').value], ['source', $('#d-src').value], ['from', $('#d-from').value], ['to', $('#d-to').value]].filter(([, v]) => v)));
      const rows = await api(`/api/air-tickets/disbursements?${qs}`);
      $('#d-tbl').innerHTML = disbTable(rows);
      bindDisb($('#d-tbl'), rows, load);
    };
    let t; $('#d-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    ['#d-src', '#d-from', '#d-to'].forEach((s) => $(s).addEventListener('change', load));
    void reload;
    await load();
  }

  // ---------- disbursement form (new, historical, edit) ----------
  async function disbursementForm(record, onSaved) {
    const editing = Boolean(record?.id);
    const historical = record?.source === 'historical';
    const fixedEmp = record?.employee_id;
    const emps = fixedEmp ? null : await api('/api/air-tickets/balances?employee_status=active');
    const r = { entitlements_used: 1, employee_included: 1, family_count: 0, ...record };
    const familyOnly = editing && r.entitlements_used === 0;
    const body = `${companyBanner(editing ? 'هذا السجل تابع لـ' : 'سيُحفظ هذا السجل في')}
      ${historical ? '<div class="notice small" style="margin-bottom:12px">سجل صرف تاريخي: أدخل ما صُرف فعلًا قبل استخدام المنصة. يمكن ترك المبالغ فارغة إن كانت غير معروفة (يظهر تنبيه بأن الإجماليات غير مكتملة).</div>' : ''}
      <form id="disb-form" class="stack">
        ${fixedEmp ? '' : `<label class="field"><span>الموظف (غير السعوديين في دليل ${esc(state.company.name_ar)}) <span class="req">*</span></span>
          <select name="employee_id" required><option value="">اختر…</option>${emps.map((e) => `<option value="${e.employee.id}">${esc(e.employee.full_name_ar)}${e.employee.employee_no ? ' · ' + esc(e.employee.employee_no) : ''}</option>`).join('')}</select></label>`}
        <div id="emp-bal" class="card" style="background:var(--bg)"><span class="muted small">${fixedEmp ? 'جارٍ تحميل الرصيد…' : 'اختر الموظف لعرض رصيده.'}</span></div>
        <div class="form-grid">
          <label class="field"><span>تاريخ الصرف <span class="req">*</span></span><input type="date" name="disbursed_on" value="${esc(r.disbursed_on || (historical ? '' : today()))}" max="${today()}" required></label>
          <label class="field"><span>نوع الصرف</span><select name="kind">
            <option value="periodic" ${familyOnly ? '' : 'selected'}>استحقاق دوري للموظف (يُخصم من رصيده)</option>
            <option value="family" ${familyOnly ? 'selected' : ''}>تذاكر لأفراد الأسرة فقط (لا يُخصم استحقاق دوري)</option></select></label>
          <label class="field" data-periodic><span>عدد الاستحقاقات الدورية المستخدمة</span><input type="number" name="entitlements_used" min="1" max="10" step="1" class="ltr" value="${esc(Math.max(1, r.entitlements_used))}"></label>
          <label class="field"><span>عدد المستفيدين من الأسرة</span><input type="number" name="family_count" min="0" max="20" step="1" class="ltr" value="${esc(r.family_count)}"></label>
          <label class="check full" data-periodic><input type="checkbox" name="employee_included" ${r.employee_included ? 'checked' : ''}> الموظف نفسه ضمن المسافرين (ألغِ التحديد إن صُرف الاستحقاق دون سفر الموظف)</label>
          <label class="field"><span>مبلغ التذاكر (ر.س) ${historical ? '' : '<span class="req">*</span>'}</span><input type="number" name="ticket_amount" min="0" step="0.01" class="ltr" value="${esc(r.ticket_amount ?? '')}" ${historical ? '' : 'required'}></label>
          <label class="field"><span>رسوم الخروج والعودة (ر.س)</span><input type="number" name="exit_reentry_fee" min="0" step="0.01" class="ltr" value="${esc(r.exit_reentry_fee ?? '')}"></label>
          <label class="field"><span>المرجع (رقم الحجز / الطلب)</span><input type="text" name="reference" class="ltr" value="${esc(r.reference || '')}"></label>
          <label class="field full"><span>ملاحظات</span><textarea name="notes">${esc(r.notes || '')}</textarea></label>
        </div>
        <div id="disb-sum" class="small"></div>
        <label class="check" id="exceed-wrap" hidden><input type="checkbox" name="confirm_exceed"> أؤكد صحة هذا الصرف رغم تجاوزه الرصيد المستحق</label>
      </form><p class="error-text" id="disb-err" hidden></p>`;
    const title = editing ? `تعديل سجل صرف — ${record.employee_name || ''}` : historical ? 'إدخال سجل صرف تاريخي' : 'تسجيل صرف تذاكر';
    const d = openModal(title, body, `<button class="btn primary" form="disb-form" type="submit">حفظ في ${esc(state.company.name_ar)}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    $('[data-close]', d).addEventListener('click', () => d.close());
    const f = $('#disb-form', d);
    const empId = () => fixedEmp || Number(f.employee_id?.value) || null;
    const sync = () => {
      const fam = f.kind.value === 'family';
      $$('[data-periodic]', d).forEach((x) => (x.hidden = fam));
      const ent = fam ? 0 : Number(f.entitlements_used.value || 0);
      const ben = (fam ? 0 : f.employee_included.checked ? 1 : 0) + Number(f.family_count.value || 0);
      const amt = f.ticket_amount.value === '' && f.exit_reentry_fee.value === '' ? null : Number(f.ticket_amount.value || 0) + Number(f.exit_reentry_fee.value || 0);
      $('#disb-sum', d).innerHTML = `يُخصم من الموظف: <b>${ent}</b> استحقاق دوري · تذاكر الأسرة: <b>${Number(f.family_count.value || 0)}</b> · إجمالي المستفيدين: <b>${ben}</b> · الإجمالي: ${money(amt)}`;
    };
    const showBalance = async () => {
      const box = $('#emp-bal', d);
      if (!empId()) { box.innerHTML = '<span class="muted small">اختر الموظف لعرض رصيده.</span>'; return; }
      const b = await api(`/api/air-tickets/employees/${empId()}`);
      box.innerHTML = `<dl class="kv"><dt>الموظف</dt><dd>${esc(b.employee.full_name_ar)} <span class="muted small">— ${esc(b.employee.nationality_ar || b.employee.nationality_en || '')}</span></dd>
        <dt>تاريخ المباشرة</dt><dd>${dmy(b.employee.hire_date)}</dd>
        <dt>الرصيد الحالي</dt><dd>المستحق ${num(b.accrued)} · المستخدم ${num(b.used)} · المتبقي ${signed(b.remaining)}</dd>
        <dt>تذاكر الأسرة</dt><dd>المستحق ${num(b.family_accrued)} · المصروف ${num(b.family_used)} · المتبقي ${signed(b.family_remaining)}</dd>
        <dt>حالة الرصيد</dt><dd>${statusPill(await meta(), b)}${b.approval ? ` <span class="small muted">— معتمد حتى ${dmy(b.approval.as_of)} (السجلات حتى هذا التاريخ مقفلة)</span>` : ''}</dd></dl>`;
    };
    f.kind.addEventListener('change', sync);
    ['entitlements_used', 'family_count', 'ticket_amount', 'exit_reentry_fee'].forEach((n) => f[n].addEventListener('input', sync));
    f.employee_included.addEventListener('change', sync);
    f.employee_id?.addEventListener('change', showBalance);
    sync();
    showBalance().catch(() => {});
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fam = f.kind.value === 'family';
      const data = {
        disbursed_on: f.disbursed_on.value, entitlements_used: fam ? 0 : Number(f.entitlements_used.value), employee_included: fam ? false : f.employee_included.checked,
        family_count: Number(f.family_count.value || 0), ticket_amount: f.ticket_amount.value, exit_reentry_fee: f.exit_reentry_fee.value,
        reference: f.reference.value, notes: f.notes.value, confirm_exceed: f.confirm_exceed.checked,
      };
      try {
        const res = editing ? await api(`/api/air-tickets/disbursements/${record.id}`, { method: 'PATCH', body: data })
          : await api('/api/air-tickets/disbursements', { method: 'POST', body: { ...data, employee_id: empId(), source: historical ? 'historical' : 'current' } });
        d.close();
        toast(`تم الحفظ — المتبقي الآن: ${res.balance.remaining} استحقاق${res.balance.final ? '' : ' (رصيد مبدئي)'}`);
        onSaved?.();
      } catch (err) {
        if (err.code === 'company_changed') return d.close();
        if (err.code === 'exceeds_balance') $('#exceed-wrap', d).hidden = false;
        const el = $('#disb-err', d); el.textContent = err.message; el.hidden = false;
      }
    });
  }

  // ---------- small dialogs ----------
  function formDialog(title, inner, submitLabel, onSubmit, onDone) {
    const d = openModal(title, `${companyBanner('هذا الإجراء على بيانات')}<form id="dlg-form" class="stack">${inner}</form><p class="error-text" id="dlg-err" hidden></p>`,
      `<button class="btn primary" form="dlg-form" type="submit">${submitLabel}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    $('[data-close]', d).addEventListener('click', () => d.close());
    $('#dlg-form', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await onSubmit(e.target); d.close(); toast('تم'); onDone?.(); }
      catch (err) { if (err.code === 'company_changed') return d.close(); const el = $('#dlg-err', d); el.textContent = err.message; el.hidden = false; }
    });
    return d;
  }
  const reasonDialog = (title, label, submit, call, onDone, extra = '') =>
    formDialog(title, `<label class="field"><span>${label} <span class="req">*</span></span><input type="text" name="reason" required></label>${extra}`, submit, (f) => call(f.reason.value), onDone);

  // ---------- employee page ----------
  async function employeePage(main, id) {
    const m = await meta();
    const b = await api(`/api/air-tickets/employees/${id}`);
    const e = b.employee;
    const reload = () => employeePage(main, id);
    main.innerHTML = workspaceHead(e.full_name_ar, '<a class="btn" href="#/air-tickets/balances">← الأرصدة</a>');
    if (!b.eligible) {
      main.insertAdjacentHTML('beforeend', `<div class="card stack"><p>${pill(b.eligibility === 'saudi' ? 'off' : 'warn', m.eligibility[b.eligibility])}</p>
        <p class="small muted" style="margin:0">أداة تذاكر الطيران للموظفين غير السعوديين فقط. الجنسية وتاريخ المباشرة يُعدَّلان من <a href="#/records/employees">دليل الموظفين</a>.</p></div>`);
      return;
    }
    const banner = b.final
      ? `<div class="card" style="border-color:var(--success);margin-bottom:16px">${statusPill(m, b)} ${b.approval ? `<span class="small">اعتمده ${esc(b.approval.approved_by_name || '')} حتى تاريخ ${dmy(b.approval.as_of)} — السجلات حتى هذا التاريخ مقفلة.</span>` : '<span class="small">الموظف باشر بعد تاريخ بدء التشغيل؛ لا توجد سجلات تاريخية.</span>'}</div>`
      : `<div class="notice" style="margin-bottom:16px"><b>${esc(m.balance_status[b.balance_status])} — هذا الرصيد ليس نهائيًا ولا معتمدًا.</b></div>`;
    const periods = b.periods.slice().reverse();
    main.insertAdjacentHTML('beforeend', `
      ${banner}
      ${b.warnings.length ? `<div class="card stack" style="margin-bottom:16px"><h3>تنبيهات</h3><ul class="small" style="margin:0;padding-inline-start:18px">${b.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card stat"><span class="muted small">الاستحقاقات الدورية المستحقة</span><span class="num">${num(b.accrued)}</span><span class="small muted">كل ${b.cycle_months} شهرًا من ${dmy(e.hire_date)}</span></div>
        <div class="card stat"><span class="muted small">المستخدم (المسجل في سجل الصرف)</span><span class="num">${num(b.used)}</span></div>
        <div class="card stat"><span class="muted small">المتبقي ${b.final ? '' : '(مبدئي)'}</span><span class="num">${signed(b.remaining)}</span></div>
        <div class="card stat"><span class="muted small">الاستحقاق القادم</span><span class="num small-num">${b.next_due ? dmy(b.next_due) : '<span class="muted">—</span>'}</span>${e.end_date ? `<span class="small muted">انتهاء الخدمة ${dmy(e.end_date)}</span>` : ''}</div>
        <div class="card stat"><span class="muted small">تذاكر الأسرة: المستحق / المصروف</span><span class="num small-num">${num(b.family_accrued)} / ${num(b.family_used)}</span><span class="small muted">المتبقي ${signed(b.family_remaining)}</span></div>
        <div class="card stat"><span class="muted small">إجمالي المصروف</span><span class="num small-num">${money(b.money.total)}</span><span class="small muted">تذاكر ${money(b.money.ticket_amount)} · رسوم ${money(b.money.exit_reentry_fee)}</span></div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card stack"><div class="spread"><h3>بيانات الموظف والتذاكر</h3><button class="btn small" id="edit-profile">تعديل</button></div>
          <dl class="kv"><dt>الرقم الوظيفي</dt><dd class="ltr">${esc(e.employee_no || '—')}</dd><dt>الإدارة</dt><dd>${esc(e.department || '—')}</dd>
            <dt>الجنسية</dt><dd>${esc(e.nationality_ar || e.nationality_en)}</dd><dt>تاريخ المباشرة</dt><dd>${dmy(e.hire_date)}</dd>
            <dt>وجهة السفر</dt><dd>${esc(b.profile?.destination || '—')}</dd><dt>درجة السفر</dt><dd>${esc(b.profile?.travel_class || '—')}</dd>
            ${b.profile?.notes ? `<dt>ملاحظات</dt><dd>${esc(b.profile.notes)}</dd>` : ''}</dl>
          <p class="small muted" style="margin:0">الاسم والجنسية وتاريخ المباشرة من <a href="#/records/employees">دليل الموظفين</a>.</p></div>
        <div class="card stack"><div class="spread"><h3>أفراد الأسرة المشمولون مع كل استحقاق</h3><button class="btn small" id="add-family">+ تحديد</button></div>
          <p class="small muted" style="margin:0">يُحتسب منفصلًا عن استحقاق الموظف: تذكرة الموظف تُخصم من استحقاقه الدوري، وتذاكر الأسرة تُخصم من رصيد الأسرة.</p>
          ${b.family_history.length ? `<table><thead><tr><th>العدد</th><th>يسري من</th><th>ملاحظة</th><th></th></tr></thead><tbody>${b.family_history.slice().reverse().map((x) => `<tr><td>${num(x.family_count)}</td><td>${dmy(x.effective_from)}</td><td class="small">${esc(x.note || '')}</td><td><button class="btn small" data-fdel="${x.id}">حذف</button></td></tr>`).join('')}</tbody></table>`
            : '<span class="muted small">لم يُحدد — لا تُحتسب تذاكر للأسرة.</span>'}</div>
      </div>
      <div class="card stack" style="margin-bottom:16px"><div class="spread"><h3>سجل الصرف</h3><div class="row"><button class="btn small" id="add-hist">+ سجل تاريخي</button><button class="btn small primary" id="add-disb">+ صرف جديد</button></div></div>
        ${disbTable(b.disbursements, { showEmployee: false, lockedUntil: b.approval?.as_of })}</div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card stack"><h3>الاستحقاقات الدورية</h3>
          ${periods.length ? `<div class="table-wrap" style="max-height:320px;overflow:auto"><table><thead><tr><th>#</th><th>تاريخ الاستحقاق</th><th>الحالة</th><th>أفراد الأسرة</th></tr></thead><tbody>
            ${periods.map((p) => `<tr><td>${p.n}</td><td>${dmy(p.due_date)}</td><td>${p.status === 'used' ? pill('off', 'مستخدم') : pill('info', 'متاح')}</td><td>${num(p.family_entitled)}</td></tr>`).join('')}
            </tbody></table></div><p class="small muted" style="margin:0">يُوزَّع المستخدم على أقدم الاستحقاقات أولًا لأغراض العرض فقط.</p>` : '<span class="muted small">لم يحل أول استحقاق بعد.</span>'}</div>
        <div class="card stack"><h3>اعتماد الرصيد الافتتاحي</h3>
          ${b.approval ? `<dl class="kv"><dt>معتمد حتى</dt><dd>${dmy(b.approval.as_of)}</dd><dt>المستحق / المستخدم / المتبقي</dt><dd>${b.approval.accrued} / ${b.approval.used} / ${b.approval.remaining}</dd>
              <dt>الأسرة</dt><dd>${b.approval.family_accrued} / ${b.approval.family_used} / ${b.approval.family_remaining}</dd><dt>اعتمده</dt><dd>${esc(b.approval.approved_by_name || '')} <span class="small muted ltr">${esc(fmtTime(b.approval.approved_at))}</span></dd>
              ${b.approval.note ? `<dt>ملاحظة</dt><dd>${esc(b.approval.note)}</dd>` : ''}</dl>`
            : `<p class="small" style="margin:0">${b.balance_status === 'not_required' ? 'لا يحتاج هذا الموظف رصيدًا افتتاحيًا.' : 'لم يُعتمد بعد. يعتمده المسؤول بعد مراجعة سجلات الصرف التاريخية؛ بعد الاعتماد تُقفل السجلات حتى تاريخ الاعتماد.'}</p>`}
          ${isAdmin() ? (b.approval ? '<button class="btn" id="revoke">إلغاء الاعتماد</button>' : b.balance_status !== 'not_required' ? '<button class="btn primary" id="approve">اعتماد الرصيد الافتتاحي</button>' : '') : '<p class="small muted" style="margin:0">الاعتماد متاح لحساب المسؤول فقط.</p>'}
          ${b.approvals.filter((x) => x.status === 'revoked').length ? `<details><summary class="small">اعتمادات سابقة ملغاة (${b.approvals.filter((x) => x.status === 'revoked').length})</summary>
            <ul class="small">${b.approvals.filter((x) => x.status === 'revoked').map((x) => `<li>حتى ${dmy(x.as_of)} — ${x.accrued}/${x.used}/${x.remaining} — أُلغي: ${esc(x.revoke_reason || '')} (${esc(x.revoked_by_name || '')})</li>`).join('')}</ul></details>` : ''}
        </div>
      </div>
      <div class="card stack"><h3>سجل التعديلات</h3>${eventsTable(b.events, false)}</div>`);
    $('#edit-profile').addEventListener('click', () => formDialog('بيانات التذاكر', `
      <label class="field"><span>وجهة السفر</span><input type="text" name="destination" value="${esc(b.profile?.destination || '')}"></label>
      <label class="field"><span>درجة السفر</span><input type="text" name="travel_class" value="${esc(b.profile?.travel_class || '')}"></label>
      <label class="field"><span>ملاحظات</span><textarea name="notes">${esc(b.profile?.notes || '')}</textarea></label>`, 'حفظ',
    (f) => api(`/api/air-tickets/employees/${id}/profile`, { method: 'PATCH', body: { destination: f.destination.value, travel_class: f.travel_class.value, notes: f.notes.value } }), reload));
    $('#add-family').addEventListener('click', () => formDialog('أفراد الأسرة المشمولون مع كل استحقاق', `
      <label class="field"><span>عدد أفراد الأسرة <span class="req">*</span></span><input type="number" name="family_count" min="0" max="20" step="1" class="ltr" required></label>
      <label class="field"><span>يسري من <span class="req">*</span></span><input type="date" name="effective_from" value="${esc(b.family_history.length ? today() : e.hire_date)}" min="${esc(e.hire_date)}" required></label>
      <label class="field"><span>ملاحظة (مثل: الزوجة وطفلان)</span><input type="text" name="note"></label>
      <p class="small muted" style="margin:0">يُطبَّق على الاستحقاقات التي تحل من هذا التاريخ فصاعدًا.</p>`, 'حفظ',
    (f) => api(`/api/air-tickets/employees/${id}/family`, { method: 'POST', body: { family_count: Number(f.family_count.value), effective_from: f.effective_from.value, note: f.note.value } }), reload));
    $$('[data-fdel]').forEach((x) => x.addEventListener('click', () => reasonDialog('حذف استحقاق الأسرة', 'سبب الحذف', 'حذف',
      (reason) => api(`/api/air-tickets/family/${x.dataset.fdel}`, { method: 'DELETE', body: { reason } }), reload)));
    $('#add-hist').addEventListener('click', () => disbursementForm({ source: 'historical', employee_id: id }, reload));
    $('#add-disb').addEventListener('click', () => disbursementForm({ source: 'current', employee_id: id }, reload));
    bindDisb(main, b.disbursements.map((d) => ({ ...d, employee_name: e.full_name_ar })), reload);
    $('#approve')?.addEventListener('click', () => formDialog(`اعتماد الرصيد الافتتاحي — ${e.full_name_ar}`, `
      <dl class="kv"><dt>المستحق حتى اليوم</dt><dd>${b.accrued}</dd><dt>المستخدم (السجلات المدخلة)</dt><dd>${b.used}</dd><dt>المتبقي</dt><dd>${b.remaining}</dd>
        <dt>تذاكر الأسرة</dt><dd>${b.family_accrued} / ${b.family_used} / ${b.family_remaining}</dd><dt>سجلات تاريخية</dt><dd>${b.historical_records}</dd></dl>
      <label class="field"><span>الاعتماد حتى تاريخ <span class="req">*</span></span><input type="date" name="as_of" value="${today()}" max="${today()}" min="${esc(e.hire_date)}" required></label>
      <label class="field"><span>ملاحظة</span><input type="text" name="note"></label>
      <label class="check"><input type="checkbox" name="reviewed" required> راجعتُ سجلات الصرف التاريخية لهذا الموظف وأعتمد الرصيد كما هو محسوب</label>
      <p class="small muted" style="margin:0">يُحفظ الرصيد حتى هذا التاريخ، وتُقفل السجلات حتى هذا التاريخ إلى أن يُلغى الاعتماد.</p>`, 'اعتماد',
    (f) => api(`/api/air-tickets/employees/${id}/opening-balance/approve`, { method: 'POST', body: { as_of: f.as_of.value, note: f.note.value, reviewed: f.reviewed.checked } }), reload));
    $('#revoke')?.addEventListener('click', () => reasonDialog('إلغاء اعتماد الرصيد الافتتاحي', 'سبب الإلغاء', 'إلغاء الاعتماد',
      (reason) => api(`/api/air-tickets/employees/${id}/opening-balance/revoke`, { method: 'POST', body: { reason } }), reload,
      '<p class="small muted" style="margin:0">يعود الرصيد مبدئيًا وتُفتح السجلات للتعديل، ويبقى الاعتماد السابق في السجل.</p>'));
  }

  // ---------- reports ----------
  async function reportsTab(el) {
    const y = today().slice(0, 4);
    el.innerHTML = `<div class="toolbar">
        <label class="row small muted">من <input type="date" id="r-from" value="${y}-01-01" style="width:auto"></label>
        <label class="row small muted">إلى <input type="date" id="r-to" value="${today()}" style="width:auto"></label>
        <button class="btn small primary" id="r-xlsx">تصدير التقرير إلى Excel</button></div>
      <p class="small muted">ملف Excel يحتوي: الملخص، أرصدة جميع الموظفين المشمولين، سجل الصرف للفترة، والاستحقاقات القادمة والمتراكمة.</p><div id="r-body"></div>`;
    const qs = () => `?from=${$('#r-from').value}&to=${$('#r-to').value}`;
    const load = async () => {
      const s = await api(`/api/air-tickets/summary${qs()}`);
      const d = s.disbursed;
      $('#r-body').innerHTML = `
        ${s.totals.provisional ? `<div class="notice small" style="margin-bottom:16px">${s.totals.provisional} رصيد مبدئي غير معتمد ضمن الإجماليات.</div>` : ''}
        <div class="grid cols-4" style="margin-bottom:16px">
          <div class="card stat"><span class="muted small">سجلات الصرف في الفترة</span><span class="num">${d.count}</span><span class="small muted">تاريخية ${d.by_source.historical} · جديدة ${d.by_source.current}</span></div>
          <div class="card stat"><span class="muted small">استحقاقات دورية مستخدمة</span><span class="num">${num(d.entitlements)}</span><span class="small muted">تذاكر أسرة ${num(d.family_tickets)} · مستفيدون ${num(d.beneficiaries)}</span></div>
          <div class="card stat"><span class="muted small">مبلغ التذاكر</span><span class="num small-num">${money(d.ticket_amount)}</span><span class="small muted">رسوم خروج وعودة ${money(d.exit_reentry_fee)}</span></div>
          <div class="card stat"><span class="muted small">الإجمالي</span><span class="num small-num">${money(d.total)}</span>${d.missing_amounts ? `<span class="small" style="color:var(--danger)">${d.missing_amounts} سجل بلا مبلغ</span>` : ''}</div>
        </div>
        <div class="card stack"><h3>حسب الشهر</h3>${d.by_month.length ? `<div class="table-wrap"><table><thead><tr><th>الشهر</th><th>السجلات</th><th>استحقاقات دورية</th><th>المستفيدون</th><th>الإجمالي</th></tr></thead><tbody>
          ${d.by_month.map((x) => `<tr><td class="ltr">${esc(x.month)}</td><td>${x.count}</td><td>${x.entitlements}</td><td>${x.beneficiaries}</td><td>${money(x.total)}</td></tr>`).join('')}</tbody></table></div>` : '<span class="muted small">لا يوجد صرف في الفترة.</span>'}</div>`;
    };
    $('#r-from').addEventListener('change', load);
    $('#r-to').addEventListener('change', load);
    $('#r-xlsx').addEventListener('click', () => exportXlsx(qs()));
    await load();
  }

  // ---------- log ----------
  const changesHtml = (e) => {
    if (!e.changes_json) return '';
    const c = JSON.parse(e.changes_json);
    if (c.snapshot) return '';
    const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : esc(String(v)));
    return `<div class="small muted">${Object.entries(c).map(([k, [a, b]]) => `${esc(FIELD_LABELS[k] || k)}: ${fmt(a)} ← ${fmt(b)}`).join(' · ')}</div>`;
  };
  const eventsTable = (ev, showEmployee = true) => (ev.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th>${showEmployee ? '<th>الموظف</th>' : ''}<th>العملية</th><th>التفاصيل</th></tr></thead><tbody>
    ${ev.map((e) => `<tr><td class="small ltr">${esc(fmtTime(e.created_at))}</td><td class="small">${esc(e.user_name || 'النظام')}</td>${showEmployee ? `<td class="small">${e.employee_id ? `<a href="#/air-tickets/employee/${e.employee_id}">${esc(e.employee_name || '')}</a>` : '—'}</td>` : ''}
      <td>${esc(EVENTS[e.event] || e.event)}</td><td class="small" style="white-space:normal">${esc(e.detail || '')}${changesHtml(e)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">لا توجد عمليات مسجلة بعد.</div>');
  async function logTab(el) { el.innerHTML = eventsTable(await api('/api/air-tickets/events')); }

  // ---------- policy ----------
  async function policyTab(el, reload) {
    const p = await api('/api/air-tickets/policy');
    const c = p.current;
    el.innerHTML = `<div class="grid cols-2">
      <div class="card stack"><h2>السياسة الحالية — الإصدار ${c.version}</h2>
        <dl class="kv"><dt>دورة الاستحقاق</dt><dd>تذكرة كل ${c.cycle_months} شهرًا من تاريخ المباشرة</dd><dt>التنبيه المسبق</dt><dd>${c.due_soon_days} يومًا قبل الاستحقاق</dd>
          <dt>تاريخ بدء التشغيل</dt><dd>${c.tracking_start ? `${dmy(c.tracking_start)} <span class="small muted">— من يباشر بعده لا يحتاج رصيدًا افتتاحيًا</span>` : '<span class="muted">غير محدد — كل الأرصدة تحتاج اعتمادًا افتتاحيًا</span>'}</dd>
          <dt>يسري من</dt><dd>${c.version === 1 ? 'البداية' : dmy(c.effective_from)}</dd></dl>
        <p class="small muted" style="margin:0">أي تعديل يُنشئ إصدارًا جديدًا يسري من تاريخه فصاعدًا؛ لا يغيّر الاستحقاقات السابقة ولا الأرصدة المعتمدة.</p>
        ${isAdmin() ? `<form id="pol-form" class="stack"><h3>تعديل السياسة (المسؤول)</h3><div class="form-grid">
          <label class="field"><span>دورة الاستحقاق (شهر)</span><input type="number" name="cycle_months" min="1" max="60" class="ltr" value="${c.cycle_months}" required></label>
          <label class="field"><span>التنبيه المسبق (يوم)</span><input type="number" name="due_soon_days" min="1" max="365" class="ltr" value="${c.due_soon_days}" required></label>
          <label class="field"><span>تاريخ بدء التشغيل (اختياري)</span><input type="date" name="tracking_start" value="${esc(c.tracking_start || '')}"></label>
          <label class="field"><span>يسري من</span><input type="date" name="effective_from" value="${today()}" min="${today()}" required></label>
          <label class="field full"><span>ملاحظة</span><input type="text" name="note"></label></div>
          <button class="btn primary" type="submit">حفظ إصدار جديد</button><p class="error-text" id="pol-err" hidden></p></form>` : '<p class="small muted">تعديل السياسة متاح لحساب المسؤول فقط.</p>'}</div>
      <div class="card stack"><h2>سجل الإصدارات</h2><div class="table-wrap"><table><thead><tr><th>الإصدار</th><th>الدورة</th><th>التنبيه</th><th>بدء التشغيل</th><th>يسري من</th><th>بواسطة</th><th>ملاحظة</th></tr></thead><tbody>
        ${p.history.map((h) => `<tr><td>${h.version}</td><td>${h.cycle_months} شهر</td><td>${h.due_soon_days} يوم</td><td>${dmy(h.tracking_start)}</td><td>${h.version === 1 ? 'البداية' : dmy(h.effective_from)}</td><td class="small">${esc(h.created_by_name || 'النظام')}</td><td class="small" style="white-space:normal">${esc(h.note || '')}</td></tr>`).join('')}
      </tbody></table></div></div></div>`;
    $('#pol-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/admin/air-tickets/policy', { method: 'POST', body: { cycle_months: Number(f.cycle_months.value), due_soon_days: Number(f.due_soon_days.value), tracking_start: f.tracking_start.value || null, effective_from: f.effective_from.value, note: f.note.value } });
        toast('تم حفظ إصدار جديد من السياسة');
        reload();
      } catch (err) { if (err.code === 'company_changed') return; const x = $('#pol-err'); x.textContent = err.message; x.hidden = false; }
    });
  }

  return { view, dashboardSection };
}
