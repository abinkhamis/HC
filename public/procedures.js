// Employee procedures tracking UI: dashboard, cases, case page, outstanding work
// list, change log and Admin settings (checklists and lists). Everything is scoped
// to the selected company by the server.

const STEP_PILL = { done: 'ok', pending: 'off', in_progress: 'info', na: 'warn' };
const CASE_PILL = { open: 'info', closed: 'ok', cancelled: 'off' };
const EVENTS = {
  case_opened: 'فتح حالة', case_updated: 'تعديل بيانات الحالة', case_closed: 'إغلاق الحالة', case_cancelled: 'إلغاء الحالة', case_reopened: 'إعادة فتح',
  case_deleted: 'حذف الحالة', step_updated: 'تحديث إجراء', step_added: 'إضافة إجراء للحالة', step_removed: 'حذف إجراء من الحالة',
  letter_linked: 'ربط خطاب', letter_unlinked: 'إلغاء ربط خطاب', checklist_changed: 'تعديل قائمة الإجراءات', checklist_added: 'إضافة إجراء للقائمة',
  list_item_added: 'إضافة عنصر قائمة', list_item_updated: 'تعديل عنصر قائمة', member_added: 'إضافة عضو فريق', member_updated: 'تعديل عضو فريق',
  employee_created: 'إنشاء سجل الموظف في الدليل', employee_started: 'تأكيد المباشرة', employee_ended: 'تأكيد انتهاء الخدمة', employee_no_assigned: 'إضافة الرقم الوظيفي',
};
// employee status pills (stored: onboarding / active / inactive; «قيد إنهاء الخدمة» is shown, not stored)
export const EMP_PILL = { onboarding: 'info', active: 'ok', offboarding: 'warn', inactive: 'off' };
const FIELD_LABELS = {
  status: 'الحالة', party_id: 'الجهة', assignee_name: 'المنفذ', due_date: 'المهلة', completed_on: 'تاريخ الإنجاز', reference: 'المرجع', notes: 'ملاحظات',
  na_reason: 'سبب لا ينطبق', na_reason_id: 'سبب عدم الإضافة', key_date: 'التاريخ', project_id: 'المشروع', offboarding_reason_id: 'سبب الخروج',
  notice_date: 'تاريخ الإشعار', owner_name: 'مسؤول الحالة', name_ar: 'الاسم', sort: 'الترتيب', applies_to: 'ينطبق على', deadline_days: 'المهلة (يوم)',
  letter_type_id: 'نوع الخطاب', na_reason_list: 'قائمة الأسباب', date_label: 'تسمية التاريخ', reference_label: 'تسمية المرجع', is_active: 'نشط', label: 'الاسم', owner_member_id: 'المسؤول', name: 'الاسم',
};

