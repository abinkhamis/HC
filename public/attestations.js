// Chamber of Commerce attestations UI: requests, salary deductions, reports,
// change log and policy. All data is scoped to the selected company by the server.

const STATUS_PILL = { requested: 'off', in_progress: 'info', attested: 'ok', delivered: 'ok', cancelled: 'danger' };
const DED_PILL = { not_applicable: 'off', pending: 'warn', confirmed: 'ok', waived: 'info' };
const EVENTS = {
  created: 'إنشاء الطلب', updated: 'تعديل', deleted: 'حذف الطلب', recalculated: 'إعادة احتساب', needs_review: 'يحتاج مراجعة',
  'status:submit': 'إرسال للتصديق', 'status:attest': 'تم التصديق', 'status:deliver': 'تم التسليم', 'status:cancel': 'إلغاء', 'status:reopen': 'إعادة فتح',
  deduction_confirmed: 'تأكيد الخصم', deduction_reverted: 'إلغاء تأكيد الخصم', deduction_waived: 'إعفاء من الخصم', waiver_reverted: 'إلغاء الإعفاء', policy_changed: 'تعديل السياسة',
};
const FIELD_LABELS = {
  employee_id: 'الموظف', document_type: 'نوع المستند', purpose: 'الغرض / الجهة', request_date: 'تاريخ الطلب', fee_amount: 'الرسوم', chamber_reference: 'مرجع الغرفة',
  notes: 'ملاحظات', submitted_at: 'تاريخ الإرسال', attested_at: 'تاريخ التصديق', delivered_at: 'تاريخ التسليم', status: 'الحالة', charged_to: 'على حساب', seq_in_year: 'الترتيب',
  free_per_year: 'عدد التصديقات على الشركة', year_basis: 'أساس السنة', default_fee: 'الرسوم الافتراضية', overdue_days: 'مدة التنبيه', contract_year_start: 'بداية سنة العقد', contract_year_end: 'نهاية سنة العقد',
};
const STATUS_ACTIONS = {
  submit: { label: 'إرسال للتصديق', from: ['requested'] },
  attest: { label: 'تم التصديق', from: ['requested', 'in_progress'], ref: true },
  deliver: { label: 'تم التسليم', from: ['attested'] },
  cancel: { label: 'إلغاء الطلب', from: ['requested', 'in_progress', 'attested'], reason: true },
  reopen: { label: 'إعادة فتح', from: ['cancelled'] },
};
const BASIS = { hire_anniversary: 'سنة العقد (من تاريخ المباشرة)', calendar: 'السنة الميلادية' };

