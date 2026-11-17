// Employee directory: one record per employee from recruitment to end of service,
// status overview, record history, and the active-employees Excel import
// (preview first; nothing is saved until «تنفيذ الاستيراد»).
const EMP_PILL = { onboarding: 'info', active: 'ok', offboarding: 'warn', inactive: 'off' };
const STATUS_ORDER = ['onboarding', 'active', 'offboarding', 'inactive'];
const STATUS_HINT = {
  onboarding: 'أضافهم التوظيف ولم تؤكَّد مباشرتهم بعد',
  active: 'على رأس العمل',
  offboarding: 'لديهم حالة خروج مفتوحة',
  inactive: 'أُكِّد انتهاء خدمتهم',
};
const EVENT_LABEL = {
  created: 'إنشاء السجل', updated: 'تعديل', imported: 'إنشاء من ملف النشطين', import_updated: 'تحديث من ملف النشطين', import_linked: 'ربط بملف النشطين',
  start_confirmed: 'تأكيد المباشرة', end_confirmed: 'تأكيد انتهاء الخدمة', number_assigned: 'إضافة الرقم الوظيفي',
};
const KIND = {
  create: ['جديد — سيُنشأ سجل', 'info'], update: ['موجود — سيُحدَّث', 'ok'], unchanged: ['بلا تغيير', 'off'],
  review: ['مراجعة يدوية', 'warn'], error: ['خطأ — لن يُستورد', 'danger'],
};

