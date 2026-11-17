// Consulting contracts UI: follow-up dashboard, contracts list, contract page,
// certificates and payments. All data comes from /api/consulting/* which is
// always scoped to the company selected in the session.

import { startTour, helpTip, installHelpTips, waitFor } from './tour.js';

const STATUS = { draft: 'مسودة', sent: 'أُرسل للتوقيع', active: 'موقّع وساري', terminated: 'منهى', closed: 'مغلق', expired: 'منتهي المدة' };
const STATUS_PILL = { draft: 'off', sent: 'info', active: 'ok', terminated: 'danger', closed: 'off', expired: 'warn' };
const STAGE = { in_progress: 'قيد التنفيذ', completed: 'منجز', certificate_issued: 'صدرت الشهادة', certificate_sent: 'أُرسلت الشهادة' };
const STAGE_PILL = { in_progress: 'off', completed: 'info', certificate_issued: 'info', certificate_sent: 'ok' };
const PAY = { unpaid: 'غير مدفوع', partial: 'مدفوع جزئيًا', paid: 'مدفوع' };
const PAY_PILL = { unpaid: 'off', partial: 'warn', paid: 'ok' };
const EVENTS = {
  created: 'إنشاء العقد', updated: 'تعديل بيانات العقد', contract_generated: 'إصدار ملف العقد (Word)', signed_copy_uploaded: 'رفع النسخة الموقعة',
  'status:mark_sent': 'تسجيل الإرسال للتوقيع', 'status:mark_signed': 'تسجيل التوقيع', 'status:terminate': 'إنهاء العقد', 'status:close': 'إغلاق العقد', 'status:reopen': 'إعادة فتح العقد',
  certificate_issued: 'إصدار شهادة إنجاز', certificate_reissued: 'إعادة إصدار شهادة إنجاز', certificate_sent: 'تسجيل إرسال الشهادة',
  payment_recorded: 'تسجيل صرف', payment_deleted: 'حذف دفعة (سجل قديم)', payment_voided: 'إلغاء صرف', payment_corrected: 'تصحيح صرف', consultant_created: 'إنشاء الاستشاري مع العقد',
  payment_request_created: 'إنشاء طلب دفعة', payment_request_updated: 'تعديل طلب دفعة', payment_request_issued: 'إصدار طلب الدفعة', payment_request_reissued: 'إعادة إصدار طلب الدفعة',
  payment_request_sent: 'إرسال الطلب للمالية', payment_request_cancelled: 'إلغاء طلب الدفعة', payment_request_paid: 'تسجيل صرف على الطلب',
};
const ACTIONS = {
  mark_sent: { label: 'تسجيل الإرسال للتوقيع', from: ['draft', 'sent'], dateLabel: 'تاريخ الإرسال' },
  mark_signed: { label: 'تسجيل التوقيع', from: ['draft', 'sent'], dateLabel: 'تاريخ التوقيع', file: true },
  terminate: { label: 'إنهاء العقد', from: ['sent', 'active'], dateLabel: 'تاريخ الإنهاء', reason: true },
  close: { label: 'إغلاق العقد', from: ['active', 'terminated'], dateLabel: 'تاريخ الإغلاق' },
  reopen: { label: 'إعادة فتح العقد', from: ['closed', 'terminated'], dateLabel: 'التاريخ' },
};