export function createProcedureViews(ctx) {
  const { api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, state } = ctx;
  const isAdmin = () => state.session?.user.role === 'admin';
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const dmy = (iso) => (iso ? `<span class="ltr">${esc(iso.split('-').reverse().join('/'))}</span>` : '<span class="muted">—</span>');
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
  const bar = (pct) => `<div style="display:flex;align-items:center;gap:8px;min-width:120px"><div style="flex:1;height:8px;border-radius:4px;background:var(--border);overflow:hidden"><div style="width:${pct}%;height:100%;background:${pct === 100 ? 'var(--success)' : 'var(--brand)'}"></div></div><span class="small ltr">${pct}%</span></div>`;
  let META;
  const meta = async () => (META ||= await api('/api/procedures/meta'));
  const keyLabel = (t) => (t === 'onboarding' ? 'تاريخ المباشرة' : 'آخر يوم عمل');
  const typePill = (m, t) => pill(t === 'onboarding' ? 'info' : 'warn', t === 'onboarding' ? 'مباشرة' : 'خروج');

  // ---------- home alerts ----------
  async function dashboardSection(el) {
    const s = await api('/api/procedures/summary');
    const cards = [
      s.open.total && `<a class="card stat" href="#/procedures/cases"><span class="muted small">حالات مفتوحة</span><span class="num">${s.open.total}</span><span class="small muted">مباشرة ${s.open.onboarding} · خروج ${s.open.offboarding}</span></a>`,
      s.overdue_cases.length && `<a class="card stat" href="#/procedures/cases?overdue=1"><span class="muted small">حالات بها إجراءات متأخرة</span><span class="num" style="color:var(--danger)">${s.overdue_cases.length}</span><span class="small muted">${s.overdue_steps} إجراء متأخر</span></a>`,
      s.upcoming.length && `<a class="card stat" href="#/procedures"><span class="muted small">مباشرة أو خروج خلال 14 يومًا</span><span class="num">${s.upcoming.length}</span></a>`,
    ].filter(Boolean);
    el.innerHTML = `
      <div class="spread" style="margin:28px 0 12px"><h2>متابعة إجراءات الموظفين</h2><a class="btn small" href="#/procedures">فتح الأداة</a></div>
      ${cards.length ? `<div class="grid cols-3">${cards.join('')}</div>` : '<div class="card muted small">لا توجد حالات مفتوحة.</div>'}`;
  }

  // ---------- shell ----------
  async function view(main, tab = 'dashboard', sub) {
    if (tab === 'case' && sub) return casePage(main, Number(sub));
    const tabs = [['dashboard', 'لوحة المتابعة'], ['cases', 'الحالات'], ['outstanding', 'النواقص'], ['log', 'سجل التعديلات'], ['settings', 'القوائم والإعدادات']];
    const t = (tab || 'dashboard').split('?')[0];
    main.innerHTML = workspaceHead('متابعة إجراءات الموظفين', `<button class="btn" id="pr-xlsx">تصدير Excel</button><button class="btn" id="pr-off">+ حالة خروج</button><button class="btn primary" id="pr-on">+ مباشرة جديدة</button>`) + `
      <p class="small muted" style="margin:-8px 0 12px">مباشرة الموظفين الجدد والاستقالات وإنهاء الخدمات في ${esc(state.company.name_ar)} — مرتبطة بدليل الموظفين. التحديث يدوي لكل إجراء.</p>
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<a role="tab" href="#/procedures/${k}" class="${k === t ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div id="pr-body"></div>`;
    $('#pr-on').addEventListener('click', () => caseForm('onboarding'));
    $('#pr-off').addEventListener('click', () => caseForm('offboarding'));
    $('#pr-xlsx').addEventListener('click', () => download('/api/procedures/export.xlsx', `متابعة إجراءات الموظفين ${state.company.name_ar}.xlsx`).catch((e) => toast(e.message, 'error')));
    const reload = () => view(main, tab);
    const fn = { dashboard: dashboardTab, cases: casesTab, outstanding: outstandingTab, log: logTab, settings: settingsTab }[t] || dashboardTab;
    await fn($('#pr-body'), reload);
  }

  const caseTable = (rows, m, { extraHead = '', extraCell = () => '' } = {}) => (rows.length ? `<div class="table-wrap"><table><thead><tr>
      <th>رقم الحالة</th><th>النوع</th><th>الموظف</th><th>الإدارة</th><th>التاريخ</th><th>الإنجاز</th><th>معلّق</th><th>الحالة</th>${extraHead}</tr></thead><tbody>
    ${rows.map((c) => `<tr class="clickable" data-case="${c.id}"><td class="ltr">${esc(c.case_no)}</td><td>${typePill(m, c.case_type)}</td>
      <td>${esc(c.employee_name)}</td><td>${esc(c.department || '—')}</td><td>${dmy(c.key_date)}</td><td>${bar(c.progress.percent)}</td>
      <td>${c.progress.pending}${c.overdue_steps ? ` ${pill('danger', `${c.overdue_steps} متأخر`)}` : ''}</td><td>${pill(CASE_PILL[c.status], m.case_status[c.status])}</td>${extraCell(c)}</tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">لا يوجد.</div>');
  const bindCases = (el) => $$('[data-case]', el).forEach((tr) => tr.addEventListener('click', () => (location.hash = `#/procedures/case/${tr.dataset.case}`)));

  // ---------- dashboard ----------
  async function dashboardTab(el) {
    const m = await meta();
    const s = await api('/api/procedures/summary');
    const ap = s.average_progress;
    el.innerHTML = `
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card stat"><span class="muted small">حالات مفتوحة</span><span class="num">${s.open.total}</span><span class="small muted">مباشرة ${s.open.onboarding} · خروج ${s.open.offboarding}</span></div>
        <div class="card stat"><span class="muted small">متوسط نسبة الإنجاز</span><span class="num">${ap.all === null ? '—' : `${ap.all}%`}</span><span class="small muted">مباشرة ${ap.onboarding ?? '—'}% · خروج ${ap.offboarding ?? '—'}%</span></div>
        <div class="card stat"><span class="muted small">إجراءات معلّقة</span><span class="num">${s.pending_steps}</span></div>
        <div class="card stat"><span class="muted small">إجراءات متأخرة</span><span class="num" style="${s.overdue_steps ? 'color:var(--danger)' : ''}">${s.overdue_steps}</span><span class="small muted">في ${s.overdue_cases.length} حالة · المتأخر ما تجاوز مهلته فقط</span></div>
      </div>
      <div class="stack">
        ${s.overdue_cases.length ? `<div class="card stack"><div class="spread"><h2>حالات بها إجراءات متأخرة</h2>${pill('danger', s.overdue_cases.length)}</div>${caseTable(s.overdue_cases, m)}</div>` : ''}
        <div class="card stack"><div class="spread"><h2>مباشرة أو خروج خلال 14 يومًا</h2>${pill('info', s.upcoming.length)}</div>${caseTable(s.upcoming, m)}</div>
        <div class="grid cols-2">
          <div class="card stack"><h2>الإجراءات المعلّقة حسب الجهة</h2>${s.by_party.length ? `<table><thead><tr><th>الجهة</th><th>معلّق</th><th>متأخر</th></tr></thead><tbody>
            ${s.by_party.map((p) => `<tr class="clickable" data-party="${p.party_id ?? 'none'}"><td>${esc(p.label)}</td><td>${p.pending}</td><td>${p.overdue ? pill('danger', p.overdue) : '0'}</td></tr>`).join('')}</tbody></table>` : '<span class="muted small">لا توجد إجراءات معلّقة.</span>'}</div>
          <div class="card stack"><h2>الإجراءات المعلّقة حسب المسؤول</h2>${s.by_owner.length ? `<table><thead><tr><th>المسؤول</th><th>معلّق</th><th>متأخر</th></tr></thead><tbody>
            ${s.by_owner.map((p) => `<tr class="clickable" data-owner="${p.owner_member_id ?? 'none'}"><td>${esc(p.label)}</td><td>${p.pending}</td><td>${p.overdue ? pill('danger', p.overdue) : '0'}</td></tr>`).join('')}</tbody></table>` : '<span class="muted small">لا توجد إجراءات معلّقة.</span>'}</div>
          <div class="card stack"><h2>أُغلقت خلال 30 يومًا</h2>${s.recently_closed.length ? s.recently_closed.map((c) => `<div class="small"><a href="#/procedures/case/${c.id}">${esc(c.case_no)}</a> — ${esc(c.employee_name)} — ${dmy(c.closed_on)}</div>`).join('') : '<span class="muted small">لا يوجد.</span>'}</div>
        </div>
        ${s.unknown_nationality.length ? `<div class="notice small">${s.unknown_nationality.length} حالة مفتوحة لموظفين بلا جنسية في دليل الموظفين؛ الإجراءات المرتبطة بالجنسية تُحدد يدويًا.</div>` : ''}
        <div class="card stack"><div class="spread"><h2>جميع الحالات المفتوحة (الأقل إنجازًا أولًا)</h2>${pill('info', s.open_cases.length)}</div>${caseTable(s.open_cases, m)}</div>
      </div>`;
    bindCases(el);
    $$('[data-owner]', el).forEach((tr) => tr.addEventListener('click', () => { sessionStorageSafe('pr-owner', tr.dataset.owner); location.hash = '#/procedures/outstanding'; }));
    $$('[data-party]', el).forEach((tr) => tr.addEventListener('click', () => { sessionStorageSafe('pr-party', tr.dataset.party); location.hash = '#/procedures/outstanding'; }));
  }
  const sessionStorageSafe = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch { return null; } return null; };

  // ---------- cases ----------
  async function casesTab(el) {
    const m = await meta();
    const lists = await api('/api/procedures/lists');
    const wantOverdue = location.hash.includes('overdue=1');
    el.innerHTML = `<div class="toolbar">
        <input type="search" id="c-q" placeholder="بحث بالرقم أو الموظف أو الإدارة…" style="max-width:260px">
        <select id="c-type" style="max-width:150px"><option value="">كل الأنواع</option>${Object.entries(m.case_types).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <select id="c-status" style="max-width:140px"><option value="open">المفتوحة</option><option value="closed">المغلقة</option><option value="cancelled">الملغاة</option><option value="">الكل</option></select>
        <select id="c-project" style="max-width:180px"><option value="">كل المشاريع</option>${lists.project.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('')}</select>
        <label class="check small"><input type="checkbox" id="c-overdue" ${wantOverdue ? 'checked' : ''}> المتأخرة فقط</label>
      </div><div id="c-tbl"><div class="empty">جارٍ التحميل…</div></div>`;
    const load = async () => {
      const qs = new URLSearchParams(Object.fromEntries([['q', $('#c-q').value], ['case_type', $('#c-type').value], ['status', $('#c-status').value], ['project_id', $('#c-project').value], ['overdue', $('#c-overdue').checked ? '1' : '']].filter(([, v]) => v)));
      const rows = await api(`/api/procedures/cases?${qs}`);
      const filtered = $('#c-q').value || $('#c-type').value || $('#c-project').value || $('#c-overdue').checked;
      const statusWord = { open: ' مفتوحة', closed: ' مغلقة', cancelled: ' ملغاة' }[$('#c-status').value] || '';
      $('#c-tbl').innerHTML = rows.length ? caseTable(rows, m) : `<div class="empty">لا توجد حالات${statusWord}${filtered ? ' مطابقة للبحث' : ''} في ${esc(state.company.name_ar)}.</div>`;
      bindCases($('#c-tbl'));
    };
    let t; $('#c-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    ['#c-type', '#c-status', '#c-project', '#c-overdue'].forEach((s) => $(s).addEventListener('change', load));
    await load();
  }

  // ---------- outstanding work list ----------
  async function outstandingTab(el) {
    const m = await meta();
    const lists = await api('/api/procedures/lists');
    const preset = sessionStorageSafe('pr-party') || '';
    sessionStorageSafe('pr-party', '');
    el.innerHTML = `<div class="toolbar">
        <select id="o-owner" style="max-width:200px"><option value="">كل المسؤولين</option><option value="none">بدون مسؤول</option>${lists.members.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <select id="o-party" style="max-width:200px"><option value="">كل الجهات</option><option value="none" ${preset === 'none' ? 'selected' : ''}>بدون جهة محددة</option>${lists.party.map((p) => `<option value="${p.id}" ${String(p.id) === preset ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        <select id="o-type" style="max-width:150px"><option value="">كل الأنواع</option>${Object.entries(m.case_types).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <label class="check small"><input type="checkbox" id="o-overdue"> المتأخرة فقط</label>
      </div><p class="small muted">كل إجراء «لم يكتمل» أو «قيد التنفيذ» في الحالات المفتوحة. اضغط الإجراء لتحديثه.</p><div id="o-tbl"></div>`;
    const load = async () => {
      try { localStorage.setItem('pr-owner', $('#o-owner').value); } catch {}
      const qs = new URLSearchParams(Object.fromEntries([['owner_member_id', $('#o-owner').value], ['party_id', $('#o-party').value], ['case_type', $('#o-type').value], ['overdue', $('#o-overdue').checked ? '1' : '']].filter(([, v]) => v)));
      const rows = await api(`/api/procedures/outstanding?${qs}`);
      $('#o-tbl').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>الإجراء</th><th>الحالة</th><th>الموظف</th><th>رقم الحالة</th><th>المسؤول</th><th>الجهة / المنفذ</th><th>المهلة</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="clickable" data-step="${r.id}" data-case="${r.case_id}"><td><b>${esc(r.name_ar)}</b></td><td>${pill(STEP_PILL[r.status], m.step_status[r.status])}</td>
          <td>${esc(r.employee_name)} ${typePill(m, r.case_type)}</td><td class="ltr small">${esc(r.case_no)}</td>
          <td class="small">${esc(r.owner_name || '—')}</td><td class="small">${esc(r.party_label || '—')}${r.assignee_name ? ` · ${esc(r.assignee_name)}` : ''}</td><td>${dmy(r.due_date)}${r.overdue ? ' ' + pill('danger', 'متأخر') : ''}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">لا توجد نواقص.</div>';
      $$('[data-step]', $('#o-tbl')).forEach((tr) => tr.addEventListener('click', async () => {
        const c = await api(`/api/procedures/cases/${tr.dataset.case}`);
        stepDialog(c, c.steps.find((s) => s.id === Number(tr.dataset.step)), load);
      }));
    };
    try { const o = sessionStorageSafe('pr-owner') || localStorage.getItem('pr-owner'); if (o && [...$('#o-owner').options].some((x) => x.value === o)) $('#o-owner').value = o; } catch {}
    sessionStorageSafe('pr-owner', '');
    ['#o-owner', '#o-party', '#o-type', '#o-overdue'].forEach((s) => $(s).addEventListener('change', load));
    await load();
  }

  // ---------- new / edit case ----------
  // Onboarding: pick an existing employee OR enter a new one; a new employee and
  // the case are created together by the server in one transaction.
  async function caseForm(type, existing = null) {
    const m = await meta();
    const lists = await api('/api/procedures/lists');
    const emps = existing ? null : (await api('/api/records/employees')).rows;
    const c = existing || {};
    const off = type === 'offboarding';
    const allowNew = !existing && !off;
    const opt = (arr, sel) => arr.filter((x) => x.is_active || x.id === sel).map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.label)}</option>`).join('');
    const uniq = (k) => [...new Set((emps || []).map((e) => e[k]).filter(Boolean))].sort();
    const nationalities = [...new Set(['سعودي', ...uniq('nationality_ar')])];
    const members = lists.members.filter((x) => x.is_active).map((x) => `<option value="${esc(x.name)}">`).join('');
    const empLabel = (e) => `${esc(e.full_name_ar)}${e.employee_no ? ' · ' + esc(e.employee_no) : ''}${e.display_status_label && e.display_status !== 'active' ? ` (${esc(e.display_status_label)})` : ''}`;
    const body = `${companyBanner(existing ? 'هذه الحالة تابعة لـ' : 'ستُفتح هذه الحالة في')}
      <form id="case-form" class="stack" autocomplete="off">
        ${existing ? `<div class="card" style="background:var(--bg)"><b>${esc(c.employee_name)}</b> <span class="muted small">${esc(c.case_no)}</span></div>` : `
        ${allowNew ? `<div class="row" role="tablist" aria-label="اختيار الموظف">
          <button type="button" class="btn small primary" data-mode="new" aria-pressed="true">موظف جديد</button>
          <button type="button" class="btn small" data-mode="existing" aria-pressed="false">موظف موجود في الدليل</button></div>` : ''}
        <div data-section="new" ${allowNew ? '' : 'hidden'}>
          <p class="small muted" style="margin:0 0 8px">يُنشأ سجل الموظف في دليل موظفي ${esc(state.company.name_ar)} بحالة «قيد الانضمام» وتُفتح حالة المباشرة معًا، ويصبح «نشط» عند «تأكيد المباشرة» من صفحة الحالة. باقي البيانات (مثل الراتب) تُستكمل لاحقًا من الدليل.</p>
          <div class="form-grid">
            <label class="field"><span>الاسم بالعربية <span class="req">*</span></span><input type="text" name="full_name_ar" data-match></label>
            <label class="field"><span>الاسم بالإنجليزية</span><input type="text" name="full_name_en" class="ltr"></label>
            <label class="field"><span>الرقم الوظيفي <span class="muted small">(اتركه فارغًا إن لم يُخصَّص بعد)</span></span><input type="text" name="employee_no" class="ltr" data-match></label>
            <label class="field"><span>رقم الهوية / الإقامة</span><input type="text" name="national_id" class="ltr" data-match></label>
            <label class="field"><span>الجنسية</span><input type="text" name="nationality_ar" list="pr-nat"><datalist id="pr-nat">${nationalities.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></label>
            <label class="field"><span>الجنس</span><select name="gender"><option value="">—</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
            <label class="field"><span>المسمى الوظيفي</span><input type="text" name="job_title"></label>
            <label class="field"><span>الإدارة</span><input type="text" name="department" list="pr-dept"><datalist id="pr-dept">${uniq('department').map((n) => `<option value="${esc(n)}">`).join('')}</datalist></label>
          </div>
          <div id="match-box" class="stack" style="margin-top:8px"></div>
          <label class="check" id="newdup-wrap" hidden><input type="checkbox" name="confirm_new_employee"> تأكدت أنه موظف مختلف بالاسم نفسه — أنشئ سجلًا جديدًا</label>
        </div>
        <div data-section="existing" ${allowNew ? 'hidden' : ''} class="stack">
          <input type="search" id="emp-q" placeholder="ابحث بالاسم أو الرقم الوظيفي…">
          <select name="employee_id" size="5" style="height:auto">${emps.map((e) => `<option value="${e.id}">${empLabel(e)}</option>`).join('')}</select>
          <div id="emp-box" class="card" style="background:var(--bg)"><span class="muted small">اختر الموظف لعرض بياناته من الدليل.</span></div>
        </div>`}
        <div class="form-grid">
          <label class="field"><span>${keyLabel(type)} <span class="req">*</span></span><input type="date" name="key_date" value="${esc(c.key_date || '')}" required></label>
          <label class="field"><span>المشروع</span><select name="project_id"><option value="">—</option>${opt(lists.project, c.project_id)}</select></label>
          ${off ? `<label class="field"><span>سبب الخروج</span><select name="offboarding_reason_id"><option value="">—</option>${opt(lists.offboarding_reason, c.offboarding_reason_id)}</select></label>
          <label class="field"><span>تاريخ الإشعار</span><input type="date" name="notice_date" value="${esc(c.notice_date || '')}"></label>` : ''}
          <label class="field"><span>مسؤول الحالة</span><input type="text" name="owner_name" list="pr-members" value="${esc(c.owner_name || '')}"><datalist id="pr-members">${members}</datalist></label>
          <label class="field full"><span>ملاحظات</span><textarea name="notes" rows="2">${esc(c.notes || '')}</textarea></label>
        </div>
        <label class="check" id="dup-wrap" hidden><input type="checkbox" name="confirm_duplicate"> تأكدت أن هذه حالة جديدة وليست تكرارًا للحالة الموجودة</label>
      </form><p class="error-text" id="case-err" hidden></p>`;
    const d = openModal(existing ? `تعديل الحالة ${c.case_no}` : off ? 'حالة خروج جديدة' : 'مباشرة جديدة', body,
      `<button class="btn primary" form="case-form" type="submit" id="case-submit">${existing ? 'حفظ' : allowNew ? 'إنشاء الموظف وفتح حالة المباشرة' : `فتح الحالة في ${esc(state.company.name_ar)}`}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    $('[data-close]', d).addEventListener('click', () => d.close());
    const f = $('#case-form', d);
    let mode = allowNew ? 'new' : 'existing';
    const err = (msg) => { const x = $('#case-err', d); x.textContent = msg || ''; x.hidden = !msg; };

    const showEmployee = () => {
      const e = emps.find((x) => x.id === Number(f.employee_id.value));
      $('#emp-box', d).innerHTML = e ? `<dl class="kv"><dt>الاسم</dt><dd>${esc(e.full_name_ar)}</dd><dt>الإدارة</dt><dd>${esc(e.department || '—')}</dd><dt>المسمى</dt><dd>${esc(e.job_title || '—')}</dd>
        <dt>الجنسية</dt><dd>${esc(e.nationality_ar || e.nationality_en || '') || '<span style="color:var(--danger)">غير محددة — لن تُحدد الإجراءات المرتبطة بالجنسية تلقائيًا</span>'}</dd>
        <dt>تاريخ المباشرة</dt><dd>${dmy(e.hire_date)}</dd>${e.end_date ? `<dt>تاريخ انتهاء الخدمة</dt><dd>${dmy(e.end_date)}</dd>` : ''}</dl>` : '<span class="muted small">اختر الموظف لعرض بياناته من الدليل.</span>';
      const def = e && (off ? e.end_date : e.hire_date);
      if (def) f.key_date.value = def;
    };
    const setMode = (mm) => {
      mode = mm;
      $$('[data-mode]', d).forEach((b) => { const on = b.dataset.mode === mm; b.classList.toggle('primary', on); b.setAttribute('aria-pressed', String(on)); });
      $('[data-section="new"]', d).hidden = mm !== 'new';
      $('[data-section="existing"]', d).hidden = mm !== 'existing';
      $('#case-submit', d).textContent = mm === 'new' ? 'إنشاء الموظف وفتح حالة المباشرة' : `فتح الحالة في ${state.company.name_ar}`;
      $('#case-submit', d).disabled = false;
      if (mm === 'new') matchCheck();
      err('');
    };
    const pick = (id) => { setMode('existing'); f.employee_id.value = String(id); showEmployee(); };
    if (!existing) {
      $$('[data-mode]', d).forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
      f.employee_id.addEventListener('change', showEmployee);
      $('#emp-q', d).addEventListener('input', (e) => {
        const q = e.target.value.trim();
        f.employee_id.innerHTML = emps.filter((x) => !q || [x.full_name_ar, x.full_name_en, x.employee_no].some((v) => v && String(v).includes(q))).map((x) => `<option value="${x.id}">${empLabel(x)}</option>`).join('');
        if (f.employee_id.options.length === 1) { f.employee_id.selectedIndex = 0; showEmployee(); }
      });
    }
    // Live duplicate check while a new employee is typed.
    const matchCheck = async () => {
      if (mode !== 'new') return;
      const q = new URLSearchParams(Object.fromEntries(['full_name_ar', 'employee_no', 'national_id'].map((k) => [k, f[k].value.trim()]).filter(([, v]) => v)));
      if (!q.toString()) { $('#match-box', d).innerHTML = ''; return; }
      const hits = await api(`/api/procedures/employee-match?${q}`).catch(() => []);
      const BY = { employee_no: 'الرقم الوظيفي', national_id: 'رقم الهوية', name: 'الاسم' };
      const taken = hits.find((h) => h.matched_by.includes('employee_no'));
      $('#case-submit', d).disabled = !!taken;
      $('#match-box', d).innerHTML = (taken ? `<div class="notice small" style="border-color:var(--danger);color:var(--danger)" role="alert"><b>الرقم الوظيفي <span class="ltr" dir="ltr">${esc(taken.employee_no)}</span> مستخدم مسبقًا</b> للموظف ${esc(taken.full_name_ar)} (${esc(taken.status_label)}). لا يمكن حفظ سجل مكرر — افتح السجل الموجود، أو اختره إن كان هو، أو صحّح الرقم. <a href="#/records/employees/${taken.id}" target="_blank" rel="noopener">فتح السجل</a></div>` : '') + hits.map((h) => `<div class="notice small">موجود في الدليل: <b>${esc(h.full_name_ar)}</b>${h.employee_no ? ` <span class="ltr">${esc(h.employee_no)}</span>` : ''} — ${esc(h.status_label || '')} — مطابق في: ${h.matched_by.map((x) => BY[x]).join('، ')}
        ${h.open_onboarding ? ` — لديه حالة مباشرة مفتوحة <a href="#/procedures/case/${h.open_onboarding.id}" data-goto class="ltr">${esc(h.open_onboarding.case_no)}</a>` : ` <button type="button" class="btn small" data-pick="${h.id}">اختيار هذا الموظف</button>`}</div>`).join('');
      $$('[data-pick]', d).forEach((b) => b.addEventListener('click', () => pick(Number(b.dataset.pick))));
      $$('[data-goto]', d).forEach((a) => a.addEventListener('click', () => d.close()));
    };
    $$('[data-match]', d).forEach((x) => x.addEventListener('change', matchCheck));
    let mt; f.employee_no?.addEventListener('input', () => { clearTimeout(mt); mt = setTimeout(matchCheck, 350); });

    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      err('');
      const data = { key_date: f.key_date.value, project_id: f.project_id.value || null, owner_name: f.owner_name.value, notes: f.notes.value };
      if (off) Object.assign(data, { offboarding_reason_id: f.offboarding_reason_id.value || null, notice_date: f.notice_date.value || null });
      try {
        let r;
        if (existing) r = await api(`/api/procedures/cases/${c.id}`, { method: 'PATCH', body: data });
        else if (mode === 'new') {
          if (!f.full_name_ar.value.trim()) { f.full_name_ar.focus(); return err('اكتب اسم الموظف بالعربية.'); }
          const employee = Object.fromEntries(['full_name_ar', 'full_name_en', 'employee_no', 'national_id', 'nationality_ar', 'gender', 'job_title', 'department'].map((k) => [k, f[k].value]));
          r = await api('/api/procedures/onboarding', { method: 'POST', body: {
            employee: { ...employee, hire_date: data.key_date }, case: { project_id: data.project_id, owner_name: data.owner_name, notes: data.notes },
            confirm_new_employee: f.confirm_new_employee.checked } });
        } else {
          if (!f.employee_id.value) return err('اختر الموظف من القائمة.');
          r = await api('/api/procedures/cases', { method: 'POST', body: { ...data, case_type: type, employee_id: Number(f.employee_id.value), confirm_duplicate: f.confirm_duplicate.checked } });
        }
        d.close();
        toast(existing ? 'تم الحفظ' : mode === 'new' ? `تمت إضافة ${r.employee_name} إلى الدليل وفتح الحالة ${r.case_no}` : `تم فتح الحالة ${r.case_no}`);
        location.hash = `#/procedures/case/${r.id}`;
        if (existing) window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (e2) {
        if (e2.code === 'company_changed') return d.close();
        if (e2.code === 'duplicate_case') $('#dup-wrap', d).hidden = false;
        if (e2.code === 'possible_duplicate') $('#newdup-wrap', d).hidden = false;
        if (e2.code === 'possible_duplicate' || e2.code === 'employee_exists' || e2.code === 'employee_no_taken') matchCheck();
        err(e2.message);
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

  // ---------- step dialog ----------
  async function stepDialog(c, s, onDone, preset = null) {
    const m = await meta();
    const lists = await api('/api/procedures/lists');
    const open = c.status === 'open';
    const li = s.letter_type_id ? c.letters[s.letter_type_id] : null;
    const reasons = s.na_reason_list ? lists[s.na_reason_list].filter((x) => x.is_active || x.id === s.na_reason_id) : [];
    const letterBox = !s.letter_type_id ? '' : `<div class="card stack" style="background:var(--bg)"><b class="small">مستند «${esc(s.letter_type_name)}» من مركز إصدار الخطابات</b>
      ${li.template_available ? `<p class="small" style="margin:0">القالب الرسمي متوفر. أصدر المستند من <a href="#/letters">مركز الخطابات</a> ثم اربطه هنا.</p>`
        : '<p class="small" style="margin:0;color:var(--danger)">لا يوجد قالب رسمي معتمد لهذا المستند في الشركة؛ لا يمكن إصداره حتى يرفعه المسؤول.</p>'}
      ${s.issued_letter_id ? `<p class="small" style="margin:0">مرتبط: <span class="ltr">${esc(s.letter_reference || '')}</span> ${open ? '<button type="button" class="btn small" id="unlink">إلغاء الربط</button>' : ''}</p>` : ''}
      ${!s.issued_letter_id && li.issued.length && open ? `<div class="small">خطابات صادرة لهذا الموظف من هذا النوع: ${li.issued.map((l) => `<button type="button" class="btn small" data-link="${l.id}"><span class="ltr">${esc(l.reference_no)}</span> — ربط</button>`).join(' ')}</div>` : ''}
    </div>`;
    const body = `
      <form id="step-form" class="stack">
        <div class="spread"><b>${esc(s.name_ar)}</b><span class="small muted">${esc(c.employee_name)} · <span class="ltr">${esc(c.case_no)}</span></span></div>
        ${s.auto_na ? `<div class="notice small">حُدد «لا ينطبق» تلقائيًا: ${esc(s.na_reason)}. تغييره يتطلب ذكر السبب.</div>` : ''}
        <div class="form-grid">
          <label class="field"><span>الحالة</span><select name="status" ${open ? '' : 'disabled'}>${Object.entries(m.step_status).map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
          <label class="field"><span>${esc(s.date_label || 'تاريخ الإنجاز')}</span><input type="date" name="completed_on" value="${esc(s.completed_on || '')}" max="${today()}"></label>
          <label class="field" data-na ${s.status === 'na' ? '' : 'hidden'}><span>${s.na_reason_list ? 'سبب عدم الإضافة' : 'سبب «لا ينطبق»'} <span class="req">*</span></span>
            ${s.na_reason_list ? `<select name="na_reason_id"><option value="">اختر…</option>${reasons.map((r) => `<option value="${r.id}" ${r.id === s.na_reason_id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select>`
              : `<input type="text" name="na_reason" value="${esc(s.auto_na ? '' : s.na_reason || '')}">`}</label>
          <label class="field" data-change hidden><span>سبب التغيير من «لا ينطبق» <span class="req">*</span></span><input type="text" name="reason"></label>
          <label class="field"><span>المسؤول من الفريق</span><select name="owner_member_id"><option value="">—</option>${lists.members.filter((p) => p.is_active || p.id === s.owner_member_id).map((p) => `<option value="${p.id}" ${p.id === s.owner_member_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
          <label class="field"><span>الجهة المسؤولة</span><select name="party_id"><option value="">—</option>${lists.party.filter((p) => p.is_active || p.id === s.party_id).map((p) => `<option value="${p.id}" ${p.id === s.party_id ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
          <label class="field"><span>اسم المنفذ</span><input type="text" name="assignee_name" value="${esc(s.assignee_name || '')}"></label>
          <label class="field"><span>المهلة (اختياري)</span><input type="date" name="due_date" value="${esc(s.due_date || '')}"></label>
          <label class="field"><span>${esc(s.reference_label || 'المرجع')}</span><input type="text" name="reference" value="${esc(s.reference || '')}"></label>
          <label class="field full"><span>ملاحظات</span><textarea name="notes">${esc(s.notes || '')}</textarea></label>
        </div>
        ${!lists.members.length ? `<p class="small muted" style="margin:0">قائمة أعضاء الفريق فارغة${isAdmin() ? ' — <a href="#/admin/team">أضفهم من «فريق الإدارة»</a>' : ' — يضيفها المسؤول'}.</p>` : ''}
        ${!lists.party.length ? `<p class="small muted" style="margin:0">قائمة الجهات المسؤولة فارغة${isAdmin() ? ' — أضفها من «القوائم والإعدادات»' : ' — يضيفها المسؤول'}.</p>` : ''}
        ${letterBox}
        ${s.updated_by_name ? `<p class="small muted" style="margin:0">آخر تحديث: ${esc(s.updated_by_name)} — <span class="ltr">${esc(fmtTime(s.updated_at))}</span></p>` : ''}
      </form><p class="error-text" id="step-err" hidden></p>`;
    const d = openModal('تحديث إجراء', body, open ? `<button class="btn primary" form="step-form" type="submit">حفظ</button><button class="btn" type="button" data-close>إغلاق</button>`
      : '<span class="small muted">الحالة غير مفتوحة — للعرض فقط.</span><button class="btn" type="button" data-close>إغلاق</button>');
    $('[data-close]', d).addEventListener('click', () => d.close());
    const f = $('#step-form', d);
    const sync = () => {
      $('[data-na]', d).hidden = f.status.value !== 'na';
      $('[data-change]', d).hidden = !(s.status === 'na' && f.status.value !== 'na');
      if (f.status.value === 'done' && !f.completed_on.value) f.completed_on.value = today();
    };
    f.status.addEventListener('change', sync);
    if (preset && open) { f.status.value = preset; sync(); }
    if (!open) [...f.elements].forEach((x) => (x.disabled = true));
    const fail = (err) => { if (err.code === 'company_changed') return d.close(); const x = $('#step-err', d); x.textContent = err.message; x.hidden = false; };
    $$('[data-link]', d).forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/procedures/steps/${s.id}/letter`, { method: 'POST', body: { issued_letter_id: Number(b.dataset.link) } }); d.close(); toast('تم ربط الخطاب — حدّث حالة الإجراء عند اكتماله'); onDone?.(); } catch (err) { fail(err); }
    }));
    $('#unlink', d)?.addEventListener('click', () => { d.close(); reasonDialog('إلغاء ربط الخطاب', 'السبب', 'إلغاء الربط', (reason) => api(`/api/procedures/steps/${s.id}/letter`, { method: 'POST', body: { issued_letter_id: null, reason } }), onDone); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = { status: f.status.value, completed_on: f.completed_on.value || null, owner_member_id: f.owner_member_id.value || null, party_id: f.party_id.value || null, assignee_name: f.assignee_name.value,
        due_date: f.due_date.value || null, reference: f.reference.value, notes: f.notes.value, reason: f.reason.value || undefined };
      if (f.status.value === 'na') { if (f.na_reason_id) data.na_reason_id = f.na_reason_id.value || null; else data.na_reason = f.na_reason.value; }
      try { await api(`/api/procedures/steps/${s.id}`, { method: 'PATCH', body: data }); d.close(); toast('تم تحديث الإجراء'); onDone?.(); } catch (err) { fail(err); }
    });
  }

  // ---------- case page ----------
  async function casePage(main, id) {
    const m = await meta();
    const c = await api(`/api/procedures/cases/${id}`);
    const reload = () => casePage(main, id);
    const members = (await api('/api/procedures/lists')).members;
    const e = c.employee;
    const open = c.status === 'open';
    const p = c.progress;
    main.innerHTML = workspaceHead(`${c.employee_name} — ${m.case_types[c.case_type]}`, '<a class="btn" href="#/procedures/cases">← الحالات</a>') + `
      ${c.warnings.map((w) => `<div class="notice small" style="margin-bottom:12px">${esc(w)}</div>`).join('')}
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card stat"><span class="muted small">رقم الحالة</span><span class="num small-num ltr">${esc(c.case_no)}</span><span>${pill(CASE_PILL[c.status], m.case_status[c.status])}${c.closed_on ? ` <span class="small muted">أُغلقت ${dmy(c.closed_on)}</span>` : ''}</span></div>
        <div class="card stat"><span class="muted small">نسبة الإنجاز</span>${bar(p.percent)}<span class="small muted">مكتمل ${p.done} من ${p.applicable} · لا ينطبق ${p.na}</span></div>
        <div class="card stat"><span class="muted small">إجراءات معلّقة</span><span class="num">${p.pending}</span>${c.overdue_steps ? `<span class="small" style="color:var(--danger)">${c.overdue_steps} متأخر</span>` : ''}</div>
        <div class="card stat"><span class="muted small">${keyLabel(c.case_type)}</span><span class="num small-num">${dmy(c.key_date)}</span>${c.notice_date ? `<span class="small muted">الإشعار ${dmy(c.notice_date)}</span>` : ''}</div>
      </div>
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card stack"><div class="spread"><h3>بيانات الحالة</h3>${open ? '<button class="btn small" id="edit-case">تعديل</button>' : ''}</div>
          <dl class="kv"><dt>الموظف</dt><dd>${esc(e.full_name_ar)} ${e.employee_no ? `<span class="ltr muted small">${esc(e.employee_no)}</span>` : ''}</dd>
            <dt>الإدارة / المسمى</dt><dd>${esc(e.department || '—')} · ${esc(e.job_title || '—')}</dd><dt>الجنسية</dt><dd>${esc(e.nationality_ar || e.nationality_en || 'غير محددة')}</dd>
            <dt>المشروع</dt><dd>${esc(c.project_label || '—')}</dd>${c.case_type === 'offboarding' ? `<dt>سبب الخروج</dt><dd>${esc(c.offboarding_reason_label || '—')}</dd>` : ''}
            <dt>مسؤول الحالة</dt><dd>${esc(c.owner_name || '—')}</dd>${c.notes ? `<dt>ملاحظات</dt><dd>${esc(c.notes)}</dd>` : ''}
            <dt>في دليل الموظفين</dt><dd>${pill(EMP_PILL[e.display_status] || 'off', e.display_status_label)} المباشرة ${dmy(e.hire_date)}${e.end_date ? ` · انتهاء الخدمة ${dmy(e.end_date)}` : ''} · <a href="#/records/employees/${e.id}">فتح السجل</a></dd>
            <dt>الرقم الوظيفي</dt><dd>${e.employee_no ? `<span class="ltr">${esc(e.employee_no)}</span>` : '<span class="muted">لم يُخصَّص بعد</span> <button class="btn small" id="set-empno">إضافة الرقم الوظيفي</button>'}</dd></dl>
          ${e.can_confirm_start ? '<div class="notice small">الموظف «قيد الانضمام». عند مباشرته فعليًا أكّد ذلك ليصبح «نشط» — لا يحدث هذا تلقائيًا ولا من ملف Excel. <button class="btn small primary" id="confirm-start">تأكيد المباشرة</button></div>' : ''}
          ${e.can_confirm_end ? '<div class="notice small">الموظف «قيد إنهاء الخدمة». بعد آخر يوم عمل أكّد انتهاء الخدمة ليصبح «منتهي الخدمة». <button class="btn small" id="confirm-end">تأكيد انتهاء الخدمة</button></div>' : ''}
          ${c.case_type === 'offboarding' ? '<p class="small muted" style="margin:0">إغلاق الحالة لا يغيّر حالة الموظف ولا تاريخ انتهاء خدمته؛ ذلك يتم فقط عبر «تأكيد انتهاء الخدمة».</p>' : ''}
          <div id="air-box"></div>
          ${c.other_cases.length ? `<p class="small" style="margin:0">حالات أخرى للموظف: ${c.other_cases.map((o) => `<a href="#/procedures/case/${o.id}" class="ltr">${esc(o.case_no)}</a> (${esc(m.case_status[o.status])})`).join('، ')}</p>` : ''}</div>
        <div class="card stack"><h3>الإجراءات على الحالة</h3>
          ${open ? `<button class="btn primary" id="close-case" ${p.pending ? 'disabled title="يجب أن تكون كل الإجراءات مكتملة أو لا تنطبق"' : ''}>إغلاق الحالة</button>
            ${p.pending ? `<p class="small muted" style="margin:0">الإغلاق متاح عندما تكون كل الإجراءات «مكتمل» أو «لا ينطبق» (${p.pending} معلّق).</p>` : ''}
            <button class="btn" id="add-step">+ إجراء إضافي لهذه الحالة</button><button class="btn" id="cancel-case">إلغاء الحالة</button>`
            : `${c.close_note ? `<p class="small" style="margin:0">ملاحظة الإغلاق: ${esc(c.close_note)} — ${esc(c.closed_by_name || '')}</p>` : ''}${c.cancel_reason ? `<p class="small" style="margin:0">سبب الإلغاء: ${esc(c.cancel_reason)}</p>` : ''}
              ${isAdmin() ? '<button class="btn" id="reopen-case">إعادة فتح الحالة</button>' : '<p class="small muted" style="margin:0">إعادة الفتح متاحة للمسؤول.</p>'}`}
          ${isAdmin() ? '<button class="btn" id="delete-case">حذف الحالة</button>' : ''}</div>
      </div>
      <div class="card stack" style="margin-bottom:16px"><div class="spread"><h3>الإجراءات</h3>${open && !members.length ? `<span class="small muted">لا يوجد أعضاء فريق لتعيينهم${isAdmin() ? ' — <a href="#/admin/team">أضفهم من «فريق الإدارة»</a>' : ' — يضيفهم المسؤول'}</span>` : ''}</div><div class="table-wrap"><table><thead><tr><th>الإجراء</th><th>الحالة</th><th>المسؤول</th><th>الجهة / المنفذ</th><th>المهلة</th><th>التاريخ</th><th>المرجع / ملاحظات</th><th></th></tr></thead><tbody>
        ${c.steps.map((s) => `<tr data-step="${s.id}"><td class="clickable" data-open><b>${esc(s.name_ar)}</b>${s.checklist_step_id ? '' : ' <span class="muted small">(إضافي)</span>'}${s.letter_type_id ? ` <span class="pill off">مستند</span>` : ''}</td>
          <td>${open ? `<select data-quick-status aria-label="حالة ${esc(s.name_ar)}" style="min-width:110px">${Object.entries(m.step_status).map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>` : pill(STEP_PILL[s.status], m.step_status[s.status])}${s.status === 'na' ? `<div class="small muted" style="white-space:normal">${esc(s.na_reason_label || s.na_reason || '')}</div>` : ''}</td>
          <td>${open ? `<select data-quick-owner aria-label="مسؤول ${esc(s.name_ar)}" style="min-width:110px"><option value="">—</option>${members.filter((x) => x.is_active || x.id === s.owner_member_id).map((x) => `<option value="${x.id}" ${x.id === s.owner_member_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>` : esc(s.owner_name || '—')}</td>
          <td class="small">${esc(s.party_label || '—')}${s.assignee_name ? ` · ${esc(s.assignee_name)}` : ''}</td>
          <td>${dmy(s.due_date)}${s.overdue ? ' ' + pill('danger', 'متأخر') : ''}</td><td>${dmy(s.completed_on)}</td>
          <td class="small" style="white-space:normal">${esc([s.letter_reference || s.reference, s.notes].filter(Boolean).join(' — ')) || '<span class="muted">—</span>'}</td>
          <td><button class="btn small" data-open>التفاصيل</button></td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="card stack"><h3>سجل التعديلات</h3>${eventsTable(c.events, false)}</div>`;
    const stepOf = (el) => c.steps.find((s) => s.id === Number(el.closest('[data-step]').dataset.step));
    $$('[data-open]', main).forEach((el) => el.addEventListener('click', () => stepDialog(c, stepOf(el), reload)));
    // Quick updates from the table; anything that needs a reason opens the dialog instead.
    const quick = async (s, body) => {
      try { await api(`/api/procedures/steps/${s.id}`, { method: 'PATCH', body }); toast(`تم تحديث «${s.name_ar}»`); reload(); }
      catch (err) { if (err.code !== 'company_changed') { toast(err.message, 'error'); reload(); } }
    };
    $$('[data-quick-status]', main).forEach((sel) => sel.addEventListener('change', () => {
      const s = stepOf(sel);
      if (sel.value === 'na' || s.status === 'na') { const v = sel.value; sel.value = s.status; return stepDialog(c, s, reload, v); }
      quick(s, { status: sel.value });
    }));
    $$('[data-quick-owner]', main).forEach((sel) => sel.addEventListener('change', () => quick(stepOf(sel), { owner_member_id: sel.value || null })));
    $('#edit-case')?.addEventListener('click', () => caseForm(c.case_type, c));
    $('#confirm-start')?.addEventListener('click', () => formDialog(`تأكيد مباشرة ${e.full_name_ar}`, `
      <label class="field"><span>تاريخ المباشرة الفعلي <span class="req">*</span></span><input type="date" name="start_date" value="${esc(c.key_date)}" required></label>
      <label class="check"><input type="checkbox" name="confirmed" required> أؤكد أن الموظف باشر العمل فعليًا</label>
      <p class="small muted" style="margin:0">تتغير حالته في الدليل من «قيد الانضمام» إلى «نشط»، ويُحدَّث تاريخ المباشرة. لا يُغلق هذا حالة المتابعة.</p>`, 'تأكيد المباشرة',
    (f) => api(`/api/procedures/cases/${id}/confirm-start`, { method: 'POST', body: { start_date: f.start_date.value, confirmed: f.confirmed.checked } }), reload));
    $('#confirm-end')?.addEventListener('click', () => formDialog(`تأكيد انتهاء خدمة ${e.full_name_ar}`, `
      <label class="field"><span>آخر يوم عمل <span class="req">*</span></span><input type="date" name="end_date" value="${esc(c.key_date)}" required></label>
      <label class="check"><input type="checkbox" name="confirmed" required> أؤكد انتهاء خدمة الموظف فعليًا</label>
      <p class="small muted" style="margin:0">تتغير حالته في الدليل إلى «منتهي الخدمة» ويُسجَّل تاريخ انتهاء الخدمة. تبقى كل بياناته وإجراءاته وسجله.</p>`, 'تأكيد انتهاء الخدمة',
    (f) => api(`/api/procedures/cases/${id}/confirm-end`, { method: 'POST', body: { end_date: f.end_date.value, confirmed: f.confirmed.checked } }), reload));
    $('#set-empno')?.addEventListener('click', () => formDialog(`الرقم الوظيفي — ${e.full_name_ar}`, `
      <label class="field"><span>الرقم الوظيفي <span class="req">*</span></span><input type="text" name="employee_no" class="ltr" required></label>
      <p class="small muted" style="margin:0">يُتحقق من عدم استخدامه لأي موظف في ${esc(state.company.name_ar)} (نشط أو قيد الانضمام أو منتهي الخدمة).</p>`, 'حفظ الرقم',
    (f) => api(`/api/procedures/cases/${id}/employee-no`, { method: 'POST', body: { employee_no: f.employee_no.value } }), reload));
    $('#add-step')?.addEventListener('click', () => formDialog('إجراء إضافي لهذه الحالة فقط', `
      <label class="field"><span>اسم الإجراء <span class="req">*</span></span><input type="text" name="name_ar" required></label>
      <label class="field"><span>المهلة (اختياري)</span><input type="date" name="due_date"></label>
      <p class="small muted" style="margin:0">لا يغيّر قائمة إجراءات الشركة؛ تعديل القائمة من «القوائم والإعدادات».</p>`, 'إضافة',
    (f) => api(`/api/procedures/cases/${id}/steps`, { method: 'POST', body: { name_ar: f.name_ar.value, due_date: f.due_date.value || null } }), reload));
    $('#close-case')?.addEventListener('click', () => formDialog(`إغلاق الحالة ${c.case_no}`, `
      <dl class="kv"><dt>مكتمل</dt><dd>${p.done}</dd><dt>لا ينطبق</dt><dd>${p.na}</dd></dl>
      <label class="field"><span>تاريخ الإغلاق <span class="req">*</span></span><input type="date" name="closed_on" value="${today()}" max="${today()}" required></label>
      <label class="field"><span>ملاحظة</span><input type="text" name="note"></label>
      <label class="check"><input type="checkbox" name="confirmed" required> راجعتُ جميع إجراءات الحالة وأؤكد إغلاقها</label>
      ${c.case_type === 'offboarding' ? '<p class="small muted" style="margin:0">لن يتغير تاريخ انتهاء خدمة الموظف في الدليل.</p>' : ''}`, 'إغلاق الحالة',
    (f) => api(`/api/procedures/cases/${id}/close`, { method: 'POST', body: { closed_on: f.closed_on.value, note: f.note.value, confirmed: f.confirmed.checked } }), reload));
    $('#cancel-case')?.addEventListener('click', () => reasonDialog(`إلغاء الحالة ${c.case_no}`, 'سبب الإلغاء (مثل: لم يباشر الموظف)', 'إلغاء الحالة',
      (reason) => api(`/api/procedures/cases/${id}/cancel`, { method: 'POST', body: { reason } }), reload));
    $('#reopen-case')?.addEventListener('click', () => reasonDialog(`إعادة فتح ${c.case_no}`, 'السبب', 'إعادة الفتح',
      (reason) => api(`/api/procedures/cases/${id}/reopen`, { method: 'POST', body: { reason } }), reload));
    $('#delete-case')?.addEventListener('click', () => reasonDialog(`حذف ${c.case_no}`, 'سبب الحذف', 'حذف الحالة',
      (reason) => api(`/api/procedures/cases/${id}`, { method: 'DELETE', body: { reason } }), () => (location.hash = '#/procedures/cases'),
      '<p class="small muted" style="margin:0">تُحفظ نسخة كاملة من الحالة في سجل التعديلات.</p>'));
    // Read-only air-ticket balance for non-Saudi employees leaving (helps the settlement).
    if (c.case_type === 'offboarding' && e.nationality_class === 'non_saudi') {
      api(`/api/air-tickets/employees/${e.id}`).then((b) => {
        if (!b.eligible) return;
        $('#air-box').innerHTML = `<div class="card small" style="background:var(--bg)"><b>رصيد تذاكر الطيران</b> (للاطلاع): المتبقي ${b.remaining} استحقاق · تذاكر الأسرة المتبقية ${b.family_remaining}
          ${b.final ? '' : ' — <span style="color:var(--warn-text)">رصيد مبدئي غير معتمد</span>'} · <a href="#/air-tickets/employee/${e.id}">فتح</a></div>`;
      }).catch(() => {});
    }
  }

  // ---------- log ----------
  const changesHtml = (e) => {
    if (!e.changes_json) return '';
    const c = JSON.parse(e.changes_json);
    if (c.snapshot) return '';
    const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : esc(String(v)));
    return `<div class="small muted">${Object.entries(c).map(([k, [a, b]]) => `${esc(FIELD_LABELS[k] || k)}: ${fmt(a)} ← ${fmt(b)}`).join(' · ')}</div>`;
  };
  const eventsTable = (ev, showCase = true) => (ev.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th>${showCase ? '<th>الحالة</th>' : ''}<th>العملية</th><th>التفاصيل</th></tr></thead><tbody>
    ${ev.map((e) => `<tr><td class="small ltr">${esc(fmtTime(e.created_at))}</td><td class="small">${esc(e.user_name || 'النظام')}${e.actor === 'assistant' ? ' (مها)' : ''}</td>
      ${showCase ? `<td class="small ltr">${e.case_id && e.event !== 'case_deleted' ? `<a href="#/procedures/case/${e.case_id}">${esc(e.case_no || '')}</a>` : esc(e.case_no || '—')}</td>` : ''}
      <td>${esc(EVENTS[e.event] || e.event)}</td><td class="small" style="white-space:normal">${esc(e.detail || '')}${changesHtml(e)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">لا توجد عمليات مسجلة بعد.</div>');
  async function logTab(el) { el.innerHTML = eventsTable(await api('/api/procedures/events')); }

  // ---------- settings (Admin edits; team can view) ----------
  async function settingsTab(el, reload) {
    const m = await meta();
    const [steps, lists, cat] = await Promise.all([api('/api/procedures/checklists'), api('/api/procedures/lists'), api('/api/letters/catalog')]);
    const admin = isAdmin();
    const stepRows = (type) => steps.filter((s) => s.case_type === type).map((s) => `<tr style="${s.is_active ? '' : 'opacity:.55'}">
      <td>${s.sort}</td><td><b>${esc(s.name_ar)}</b>${s.is_active ? '' : ' ' + pill('off', 'موقوف')}</td><td class="small">${esc(m.applies_to[s.applies_to])}</td>
      <td>${s.deadline_days === null ? '<span class="muted small">بدون مهلة</span>' : `${s.deadline_days} يوم`}</td><td class="small">${esc(s.letter_type_name || '—')}</td>
      ${admin ? `<td><button class="btn small" data-edit-step="${s.id}">تعديل</button></td>` : ''}</tr>`).join('');
    const listBox = (key) => `<div class="card stack"><div class="spread"><h3>${esc(m.lists[key])}</h3>${admin ? `<button class="btn small" data-add-list="${key}">+ إضافة</button>` : ''}</div>
      ${lists[key].length ? lists[key].map((x) => `<div class="spread small" style="${x.is_active ? '' : 'opacity:.55'}"><span>${esc(x.label)}${x.is_active ? '' : ' (موقوف)'}</span>
        ${admin ? `<span><button class="btn small" data-rename="${x.id}">تعديل</button> <button class="btn small" data-toggle="${x.id}" data-active="${x.is_active}">${x.is_active ? 'إيقاف' : 'تفعيل'}</button></span>` : ''}</div>`).join('') : '<span class="muted small">القائمة فارغة.</span>'}</div>`;
    el.innerHTML = `
      ${admin ? '' : '<div class="notice small" style="margin-bottom:12px">عرض فقط — تعديل القوائم متاح لحساب المسؤول.</div>'}
      <p class="small muted">القوائم خاصة بشركة ${esc(state.company.name_ar)}. تعديل قائمة الإجراءات يطبق على الحالات الجديدة فقط؛ الحالات المفتوحة تحتفظ بإجراءاتها. المهلة اختيارية بالأيام من تاريخ المباشرة / آخر يوم عمل، وبدونها لا يُعتبر الإجراء متأخرًا.</p>
      ${['onboarding', 'offboarding'].map((type) => `<div class="card stack" style="margin-bottom:16px"><div class="spread"><h2>إجراءات ${esc(m.case_types[type])}</h2>${admin ? `<button class="btn small primary" data-new-step="${type}">+ إجراء</button>` : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>الترتيب</th><th>الإجراء</th><th>ينطبق على</th><th>المهلة</th><th>مستند مرتبط</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>${stepRows(type)}</tbody></table></div></div>`).join('')}
      <div class="grid cols-2">
        <div class="card stack"><div class="spread"><h3>أعضاء الفريق (المسؤولون عن الإجراءات) <a class="small" href="#/admin/team" style="font-weight:400">إدارة الفريق</a></h3>${admin ? '<button class="btn small" id="add-member">+ إضافة</button>' : ''}</div>
          ${lists.members.length ? lists.members.map((x) => `<div class="spread small" style="${x.is_active ? '' : 'opacity:.55'}"><span>${esc(x.name)}${x.is_active ? '' : ' (موقوف)'}</span>
            ${admin ? `<span><button class="btn small" data-mrename="${x.id}">تعديل</button> <button class="btn small" data-mtoggle="${x.id}" data-active="${x.is_active}">${x.is_active ? 'إيقاف' : 'تفعيل'}</button></span>` : ''}</div>`).join('') : '<span class="muted small">القائمة فارغة.</span>'}</div>
        ${['party', 'project', 'offboarding_reason', 'support_reason'].map(listBox).join('')}</div>`;
    const stepForm = (s, type) => formDialog(s ? `تعديل إجراء — ${s.name_ar}` : `إجراء جديد — ${m.case_types[type]}`, `
      <div class="form-grid">
        <label class="field full"><span>اسم الإجراء <span class="req">*</span></span><input type="text" name="name_ar" value="${esc(s?.name_ar || '')}" required></label>
        <label class="field"><span>الترتيب</span><input type="number" name="sort" class="ltr" value="${esc(s?.sort ?? '')}"></label>
        <label class="field"><span>ينطبق على</span><select name="applies_to">${Object.entries(m.applies_to).map(([k, v]) => `<option value="${k}" ${k === (s?.applies_to || 'all') ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label class="field"><span>المهلة بالأيام (اختياري، سالب = قبل التاريخ)</span><input type="number" name="deadline_days" class="ltr" min="-365" max="365" value="${esc(s?.deadline_days ?? '')}"></label>
        <label class="field"><span>مستند من مركز الخطابات</span><select name="letter_type_id"><option value="">—</option>${cat.types.map((t) => `<option value="${t.id}" ${t.id === s?.letter_type_id ? 'selected' : ''}>${esc(t.name_ar)}${t.template ? '' : ' (لا يوجد قالب)'}</option>`).join('')}</select></label>
        <label class="field"><span>تسمية حقل التاريخ</span><input type="text" name="date_label" value="${esc(s?.date_label || '')}" placeholder="تاريخ الإنجاز"></label>
        <label class="field"><span>تسمية حقل المرجع</span><input type="text" name="reference_label" value="${esc(s?.reference_label || '')}" placeholder="المرجع"></label>
        <label class="check full"><input type="checkbox" name="support_reason" ${s?.na_reason_list ? 'checked' : ''}> «لا ينطبق» يُختار سببه من قائمة أسباب عدم الإضافة في الدعم</label>
        ${s ? `<label class="check full"><input type="checkbox" name="is_active" ${s.is_active ? 'checked' : ''}> نشط (يُنسخ إلى الحالات الجديدة)</label>` : ''}
      </div>`, 'حفظ', (f) => api('/api/admin/procedures/checklists', { method: 'POST', body: {
      id: s?.id, case_type: type, name_ar: f.name_ar.value, sort: f.sort.value === '' ? undefined : Number(f.sort.value), applies_to: f.applies_to.value,
      deadline_days: f.deadline_days.value === '' ? null : Number(f.deadline_days.value), letter_type_id: f.letter_type_id.value || null,
      date_label: f.date_label.value, reference_label: f.reference_label.value, na_reason_list: f.support_reason.checked ? 'support_reason' : null,
      ...(s ? { is_active: f.is_active.checked } : {}),
    } }), reload);
    $$('[data-new-step]', el).forEach((b) => b.addEventListener('click', () => stepForm(null, b.dataset.newStep)));
    $$('[data-edit-step]', el).forEach((b) => b.addEventListener('click', () => { const s = steps.find((x) => x.id === Number(b.dataset.editStep)); stepForm(s, s.case_type); }));
    $$('[data-add-list]', el).forEach((b) => b.addEventListener('click', () => formDialog(`إضافة إلى ${m.lists[b.dataset.addList]}`, '<label class="field"><span>الاسم <span class="req">*</span></span><input type="text" name="label" required></label>', 'إضافة',
      (f) => api('/api/admin/procedures/lists', { method: 'POST', body: { list: b.dataset.addList, label: f.label.value } }), reload)));
    $('#add-member')?.addEventListener('click', () => formDialog('إضافة عضو فريق', '<label class="field"><span>الاسم <span class="req">*</span></span><input type="text" name="name" required></label>', 'إضافة',
      (f) => api('/api/admin/procedures/members', { method: 'POST', body: { name: f.name.value } }), reload));
    $$('[data-mrename]', el).forEach((b) => b.addEventListener('click', () => { const x = lists.members.find((i) => i.id === Number(b.dataset.mrename)); formDialog('تعديل الاسم', `<label class="field"><span>الاسم <span class="req">*</span></span><input type="text" name="name" value="${esc(x.name)}" required></label>`, 'حفظ',
      (f) => api(`/api/admin/procedures/members/${x.id}`, { method: 'PATCH', body: { name: f.name.value } }), reload); }));
    $$('[data-mtoggle]', el).forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/procedures/members/${b.dataset.mtoggle}`, { method: 'PATCH', body: { is_active: b.dataset.active !== '1' } }); reload(); } catch (err) { toast(err.message, 'error'); }
    }));
    const all = Object.entries(lists).filter(([k]) => k !== 'members').flatMap(([, v]) => v);
    $$('[data-rename]', el).forEach((b) => b.addEventListener('click', () => { const x = all.find((i) => i.id === Number(b.dataset.rename)); formDialog('تعديل الاسم', `<label class="field"><span>الاسم <span class="req">*</span></span><input type="text" name="label" value="${esc(x.label)}" required></label>`, 'حفظ',
      (f) => api(`/api/admin/procedures/lists/${x.id}`, { method: 'PATCH', body: { label: f.label.value } }), reload); }));
    $$('[data-toggle]', el).forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/procedures/lists/${b.dataset.toggle}`, { method: 'PATCH', body: { is_active: b.dataset.active !== '1' } }); reload(); } catch (err) { toast(err.message, 'error'); }
    }));
  }

  return { view, dashboardSection };
}