export function createEmployeeViews(ctx) {
  const { api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, fmtTime, openRecordForm, state, fileToUpload } = ctx;
  const isAdmin = () => state.session?.user?.role === 'admin';
  const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;
  const val = (v) => (v === null || v === undefined || v === '' ? '<span class="muted">—</span>' : esc(String(v)));
  const fields = () => state.session.entities.employees.fields;
  const fieldLabel = (k) => fields().find((f) => f.name === k)?.label || k;

  async function directory(main, openId) {
    let filter = '';
    main.innerHTML = workspaceHead('سجلات الموظفين', `${isAdmin() ? '<button class="btn" id="emp-import">استيراد ملف الموظفين النشطين (Excel)</button>' : ''}<button class="btn" id="emp-imports">سجل الاستيراد</button><button class="btn primary" id="add">+ إضافة موظف</button>`) + `
      <p class="small muted" style="margin:-6px 0 12px">سجل واحد لكل موظف في ${esc(state.company.name_ar)} من التوظيف حتى انتهاء الخدمة؛ ترتبط به الإجراءات والحسابات البنكية والخطابات وبقية الأدوات.</p>
      <div class="grid cols-4" id="emp-status" style="margin-bottom:12px"></div>
      <div class="toolbar"><input type="search" id="q" placeholder="بحث بالاسم أو الرقم الوظيفي أو الهوية…" style="max-width:320px"></div>
      <div class="table-wrap" id="tbl"><div class="empty">جارٍ التحميل…</div></div>`;
    const load = async () => {
      const r = await api(`/api/records/employees?q=${encodeURIComponent($('#q').value)}${filter ? `&status=${filter}` : ''}`);
      $('#emp-status').innerHTML = STATUS_ORDER.map((k) => `<button type="button" class="card stat clickable" data-status="${k}" aria-pressed="${filter === k}" style="text-align:start;${filter === k ? 'outline:2px solid var(--brand)' : ''}">
        <span>${pill(EMP_PILL[k], r.status_labels[k])}</span><span class="num">${r.counts[k]}</span><span class="small muted">${STATUS_HINT[k]}</span></button>`).join('');
      $$('[data-status]').forEach((b) => b.addEventListener('click', () => { filter = filter === b.dataset.status ? '' : b.dataset.status; load(); }));
      $('#tbl').innerHTML = r.rows.length ? `<table><thead><tr><th>الرقم الوظيفي</th><th>الاسم</th><th>المسمى الوظيفي</th><th>الإدارة</th><th>الحالة</th><th>متابعة الإجراءات</th><th></th></tr></thead><tbody>
        ${r.rows.map((e) => `<tr><td class="ltr">${e.employee_no ? esc(e.employee_no) : '<span class="muted small">لم يُخصَّص</span>'}</td><td>${esc(e.full_name_ar)}</td><td>${val(e.job_title)}</td><td>${val(e.department)}</td>
          <td>${pill(EMP_PILL[e.display_status], e.display_status_label)}</td>
          <td class="small">${[e.open_onboarding_case && `<a href="#/procedures/case/${e.open_onboarding_case}">حالة مباشرة مفتوحة</a>`, e.open_offboarding_case && `<a href="#/procedures/case/${e.open_offboarding_case}">حالة خروج مفتوحة</a>`].filter(Boolean).join(' · ') || '<span class="muted">—</span>'}</td>
          <td style="white-space:nowrap"><button class="btn small" data-edit="${e.id}">تعديل</button> <button class="btn small" data-hist="${e.id}">السجل</button></td></tr>`).join('')}
        </tbody></table>` : `<div class="empty">${filter ? `لا يوجد موظفون بحالة «${esc(r.status_labels[filter])}».` : `لا توجد سجلات في ${esc(state.company.name_ar)} بعد.`}</div>`;
      $$('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(Number(b.dataset.edit), load)));
      $$('[data-hist]').forEach((b) => b.addEventListener('click', () => history(Number(b.dataset.hist))));
    };
    let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    $('#add').addEventListener('click', () => openRecordForm('employees', null, load));
    $('#emp-import')?.addEventListener('click', () => importDialog(load));
    $('#emp-imports').addEventListener('click', importsLog);
    await load();
    if (openId) { // #/records/employees/<id> opens that record (the address goes back to the list)
      history.replaceState(null, '', '#/records/employees');
      edit(Number(openId), load);
    }
  }

  async function edit(id, onSaved) {
    try { openRecordForm('employees', await api(`/api/records/employees/${id}`), onSaved); }
    catch (e) { toast(e.message, 'error'); }
  }

  async function history(id) {
    const [e, h] = await Promise.all([api(`/api/records/employees/${id}`), api(`/api/employees/${id}/history`)]);
    const ch = (c) => (c || []).map((x) => `${esc(fieldLabel(x.field))}: ${x.from === null ? '—' : esc(String(x.from))} ← ${x.to === null ? '—' : esc(String(x.to))}`).join(' · ');
    const d = openModal(`سجل ${e.full_name_ar}`, `
      <dl class="kv"><dt>الحالة</dt><dd>${pill(EMP_PILL[e.display_status], e.display_status_label)}</dd><dt>الرقم الوظيفي</dt><dd class="ltr">${val(e.employee_no)}</dd>
        <dt>المعرف الداخلي</dt><dd class="ltr">#${e.id}</dd><dt>الحسابات البنكية</dt><dd>${h.bank_accounts}</dd>
        <dt>حالات المتابعة</dt><dd>${h.cases.length ? h.cases.map((c) => `<a href="#/procedures/case/${c.id}" class="ltr" data-close-nav>${esc(c.case_no)}</a>`).join('، ') : '—'}</dd></dl>
      <h3 style="margin-top:12px">التعديلات</h3>
      ${h.events.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th></tr></thead><tbody>
        ${h.events.map((x) => `<tr><td class="small ltr">${esc(fmtTime(x.created_at))}</td><td class="small">${esc(x.user_name || 'النظام')}</td><td>${esc(EVENT_LABEL[x.event] || x.event)}</td>
          <td class="small" style="white-space:normal">${esc(x.detail || '')}${x.changes ? `<div class="muted">${ch(x.changes)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">لا توجد تعديلات مسجلة (السجلات الأقدم من هذه الميزة تبدأ من الآن).</div>'}`,
      '<button class="btn" type="button" data-close>إغلاق</button>');
    $('[data-close]', d).addEventListener('click', () => d.close());
    $$('[data-close-nav]', d).forEach((a) => a.addEventListener('click', () => d.close()));
  }

  async function importsLog() {
    const rows = await api('/api/employees/imports');
    const d = openModal('سجل استيراد ملف الموظفين النشطين', rows.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الملف</th><th>الصفوف</th><th>جديد</th><th>محدَّث</th><th>مربوط</th><th>بلا تغيير</th><th>متروك</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="small ltr">${esc(fmtTime(r.created_at))}</td><td class="small">${esc(r.user_name || '')}</td><td class="small">${esc(r.filename || '')}</td><td>${r.rows_total}</td><td>${r.created_count}</td><td>${r.updated_count}</td><td>${r.linked_count}</td><td>${r.unchanged_count}</td><td>${r.skipped_count}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">لم يُستورد أي ملف بعد.</div>', '<button class="btn" type="button" data-close>إغلاق</button>');
    $('[data-close]', d).addEventListener('click', () => d.close());
  }

  // ---------- import: choose file → preview (nothing saved) → decisions → import ----------
  function importDialog(onDone) {
    let file = null, preview = null, mapping = null;
    const decisions = {};
    const d = openModal('استيراد ملف الموظفين النشطين', `${companyBanner('سيُستورد الملف إلى')}
      <div class="stack">
        <p class="small muted" style="margin:0">المطابقة بالرقم الوظيفي داخل ${esc(state.company.name_ar)} فقط. لا يُحذف أي موظف، ولا تتغير حالة أي موظف (من «قيد الانضمام» يبقى كذلك حتى «تأكيد المباشرة»)، والخلايا الفارغة لا تمسح بيانات موجودة. ستظهر لك معاينة كاملة قبل أي حفظ.</p>
        <label class="field"><span>ملف Excel (xlsx)</span><input type="file" id="imp-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></label>
        <div id="imp-body"></div>
      </div><p class="error-text" id="imp-err" hidden></p>`,
    '<button class="btn primary" type="button" id="imp-apply" disabled>تنفيذ الاستيراد</button><button class="btn" type="button" data-close>إغلاق</button>');
    d.style.width = 'min(1100px, 96vw)';
    const err = (m) => { const x = $('#imp-err', d); x.textContent = m || ''; x.hidden = !m; };
    $('[data-close]', d).addEventListener('click', () => d.close());

    const runPreview = async () => {
      err('');
      $('#imp-body', d).innerHTML = '<div class="empty">جارٍ قراءة الملف ومعاينته… (لا يُحفظ شيء)</div>';
      $('#imp-apply', d).disabled = true;
      try {
        preview = await api('/api/employees/import/preview', { method: 'POST', body: { file, mapping, decisions } });
        render();
      } catch (e) { $('#imp-body', d).innerHTML = ''; err(e.message); }
    };
    $('#imp-file', d).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      file = await fileToUpload(f);
      mapping = null;
      for (const k of Object.keys(decisions)) delete decisions[k];
      runPreview();
    });

    const optLabel = (o, r) => {
      if (o === 'skip') return 'تجاهل هذا الصف';
      if (o === 'create') return 'إنشاء سجل جديد';
      const [a, id] = o.split(':');
      const who = [r.employee, ...(r.candidates || [])].find((x) => x && x.id === Number(id));
      return `${a === 'link' ? 'ربط بالسجل' : 'تحديث السجل'}: ${who ? `${who.full_name_ar}${who.employee_no ? ` (${who.employee_no})` : ''} — ${who.status_label}` : `#${id}`}`;
    };
    const changesCell = (r) => (r.changes?.length ? r.changes.map((c) => `${esc(c.label)}: ${c.from === null ? '—' : esc(String(c.from))} ← <b>${esc(String(c.to))}</b>`).join('<br>') : '');

    function render() {
      const p = preview;
      const colSel = (c) => `<select data-col="${c.index}" style="min-width:150px"><option value="">— لا يُستورد —</option>${Object.entries(p.fields).map(([k, l]) => `<option value="${k}" ${c.field === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      const s = p.summary;
      const groups = ['review', 'create', 'update', 'error', 'unchanged'];
      $('#imp-body', d).innerHTML = `
        ${p.previous_import ? `<div class="notice small">هذا الملف نفسه استُورد سابقًا (${esc(fmtTime(p.previous_import.created_at))} — ${esc(p.previous_import.user_name || '')}). إعادة استيراده لا تُنشئ تكرارًا.</div>` : ''}
        <details ${p.missing_employee_no ? 'open' : ''} class="card" style="background:var(--bg)"><summary><b>الأعمدة</b> <span class="small muted">— الورقة «${esc(p.sheets[p.sheet])}»، صف العناوين ${p.header_row}. غيّر الربط إن لزم ثم «تحديث المعاينة».</span></summary>
          <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>عمود الملف</th><th>أمثلة</th><th>يُستورد إلى</th></tr></thead><tbody>
          ${p.columns.map((c) => `<tr><td>${esc(c.header || '(بلا عنوان)')}</td><td class="small muted">${esc(c.sample.join(' · '))}</td><td>${colSel(c)}</td></tr>`).join('')}
          </tbody></table></div><button class="btn small" type="button" id="imp-remap">تحديث المعاينة</button></details>
        ${p.missing_employee_no ? '<div class="notice small" style="color:var(--danger)">لم يُحدَّد عمود «الرقم الوظيفي». اختره من الجدول أعلاه — المطابقة لا تتم بدونه.</div>' : `
        <div class="grid cols-4" style="margin:12px 0">
          <div class="card stat"><span class="muted small">صفوف الملف</span><span class="num">${s.total}</span></div>
          <div class="card stat"><span class="muted small">جديد</span><span class="num">${s.create}</span></div>
          <div class="card stat"><span class="muted small">تحديث / ربط</span><span class="num">${s.update + s.linked}</span><span class="small muted">بلا تغيير ${s.unchanged}</span></div>
          <div class="card stat"><span class="muted small">مراجعة يدوية</span><span class="num">${s.review}</span><span class="small ${s.error ? '' : 'muted'}" ${s.error ? 'style="color:var(--danger)"' : ''}>أخطاء: ${s.error}</span></div>
        </div>
        ${groups.map((g) => {
          const rows = p.rows.filter((r) => r.kind === g);
          if (!rows.length) return '';
          return `<details class="card" ${g === 'review' || g === 'error' ? 'open' : ''} style="margin-bottom:8px"><summary>${pill(KIND[g][1], KIND[g][0])} <b>${rows.length}</b>${g === 'review' ? ' <span class="small muted">— اختر لكل صف ما يحدث له (الافتراضي هو الأكثر أمانًا)</span>' : ''}</summary>
            <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>الصف</th><th>الرقم الوظيفي</th><th>الاسم</th><th>${g === 'review' ? 'السبب والقرار' : g === 'error' ? 'الخطأ' : 'السجل والتغييرات'}</th></tr></thead><tbody>
            ${rows.map((r) => `<tr><td>${r.row}</td><td class="ltr">${val(r.employee_no)}</td><td>${val(r.name)}</td><td class="small" style="white-space:normal">
              ${g === 'review' ? `<b>${esc(r.reason_text)}</b>${(r.issues || []).map((x) => `<div>• ${esc(x)}</div>`).join('')}${(r.candidates || []).length ? `<div class="muted">سجلات مشابهة: ${r.candidates.map((c) => `${esc(c.full_name_ar)}${c.employee_no ? ` (${esc(c.employee_no)})` : ''} — ${esc(c.status_label)}`).join('، ')}</div>` : ''}
                ${changesCell(r) ? `<div class="muted">${changesCell(r)}</div>` : ''}
                <select data-decide="${r.row}" style="margin-top:6px">${r.options.map((o) => `<option value="${esc(o)}" ${(decisions[r.row] ?? r.action ?? r.default) === o ? 'selected' : ''}>${esc(optLabel(o, r))}</option>`).join('')}</select>`
              : g === 'error' ? esc(r.error || '')
              : `${r.employee ? `${esc(r.employee.full_name_ar)} — ${pill(EMP_PILL[r.employee.status] || 'off', r.employee.status_label)}` : ''}${r.onboarding ? ' <span class="muted">(يبقى «قيد الانضمام» حتى تأكيد المباشرة)</span>' : ''}${g === 'create' ? 'سجل جديد بحالة «نشط»' : ''}${changesCell(r) ? `<div>${changesCell(r)}</div>` : ''}`}
              ${(r.warnings || []).map((w) => `<div style="color:var(--warn-text, #93370d)">⚠ ${esc(w)}</div>`).join('')}</td></tr>`).join('')}
            </tbody></table></div></details>`;
        }).join('')}
        ${p.not_in_file.length ? `<details class="card" style="margin-bottom:8px"><summary>${pill('off', 'غير موجودين في الملف')} <b>${p.not_in_file.length}</b> <span class="small muted">— لن يُحذفوا ولن تتغير حالتهم</span></summary>
          <p class="small" style="margin:8px 0 0">${p.not_in_file.map((e) => `${esc(e.full_name_ar)}${e.employee_no ? ` <span class="ltr">(${esc(e.employee_no)})</span>` : ''} — ${esc(e.status_label)}`).join('، ')}</p></details>` : ''}`}`;
      $('#imp-remap', d)?.addEventListener('click', () => {
        mapping = Object.fromEntries($$('[data-col]', d).map((s2) => [s2.dataset.col, s2.value || null]));
        runPreview();
      });
      $$('[data-decide]', d).forEach((s2) => s2.addEventListener('change', () => { decisions[s2.dataset.decide] = s2.value; }));
      $('#imp-apply', d).disabled = !!p.missing_employee_no || !p.rows.length;
    }

    $('#imp-apply', d).addEventListener('click', async () => {
      if (!preview) return;
      const pending = preview.rows.filter((r) => r.kind === 'review');
      const chosen = (r) => decisions[r.row] ?? r.action ?? r.default;
      const n = { create: preview.rows.filter((r) => r.kind === 'create').length + pending.filter((r) => chosen(r) === 'create').length,
        update: preview.rows.filter((r) => r.kind === 'update').length + pending.filter((r) => /^(update|link):/.test(chosen(r))).length,
        skip: pending.filter((r) => chosen(r) === 'skip').length };
      if (!confirm(`سيُنفَّذ الاستيراد في ${state.company.name_ar}:\n• إنشاء ${n.create} سجل\n• تحديث / ربط ${n.update} سجل\n• تجاهل ${n.skip} صف\n\nلا يُحذف أي موظف ولا تتغير أي حالة. متابعة؟`)) return;
      $('#imp-apply', d).disabled = true;
      try {
        const r = await api('/api/employees/import/apply', { method: 'POST', body: { file, mapping, decisions, sha256: preview.sha256 } });
        d.close();
        toast(`تم الاستيراد: ${r.summary.create} جديد، ${r.summary.update} محدَّث، ${r.summary.linked} مربوط، ${r.summary.unchanged} بلا تغيير${r.summary.error ? `، ${r.summary.error} خطأ` : ''}`);
        onDone?.();
      } catch (e) {
        if (e.code === 'company_changed') return d.close();
        err(e.message);
        $('#imp-apply', d).disabled = false;
      }
    });
  }

  return { directory };
}