export function createConsultingViews(ctx) {
  const { api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, openRecordForm, state, fileToUpload } = ctx;
  installHelpTips();
  const money = (n) => `<span class="ltr">${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span> <span class="muted small">ر.س</span>`;
  const dmy = (iso) => (iso ? `<span class="ltr">${esc(iso.split('-').reverse().join('/'))}</span>` : '<span class="muted">—</span>');
  const pill = (cls, text) => `<span class="pill ${cls}">${esc(text)}</span>`;
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const statusPill = (c) => pill(STATUS_PILL[c.effective_status] || 'off', STATUS[c.effective_status] || c.status) + (c.ending_soon ? ' ' + pill('warn', 'ينتهي قريبًا') : '');
  const duePill = (d) => (d.due_state === 'overdue' ? pill('danger', 'متأخر') : d.due_state === 'upcoming' ? pill('warn', 'مستحق قريبًا') : '');

  const templateNotice = (tpl) => {
    const miss = [];
    if (!tpl.contract) miss.push('نموذج العقد الرسمي');
    if (!tpl.certificate) miss.push('نموذج شهادة الإنجاز الرسمي');
    if (!miss.length) return '';
    return `<div class="notice" style="margin-bottom:16px">${miss.join(' و')} ${miss.length > 1 ? 'غير متوفرين' : 'غير متوفر'} لـ ${esc(state.company.name_ar)}. لا يمكن إصدار مستند رسمي حتى يرفعه مسؤول النظام من «نماذج المستندات». باقي وظائف المتابعة تعمل بشكل طبيعي.</div>`;
  };

  // ---------- follow-up on the home page ----------
  async function dashboardSection(el) {
    const days = Number(sessionStorage.getItem('cc-days')) || 30;
    const s = await api(`/api/consulting/summary?days=${days}`);
    const list = (title, rows, cols, empty) => `
      <div class="card stack"><div class="spread"><h3>${title}</h3><span class="pill">${rows.length}</span></div>
        ${rows.length ? `<div class="table-wrap"><table><tbody>${rows.slice(0, 8).map(cols).join('')}</tbody></table></div>
          ${rows.length > 8 ? `<span class="muted small">و${rows.length - 8} أخرى…</span>` : ''}` : `<span class="muted small">${empty}</span>`}
      </div>`;
    const dRow = (extra) => (d) => `<tr class="clickable" data-go="${d.contract_id}">
      <td><b>${esc(d.consultant_name)}</b><div class="muted small">${esc(d.contract_no)} · المخرج ${d.seq}: ${esc(d.title)}</div></td>
      <td>${extra(d)}</td></tr>`;
    el.innerHTML = `
      <div class="spread" style="margin:28px 0 12px"><h2>متابعة العقود الاستشارية</h2>
        <label class="row small muted">الفترة القادمة
          <select id="cc-days" style="width:auto">${[7, 14, 30, 60, 90].map((n) => `<option value="${n}" ${n === s.days ? 'selected' : ''}>${n} يومًا</option>`).join('')}</select></label></div>
      <div class="grid cols-4" style="margin-bottom:16px">
        <a class="card stat" href="#/consulting/contracts"><span class="muted small">العقود السارية</span><span class="num">${s.counts.active}</span></a>
        <div class="card stat"><span class="muted small">قيمة العقود (غير المسودات)</span><span class="num small-num">${money(s.money.total)}</span></div>
        <div class="card stat"><span class="muted small">المدفوع</span><span class="num small-num">${money(s.money.paid)}</span></div>
        <div class="card stat"><span class="muted small">غير المدفوع</span><span class="num small-num" style="color:var(--danger)">${money(s.money.outstanding)}</span></div>
      </div>
      <div class="grid cols-2">
        ${list('مخرجات متأخرة غير مدفوعة', s.overdue, dRow((d) => `${dmy(d.due_date)}<div class="small">${money(d.remaining)}</div>`), 'لا توجد مخرجات متأخرة.')}
        ${list(`استحقاقات خلال ${s.days} يومًا`, s.upcoming, dRow((d) => `${dmy(d.due_date)}<div class="small">${money(d.remaining)}</div>`), 'لا توجد استحقاقات قادمة.')}
        ${list('شهادات صدرت ولم يُسجَّل إرسالها', s.certificates_to_send, dRow((d) => `<span class="ltr small">${esc(d.certificate_ref)}</span>`), 'لا يوجد.')}
        ${list('شهادات أُرسلت بانتظار الدفع', s.awaiting_payment, dRow((d) => `${money(d.remaining)}<div class="muted small">أُرسلت ${dmy(d.certificate_sent_at)}</div>`), 'لا يوجد.')}
        ${list('عقود تنتهي مدتها قريبًا', s.contracts_ending, (c) => `<tr class="clickable" data-go="${c.id}"><td><b>${esc(c.consultant_name)}</b><div class="muted small">${esc(c.contract_no)}</div></td><td>${dmy(c.end_date)}</td></tr>`, 'لا يوجد.')}
        ${list('عقود سارية انتهت مدتها', s.contracts_expired, (c) => `<tr class="clickable" data-go="${c.id}"><td><b>${esc(c.consultant_name)}</b><div class="muted small">${esc(c.contract_no)}</div></td><td>${dmy(c.end_date)}</td></tr>`, 'لا يوجد.')}
      </div>`;
    $$('[data-go]', el).forEach((r) => r.addEventListener('click', () => (location.hash = `#/consulting/contract/${r.dataset.go}`)));
    $('#cc-days', el).addEventListener('change', (e) => { try { sessionStorage.setItem('cc-days', e.target.value); } catch {} dashboardSection(el); });
  }

  // ---------- contracts list (now a tab of the unified section) ----------
  const viewContracts = (main) => hub(main, 'contracts');

  // ---------- contract form (create / edit) ----------
  async function openContractForm(contract, onSaved, opts = {}) {
    const company = state.company;
    const consultants = (await api('/api/records/consultants')).rows;
    const preset = opts.consultantId || null;
    const startExisting = !!preset || (!contract && consultants.length > 0);
    const optionHtml = (sel) => `<option value="">اختر…</option>${consultants.map((k) => `<option value="${k.id}" ${k.id === sel ? 'selected' : ''}>${esc(k.full_name_ar)}${k.id_number ? ' · ' + esc(k.id_number) : ''}</option>`).join('')}`;
    const v = contract || {};
    const field = (name, label, type = 'text', extra = '') => `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(v[name] ?? '')}" ${extra}></label>`;
    const body = `${companyBanner(contract ? 'هذا العقد تابع لـ' : 'سيُحفظ هذا العقد في')}
      <form id="cc-form" class="stack">
        <div class="form-grid">
          ${contract ? `<label class="field full"><span>الاستشاري <span class="req">*</span></span><select name="consultant_id" required>${optionHtml(v.consultant_id)}</select></label>` : `
          <div class="full stack" style="gap:8px">
            <div class="row" role="tablist" aria-label="الاستشاري"><b class="small">الاستشاري: ${helpTip('«استشاري موجود» للبحث في سجل الشركة. «استشاري جديد» يُحفظ مع العقد في عملية واحدة؛ يُرفض رقم الهوية المكرر، ويُطلب تأكيد عند تطابق الاسم أو الجوال أو الآيبان.', 'الاستشاري')}</b>
              <button type="button" class="btn small ${startExisting ? 'primary' : ''}" data-kmode="existing" aria-pressed="${startExisting}">استشاري موجود</button>
              <button type="button" class="btn small ${startExisting ? '' : 'primary'}" data-kmode="new" aria-pressed="${!startExisting}">استشاري جديد</button></div>
            <div data-ksec="existing" class="stack" style="gap:6px" ${startExisting ? '' : 'hidden'}>
              <input type="search" id="k-search" placeholder="ابحث بالاسم أو رقم الهوية…">
              <select name="consultant_id" size="4" style="height:auto">${optionHtml(preset)}</select></div>
            <div data-ksec="new" class="stack" style="gap:6px" ${startExisting ? 'hidden' : ''}>
              <p class="small muted" style="margin:0">يُحفظ الاستشاري والعقد معًا في عملية واحدة.</p>
              <div class="form-grid">
                <label class="field"><span>الاسم بالعربية <span class="req">*</span></span><input type="text" name="k_full_name_ar" data-kmatch></label>
                <label class="field"><span>الاسم بالإنجليزية</span><input type="text" name="k_full_name_en" class="ltr"></label>
                <label class="field"><span>رقم الهوية / الإقامة</span><input type="text" name="k_id_number" class="ltr" data-kmatch></label>
                <label class="field"><span>الجنسية</span><input type="text" name="k_nationality_ar"></label>
                <label class="field"><span>الجنس</span><select name="k_gender"><option value="">—</option><option value="male">ذكر</option><option value="female">أنثى</option></select></label>
                <label class="field"><span>الجوال</span><input type="text" name="k_mobile" class="ltr" data-kmatch></label>
                <label class="field"><span>البريد الإلكتروني</span><input type="text" name="k_email" class="ltr"></label>
                <label class="field"><span>اسم المستفيد في الحساب</span><input type="text" name="k_bank_beneficiary"></label>
                <label class="field"><span>البنك</span><input type="text" name="k_bank_name"></label>
                <label class="field"><span>الآيبان ${helpTip('يلزم لطلبات الدفعات، ويظهر في شهادة الإنجاز إذا كان نموذج الشركة يتضمنه.', 'الآيبان')}</span><input type="text" name="k_iban" class="ltr" data-kmatch></label>
                <label class="field"><span>السويفت</span><input type="text" name="k_swift_code" class="ltr"></label>
              </div>
              <div id="k-match" class="stack" style="gap:6px"></div>
              <label class="check" id="k-dup" hidden><input type="checkbox" name="confirm_new_consultant"> تأكدت أنه استشاري مختلف — أنشئ سجلًا جديدًا</label>
            </div></div>`}
          ${field('contract_no', `رقم العقد ${helpTip('يُولَّد تلقائيًا بصيغة الشركة (مثل COA/CC/2026/0001) إذا تُرك فارغًا، ولا يتكرر داخل الشركة.', 'رقم العقد')} <span class="muted small">(يُولَّد تلقائيًا إذا تُرك فارغًا)</span>`, 'text', 'class="ltr"')}
          ${field('project_name', 'اسم المشروع')}
          ${field('department', 'الإدارة الطالبة')}
          ${field('supervisor_name', 'المدير المسؤول')}
          ${field('contract_date', 'تاريخ العقد', 'date')}
          ${field('duration_text', `مدة العقد (كما تُكتب في العقد، مثل: شهرين) ${helpTip('نص يظهر كما هو في ملف العقد الرسمي عند إصداره؛ تواريخ البداية والنهاية تُستخدم للمتابعة والتنبيهات.', 'مدة العقد')}`)}
          ${field('start_date', 'تاريخ البداية', 'date')}
          ${field('end_date', 'تاريخ النهاية', 'date')}
          <label class="field full"><span>نطاق العمل</span><textarea name="scope">${esc(v.scope ?? '')}</textarea></label>
        </div>
        <div class="spread"><h3>المخرجات ${helpTip('لكل مخرج وصف وقيمة وتاريخ استحقاق. تُصدر شهادة إنجاز وطلب دفعة لكل مخرج، والمخرج الذي صدرت له شهادة أو سُجّل له صرف يُقفل من التعديل والحذف.', 'المخرجات')}</h3><span class="small">الإجمالي: <b id="dl-total"></b></span></div>
        <div class="table-wrap"><table class="edit-table"><thead><tr><th>#</th><th>وصف المخرج *</th><th>القيمة *</th><th>تاريخ الاستحقاق *</th><th>فترة التسليم من ${helpTip('اختيارية — تظهر في شهادة الإنجاز بصيغة «من … حتى …».', 'فترة التسليم')}</th><th>إلى</th><th></th></tr></thead>
          <tbody id="dl-rows"></tbody></table></div>
        <div><button type="button" class="btn small" id="dl-add">+ إضافة مخرج</button></div>
        <label class="field"><span>ملاحظات</span><textarea name="notes">${esc(v.notes ?? '')}</textarea></label>
      </form><p class="error-text" id="cc-err" hidden></p>`;
    const d = openModal(contract ? `تعديل العقد ${contract.contract_no}` : 'عقد استشاري جديد', body,
      `<button class="btn primary" form="cc-form" type="submit">حفظ في ${esc(company.name_ar)}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    d.classList.add('wide');
    $('[data-close]', d).addEventListener('click', () => d.close());

    const rowsEl = $('#dl-rows', d);
    const addRow = (x = {}) => {
      const locked = !!(x.certificate_issued_at || x.paid_total > 0);
      const tr = document.createElement('tr');
      tr.dataset.id = x.id || '';
      tr.innerHTML = `<td class="seq"></td>
        <td><input type="text" data-k="title" value="${esc(x.title ?? '')}" required></td>
        <td><input type="number" step="0.01" min="0" data-k="amount" value="${esc(x.amount ?? '')}" class="ltr" required style="min-width:110px"></td>
        <td><input type="date" data-k="due_date" value="${esc(x.due_date ?? '')}" required></td>
        <td><input type="date" data-k="period_from" value="${esc(x.period_from ?? '')}"></td>
        <td><input type="date" data-k="period_to" value="${esc(x.period_to ?? '')}"></td>
        <td>${locked ? '<span class="muted small" title="صدرت له شهادة أو سُجّلت له دفعة">🔒</span>' : '<button type="button" class="icon-btn" title="حذف" data-del>×</button>'}</td>`;
      rowsEl.appendChild(tr);
      $('[data-del]', tr)?.addEventListener('click', () => { tr.remove(); renumber(); });
      renumber();
    };
    const renumber = () => {
      $$('tr', rowsEl).forEach((tr, i) => ($('.seq', tr).textContent = i + 1));
      const total = $$('[data-k="amount"]', rowsEl).reduce((s, i) => s + (Number(i.value) || 0), 0);
      $('#dl-total', d).textContent = `${total.toLocaleString('en-US', { maximumFractionDigits: 2 })} ر.س`;
    };
    rowsEl.addEventListener('input', renumber);
    (contract?.deliverables?.length ? contract.deliverables : [{}]).forEach(addRow);
    $('#dl-add', d).addEventListener('click', () => addRow());
    let kmode = contract ? 'existing' : startExisting ? 'existing' : 'new';
    const kf = $('#cc-form', d);
    const setK = (m) => {
      kmode = m;
      $$('[data-kmode]', d).forEach((b) => { const on = b.dataset.kmode === m; b.classList.toggle('primary', on); b.setAttribute('aria-pressed', String(on)); });
      $$('[data-ksec]', d).forEach((x) => (x.hidden = x.dataset.ksec !== m));
    };
    $$('[data-kmode]', d).forEach((b) => b.addEventListener('click', () => setK(b.dataset.kmode)));
    $('#k-search', d)?.addEventListener('input', (e) => {
      const q = e.target.value.trim();
      const sel = kf.elements.consultant_id;
      sel.innerHTML = consultants.filter((k) => !q || [k.full_name_ar, k.full_name_en, k.id_number].some((x) => x && String(x).includes(q))).map((k) => `<option value="${k.id}">${esc(k.full_name_ar)}${k.id_number ? ' · ' + esc(k.id_number) : ''}</option>`).join('');
      if (sel.options.length === 1) sel.selectedIndex = 0;
    });
    const kMatch = async () => {
      if (kmode !== 'new') return;
      const q = new URLSearchParams(Object.fromEntries([['full_name_ar', kf.k_full_name_ar.value], ['id_number', kf.k_id_number.value], ['mobile', kf.k_mobile.value], ['iban', kf.k_iban.value]].filter(([, x]) => x.trim())));
      if (!q.toString()) { $('#k-match', d).innerHTML = ''; return; }
      const hits = await api(`/api/consulting/consultant-match?${q}`).catch(() => []);
      const BY = { id_number: 'رقم الهوية', iban: 'الآيبان', mobile: 'الجوال', name: 'الاسم' };
      $('#k-match', d).innerHTML = hits.map((h) => `<div class="notice small">موجود: <b>${esc(h.full_name_ar)}</b>${h.id_number ? ` <span class="ltr">${esc(h.id_number)}</span>` : ''} — مطابق في: ${h.matched_by.map((x) => BY[x]).join('، ')} — لديه ${h.contracts} عقد <button type="button" class="btn small" data-kpick="${h.id}">اختيار هذا الاستشاري</button></div>`).join('');
      $$('[data-kpick]', d).forEach((b) => b.addEventListener('click', () => { setK('existing'); kf.elements.consultant_id.innerHTML = optionHtml(Number(b.dataset.kpick)); }));
    };
    $$('[data-kmatch]', d).forEach((x) => x.addEventListener('change', kMatch));

    $('#cc-form', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const data = Object.fromEntries(['consultant_id', 'contract_no', 'project_name', 'department', 'supervisor_name', 'contract_date', 'duration_text', 'start_date', 'end_date', 'scope', 'notes'].map((k) => [k, f.elements[k].value]));
      data.deliverables = $$('tr', rowsEl).map((tr) => ({ id: tr.dataset.id ? Number(tr.dataset.id) : undefined, ...Object.fromEntries($$('[data-k]', tr).map((i) => [i.dataset.k, i.value])) }));
      try {
        let saved;
        if (contract) saved = await api(`/api/consulting/contracts/${contract.id}`, { method: 'PATCH', body: data });
        else if (kmode === 'new') {
          const consultant = Object.fromEntries(['full_name_ar', 'full_name_en', 'id_number', 'nationality_ar', 'gender', 'mobile', 'email', 'bank_beneficiary', 'bank_name', 'iban', 'swift_code'].map((k) => [k, f.elements[`k_${k}`].value]));
          if (!consultant.full_name_ar.trim()) throw Object.assign(new Error('اكتب اسم الاستشاري بالعربية.'), {});
          const { consultant_id, ...contractData } = data; void consultant_id;
          saved = await api('/api/consulting/contracts-with-consultant', { method: 'POST', body: { consultant, contract: contractData, confirm_new_consultant: f.elements.confirm_new_consultant.checked } });
        } else {
          if (!data.consultant_id) throw new Error('اختر الاستشاري من القائمة.');
          saved = await api('/api/consulting/contracts', { method: 'POST', body: data });
        }
        d.close();
        toast(`تم حفظ العقد ${saved.contract_no} في ${company.name_ar}`);
        onSaved?.(saved);
      } catch (err) {
        if (err.code === 'company_changed') return d.close();
        if (err.code === 'possible_duplicate') $('#k-dup', d).hidden = false;
        if (err.code === 'possible_duplicate' || err.code === 'consultant_exists') kMatch();
        const el = $('#cc-err', d); el.textContent = err.message; el.hidden = false;
      }
    });
  }

  // ---------- contract page ----------
  async function viewContract(main, id) {
    const [c, tpl] = await Promise.all([api(`/api/consulting/contracts/${id}`), api('/api/consulting/templates')]);
    const reload = () => viewContract(main, id);
    const k = c.consultant;
    const pct = c.total > 0 ? Math.min(100, Math.round((c.paid / c.total) * 100)) : 0;
    const actionBtns = Object.entries(ACTIONS).filter(([, a]) => a.from.includes(c.status))
      .map(([key, a]) => `<button class="btn small" data-act="${key}">${a.label}</button>`).join('');
    main.innerHTML = workspaceHead(`عقد ${c.contract_no}`, `<a class="btn small" href="#/consulting/contracts">← العقود</a><a class="btn small" href="#/consulting/consultant/${c.consultant.id}">الاستشاري</a><button class="btn small" id="edit">تعديل العقد والمخرجات</button>`) + templateNotice(tpl) + `
      <div class="grid cols-3" style="margin-bottom:16px">
        <div class="card stack">
          <div class="spread"><h2>العقد</h2>${statusPill(c)}</div>
          <dl class="kv">
            <dt>الاستشاري</dt><dd>${esc(k.full_name_ar)}</dd>
            <dt>المشروع</dt><dd>${esc(c.project_name || '—')}</dd>
            <dt>الإدارة / المسؤول</dt><dd>${esc([c.department, c.supervisor_name].filter(Boolean).join(' — ') || '—')}</dd>
            <dt>تاريخ العقد</dt><dd>${dmy(c.contract_date)}</dd>
            <dt>المدة</dt><dd>${dmy(c.start_date)} – ${dmy(c.end_date)}${c.duration_text ? ` <span class="muted small">(${esc(c.duration_text)})</span>` : ''}</dd>
            ${c.sent_at ? `<dt>أُرسل للتوقيع</dt><dd>${dmy(c.sent_at)}</dd>` : ''}
            ${c.signed_at ? `<dt>تاريخ التوقيع</dt><dd>${dmy(c.signed_at)}</dd>` : ''}
            ${c.terminated_at ? `<dt>تاريخ الإنهاء</dt><dd>${dmy(c.terminated_at)} — ${esc(c.termination_reason || '')}</dd>` : ''}
          </dl>
          ${actionBtns ? `<div class="row">${actionBtns}</div>` : ''}
        </div>
        <div class="card stack">
          <h2>المبالغ</h2>
          <dl class="kv"><dt>قيمة العقد</dt><dd>${money(c.total)}</dd><dt>المدفوع</dt><dd>${money(c.paid)}</dd><dt>المتبقي</dt><dd>${money(c.remaining)}</dd></dl>
          <div class="progress" title="${pct}%"><span style="width:${pct}%"></span></div>
          <span class="muted small">${pct}% مدفوع — يُحدَّث فقط عند تسجيل دفعة مؤكدة من الإدارة المالية.</span>
        </div>
        <div class="card stack">
          <h2>المستندات</h2>
          <div class="stack" style="gap:6px">
            <b class="small">ملف العقد (Word)</b>
            ${tpl.contract ? `<span class="muted small">النموذج المعتمد: ${esc(tpl.contract.original_name)} · الإصدار ${tpl.contract.version}</span>` : '<span class="error-text small">نموذج العقد الرسمي غير متوفر — الإصدار غير متاح.</span>'}
            <div class="row"><button class="btn primary small" id="gen" ${tpl.contract ? '' : 'disabled'}>معاينة وإصدار العقد</button>
              ${c.has_generated ? `<button class="btn small" id="dl-gen">تنزيل آخر إصدار</button><span class="muted small">${esc(fmtTime(c.generated_at))}</span>` : ''}</div>
          </div>
          <div class="stack" style="gap:6px">
            <b class="small">النسخة الموقعة</b>
            <div class="row">${c.has_signed ? '<button class="btn small" id="dl-signed">تنزيل النسخة الموقعة</button>' : '<span class="muted small">لم تُرفع بعد</span>'}
              <label class="btn small">رفع نسخة موقعة<input type="file" id="signed-file" accept=".pdf,.docx,image/png,image/jpeg" hidden></label></div>
          </div>
        </div>
      </div>

      <h2 style="margin:8px 0 10px">المخرجات</h2>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>المخرج</th><th>القيمة</th><th>الاستحقاق</th><th>فترة التسليم</th><th>الإنجاز / الشهادة</th><th>الدفع</th><th>الإجراءات</th></tr></thead><tbody>
        ${c.deliverables.map((d) => `<tr>
          <td>${d.seq}</td>
          <td style="white-space:normal;min-width:180px">${esc(d.title)}</td>
          <td>${money(d.amount)}</td>
          <td>${dmy(d.due_date)} ${duePill(d)}</td>
          <td class="small">${d.period_from || d.period_to ? `${dmy(d.period_from)} – ${dmy(d.period_to)}` : '<span class="muted">—</span>'}</td>
          <td>${pill(STAGE_PILL[d.stage], STAGE[d.stage])}
            ${d.certificate_ref ? `<div class="muted small ltr">${esc(d.certificate_ref)}</div>` : ''}
            ${d.completion_date ? `<div class="muted small">الإنجاز ${dmy(d.completion_date)}</div>` : ''}
            ${d.certificate_sent_at ? `<div class="muted small">أُرسلت ${dmy(d.certificate_sent_at)}${d.certificate_sent_to ? ' — ' + esc(d.certificate_sent_to) : ''}</div>` : ''}</td>
          <td>${pill(PAY_PILL[d.payment_status], PAY[d.payment_status])}<div class="small">${money(d.paid_total)} / ${money(d.amount)}</div></td>
          <td><div class="row" style="gap:4px">
            <button class="btn small" data-cert="${d.id}" ${tpl.certificate ? '' : 'disabled title="نموذج الشهادة غير متوفر"'}>${d.certificate_issued_at ? 'إعادة إصدار الشهادة' : 'إصدار شهادة الإنجاز'}</button>
            ${d.certificate_issued_at ? `<button class="btn small" data-cert-dl="${d.id}">تنزيل الشهادة</button><button class="btn small" data-sent="${d.id}">${d.certificate_sent_at ? 'تعديل تاريخ الإرسال' : 'تسجيل الإرسال'}</button>` : ''}
            ${d.certificate_issued_at && d.remaining - (d.open_claim || 0) > 0.005 && ['active', 'terminated', 'closed'].includes(c.status) ? `<button class="btn small primary" data-req-new="${d.id}">طلب دفعة</button>` : ''}
            ${d.open_claim > 0 ? `<span class="small muted">مطلوب بانتظار الصرف: ${money(d.open_claim)}</span>` : ''}
            ${d.remaining > 0 ? `<button class="btn small" data-pay="${d.id}">تسجيل صرف مباشر</button>` : ''}
          </div></td></tr>`).join('')}
      </tbody></table></div>

      <div class="grid cols-2" style="margin-top:16px">
        <div class="card stack"><h2>الصرف الفعلي</h2>${paymentsTable(c.payments)}
          <h3 style="margin-top:12px">طلبات الدفعات</h3><div id="c-requests"><span class="muted small">جارٍ التحميل…</span></div>
        </div>
        <div class="card stack"><h2>سجل النشاط</h2>
          <ul class="timeline">${c.events.map((e) => `<li><b>${esc(EVENTS[e.event] || e.event)}</b>${e.detail ? ` — ${esc(e.detail)}` : ''}<div class="muted small">${esc(fmtTime(e.created_at))} · ${esc(e.user_name || '')}</div></li>`).join('')}</ul>
        </div>
      </div>`;

    const byId = (x) => c.deliverables.find((d) => d.id === Number(x));
    $('#edit').addEventListener('click', () => openContractForm(c, reload));
    $$('[data-act]').forEach((b) => b.addEventListener('click', () => statusDialog(c, b.dataset.act, reload)));
    $('#gen')?.addEventListener('click', () => documentDialog({
      title: `إصدار العقد ${c.contract_no}`, tpl, previewUrl: `/api/consulting/contracts/${c.id}/document/preview`, issueUrl: `/api/consulting/contracts/${c.id}/document`,
      downloadUrl: `/api/consulting/contracts/${c.id}/document`, issueLabel: 'إصدار العقد وتنزيله', onDone: reload,
    }));
    $('#dl-gen')?.addEventListener('click', () => download(`/api/consulting/contracts/${c.id}/document`, `عقد ${c.contract_no}.docx`).catch((e) => toast(e.message, 'error')));
    $('#dl-signed')?.addEventListener('click', () => download(`/api/consulting/contracts/${c.id}/signed-copy`, `عقد موقع ${c.contract_no}`).catch((e) => toast(e.message, 'error')));
    $('#signed-file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { await api(`/api/consulting/contracts/${c.id}/signed-copy`, { method: 'POST', body: { file: await fileToUpload(f) } }); toast('تم رفع النسخة الموقعة'); reload(); }
      catch (err) { toast(err.message, 'error'); }
    });
    $$('[data-cert]').forEach((b) => b.addEventListener('click', () => certificateDialog(byId(b.dataset.cert), tpl, reload)));
    $$('[data-req-new]').forEach((b) => b.addEventListener('click', () => requestForm({ contractId: c.id, deliverableIds: [Number(b.dataset.reqNew)] })));
    bindPaymentActions(main, c.payments, reload);
    api(`/api/consulting/payment-requests?contract_id=${c.id}`).then((rows) => { const el = $('#c-requests'); if (el) { el.innerHTML = requestRows(rows); bindRows(el); } }).catch(() => {});
    $$('[data-cert-dl]').forEach((b) => b.addEventListener('click', () => {
      const d = byId(b.dataset.certDl);
      download(`/api/consulting/deliverables/${d.id}/certificate`, `شهادة إنجاز ${d.certificate_ref}.docx`).catch((e) => toast(e.message, 'error'));
    }));
    $$('[data-sent]').forEach((b) => b.addEventListener('click', () => sentDialog(byId(b.dataset.sent), reload)));
    $$('[data-pay]').forEach((b) => b.addEventListener('click', () => paymentDialog(byId(b.dataset.pay), reload)));
  }

  // ======================================================================
  // Unified section: «إدارة الاستشاريين والعقود الاستشارية»
  // ======================================================================
  const isAdmin = () => state.session?.user.role === 'admin';
  const REQ = { draft: 'مسودة', issued: 'صدر الطلب', sent: 'أُرسل للمالية', cancelled: 'ملغى' };
  const REQ_PILL = { draft: 'off', issued: 'info', sent: 'warn', cancelled: 'danger' };
  const REQ_PAY = { unpaid: 'لم يُصرف', partial: 'صُرف جزئيًا', paid: 'صُرف بالكامل' };
  const REQ_PAY_PILL = { unpaid: 'off', partial: 'warn', paid: 'ok' };
  const HUB_TABS = [['consultants', 'الاستشاريون'], ['contracts', 'العقود'], ['deliverables', 'المخرجات وشهادات الإنجاز'], ['requests', 'طلبات الدفعات']];
  let suggestCache = null;
  const suggestions = async () => (suggestCache ||= await api('/api/consulting/approver-suggestions').catch(() => []));

  async function hub(main, tab, sub) {
    if (tab === 'consultant' && sub) return consultantPage(main, Number(sub));
    if (tab === 'request' && sub) return requestPage(main, Number(sub));
    if (tab === 'contract' && sub) return viewContract(main, Number(sub));
    const t = HUB_TABS.some(([k]) => k === tab) ? tab : 'contracts';
    const [tpl, s] = await Promise.all([api('/api/consulting/templates'), api('/api/consulting/summary?days=30')]);
    main.innerHTML = workspaceHead('إدارة الاستشاريين والعقود الاستشارية', '<button class="btn" id="hub-tour">كيف أستخدم هذه الأداة؟</button><button class="btn" id="hub-new-k">+ استشاري</button><button class="btn" id="hub-new-r">+ طلب دفعة</button><button class="btn primary" id="hub-new-c">+ عقد جديد</button>') + templateNotice(tpl) + `
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="card stat"><span class="muted small">العقود السارية</span><span class="num">${s.counts.active}</span><span class="small muted">مسودات / بانتظار التوقيع: ${s.counts.draft}</span></div>
        <div class="card stat"><span class="muted small">قيمة العقود</span><span class="num small-num">${money(s.money.total)}</span></div>
        <div class="card stat"><span class="muted small">المصروف فعليًا</span><span class="num small-num">${money(s.money.paid)}</span></div>
        <div class="card stat"><span class="muted small">غير المصروف</span><span class="num small-num" style="color:var(--danger)">${money(s.money.outstanding)}</span><span class="small muted">متأخر: ${s.overdue.length} مخرج</span></div>
      </div>
      <div class="tabs" role="tablist">${HUB_TABS.map(([k, l]) => `<a role="tab" href="#/consulting/${k}" class="${k === t ? 'active' : ''}">${l}</a>`).join('')}</div>
      <div id="hub-body"><div class="empty">جارٍ التحميل…</div></div>`;
    const reload = () => hub(main, t);
    $('#hub-new-c').addEventListener('click', () => openContractForm(null, (c) => (location.hash = `#/consulting/contract/${c.id}`)));
    $('#hub-new-k').addEventListener('click', () => openRecordForm('consultants', null, reload));
    $('#hub-new-r').addEventListener('click', () => requestForm({}));
    $('#hub-tour').addEventListener('click', () => runTour(t));
    const body = $('#hub-body');
    await ({ consultants: consultantsTab, contracts: contractsTab, deliverables: deliverablesTab, requests: requestsTab }[t])(body, reload, tpl);
  }

  // ======================================================================
  // Guided tour of this section (explains only — never saves or issues)
  // ======================================================================
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  async function runTour(startTab) {
    let opened = null;
    const closeOpened = () => { if (opened?.open) opened.close(); opened = null; };
    const goTab = async (tab) => {
      if (location.hash !== `#/consulting/${tab}`) location.hash = `#/consulting/${tab}`;
      await waitFor(() => (location.hash === `#/consulting/${tab}` ? document.querySelector('#hub-body .toolbar, #hub-body .empty, #hub-body .table-wrap') : null), 4000);
      await pause(120);
    };
    const openContractForm = async () => {
      if (document.querySelector('dialog[open] #cc-form')) return;
      closeOpened();
      await goTab('contracts');
      document.querySelector('#hub-new-c')?.click(); // opens the form only — nothing is saved
      opened = (await waitFor('dialog[open] #cc-form', 4000))?.closest('dialog') || null;
    };
    const steps = [
      { title: 'مرحبًا بك في إدارة الاستشاريين والعقود',
        text: 'جولة قصيرة توضح دورة العمل من إضافة الاستشاري حتى تسجيل الصرف. الجولة للعرض فقط: لن تُنشأ أي بيانات، ولن يُضغط أي زر حفظ أو إصدار أو اعتماد.' },
      { title: 'تبويبات الأداة', before: () => goTab(startTab || 'contracts'), target: () => document.querySelector('.tabs'),
        text: `كل مرحلة في تبويب: الاستشاريون، العقود، المخرجات وشهادات الإنجاز، طلبات الدفعات. والأرقام أعلاه تخص ${state.company.name_ar} فقط.` },
      { title: '١. إضافة استشاري جديد', target: () => document.querySelector('#hub-new-k'),
        text: 'زر «+ استشاري» يضيف استشاريًا إلى سجل الشركة. ويمكنك أيضًا إضافته مباشرة أثناء إنشاء العقد — وهو الأسهل.' },
      { title: '٢. إنشاء عقد استشاري', target: () => document.querySelector('#hub-new-c'),
        text: 'زر «+ عقد جديد» يفتح نموذج العقد. سنفتحه في الخطوة التالية للعرض فقط دون حفظ.' },
      { title: 'اختيار الاستشاري', before: openContractForm, target: async () => (await waitFor('dialog[open] [data-kmode]'))?.parentElement,
        missing: 'افتح «+ عقد جديد» لرؤية هذا الجزء.',
        text: '«استشاري موجود» للبحث في السجل، أو «استشاري جديد» لإدخال بياناته هنا؛ يُحفظ الاستشاري والعقد معًا في عملية واحدة، ويُمنع تكرار رقم الهوية.' },
      { title: 'بيانات العقد', before: openContractForm, target: async () => (await waitFor('dialog[open] [name="project_name"]'))?.closest('.form-grid'),
        text: 'المشروع والإدارة والمدة وتواريخ البداية والنهاية. رقم العقد يُولَّد تلقائيًا إذا تُرك فارغًا.' },
      { title: '٣. إضافة المخرجات', before: openContractForm, target: async () => (await waitFor('dialog[open] #dl-rows'))?.closest('.table-wrap'),
        text: 'لكل مخرج: وصف وقيمة وتاريخ استحقاق، وفترة تسليم اختيارية. «+ إضافة مخرج» يضيف سطرًا، والإجمالي يُحسب تلقائيًا.' },
      { title: 'الحفظ بيدك', before: openContractForm, target: () => waitFor('dialog[open] .modal-foot .btn.primary'),
        text: 'عند الانتهاء تضغط «حفظ» بنفسك. الجولة لا تضغطه، وستغلق النموذج دون حفظ في الخطوة التالية.' },
      { title: '٤. إصدار شهادة الإنجاز', before: async () => { closeOpened(); await goTab('deliverables'); },
        target: async () => (await waitFor('#hub-body [data-cert]', 1200)) || document.querySelector('.tabs a[href="#/consulting/deliverables"]'),
        text: (t) => `${t?.matches?.('[data-cert]') ? 'زر «إصدار الشهادة» بجانب كل مخرج.' : 'من هذا التبويب، بجانب كل مخرج يظهر زر «إصدار الشهادة» (لا توجد مخرجات في هذه الشركة حاليًا).'} تُستخدم نماذج الشركة الرسمية المعتمدة فقط، وتُدخل أسماء المعتمدين الثلاثة عند كل إصدار، وتبقى التوقيعات وتواريخها فارغة.` },
      { title: '٥. إنشاء طلب دفعة', before: () => goTab('requests'), target: () => document.querySelector('#hub-new-r'),
        text: 'زر «+ طلب دفعة»: لمخرج أو أكثر من عقد موقّع بعد إصدار شهادته. المبلغ يُقترح تلقائيًا ويمكن تعديله لدفعة جزئية، ويظهر تنبيه إذا طُلب المبلغ سابقًا. ويُصدر ملف Excel من النموذج الرسمي للشركة.' },
      { title: '٦. تسجيل الصرف الفعلي',
        before: async () => {
          const row = document.querySelector('#hub-body [data-req]');
          if (row) { location.hash = `#/consulting/request/${row.dataset.req}`; await waitFor('main #rq-pay, main .card .kv', 4000); }
        },
        target: () => document.querySelector('main #rq-pay') || document.querySelector('#hub-body .table-wrap'),
        missing: 'يظهر زر «تسجيل الصرف الفعلي» في صفحة طلب الدفعة بعد إصداره.',
        text: (t) => `${t?.id === 'rq-pay' ? 'هذا الزر في صفحة طلب الدفعة.' : 'من صفحة طلب الدفعة بعد إصداره وإرساله للمالية.'} لا يُسجَّل الصرف إلا بعد أن تؤكد الإدارة المالية التحويل الفعلي: التاريخ والمبلغ والمرجع، مع دعم الدفعات الجزئية. يبقى «المطلوب صرفه» منفصلًا عن «المصروف فعليًا»، وإلغاء الصرف أو تصحيحه للمسؤول فقط دون حذف السجل.` },
      { title: 'علامات (?) والعودة للجولة', before: () => goTab(startTab || 'contracts'), target: () => document.querySelector('#hub-tour'),
        text: 'بجانب الحقول التي تحتاج توضيحًا تجد علامة (?) — اضغطها لشرح مختصر. ويمكنك إعادة هذه الجولة في أي وقت من هذا الزر.' },
    ];
    startTour({ steps, title: 'جولة إدارة الاستشاريين والعقود', onEnd: () => {
      closeOpened();
      if (!location.hash.startsWith('#/consulting/') || location.hash.startsWith('#/consulting/request/')) location.hash = `#/consulting/${startTab || 'contracts'}`;
    } });
  }

  // ---------- consultants ----------
  async function consultantsTab(el) {
    el.innerHTML = `<div class="toolbar"><input type="search" id="k-q" placeholder="بحث بالاسم أو الهوية أو الجوال…" style="max-width:320px"></div><div id="k-tbl"></div>`;
    const load = async () => {
      const rows = await api(`/api/consulting/consultants?q=${encodeURIComponent($('#k-q').value)}`);
      $('#k-tbl').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>الاستشاري</th><th>الهوية / الإقامة</th><th>الجوال</th><th>العقود</th><th>قيمة العقود</th><th>المصروف</th><th>المتبقي</th></tr></thead><tbody>
        ${rows.map((k) => `<tr class="clickable" data-k="${k.id}"><td><b>${esc(k.full_name_ar)}</b>${k.full_name_en ? `<div class="muted small ltr">${esc(k.full_name_en)}</div>` : ''}</td>
          <td class="ltr">${esc(k.id_number || '—')}</td><td class="ltr">${esc(k.mobile || '—')}</td><td>${k.contracts}</td><td>${money(k.total)}</td><td>${money(k.paid)}</td><td>${money(k.remaining)}</td></tr>`).join('')}
        </tbody></table></div>` : `<div class="empty">لا يوجد استشاريون في ${esc(state.company.name_ar)}.</div>`;
      $$('[data-k]', el).forEach((r) => r.addEventListener('click', () => (location.hash = `#/consulting/consultant/${r.dataset.k}`)));
    };
    let tm; $('#k-q').addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 250); });
    await load();
  }

  async function consultantPage(main, id) {
    const k = await api(`/api/consulting/consultants/${id}`);
    const reload = () => consultantPage(main, id);
    main.innerHTML = workspaceHead(k.full_name_ar, '<a class="btn small" href="#/consulting/consultants">← الاستشاريون</a><button class="btn small" id="k-edit">تعديل البيانات</button><button class="btn small primary" id="k-new-c">+ عقد لهذا الاستشاري</button>') + `
      <div class="grid cols-2" style="margin-bottom:16px">
        <div class="card stack"><h2>البيانات</h2><dl class="kv">
          <dt>الاسم</dt><dd>${esc(k.full_name_ar)}${k.full_name_en ? ` <span class="ltr muted small">${esc(k.full_name_en)}</span>` : ''}</dd>
          <dt>الجنسية</dt><dd>${esc(k.nationality_ar || '—')}</dd><dt>الهوية / الإقامة</dt><dd class="ltr">${esc(k.id_number || '—')}</dd>
          <dt>الجوال</dt><dd class="ltr">${esc(k.mobile || '—')}</dd><dt>البريد</dt><dd class="ltr">${esc(k.email || '—')}</dd></dl></div>
        <div class="card stack"><h2>الحساب البنكي</h2><dl class="kv">
          <dt>المستفيد</dt><dd>${esc(k.bank_beneficiary || '—')}</dd><dt>البنك</dt><dd>${esc(k.bank_name || '—')}</dd>
          <dt>الآيبان</dt><dd class="ltr">${esc(k.iban || '—')}</dd><dt>السويفت</dt><dd class="ltr">${esc(k.swift_code || '—')}</dd></dl>
          ${!k.iban ? '<div class="notice small">لا يوجد آيبان — يلزم لطلبات الدفعات.</div>' : ''}</div>
      </div>
      <div class="card stack" style="margin-bottom:16px"><h2>العقود (${k.contracts.length})</h2>${contractRows(k.contracts, false)}</div>
      <div class="card stack"><h2>طلبات الدفعات (${k.requests.length})</h2>${requestRows(k.requests)}</div>`;
    bindRows(main);
    $('#k-edit').addEventListener('click', async () => openRecordForm('consultants', await api(`/api/records/consultants/${id}`), reload));
    $('#k-new-c').addEventListener('click', () => openContractForm(null, (c) => (location.hash = `#/consulting/contract/${c.id}`), { consultantId: k.id }));
  }

  // ---------- contracts ----------
  const contractRows = (rows, withConsultant = true) => (rows.length ? `<div class="table-wrap"><table><thead><tr><th>رقم العقد</th>${withConsultant ? '<th>الاستشاري</th>' : ''}<th>المشروع</th><th>المدة</th><th>القيمة</th><th>المصروف</th><th>المتبقي</th><th>أقرب استحقاق</th><th>الحالة</th></tr></thead><tbody>
    ${rows.map((c) => `<tr class="clickable" data-go="${c.id}"><td class="ltr">${esc(c.contract_no)}</td>${withConsultant ? `<td>${esc(c.consultant_name)}</td>` : ''}<td>${esc(c.project_name || '—')}</td>
      <td class="small">${dmy(c.start_date)} – ${dmy(c.end_date)}</td><td>${money(c.total)}</td><td>${money(c.paid)}</td><td>${money(c.remaining)}</td>
      <td>${c.next_due ? dmy(c.next_due) : '<span class="muted">—</span>'}</td><td>${statusPill(c)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">لا توجد عقود.</div>');
  const requestRows = (rows) => (rows.length ? `<div class="table-wrap"><table><thead><tr><th>رقم الطلب</th><th>الاستشاري</th><th>العقد</th><th>التاريخ</th><th>المطلوب صرفه</th><th>المصروف فعليًا</th><th>المتبقي</th><th>حالة الطلب</th><th>الصرف</th></tr></thead><tbody>
    ${rows.map((r) => `<tr class="clickable" data-req="${r.id}"><td class="ltr">${esc(r.request_no)}</td><td>${esc(r.consultant_name)}</td><td class="ltr small">${esc(r.contract_no)}</td><td>${dmy(r.request_date)}</td>
      <td>${money(r.requested)}</td><td>${money(r.paid)}</td><td>${money(r.outstanding)}</td><td>${pill(REQ_PILL[r.status], REQ[r.status])}</td><td>${r.status === 'cancelled' ? '<span class="muted small">—</span>' : pill(REQ_PAY_PILL[r.payment_state], REQ_PAY[r.payment_state])}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">لا توجد طلبات دفعات.</div>');
  const bindRows = (el) => {
    $$('[data-go]', el).forEach((r) => r.addEventListener('click', () => (location.hash = `#/consulting/contract/${r.dataset.go}`)));
    $$('[data-req]', el).forEach((r) => r.addEventListener('click', () => (location.hash = `#/consulting/request/${r.dataset.req}`)));
  };

  async function contractsTab(el) {
    el.innerHTML = `<div class="toolbar">
        <input type="search" id="q" placeholder="بحث برقم العقد أو الاستشاري أو المشروع…" style="max-width:340px">
        <select id="st" style="max-width:200px"><option value="">كل الحالات</option>${Object.entries(STATUS).filter(([k]) => k !== 'expired').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      </div><div id="tbl"></div>`;
    const load = async () => {
      const rows = await api(`/api/consulting/contracts?q=${encodeURIComponent($('#q').value)}&status=${$('#st').value}`);
      $('#tbl').innerHTML = rows.length ? contractRows(rows) : `<div class="empty">لا توجد عقود استشارية في ${esc(state.company.name_ar)}.</div>`;
      bindRows(el);
    };
    let tm; $('#q').addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 250); });
    $('#st').addEventListener('change', load);
    await load();
  }

  // ---------- deliverables & certificates across contracts ----------
  const D_FILTERS = [['', 'كل المخرجات'], ['overdue', 'متأخرة غير مصروفة'], ['upcoming', 'مستحقة خلال 30 يومًا'], ['no_certificate', 'بدون شهادة إنجاز'], ['not_sent', 'شهادات لم يُسجَّل إرسالها'], ['to_request', 'جاهزة لطلب دفعة'], ['awaiting_payment', 'مطلوبة بانتظار الصرف'], ['paid', 'مصروفة بالكامل']];
  async function deliverablesTab(el, reload, tpl) {
    el.innerHTML = `<div class="toolbar"><select id="d-state" style="max-width:240px">${D_FILTERS.map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>${helpTip('«جاهزة لطلب دفعة»: صدرت شهادتها وبقي منها مبلغ لم يُطلب. «مطلوبة بانتظار الصرف»: طُلبت ولم تؤكد المالية صرفها بعد.', 'تصفية المخرجات')}
      <input type="search" id="d-q" placeholder="بحث بالمخرج أو العقد أو الاستشاري…" style="max-width:300px"></div><div id="d-tbl"></div>`;
    const load = async () => {
      const rows = await api(`/api/consulting/deliverables?state=${$('#d-state').value}&q=${encodeURIComponent($('#d-q').value)}`);
      $('#d-tbl').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>الاستشاري / العقد</th><th>المخرج</th><th>القيمة</th><th>الاستحقاق</th><th>الشهادة</th><th>المطلوب (لم يُصرف)</th><th>المصروف</th><th></th></tr></thead><tbody>
        ${rows.map((d) => `<tr><td><b>${esc(d.consultant_name)}</b><div class="small"><a href="#/consulting/contract/${d.contract_id}" class="ltr">${esc(d.contract_no)}</a></div></td>
          <td style="white-space:normal;min-width:160px">${d.seq}. ${esc(d.title)}</td><td>${money(d.amount)}</td><td>${dmy(d.due_date)} ${duePill(d)}</td>
          <td>${pill(STAGE_PILL[d.stage], STAGE[d.stage])}${d.certificate_ref ? `<div class="muted small ltr">${esc(d.certificate_ref)}</div>` : ''}</td>
          <td>${d.open_claim > 0 ? `${money(d.open_claim)}<div class="muted small ltr">${esc(d.open_requests.join('، '))}</div>` : '<span class="muted small">—</span>'}</td>
          <td>${pill(PAY_PILL[d.payment_status], PAY[d.payment_status])}<div class="small">${money(d.paid_total)}</div></td>
          <td><div class="row" style="gap:4px">
            ${d.contract_status !== 'draft' ? `<button class="btn small" data-cert="${d.id}" ${tpl.certificate ? '' : 'disabled title="نموذج الشهادة غير متوفر"'}>${d.certificate_issued_at ? 'إعادة الإصدار' : 'إصدار الشهادة'}</button>` : ''}
            ${d.certificate_issued_at ? `<button class="btn small" data-cert-dl="${d.id}">تنزيل</button><button class="btn small" data-sent="${d.id}">${d.certificate_sent_at ? 'تعديل الإرسال' : 'تسجيل الإرسال'}</button>` : ''}
            ${d.certificate_issued_at && d.claimable > 0 ? `<button class="btn small primary" data-req-new="${d.id}">طلب دفعة</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">لا توجد مخرجات مطابقة.</div>';
      const byId = (x) => rows.find((d) => d.id === Number(x));
      $$('[data-cert]', el).forEach((b) => b.addEventListener('click', () => certificateDialog(byId(b.dataset.cert), tpl, load)));
      $$('[data-cert-dl]', el).forEach((b) => b.addEventListener('click', () => { const d = byId(b.dataset.certDl); download(`/api/consulting/deliverables/${d.id}/certificate`, `شهادة إنجاز ${d.certificate_ref}.docx`).catch((e) => toast(e.message, 'error')); }));
      $$('[data-sent]', el).forEach((b) => b.addEventListener('click', () => sentDialog(byId(b.dataset.sent), load)));
      $$('[data-req-new]', el).forEach((b) => b.addEventListener('click', () => { const d = byId(b.dataset.reqNew); requestForm({ contractId: d.contract_id, deliverableIds: [d.id] }); }));
    };
    $('#d-state').addEventListener('change', load);
    let tm; $('#d-q').addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 250); });
    await load();
  }

  // ---------- payment requests ----------
  async function requestsTab(el, reload, tpl) {
    el.innerHTML = `${tpl.payment_request ? '' : '<div class="notice small" style="margin-bottom:12px">نموذج طلب الدفعة الرسمي (Excel) غير مرفوع لهذه الشركة؛ يمكن تجهيز الطلبات ومتابعتها، ولا يُصدر ملف رسمي حتى يرفعه المسؤول من «نماذج المستندات».</div>'}
      <div class="toolbar"><select id="r-st" style="max-width:200px"><option value="">كل الحالات</option>${Object.entries(REQ).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <input type="search" id="r-q" placeholder="بحث برقم الطلب أو الاستشاري أو العقد…" style="max-width:300px"></div><div id="r-tbl"></div>`;
    const load = async () => {
      const rows = await api(`/api/consulting/payment-requests?status=${$('#r-st').value}&q=${encodeURIComponent($('#r-q').value)}`);
      $('#r-tbl').innerHTML = requestRows(rows);
      bindRows(el);
    };
    $('#r-st').addEventListener('change', load);
    let tm; $('#r-q').addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(load, 250); });
    await load();
  }

  // Create or edit (draft) a request: one contract, one or more deliverables, editable amounts.
  async function requestForm({ contractId, deliverableIds = [], existing = null }) {
    const contracts = existing ? [] : (await api('/api/consulting/contracts')).filter((c) => ['active', 'terminated', 'closed'].includes(c.status));
    const cid = existing ? existing.contract.id : contractId;
    const body = `${companyBanner(existing ? 'هذا الطلب تابع لـ' : 'سيُحفظ هذا الطلب في')}
      <form id="rq-form" class="stack">
        ${existing ? `<div class="card" style="background:var(--bg)"><b>${esc(existing.consultant.full_name_ar)}</b> · <span class="ltr">${esc(existing.contract.contract_no)}</span></div>` : `
        <label class="field"><span>العقد (الموقّع) <span class="req">*</span></span><select name="contract_id" required><option value="">اختر…</option>
          ${contracts.map((c) => `<option value="${c.id}" ${c.id === cid ? 'selected' : ''}>${esc(c.contract_no)} — ${esc(c.consultant_name)}${c.project_name ? ' — ' + esc(c.project_name) : ''}</option>`).join('')}</select></label>
        ${contracts.length ? '' : '<p class="small muted" style="margin:0">لا توجد عقود موقّعة؛ طلب الدفعة يكون لعقد مسجّل توقيعه.</p>'}`}
        <div id="rq-items"><span class="muted small">اختر العقد لعرض مخرجاته.</span></div>
        <div class="form-grid">
          <label class="field"><span>تاريخ الطلب</span><input type="date" name="request_date" value="${esc(existing?.request_date || today())}" max="${today()}"></label>
          <label class="field full"><span>ملاحظات</span><textarea name="notes" rows="2">${esc(existing?.notes || '')}</textarea></label>
        </div>
        <p class="small muted" style="margin:0">المبلغ المقترح هو المتاح للطلب (المتبقي غير المصروف ناقص المطلوب سابقًا في طلبات مفتوحة)، ويمكن تعديله لطلب دفعة جزئية. أسماء المعتمدين تُدخل عند إصدار الطلب حسب النموذج.</p>
        <label class="check" id="rq-dup" hidden><input type="checkbox" name="confirm_duplicate"> راجعت المطالبات السابقة وأؤكد صحة هذا الطلب</label>
      </form><p class="error-text" id="rq-err" hidden></p>`;
    const d = openModal(existing ? `تعديل ${existing.request_no}` : 'طلب دفعة جديد', body,
      `<button class="btn primary" form="rq-form" type="submit">${existing ? 'حفظ' : `إنشاء الطلب في ${esc(state.company.name_ar)}`}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    d.classList.add('wide');
    $('[data-close]', d).addEventListener('click', () => d.close());
    const f = $('#rq-form', d);
    const chosen = new Map((existing?.items || []).map((i) => [i.deliverable_id, i.amount]));
    const loadItems = async () => {
      const id = existing ? existing.contract.id : Number(f.contract_id.value);
      const box = $('#rq-items', d);
      if (!id) { box.innerHTML = '<span class="muted small">اختر العقد لعرض مخرجاته.</span>'; return; }
      const rows = (await api(`/api/consulting/contracts/${id}/requestable${existing ? `?exclude_request_id=${existing.id}` : ''}`)).filter((x) => x.remaining > 0);
      box.innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th></th><th>المخرج</th><th>المتبقي غير المصروف</th><th>مطلوب سابقًا</th><th>المتاح للطلب ${helpTip('المتبقي غير المصروف ناقص ما طُلب سابقًا في طلبات مفتوحة لم تُصرف بعد.', 'المتاح للطلب')}</th><th>المبلغ المطلوب ${helpTip('يُقترح من المتاح للطلب ويمكن تعديله لطلب دفعة جزئية. المبلغ المطلوب لا يُعتبر مصروفًا.', 'المبلغ المطلوب')}</th></tr></thead><tbody>
        ${rows.map((x) => {
          const on = existing ? chosen.has(x.id) : deliverableIds.length ? deliverableIds.includes(x.id) : !!x.certificate_issued_at && x.claimable > 0;
          const amt = existing && chosen.has(x.id) ? chosen.get(x.id) : x.claimable || x.remaining;
          return `<tr><td><input type="checkbox" data-pick="${x.id}" ${on ? 'checked' : ''} aria-label="اختيار المخرج ${x.seq}"></td>
            <td style="white-space:normal">${x.seq}. ${esc(x.title)}<div class="small">${x.certificate_ref ? pill('info', `شهادة ${x.certificate_ref}`) : pill('warn', 'بدون شهادة إنجاز')}</div></td>
            <td>${money(x.remaining)}</td><td>${x.open_claim > 0 ? `${money(x.open_claim)}<div class="muted small ltr">${esc(x.open_requests.join('، '))}</div>` : '<span class="muted">—</span>'}</td>
            <td>${money(x.claimable)}</td><td><input type="number" step="0.01" min="0.01" max="${x.remaining}" class="ltr" data-amt="${x.id}" value="${amt}" style="min-width:110px"></td></tr>`;
        }).join('')}</tbody></table></div><div class="small">الإجمالي المطلوب: <b id="rq-total"></b></div>` : '<span class="muted small">لا توجد مخرجات بمبالغ متبقية في هذا العقد.</span>';
      const total = () => { $('#rq-total', d).innerHTML = money($$('[data-pick]', d).filter((c) => c.checked).reduce((s, c) => s + (Number($(`[data-amt="${c.dataset.pick}"]`, d).value) || 0), 0)); };
      box.addEventListener('input', total); box.addEventListener('change', total); if ($('#rq-total', d)) total();
    };
    f.contract_id?.addEventListener('change', loadItems);
    loadItems();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const items = $$('[data-pick]', d).filter((c) => c.checked).map((c) => ({ deliverable_id: Number(c.dataset.pick), amount: $(`[data-amt="${c.dataset.pick}"]`, d).value }));
      const data = { items, request_date: f.request_date.value, notes: f.notes.value, confirm_duplicate: f.confirm_duplicate.checked };
      try {
        const r = existing ? await api(`/api/consulting/payment-requests/${existing.id}`, { method: 'PATCH', body: data })
          : await api('/api/consulting/payment-requests', { method: 'POST', body: { ...data, contract_id: Number(f.contract_id.value) } });
        d.close();
        toast(existing ? 'تم الحفظ' : `تم إنشاء الطلب ${r.request_no} — المطلوب ${Number(r.requested).toLocaleString('en-US')} ر.س`);
        location.hash = `#/consulting/request/${r.id}`;
        if (existing) window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (err) {
        if (err.code === 'company_changed') return d.close();
        if (err.code === 'already_requested') $('#rq-dup', d).hidden = false;
        const x = $('#rq-err', d); x.textContent = err.message; x.hidden = false;
      }
    });
  }

  async function requestPage(main, id) {
    const r = await api(`/api/consulting/payment-requests/${id}`);
    const reload = () => requestPage(main, id);
    const open = r.status !== 'cancelled';
    const canIssue = ['draft', 'issued'].includes(r.status);
    main.innerHTML = workspaceHead(`طلب دفعة ${r.request_no}`, `<a class="btn small" href="#/consulting/requests">← طلبات الدفعات</a>${r.status === 'draft' ? '<button class="btn small" id="rq-edit">تعديل</button>' : ''}`) + `
      <div class="grid cols-3" style="margin-bottom:16px">
        <div class="card stack"><div class="spread"><h2>الطلب</h2>${pill(REQ_PILL[r.status], REQ[r.status])}</div><dl class="kv">
          <dt>الاستشاري</dt><dd><a href="#/consulting/consultant/${r.consultant.id}">${esc(r.consultant.full_name_ar)}</a></dd>
          <dt>العقد</dt><dd><a href="#/consulting/contract/${r.contract.id}" class="ltr">${esc(r.contract.contract_no)}</a></dd>
          <dt>تاريخ الطلب</dt><dd>${dmy(r.request_date)}</dd>
          ${r.sent_at ? `<dt>أُرسل للمالية</dt><dd>${dmy(r.sent_at)}${r.sent_to ? ' — ' + esc(r.sent_to) : ''}</dd>` : ''}
          ${r.approvers.some((a) => a.name) ? `<dt>المعتمدون</dt><dd>${r.approvers.filter((a) => a.name).map((a) => `${esc(a.name)}${a.title ? ` <span class="muted small">(${esc(a.title)})</span>` : ''}`).join('، ')}</dd>` : ''}
          ${r.notes ? `<dt>ملاحظات</dt><dd>${esc(r.notes)}</dd>` : ''}${r.cancel_reason ? `<dt>سبب الإلغاء</dt><dd>${esc(r.cancel_reason)}</dd>` : ''}</dl></div>
        <div class="card stack"><h2>المبالغ</h2><dl class="kv">
          <dt>المطلوب صرفه ${helpTip('مجموع ما طُلب في هذا الطلب — ليس مبلغًا مصروفًا.', 'المطلوب صرفه')}</dt><dd><b>${money(r.requested)}</b></dd><dt>المصروف فعليًا ${helpTip('ما سجّلته بعد تأكيد الإدارة المالية للتحويل الفعلي فقط.', 'المصروف فعليًا')}</dt><dd><b>${money(r.paid)}</b></dd><dt>المتبقي من الطلب</dt><dd>${money(r.outstanding)}</dd></dl>
          ${open ? pill(REQ_PAY_PILL[r.payment_state], REQ_PAY[r.payment_state]) : ''}
          <span class="muted small">المصروف يُحدَّث فقط عند تسجيل صرف أكدته الإدارة المالية.</span></div>
        <div class="card stack"><h2>المستند والإجراءات</h2>
          ${r.template ? `<span class="muted small">النموذج المعتمد: ${esc(r.template.file)} · الإصدار ${r.template.version}</span>` : '<span class="error-text small">نموذج طلب الدفعة الرسمي (Excel) غير متوفر — الإصدار غير متاح.</span>'}
          <div class="row" style="gap:6px">
            ${canIssue ? `<button class="btn primary small" id="rq-issue" ${r.template ? '' : 'disabled'}>${r.has_file ? 'إعادة إصدار الطلب' : 'معاينة وإصدار الطلب (Excel)'}</button>` : ''}
            ${r.has_file ? '<button class="btn small" id="rq-dl">تنزيل الملف</button>' : ''}
            ${['issued', 'sent'].includes(r.status) ? `<button class="btn small" id="rq-sent">${r.status === 'sent' ? 'تعديل تاريخ الإرسال' : 'تسجيل الإرسال للمالية'}</button>` : ''}
            ${['issued', 'sent'].includes(r.status) && r.outstanding > 0 ? '<button class="btn small primary" id="rq-pay">تسجيل الصرف الفعلي</button>' : ''}
            ${open && r.paid === 0 ? '<button class="btn small" id="rq-cancel">إلغاء الطلب</button>' : ''}</div></div>
      </div>
      <div class="card stack" style="margin-bottom:16px"><h2>مخرجات الطلب</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>المخرج</th><th>شهادة الإنجاز</th><th>المطلوب</th><th>المصروف عبر الطلب</th><th>المتبقي</th></tr></thead><tbody>
        ${r.items.map((i) => `<tr><td>${i.seq}</td><td style="white-space:normal">${esc(i.title)}</td><td class="ltr small">${esc(i.certificate_ref || '—')}</td><td>${money(i.amount)}</td><td>${money(i.paid)}</td><td>${money(i.outstanding)}</td></tr>`).join('')}
      </tbody></table></div></div>
      <div class="stack">
        <div class="card stack"><h2>الصرف الفعلي</h2>${paymentsTable(r.payments)}</div>
        <div class="card stack"><h2>سجل الطلب</h2><ul class="timeline">${r.events.map((e) => `<li><b>${esc(EVENTS[e.event] || e.event)}</b>${e.detail ? ` — ${esc(e.detail)}` : ''}<div class="muted small">${esc(fmtTime(e.created_at))} · ${esc(e.user_name || '')}</div></li>`).join('') || '<li class="muted small">—</li>'}</ul></div>
      </div>`;
    $('#rq-edit')?.addEventListener('click', () => requestForm({ existing: r }));
    $('#rq-issue')?.addEventListener('click', async () => documentDialog({
      title: `إصدار طلب الدفعة ${r.request_no}`, tpl: await api('/api/consulting/templates'), previewUrl: `/api/consulting/payment-requests/${r.id}/document/preview`,
      issueUrl: `/api/consulting/payment-requests/${r.id}/document`, downloadUrl: `/api/consulting/payment-requests/${r.id}/document`,
      issueLabel: 'إصدار الطلب وتنزيله', onDone: reload, approvers: { fromPreview: true, initial: r.approvers },
    }));
    $('#rq-dl')?.addEventListener('click', () => download(`/api/consulting/payment-requests/${r.id}/document`, `طلب دفعة ${r.request_no}.xlsx`).catch((e) => toast(e.message, 'error')));
    $('#rq-sent')?.addEventListener('click', () => formDialog(`تسجيل إرسال ${r.request_no} للمالية`, `
      <label class="field"><span>تاريخ الإرسال <span class="req">*</span></span><input type="date" name="sent_at" value="${esc(r.sent_at || today())}" max="${today()}" required></label>
      <label class="field"><span>أُرسل إلى (اختياري)</span><input type="text" name="sent_to" value="${esc(r.sent_to || '')}" placeholder="مثال: الإدارة المالية"></label>`,
    'حفظ', async (f) => { await api(`/api/consulting/payment-requests/${r.id}/sent`, { method: 'POST', body: { sent_at: f.sent_at.value, sent_to: f.sent_to.value } }); toast('تم'); reload(); }));
    $('#rq-pay')?.addEventListener('click', () => formDialog(`تسجيل الصرف الفعلي — ${r.request_no}`, `
      <dl class="kv"><dt>المطلوب</dt><dd>${money(r.requested)}</dd><dt>المصروف سابقًا</dt><dd>${money(r.paid)}</dd><dt>المتبقي من الطلب</dt><dd>${money(r.outstanding)}</dd></dl>
      <div class="form-grid">
        <label class="field"><span>المبلغ المصروف <span class="req">*</span></span><input type="number" step="0.01" min="0.01" max="${r.outstanding}" name="amount" value="${r.outstanding}" class="ltr" required></label>
        <label class="field"><span>تاريخ الصرف <span class="req">*</span></span><input type="date" name="paid_at" max="${today()}" required></label>
        <label class="field"><span>مرجع التحويل</span><input type="text" name="transfer_reference" class="ltr"></label>
        <label class="field"><span>ملاحظة</span><input type="text" name="note"></label>
      </div>
      <p class="small muted" style="margin:0">يُوزَّع المبلغ على مخرجات الطلب بالترتيب، ويمكن تسجيل دفعات جزئية.</p>
      <label class="check"><input type="checkbox" name="confirm" required> أؤكد أن الإدارة المالية أكدت التحويل الفعلي لهذا المبلغ ${helpTip('لا يُسجَّل الصرف إلا بعد تأكيد الإدارة المالية للتحويل. إلغاء الصرف أو تصحيحه من صلاحية المسؤول فقط، ولا يُحذف أي سجل مالي.', 'تأكيد المالية')}</label>`,
    'تسجيل الصرف', async (f) => {
      await api(`/api/consulting/payment-requests/${r.id}/payments`, { method: 'POST', body: { amount: f.amount.value, paid_at: f.paid_at.value, transfer_reference: f.transfer_reference.value, note: f.note.value, finance_confirmed: f.confirm.checked } });
      toast('تم تسجيل الصرف'); reload();
    }));
    $('#rq-cancel')?.addEventListener('click', () => formDialog(`إلغاء ${r.request_no}`, '<label class="field"><span>سبب الإلغاء <span class="req">*</span></span><input type="text" name="reason" required></label>', 'إلغاء الطلب',
      async (f) => { await api(`/api/consulting/payment-requests/${r.id}/cancel`, { method: 'POST', body: { reason: f.reason.value } }); toast('تم إلغاء الطلب'); reload(); }));
    bindPaymentActions(main, r.payments, reload);
  }

  // ---------- actual payments (shared by the contract and request pages) ----------
  const paymentsTable = (rows) => (rows.length ? `<div class="table-wrap"><table><thead><tr><th>المخرج</th><th>المبلغ</th><th>تاريخ الصرف</th><th>المرجع</th><th>سجّلها</th><th></th></tr></thead><tbody>
    ${rows.map((p) => `<tr style="${p.voided_at ? 'opacity:.6' : ''}"><td>${p.deliverable_seq}</td>
      <td>${p.voided_at ? `<s>${money(p.amount)}</s>` : money(p.amount)}${p.replaces_payment_id ? '<div class="muted small">تصحيح لدفعة سابقة</div>' : ''}</td><td style="white-space:nowrap">${dmy(p.paid_at)}</td>
      <td class="ltr small">${esc(p.transfer_reference || '—')}${p.request_no ? `<div class="muted small">${esc(p.request_no)}</div>` : ''}</td><td class="small">${esc(p.recorded_by_name || '')}</td>
      <td>${p.voided_at ? `${pill('danger', 'ملغاة')}<div class="small muted" style="white-space:normal">${esc(p.void_reason || '')} — ${esc(p.voided_by_name || '')}</div>`
        : isAdmin() ? `<div class="row" style="gap:4px;flex-wrap:nowrap;white-space:nowrap"><button class="btn small" data-fixpay="${p.id}">تصحيح</button><button class="btn small" data-voidpay="${p.id}">إلغاء</button></div>` : ''}</td></tr>`).join('')}
    </tbody></table></div>${isAdmin() ? '' : '<span class="muted small">إلغاء أو تصحيح الصرف من صلاحية المسؤول فقط.</span>'}` : '<span class="muted small">لا توجد دفعات مصروفة.</span>');
  function bindPaymentActions(el, rows, reload) {
    const byId = (x) => rows.find((p) => p.id === Number(x));
    $$('[data-voidpay]', el).forEach((b) => b.addEventListener('click', () => { const p = byId(b.dataset.voidpay); formDialog('إلغاء سجل صرف', `
      <p style="margin:0">إلغاء دفعة بمبلغ ${money(p.amount)} بتاريخ ${dmy(p.paid_at)}. لا تُحذف الدفعة؛ تبقى في السجل المالي بحالة «ملغاة» مع السبب.</p>
      <label class="field"><span>السبب <span class="req">*</span></span><input type="text" name="reason" required></label>`, 'إلغاء الدفعة',
    async (f) => { await api(`/api/consulting/payments/${p.id}/void`, { method: 'POST', body: { reason: f.reason.value } }); toast('تم إلغاء الدفعة'); reload(); }); }));
    $$('[data-fixpay]', el).forEach((b) => b.addEventListener('click', () => { const p = byId(b.dataset.fixpay); formDialog('تصحيح سجل صرف', `
      <p class="small" style="margin:0">تُلغى الدفعة الحالية (${money(p.amount)} بتاريخ ${dmy(p.paid_at)}) وتُسجَّل الدفعة الصحيحة مرتبطة بها؛ يبقى الأصل في السجل.</p>
      <div class="form-grid">
        <label class="field"><span>المبلغ الصحيح <span class="req">*</span></span><input type="number" step="0.01" min="0.01" name="amount" value="${p.amount}" class="ltr" required></label>
        <label class="field"><span>تاريخ الصرف الصحيح <span class="req">*</span></span><input type="date" name="paid_at" value="${esc(p.paid_at)}" max="${today()}" required></label>
        <label class="field"><span>مرجع التحويل</span><input type="text" name="transfer_reference" class="ltr" value="${esc(p.transfer_reference || '')}"></label>
        <label class="field"><span>سبب التصحيح <span class="req">*</span></span><input type="text" name="reason" required></label>
      </div>
      <label class="check"><input type="checkbox" name="confirm" required> أؤكد أن الإدارة المالية أكدت المبلغ والتاريخ الصحيحين</label>`, 'حفظ التصحيح',
    async (f) => { await api(`/api/consulting/payments/${p.id}/correct`, { method: 'POST', body: { amount: f.amount.value, paid_at: f.paid_at.value, transfer_reference: f.transfer_reference.value, reason: f.reason.value, finance_confirmed: f.confirm.checked } }); toast('تم التصحيح'); reload(); }); }));
  }

  function certificateDialog(d, tpl, onDone) {
    documentDialog({
      title: `شهادة إنجاز — المخرج ${d.seq}`, tpl, completion: d.completion_date || '',
      previewUrl: `/api/consulting/deliverables/${d.id}/certificate/preview`, issueUrl: `/api/consulting/deliverables/${d.id}/certificate`,
      downloadUrl: `/api/consulting/deliverables/${d.id}/certificate`, issueLabel: d.certificate_issued_at ? 'إعادة إصدار الشهادة وتنزيلها' : 'إصدار الشهادة وتنزيلها', onDone,
      approvers: { count: 3, initial: [] }, identityOff: ['signature', 'stamp'],
    });
  }

  // ---------- dialogs ----------
  function formDialog(title, inner, submitLabel, onSubmit) {
    const d = openModal(title, `${companyBanner('هذا الإجراء على بيانات')}<form id="dlg-form" class="stack">${inner}</form><p class="error-text" id="dlg-err" hidden></p>`,
      `<button class="btn primary" form="dlg-form" type="submit">${submitLabel}</button><button class="btn" type="button" data-close>إلغاء</button>`);
    $('[data-close]', d).addEventListener('click', () => d.close());
    $('#dlg-form', d).addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('.modal-foot .primary', d); btn.disabled = true;
      try { await onSubmit(e.target, d); d.close(); }
      catch (err) { btn.disabled = false; if (err.code === 'company_changed') return d.close(); const el = $('#dlg-err', d); el.textContent = err.message; el.hidden = false; }
    });
    return d;
  }

  function statusDialog(c, action, onDone) {
    const a = ACTIONS[action];
    formDialog(`${a.label} — ${c.contract_no}`, `
      <label class="field"><span>${a.dateLabel} <span class="req">*</span></span><input type="date" name="date" value="${today()}" max="${today()}" required></label>
      ${a.reason ? '<label class="field"><span>سبب الإنهاء <span class="req">*</span></span><textarea name="reason" required></textarea></label>' : ''}
      ${a.file ? '<label class="field"><span>النسخة الموقعة (اختياري — PDF أو Word أو صورة)</span><input type="file" name="file" accept=".pdf,.docx,image/png,image/jpeg"></label>' : ''}`,
    a.label, async (f) => {
      const body = { action, date: f.date.value, reason: f.reason?.value };
      if (f.file?.files[0]) body.file = await fileToUpload(f.file.files[0]);
      await api(`/api/consulting/contracts/${c.id}/status`, { method: 'POST', body });
      toast('تم التحديث'); onDone();
    });
  }

  function sentDialog(d, onDone) {
    formDialog(`تسجيل إرسال شهادة المخرج ${d.seq}`, `
      <p class="small muted" style="margin:0">الشهادة: <span class="ltr">${esc(d.certificate_ref)}</span></p>
      <label class="field"><span>تاريخ الإرسال <span class="req">*</span></span><input type="date" name="sent_at" value="${esc(d.certificate_sent_at || today())}" max="${today()}" required></label>
      <label class="field"><span>أُرسلت إلى (اختياري)</span><input type="text" name="sent_to" value="${esc(d.certificate_sent_to || '')}" placeholder="مثال: الإدارة المالية"></label>`,
    'حفظ تاريخ الإرسال', async (f) => {
      await api(`/api/consulting/deliverables/${d.id}/certificate-sent`, { method: 'POST', body: { sent_at: f.sent_at.value, sent_to: f.sent_to.value } });
      toast('تم تسجيل إرسال الشهادة'); onDone();
    });
  }

  function paymentDialog(d, onDone) {
    formDialog(`تسجيل صرف مباشر — المخرج ${d.seq}`, `
      <dl class="kv"><dt>المخرج</dt><dd>${esc(d.title)}</dd><dt>القيمة</dt><dd>${money(d.amount)}</dd><dt>المدفوع سابقًا</dt><dd>${money(d.paid_total)}</dd><dt>المتبقي</dt><dd>${money(d.remaining)}</dd></dl>
      ${d.stage !== 'certificate_sent' ? '<div class="notice small">لم يُسجَّل إرسال شهادة الإنجاز لهذا المخرج بعد.</div>' : ''}
      <div class="form-grid">
        <label class="field"><span>المبلغ المدفوع <span class="req">*</span></span><input type="number" step="0.01" min="0.01" max="${d.remaining}" name="amount" value="${d.remaining}" class="ltr" required></label>
        <label class="field"><span>تاريخ الدفع <span class="req">*</span></span><input type="date" name="paid_at" max="${today()}" required></label>
        <label class="field"><span>مرجع التحويل (اختياري)</span><input type="text" name="transfer_reference" class="ltr"></label>
        <label class="field"><span>ملاحظة (اختياري)</span><input type="text" name="note"></label>
      </div>
      <label class="check"><input type="checkbox" name="confirm" required> أؤكد أن الإدارة المالية أكدت التحويل الفعلي لهذا المبلغ ${helpTip('لا يُسجَّل الصرف إلا بعد تأكيد الإدارة المالية للتحويل. إلغاء الصرف أو تصحيحه من صلاحية المسؤول فقط، ولا يُحذف أي سجل مالي.', 'تأكيد المالية')}</label>`,
    'تسجيل الدفعة', async (f) => {
      await api(`/api/consulting/deliverables/${d.id}/payments`, { method: 'POST', body: { amount: f.amount.value, paid_at: f.paid_at.value, transfer_reference: f.transfer_reference.value, note: f.note.value, finance_confirmed: f.confirm.checked } });
      toast('تم تسجيل الدفعة'); onDone();
    });
  }

  // Shared preview → issue dialog for the contract and completion certificates.
  function documentDialog({ title, tpl, completion, previewUrl, issueUrl, downloadUrl, issueLabel, onDone, approvers = null, identityOff = [] }) {
    const isCert = completion !== undefined;
    const d = openModal(title, `${companyBanner('سيُصدر المستند باسم')}
      <form id="doc-form" class="stack">
        ${isCert ? `<label class="field"><span>تاريخ الإنجاز <span class="req">*</span> <span class="muted small">(إصدار الشهادة هو ما يسجّل إنجاز المخرج)</span></span><input type="date" name="completion_date" value="${esc(completion)}" max="${today()}"></label>` : ''}
        <div id="doc-approvers"></div>
        <div id="doc-identity"></div>
      </form>
      <div id="doc-preview" class="stack"><span class="muted small">جارٍ تجهيز المعاينة…</span></div>`,
    `<button class="btn primary" type="button" id="doc-issue" disabled>${issueLabel}</button><button class="btn" type="button" id="doc-refresh">تحديث المعاينة</button><button class="btn" type="button" data-close>إلغاء</button>`);
    d.classList.add('wide');
    $('[data-close]', d).addEventListener('click', () => d.close());
    const form = $('#doc-form', d);
    let slots = approvers?.count || 0;
    const renderApprovers = async (n) => {
      if (!approvers || !n) { $('#doc-approvers', d).innerHTML = ''; return; }
      const prev = [...Array(n)].map((_, i) => ({ name: form[`ap_name_${i}`]?.value ?? approvers.initial?.[i]?.name ?? '', title: form[`ap_title_${i}`]?.value ?? approvers.initial?.[i]?.title ?? '' }));
      const sug = await suggestions();
      $('#doc-approvers', d).innerHTML = `<fieldset class="stack" style="border:1px solid var(--border);border-radius:8px;padding:12px"><legend class="small muted">المعتمدون (${n}) — الاسم مطلوب، المسمى اختياري. توقيعاتهم وتواريخ التوقيع تبقى فارغة في المستند. ${helpTip('تُدخل الأسماء عند كل إصدار، وتظهر لك أسماء سبق استخدامها كاقتراحات. خانات التوقيع وتاريخه تبقى فارغة ليوقّع المعتمدون يدويًا.', 'المعتمدون')}</legend>
        <datalist id="ap-names">${sug.map((x) => `<option value="${esc(x.name)}">`).join('')}</datalist>
        ${prev.map((a, i) => `<div class="form-grid"><label class="field"><span>اسم المعتمد ${i + 1} <span class="req">*</span></span><input type="text" name="ap_name_${i}" list="ap-names" value="${esc(a.name)}"></label>
          <label class="field"><span>المسمى الوظيفي (اختياري)</span><input type="text" name="ap_title_${i}" value="${esc(a.title)}"></label></div>`).join('')}</fieldset>`;
      $$('[name^="ap_name_"]', d).forEach((inp) => inp.addEventListener('change', () => {
        const hit = sug.find((x) => x.name === inp.value);
        const t = form[inp.name.replace('name', 'title')];
        if (hit?.title && t && !t.value) t.value = hit.title;
      }));
    };
    const approverValues = () => (slots ? [...Array(slots)].map((_, i) => ({ name: form[`ap_name_${i}`]?.value || '', title: form[`ap_title_${i}`]?.value || '' })) : undefined);
    const payload = () => ({
      approvers: approverValues(),
      completion_date: form.completion_date?.value || undefined,
      include_logo: !!form.include_logo?.checked, include_signature: !!form.include_signature?.checked, include_stamp: !!form.include_stamp?.checked,
      signature_id: form.signature_id ? Number(form.signature_id.value) : undefined, stamp_id: form.stamp_id ? Number(form.stamp_id.value) : undefined,
    });
    let identityBuilt = false;
    const buildIdentity = (images) => {
      if (identityBuilt || !images.length) return;
      identityBuilt = true;
      const avail = { logo: tpl.has_logo, signature: tpl.signatures.length > 0, stamp: tpl.stamps.length > 0 };
      const sel = (name, list) => (list.length > 1 ? `<select name="${name}">${list.map((s) => `<option value="${s.id}">${esc(s.label)}${s.signatory_name ? ' — ' + esc(s.signatory_name) : ''}</option>`).join('')}</select>` : '');
      $('#doc-identity', d).innerHTML = `<fieldset class="stack" style="border:1px solid var(--border);border-radius:8px;padding:12px"><legend class="small muted">إضافات الهوية المعتمدة</legend>
        ${images.map((i) => `<label class="check"><input type="checkbox" name="include_${i.key}" ${!avail[i.key] ? 'disabled' : identityOff.includes(i.key) ? '' : 'checked'}> ${esc(i.label)} ${avail[i.key] ? '' : '<span class="muted small">(غير مرفوع)</span>'}</label>
          ${i.key === 'signature' && avail.signature ? sel('signature_id', tpl.signatures) : ''}${i.key === 'stamp' && avail.stamp ? sel('stamp_id', tpl.stamps) : ''}`).join('')}</fieldset>`;
    };
    const preview = async () => {
      const box = $('#doc-preview', d);
      const issue = $('#doc-issue', d);
      issue.disabled = true;
      try {
        const r = await api(previewUrl, { method: 'POST', body: payload() });
        if (approvers?.fromPreview && r.approver_slots !== slots) { slots = r.approver_slots; await renderApprovers(slots); return preview(); }
        const first = !identityBuilt && r.images.length;
        buildIdentity(r.images);
        if (first) return preview(); // re-run with the default identity choices
        const ok = r.missing.length === 0;
        box.innerHTML = `
          <div class="spread"><span class="small muted">النموذج: ${esc(r.template.file)} · الإصدار ${r.template.version}</span>${ok ? pill('ok', 'جاهز للإصدار') : pill('danger', `بيانات ناقصة: ${r.missing.length}`)}</div>
          ${(r.warnings || []).map((w) => `<div class="notice small">${esc(w)}</div>`).join('')}
          ${ok ? '' : `<div class="notice small">أكمل قبل الإصدار: ${r.missing.map(esc).join('، ')}</div>`}
          <div class="table-wrap"><table><tbody>${r.fields.map((f) => `<tr><td class="muted small">${esc(f.label)}</td><td>${f.missing ? '<span class="error-text">ناقص</span>' : esc(f.value)}</td></tr>`).join('')}</tbody></table></div>
          ${r.rows?.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>المخرج</th><th>القيمة</th><th>الاستحقاق</th></tr></thead><tbody>${r.rows.map((x) => `<tr><td>${esc(x.d_no)}</td><td>${esc(x.d_title)}</td><td class="ltr">${esc(x.d_amount)}</td><td class="ltr">${esc(x.d_due_date || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
        issue.disabled = !ok;
      } catch (e) {
        if (e.code === 'company_changed') return d.close();
        box.innerHTML = `<div class="notice">${esc(e.message)}</div>`;
      }
    };
    $('#doc-refresh', d).addEventListener('click', preview);
    form.addEventListener('change', preview);
    if (approvers?.count) renderApprovers(approvers.count);
    $('#doc-issue', d).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api(issueUrl, { method: 'POST', body: payload() });
        await download(downloadUrl, r.filename);
        d.close();
        suggestCache = null;
        toast(r.certificate_ref ? `صدرت الشهادة ${r.certificate_ref}` : r.request_no ? `صدر طلب الدفعة ${r.request_no}` : 'تم إصدار العقد');
        onDone();
      } catch (err) {
        e.target.disabled = false;
        if (err.code === 'company_changed') return d.close();
        toast(err.message, 'error');
      }
    });
    preview();
  }

  return { dashboardSection, viewContracts, viewContract, openContractForm, hub };
}