export function createAttestationViews(ctx) {
  const { api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, state } = ctx;
  const isAdmin = () => state.session?.user.role === 'admin';
  const money = (n) => `<span class="ltr">${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> <span class="muted small">ر.س</span>`;
  const dmy = (iso) => (iso ? `<span class="ltr">${esc(iso.split('-').reverse().join('/'))}</span>` : '<span class="muted">—</span>');
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  let META;
  const meta = async () => (META ||= await api('/api/attestations/meta'));
  const chargePill = (r) => (r.status === 'cancelled' ? '<span class="muted small">لا يُحتسب</span>'
    : `${pill(r.charged_to === 'employee' ? 'warn' : 'info', r.charged_to === 'employee' ? 'على الموظف' : 'على الشركة')} <span class="muted small">(التصديق ${r.seq_in_year} · المسموح على الشركة ${r.free_limit})</span>`);

  // ---------- home alerts ----------
  async function dashboardSection(el) {
    const s = await api('/api/attestations/summary');
    const a = s.alerts;
    const total = a.pending_deductions.length + a.overdue_requests.length + a.needs_review.length;
    el.innerHTML = `
      <div class="spread" style="margin:28px 0 12px"><h2>تصديقات الغرفة التجارية</h2><a class="btn small" href="#/attestations">فتح الأداة</a></div>
      ${total ? `<div class="grid cols-3">
        ${a.pending_deductions.length ? `<a class="card stat" href="#/attestations/deductions"><span class="muted small">خصومات بانتظار تأكيد الفريق</span><span class="num">${a.pending_deductions.length}</span><span class="small">${money(a.pending_deductions.reduce((x, r) => x + r.deduction_amount, 0))}</span></a>` : ''}
        ${a.overdue_requests.length ? `<a class="card stat" href="#/attestations"><span class="muted small">طلبات مفتوحة منذ أكثر من ${s.policy.overdue_days} أيام</span><span class="num" style="color:var(--danger)">${a.overdue_requests.length}</span></a>` : ''}
        ${a.needs_review.length ? `<a class="card stat" href="#/attestations/deductions"><span class="muted small">خصومات معتمدة تحتاج مراجعة</span><span class="num" style="color:var(--danger)">${a.needs_review.length}</span></a>` : ''}
      </div>` : '<div class="card muted small">لا توجد تنبيهات على التصديقات.</div>'}`;
  }

  // ---------- page shell with tabs ----------
  async function view(main, tab = 'requests') {
    const tabs = [['requests', 'الطلبات'], ['deductions', 'الخصومات'], ['reports', 'التقارير'], ['log', 'سجل العمليات'], ['policy', 'السياسة']];
    main.innerHTML = workspaceHead('تصديقات الغرفة التجارية', '<button class="btn primary" id="new-att">+ طلب تصديق</button>') + `
      <div class="tabs" role="tablist">${tabs.map(([k, l]) => `<a role="tab" href="#/attestations/${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div id="att-body"></div>`;
    $('#new-att').addEventListener('click', () => openForm(null, () => view(main, tab)));
    const body = $('#att-body');
    await ({ requests: requestsTab, deductions: deductionsTab, reports: reportsTab, log: logTab, policy: policyTab }[tab] || requestsTab)(body, () => view(main, tab));
  }

  // ---------- requests ----------
  async function requestsTab(el, reload) {
    const m = await meta();
    el.innerHTML = `
      <div class="toolbar">
        <input type="search" id="f-q" placeholder="بحث بالرقم أو الموظف أو الإدارة…" style="max-width:280px">
        <select id="f-status" style="max-width:160px"><option value="">كل الحالات</option>${Object.entries(m.status).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <select id="f-charged" style="max-width:160px"><option value="">على حساب: الكل</option><option value="company">الشركة</option><option value="employee">الموظف</option></select>
        <label class="row small muted">من <input type="date" id="f-from" style="width:auto"></label>
        <label class="row small muted">إلى <input type="date" id="f-to" style="width:auto"></label>
        <button class="btn small" id="f-csv">تصدير CSV</button>
      </div>
      <div class="table-wrap" id="att-tbl"><div class="empty">جارٍ التحميل…</div></div>`;
    const qs = () => new URLSearchParams(Object.fromEntries([['q', $('#f-q').value], ['status', $('#f-status').value], ['charged_to', $('#f-charged').value], ['from', $('#f-from').value], ['to', $('#f-to').value]].filter(([, v]) => v))).toString();
    const load = async () => {
      const rows = await api(`/api/attestations?${qs()}`);
      $('#att-tbl').innerHTML = rows.length ? `<table><thead><tr><th>رقم الطلب</th><th>الموظف</th><th>الإدارة</th><th>نوع المستند</th><th>تاريخ الطلب</th><th>الحالة</th><th>سنة العقد</th><th>الرسوم</th><th>الخصم</th></tr></thead><tbody>
        ${rows.map((r) => `<tr class="clickable" data-open="${r.id}">
          <td class="ltr">${esc(r.request_no)}</td><td>${esc(r.employee_name)}${r.needs_review ? ' ' + pill('danger', 'مراجعة') : ''}</td><td>${esc(r.department || '—')}</td>
          <td>${esc(r.document_type)}</td><td>${dmy(r.request_date)}</td><td>${pill(STATUS_PILL[r.status], m.status[r.status])}</td>
          <td>${chargePill(r)}</td><td>${money(r.fee_amount)}</td>
          <td>${r.deduction_status === 'not_applicable' ? '<span class="muted small">—</span>' : `${pill(DED_PILL[r.deduction_status], m.deduction[r.deduction_status])}<div class="small">${money(r.deduction_amount)}</div>`}</td></tr>`).join('')}
        </tbody></table>` : `<div class="empty">لا توجد طلبات تصديق في ${esc(state.company.name_ar)}${qs() ? ' مطابقة للبحث' : ''}.</div>`;
      $$('[data-open]').forEach((tr) => tr.addEventListener('click', () => openDetail(Number(tr.dataset.open), load)));
    };
    let t; $('#f-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    ['#f-status', '#f-charged', '#f-from', '#f-to'].forEach((s) => $(s).addEventListener('change', load));
    $('#f-csv').addEventListener('click', () => download(`/api/attestations/export.csv?${qs()}`, `تصديقات ${state.company.name_ar}.csv`).catch((e) => toast(e.message, 'error')));
    await load();
  }

  // ---------- create / edit form ----------
  async function openForm(record, onSaved) {
    const m = await meta();
    const [emps, pol] = await Promise.all([api('/api/records/employees'), api('/api/attestations/policy')]);
    const company = state.company;
    const r = record || {};
    const isOther = r.document_type && !m.document_types.includes(r.document_type);
    const locked = r.deduction_status === 'confirmed' || r.deduction_status === 'waived';
    const body = `${companyBanner(record ? 'هذا الطلب تابع لـ' : 'سيُحفظ هذا الطلب في')}
      ${locked ? '<div class="notice small" style="margin-bottom:12px">الخصم على هذا الطلب مؤكد/معفى؛ الموظف وتاريخ الطلب والرسوم مقفلة.</div>' : ''}
      <form id="att-form" class="stack">
        <label class="field"><span>الموظف (من دليل موظفي ${esc(company.name_ar)}) <span class="req">*</span></span>
          <select name="employee_id" required ${locked ? 'disabled' : ''}><option value="">اختر…</option>
          ${emps.rows.map((e) => `<option value="${e.id}" ${e.id === r.employee_id ? 'selected' : ''}>${esc(e.full_name_ar)}${e.employee_no ? ' · ' + esc(e.employee_no) : ''}</option>`).join('')}</select></label>
        <div id="emp-info" class="card" style="background:var(--bg)"><span class="muted small">اختر الموظف لعرض بياناته من دليل الموظفين.</span></div>
        <div class="form-grid">
          <label class="field"><span>نوع المستند <span class="req">*</span></span>
            <select name="document_type_sel">${m.document_types.map((d) => `<option ${d === r.document_type || (isOther && d === 'أخرى') ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select></label>
          <label class="field" id="doc-other" ${isOther || r.document_type === 'أخرى' ? '' : 'hidden'}><span>حدد نوع المستند</span><input type="text" name="document_type_other" value="${esc(isOther ? r.document_type : '')}"></label>
          <label class="field"><span>الغرض / الجهة المقدَّم لها</span><input type="text" name="purpose" value="${esc(r.purpose || '')}"></label>
          <label class="field"><span>تاريخ الطلب <span class="req">*</span></span><input type="date" name="request_date" value="${esc(r.request_date || today())}" max="${today()}" required ${locked ? 'disabled' : ''}></label>
          <label class="field"><span>رسوم التصديق (ر.س) <span class="req">*</span>${pol.current.default_fee === null ? ' <span class="muted small">— لا توجد رسوم افتراضية في السياسة</span>' : ''}</span>
            <input type="number" step="0.01" min="0" name="fee_amount" class="ltr" value="${esc(r.fee_amount ?? pol.current.default_fee ?? '')}" required ${locked ? 'disabled' : ''}></label>
          <label class="field"><span>مرجع الغرفة التجارية</span><input type="text" name="chamber_reference" class="ltr" value="${esc(r.chamber_reference || '')}"></label>
          <label class="field full"><span>ملاحظات</span><textarea name="notes">${esc(r.notes || '')}</textarea></label>
        </div>
      </form><p class="error-text" id="att-err" hidden></p>`;
    const d = openModal(record ? `تعديل طلب ${r.request_no}` : 'طلب تصديق جديد', body,
      `<button class="btn primary" form="att-form" type="submit">حفظ في ${esc(company.name_ar)}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    $('[data-close]', d).addEventListener('click', () => d.close());
    const f = $('#att-form', d);
    f.document_type_sel.addEventListener('change', () => ($('#doc-other', d).hidden = f.document_type_sel.value !== 'أخرى'));
    const showEmployee = async () => {
      const box = $('#emp-info', d);
      if (!f.employee_id.value) { box.innerHTML = '<span class="muted small">اختر الموظف لعرض بياناته من دليل الموظفين.</span>'; return; }
      const st = await api(`/api/attestations/employee-status?employee_id=${f.employee_id.value}&date=${f.request_date.value || today()}`);
      box.innerHTML = `<dl class="kv">
          <dt>الاسم</dt><dd>${esc(st.employee.full_name_ar)}</dd><dt>الشركة</dt><dd>${esc(st.employee.company)}</dd>
          <dt>الإدارة</dt><dd>${esc(st.employee.department || '—')}</dd><dt>تاريخ المباشرة</dt><dd>${dmy(st.employee.hire_date)}</dd>
          ${st.contract_year ? `<dt>سنة العقد</dt><dd>${dmy(st.contract_year.start)} – ${dmy(st.contract_year.end)}</dd>
            <dt>المستخدم في هذه السنة</dt><dd>${st.used} من ${st.free_limit} على الشركة</dd>` : ''}
        </dl>
        ${st.error ? `<p class="error-text small" style="margin:8px 0 0">${esc(st.error)}</p>`
          : record ? '' : `<p class="small" style="margin:8px 0 0">هذا سيكون التصديق رقم <b>${st.next_seq}</b> في سنة العقد — ${st.next_charged_to === 'employee' ? pill('warn', 'على الموظف (يُسجَّل خصم بعد تأكيد الفريق)') : pill('info', 'على الشركة')}</p>`}`;
    };
    f.employee_id.addEventListener('change', showEmployee);
    f.request_date.addEventListener('change', showEmployee);
    if (r.employee_id) showEmployee();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const docType = f.document_type_sel.value === 'أخرى' && f.document_type_other.value.trim() ? f.document_type_other.value.trim() : f.document_type_sel.value;
      const data = { document_type: docType, purpose: f.purpose.value, chamber_reference: f.chamber_reference.value, notes: f.notes.value };
      if (!locked) Object.assign(data, { employee_id: Number(f.employee_id.value), request_date: f.request_date.value, fee_amount: f.fee_amount.value });
      try {
        const saved = record ? await api(`/api/attestations/${record.id}`, { method: 'PATCH', body: data }) : await api('/api/attestations', { method: 'POST', body: data });
        d.close();
        toast(`تم الحفظ — ${saved.request_no}${!record && saved.charged_to === 'employee' ? ' (على الموظف: خصم بانتظار تأكيد الفريق)' : ''}`);
        onSaved?.();
      } catch (err) {
        if (err.code === 'company_changed') return d.close();
        const el = $('#att-err', d); el.textContent = err.message; el.hidden = false;
      }
    });
  }

  // ---------- detail ----------
  async function openDetail(id, onChange) {
    const m = await meta();
    const r = await api(`/api/attestations/${id}`);
    const acts = Object.entries(STATUS_ACTIONS).filter(([, a]) => a.from.includes(r.status));
    const d = openModal(`طلب تصديق ${r.request_no}`, `
      ${r.needs_review ? `<div class="notice" style="margin-bottom:12px"><b>يحتاج مراجعة:</b> ${esc(r.review_reason || '')}</div>` : ''}
      <div class="grid cols-2">
        <dl class="kv">
          <dt>الموظف</dt><dd>${esc(r.employee_name)}</dd><dt>الإدارة</dt><dd>${esc(r.department || '—')}</dd><dt>تاريخ المباشرة</dt><dd>${dmy(r.hire_date)}</dd>
          <dt>نوع المستند</dt><dd>${esc(r.document_type)}</dd><dt>الغرض / الجهة</dt><dd>${esc(r.purpose || '—')}</dd>
          <dt>تاريخ الطلب</dt><dd>${dmy(r.request_date)}</dd><dt>الحالة</dt><dd>${pill(STATUS_PILL[r.status], m.status[r.status])}</dd>
          ${r.submitted_at ? `<dt>أُرسل للتصديق</dt><dd>${dmy(r.submitted_at)}</dd>` : ''}${r.attested_at ? `<dt>تاريخ التصديق</dt><dd>${dmy(r.attested_at)}</dd>` : ''}
          ${r.delivered_at ? `<dt>تاريخ التسليم</dt><dd>${dmy(r.delivered_at)}</dd>` : ''}${r.cancelled_at ? `<dt>أُلغي</dt><dd>${dmy(r.cancelled_at)} — ${esc(r.cancel_reason || '')}</dd>` : ''}
          ${r.chamber_reference ? `<dt>مرجع الغرفة</dt><dd class="ltr">${esc(r.chamber_reference)}</dd>` : ''}
        </dl>
        <dl class="kv">
          <dt>سنة العقد</dt><dd>${dmy(r.contract_year_start)} – ${dmy(r.contract_year_end)}</dd>
          <dt>الترتيب</dt><dd>${chargePill(r)}</dd>
          <dt>السياسة المطبقة</dt><dd>الإصدار ${r.policy?.version} — ${r.free_limit} على الشركة · ${esc(BASIS[r.year_basis])}</dd>
          <dt>الرسوم</dt><dd>${money(r.fee_amount)}</dd>
          <dt>الخصم من الراتب</dt><dd>${pill(DED_PILL[r.deduction_status], m.deduction[r.deduction_status])} ${r.deduction_status !== 'not_applicable' ? money(r.deduction_amount) : ''}</dd>
          ${r.deduction_payroll_month ? `<dt>شهر المسير</dt><dd class="ltr">${esc(r.deduction_payroll_month)}</dd>` : ''}
          ${r.deduction_note ? `<dt>ملاحظة الخصم</dt><dd>${esc(r.deduction_note)}</dd>` : ''}
        </dl>
      </div>
      <h3 style="margin:16px 0 8px">سجل التعديلات</h3>
      <ul class="timeline">${r.events.map((e) => `<li><b>${esc(EVENTS[e.event] || e.event)}</b>${e.detail ? ` — ${esc(e.detail)}` : ''}${changesHtml(e)}<div class="muted small">${esc(fmtTime(e.created_at))} · ${esc(e.user_name || 'النظام')}</div></li>`).join('')}</ul>`,
    `<button class="btn small" data-edit>تعديل</button>
     ${acts.map(([k, a]) => `<button class="btn small" data-act="${k}">${a.label}</button>`).join('')}
     ${r.deduction_status === 'pending' ? '<button class="btn primary small" data-confirm>تأكيد تسجيل الخصم</button>' : ''}
     ${isAdmin() && r.deduction_status === 'pending' ? '<button class="btn small" data-waive>إعفاء (المسؤول)</button>' : ''}
     ${isAdmin() && ['confirmed', 'waived'].includes(r.deduction_status) ? '<button class="btn small" data-revert>إلغاء التأكيد/الإعفاء (المسؤول)</button>' : ''}
     ${isAdmin() ? '<button class="btn small" data-delete style="color:var(--danger)">حذف (المسؤول)</button>' : ''}
     <button class="btn small" data-close>إغلاق</button>`);
    d.classList.add('wide');
    const refresh = () => { d.close(); onChange?.(); };
    $('[data-close]', d).addEventListener('click', () => d.close());
    $('[data-edit]', d).addEventListener('click', () => { d.close(); openForm(r, onChange); });
    $$('[data-act]', d).forEach((b) => b.addEventListener('click', () => statusDialog(r, b.dataset.act, refresh)));
    $('[data-confirm]', d)?.addEventListener('click', () => confirmDialog(r, refresh));
    $('[data-waive]', d)?.addEventListener('click', () => reasonDialog(`إعفاء ${r.employee_name} من خصم ${r.request_no}`, 'سبب الإعفاء', 'إعفاء', (reason) => api(`/api/attestations/${r.id}/deduction/waive`, { method: 'POST', body: { reason } }), refresh));
    $('[data-revert]', d)?.addEventListener('click', () => reasonDialog(`إلغاء تأكيد الخصم — ${r.request_no}`, 'سبب الإلغاء', 'إلغاء التأكيد', (reason) => api(`/api/attestations/${r.id}/deduction/revert`, { method: 'POST', body: { reason } }), refresh));
    $('[data-delete]', d)?.addEventListener('click', () => reasonDialog(`حذف الطلب ${r.request_no}`, 'سبب الحذف (يُحفظ في سجل العمليات)', 'حذف نهائي', (reason) => api(`/api/attestations/${r.id}`, { method: 'DELETE', body: { reason } }), refresh));
  }

  const changesHtml = (e) => {
    if (!e.changes_json) return '';
    const c = JSON.parse(e.changes_json);
    if (c.snapshot) return '';
    const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : esc(String(v)));
    return `<div class="small muted">${Object.entries(c).map(([k, [a, b]]) => `${esc(FIELD_LABELS[k] || k)}: ${fmt(a)} ← ${fmt(b)}`).join(' · ')}</div>`;
  };

  function formDialog(title, inner, submitLabel, onSubmit, onDone) {
    const d = openModal(title, `${companyBanner('هذا الإجراء على بيانات')}<form id="dlg-form" class="stack">${inner}</form><p class="error-text" id="dlg-err" hidden></p>`,
      `<button class="btn primary" form="dlg-form" type="submit">${submitLabel}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    $('[data-close]', d).addEventListener('click', () => d.close());
    $('#dlg-form', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await onSubmit(e.target); d.close(); toast('تم'); onDone?.(); }
      catch (err) { if (err.code === 'company_changed') return d.close(); const el = $('#dlg-err', d); el.textContent = err.message; el.hidden = false; }
    });
  }

  function statusDialog(r, action, onDone) {
    const a = STATUS_ACTIONS[action];
    formDialog(`${a.label} — ${r.request_no}`, `
      ${action !== 'reopen' ? `<label class="field"><span>التاريخ <span class="req">*</span></span><input type="date" name="date" value="${today()}" max="${today()}" required></label>` : ''}
      ${a.ref ? `<label class="field"><span>مرجع الغرفة التجارية</span><input type="text" name="chamber_reference" class="ltr" value="${esc(r.chamber_reference || '')}"></label>` : ''}
      ${a.reason ? '<label class="field"><span>سبب الإلغاء <span class="req">*</span></span><input type="text" name="reason" required></label><p class="small muted" style="margin:0">الطلب الملغي لا يُحتسب ضمن تصديقات سنة العقد، ويُعاد احتساب الطلبات غير المؤكدة.</p>' : ''}`,
    a.label, (f) => api(`/api/attestations/${r.id}/status`, { method: 'POST', body: { action, date: f.date?.value, reason: f.reason?.value, chamber_reference: f.chamber_reference?.value } }), onDone);
  }

  function confirmDialog(r, onDone) {
    formDialog(`تأكيد تسجيل خصم — ${r.request_no}`, `
      <dl class="kv"><dt>الموظف</dt><dd>${esc(r.employee_name)}</dd><dt>الطلب</dt><dd>${esc(r.document_type)} — التصديق رقم ${r.seq_in_year} في سنة العقد</dd><dt>مبلغ الخصم</dt><dd>${money(r.deduction_amount)}</dd></dl>
      <label class="field"><span>شهر مسير الرواتب <span class="req">*</span></span><input type="month" name="payroll_month" value="${today().slice(0, 7)}" required></label>
      <label class="field"><span>ملاحظة (اختياري)</span><input type="text" name="note"></label>
      <label class="check"><input type="checkbox" name="confirm" required> راجع الفريق الخصم ويؤكد تسجيله في مسير الرواتب</label>
      <p class="small muted" style="margin:0">المنصة لا تنفذ أي خصم؛ هذا تسجيل لتأكيد الفريق فقط.</p>`,
    'تأكيد التسجيل', (f) => api(`/api/attestations/${r.id}/deduction/confirm`, { method: 'POST', body: { payroll_month: f.payroll_month.value, note: f.note.value, team_confirmed: f.confirm.checked } }), onDone);
  }

  function reasonDialog(title, label, submit, call, onDone) {
    formDialog(title, `<label class="field"><span>${label} <span class="req">*</span></span><input type="text" name="reason" required></label>`, submit, (f) => call(f.reason.value), onDone);
  }

  // ---------- deductions ----------
  async function deductionsTab(el, reload) {
    const m = await meta();
    const [pending, review, confirmed] = await Promise.all([
      api('/api/attestations?deduction_status=pending'), api('/api/attestations?needs_review=1'), api('/api/attestations?deduction_status=confirmed'),
    ]);
    const table = (rows, extra) => (rows.length ? `<div class="table-wrap"><table><thead><tr><th>رقم الطلب</th><th>الموظف</th><th>الإدارة</th><th>تاريخ الطلب</th><th>الترتيب</th><th>المبلغ</th>${extra.head}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="ltr">${esc(r.request_no)}</td><td>${esc(r.employee_name)}</td><td>${esc(r.department || '—')}</td><td>${dmy(r.request_date)}</td>
        <td>التصديق ${r.seq_in_year ?? "—"} <span class="muted small">· المسموح ${r.free_limit}</span></td><td>${money(r.deduction_amount)}</td>${extra.cell(r)}</tr>`).join('')}
      </tbody></table></div>` : '<span class="muted small">لا يوجد.</span>');
    el.innerHTML = `
      <div class="stack">
        <div class="card stack"><div class="spread"><h2>خصومات بانتظار تأكيد الفريق</h2><span class="pill warn">${pending.length}</span></div>
          <p class="small muted" style="margin:0">التصديق الثالث فما بعد في سنة العقد يُحمَّل على الموظف. لا يُسجَّل الخصم إلا بعد تأكيد الفريق.</p>
          ${table(pending, { head: '<th></th>', cell: (r) => `<td><button class="btn primary small" data-confirm="${r.id}">تأكيد التسجيل</button> <button class="btn small" data-open="${r.id}">التفاصيل</button></td>` })}</div>
        ${review.length ? `<div class="card stack"><div class="spread"><h2>خصومات معتمدة تحتاج مراجعة</h2><span class="pill danger">${review.length}</span></div>
          <p class="small muted" style="margin:0">تغيّر ترتيب هذه الطلبات بعد اعتماد الخصم (مثل إلغاء طلب سابق). لم يُغيَّر الخصم تلقائيًا؛ يقرر المسؤول.</p>
          ${table(review, { head: '<th>السبب</th><th></th>', cell: (r) => `<td class="small" style="white-space:normal">${esc(r.review_reason || '')}</td><td><button class="btn small" data-open="${r.id}">التفاصيل</button></td>` })}</div>` : ''}
        <div class="card stack"><div class="spread"><h2>خصومات مؤكدة</h2><span class="pill ok">${confirmed.length}</span></div>
          ${table(confirmed, { head: '<th>شهر المسير</th><th>أكّدها</th><th></th>', cell: (r) => `<td class="ltr">${esc(r.deduction_payroll_month || '')}</td><td class="small">${esc(r.confirmed_by_name || '')}</td><td><button class="btn small" data-open="${r.id}">التفاصيل</button></td>` })}</div>
      </div>`;
    const all = [...pending, ...review, ...confirmed];
    $$('[data-confirm]', el).forEach((b) => b.addEventListener('click', () => confirmDialog(all.find((r) => r.id === Number(b.dataset.confirm)), reload)));
    $$('[data-open]', el).forEach((b) => b.addEventListener('click', () => openDetail(Number(b.dataset.open), reload)));
    void m;
  }

  // ---------- reports ----------
  async function reportsTab(el) {
    const m = await meta();
    const y = today().slice(0, 4);
    el.innerHTML = `<div class="toolbar">
        <label class="row small muted">من <input type="date" id="r-from" value="${y}-01-01" style="width:auto"></label>
        <label class="row small muted">إلى <input type="date" id="r-to" value="${today()}" style="width:auto"></label>
        <button class="btn small" id="r-csv">تصدير التفاصيل CSV</button></div><div id="r-body"></div>`;
    const load = async () => {
      const s = await api(`/api/attestations/summary?from=${$('#r-from').value}&to=${$('#r-to').value}`);
      const t = s.totals;
      const grp = (title, rows) => `<div class="card stack"><h3>${title}</h3>${rows.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>العدد</th><th>على الشركة</th><th>على الموظف</th><th>الرسوم</th></tr></thead><tbody>
        ${rows.map((g) => `<tr><td>${esc(g.key)}</td><td>${g.count}</td><td>${g.company}</td><td>${g.employee}</td><td>${money(g.fees)}</td></tr>`).join('')}</tbody></table></div>` : '<span class="muted small">لا يوجد.</span>'}</div>`;
      $('#r-body').innerHTML = `
        <p class="small muted">السياسة الحالية: الإصدار ${s.policy.version} — أول ${s.policy.free_per_year} في ${esc(BASIS[s.policy.year_basis])} على الشركة.</p>
        <div class="grid cols-4" style="margin-bottom:16px">
          <div class="card stat"><span class="muted small">طلبات (غير ملغاة)</span><span class="num">${t.requests}</span><span class="small muted">ملغاة: ${t.cancelled}</span></div>
          <div class="card stat"><span class="muted small">على الشركة</span><span class="num">${t.company_charged}</span><span class="small">${money(t.company_cost)}</span></div>
          <div class="card stat"><span class="muted small">على الموظفين</span><span class="num">${t.employee_charged}</span></div>
          <div class="card stat"><span class="muted small">خصومات مؤكدة</span><span class="num small-num">${money(t.deductions_confirmed)}</span><span class="small muted">بانتظار التأكيد: ${money(t.deductions_pending)} · معفى: ${money(t.deductions_waived)}</span></div>
        </div>
        <div class="card" style="margin-bottom:16px"><div class="row">${Object.entries(t.by_status).map(([k, n]) => `${pill(STATUS_PILL[k], `${m.status[k]}: ${n}`)}`).join(' ')}</div></div>
        <div class="grid cols-2">${grp('حسب الإدارة', s.by_department)}${grp('حسب نوع المستند', s.by_document_type)}</div>
        <div class="card stack" style="margin-top:16px"><h3>حسب الموظف</h3>${s.by_employee.length ? `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>الإدارة</th><th>العدد</th><th>على الموظف</th><th>الخصومات</th></tr></thead><tbody>
          ${s.by_employee.map((e) => `<tr><td>${esc(e.employee_name)}</td><td>${esc(e.department || '—')}</td><td>${e.count}</td><td>${e.employee_charged}</td><td>${money(e.deductions)}</td></tr>`).join('')}</tbody></table></div>` : '<span class="muted small">لا يوجد.</span>'}</div>`;
    };
    $('#r-from').addEventListener('change', load);
    $('#r-to').addEventListener('change', load);
    $('#r-csv').addEventListener('click', () => download(`/api/attestations/export.csv?from=${$('#r-from').value}&to=${$('#r-to').value}`, `تصديقات ${state.company.name_ar}.csv`).catch((e) => toast(e.message, 'error')));
    await load();
  }

  // ---------- log ----------
  async function logTab(el) {
    const ev = await api('/api/attestations/events');
    el.innerHTML = ev.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الطلب</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>
      ${ev.map((e) => `<tr><td class="small ltr">${esc(fmtTime(e.created_at))}</td><td class="small">${esc(e.user_name || 'النظام')}</td><td class="ltr small">${esc(e.request_no || '—')}</td>
        <td>${esc(EVENTS[e.event] || e.event)}</td><td class="small" style="white-space:normal">${esc(e.detail || '')}${changesHtml(e)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">لا توجد عمليات مسجلة بعد.</div>';
  }

  // ---------- policy ----------
  async function policyTab(el, reload) {
    const p = await api('/api/attestations/policy');
    const c = p.current;
    el.innerHTML = `<div class="grid cols-2">
      <div class="card stack"><h2>السياسة الحالية — الإصدار ${c.version}</h2>
        <dl class="kv"><dt>على الشركة في كل سنة</dt><dd>${c.free_per_year} تصديق</dd><dt>أساس السنة</dt><dd>${esc(BASIS[c.year_basis])}</dd>
          <dt>الرسوم الافتراضية</dt><dd>${c.default_fee === null ? '<span class="muted">غير محددة — تُدخل مع كل طلب</span>' : money(c.default_fee)}</dd>
          <dt>تنبيه الطلبات المفتوحة بعد</dt><dd>${c.overdue_days} أيام</dd><dt>سارية من</dt><dd>${dmy(c.effective_from)}</dd></dl>
        <p class="small muted" style="margin:0">تعديل السياسة ينشئ إصدارًا جديدًا يُطبَّق على الطلبات الجديدة فقط. الطلبات السابقة والخصومات المعتمدة لا تتغير.</p>
      </div>
      ${isAdmin() ? `<form class="card stack" id="pol-form"><h2>تعديل السياسة (المسؤول)</h2>
        <div class="form-grid">
          <label class="field"><span>عدد التصديقات على الشركة في كل سنة</span><input type="number" name="free_per_year" min="0" max="50" value="${c.free_per_year}" required></label>
          <label class="field"><span>أساس السنة</span><select name="year_basis">${Object.entries(BASIS).map(([k, v]) => `<option value="${k}" ${k === c.year_basis ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
          <label class="field"><span>الرسوم الافتراضية (اتركها فارغة إن لم تُحدد)</span><input type="number" step="0.01" min="0" name="default_fee" class="ltr" value="${c.default_fee ?? ''}"></label>
          <label class="field"><span>تنبيه الطلبات المفتوحة بعد (أيام)</span><input type="number" name="overdue_days" min="1" max="365" value="${c.overdue_days}" required></label>
          <label class="field full"><span>سبب التعديل / مرجع القرار</span><input type="text" name="note"></label>
        </div><div class="row"><button class="btn primary">حفظ كإصدار جديد</button></div></form>` : '<div class="card muted small">تعديل السياسة متاح لحساب المسؤول فقط.</div>'}
    </div>
    <div class="card stack" style="margin-top:16px"><h3>سجل إصدارات السياسة</h3><div class="table-wrap"><table><thead><tr><th>الإصدار</th><th>على الشركة</th><th>أساس السنة</th><th>الرسوم الافتراضية</th><th>سارية من</th><th>بواسطة</th><th>ملاحظة</th></tr></thead><tbody>
      ${p.history.map((h) => `<tr><td>${h.version}</td><td>${h.free_per_year}</td><td>${esc(BASIS[h.year_basis])}</td><td>${h.default_fee === null ? '—' : money(h.default_fee)}</td><td>${dmy(h.effective_from)}</td><td class="small">${esc(h.created_by_name || 'النظام')}</td><td class="small" style="white-space:normal">${esc(h.note || '')}</td></tr>`).join('')}
    </tbody></table></div></div>`;
    $('#pol-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/admin/attestations/policy', { method: 'POST', body: { free_per_year: Number(f.free_per_year.value), year_basis: f.year_basis.value, default_fee: f.default_fee.value === '' ? null : f.default_fee.value, overdue_days: Number(f.overdue_days.value), note: f.note.value } });
        toast('تم حفظ إصدار جديد من السياسة'); reload();
      } catch (err) { toast(err.message, 'error'); }
    });
  }

  return { view, dashboardSection };
}
