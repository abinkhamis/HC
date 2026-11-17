// Admin: set up a completion-certificate template without editing Word.
// Upload → «ربط الخانات» (link boxes) → «تجربة النموذج» (fake-data trial, PDF + Word)
// → «اعتماد» (explicit approval). Nothing is activated automatically.

const CONF = { high: ['ok', 'متعرَّف عليها'], check: ['warn', 'تحتاج تأكيدًا'], unknown: ['danger', 'غير معروفة'] };
const MODES = { field: 'ربط بحقل', fixed: 'نص ثابت (يبقى كما هو)', blank: 'فارغة دائمًا' };

export function createTemplateMappingUI(ctx) {
  const { api, esc, $, $$, toast, openModal, companyBanner, download, fmtTime } = ctx;
  const pill = (cls, t) => `<span class="pill ${cls}">${esc(t)}</span>`;

  const stateOf = (v) => {
    const c = v.checks_json ? JSON.parse(v.checks_json) : null;
    if (v.is_active && v.review_state === 'approved') return pill('ok', 'معتمد ونشط');
    if (v.review_state === 'approved') return pill('info', 'معتمد سابقًا');
    if (v.trial_at && c?.trial_ok && c?.format_ok !== false && !c?.missing_required?.length) return pill('info', 'جُرّب — بانتظار الاعتماد');
    if (c?.missing_required?.length) return pill('warn', `ناقص: ${c.missing_required.length}`);
    if (!JSON.parse(v.placeholders || '[]').length) return pill('off', 'بدون ربط');
    return pill('off', 'مسودة');
  };

  // Rows of the certificate versions table (rendered inside the templates page).
  function versionsTable(versions) {
    return `<div class="table-wrap"><table><thead><tr><th>الإصدار</th><th>الملف</th><th>الحالة</th><th></th></tr></thead><tbody>
      ${versions.map((v) => `<tr><td>v${v.version}${v.source_template_id ? `<div class="muted small">من v${esc(String(versions.find((x) => x.id === v.source_template_id)?.version ?? ''))}</div>` : ''}</td>
        <td class="small" style="white-space:normal">${esc(v.original_name)}<div class="muted small ltr">${esc(fmtTime(v.created_at))}</div></td>
        <td>${stateOf(v)}</td>
        <td><div class="row" style="gap:4px;flex-wrap:wrap">
          <button class="btn small ${v.review_state === 'approved' || JSON.parse(v.placeholders || '[]').length ? '' : 'primary'}" data-tm-map="${v.id}">مراجعة وإعداد</button>
          ${JSON.parse(v.placeholders || '[]').length ? `<button class="btn small" data-tm-trial="${v.id}">${v.trial_at ? 'إعادة التجربة' : 'تجربة النموذج'}</button>` : ''}
          ${v.trial_at ? `<button class="btn small" data-tm-view="${v.id}">عرض التجربة</button>` : ''}
          ${v.review_state !== 'approved' && v.trial_at ? `<button class="btn small primary" data-tm-approve="${v.id}">اعتماد</button>` : ''}
          ${v.review_state === 'approved' && !v.is_active ? `<button class="btn small" data-tm-approve="${v.id}">إعادة تفعيل</button>` : ''}
          <button class="btn small" data-dl="${v.id}" data-name="${esc(v.original_name)}">تنزيل</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function bind(root, reload) {
    $$('[data-tm-map]', root).forEach((b) => b.addEventListener('click', () => openReview(Number(b.dataset.tmMap), reload)));
    $$('[data-tm-trial]', root).forEach((b) => b.addEventListener('click', () => openTrial(Number(b.dataset.tmTrial), reload, true)));
    $$('[data-tm-view]', root).forEach((b) => b.addEventListener('click', () => openTrial(Number(b.dataset.tmView), reload, false)));
    $$('[data-tm-approve]', root).forEach((b) => b.addEventListener('click', () => approve(Number(b.dataset.tmApprove), reload)));
  }

  async function approve(id, reload) {
    try { const r = await api(`/api/admin/templates/${id}/approve`, { method: 'POST' }); toast(`تم اعتماد الإصدار ${r.version} وتفعيله`); reload(); }
    catch (e) { if (e.code !== 'company_changed') { const d = openModal('لا يمكن الاعتماد بعد', `<div class="notice">${esc(e.message)}</div>`, '<button class="btn" type="button" data-close>إغلاق</button>'); $('[data-close]', d).addEventListener('click', () => d.close()); } }
  }

  // ---------- simple review: «is it ready, and what needs me?» ----------
  // Shows only the boxes that need the Admin; everything recognised is applied
  // as suggested. One click links + runs the fake-data trial; approval stays a
  // separate, explicit button.
  async function openReview(id, reload) {
    const a = await api(`/api/admin/templates/${id}/analysis`);
    const labelOf = Object.fromEntries(a.fields.map((f) => [f.key, f.label]));
    const human = (pattern) => esc(String(pattern || '')).replace(/\{\{\s*([a-z0-9_]+)(?::[a-z]+)?\s*\}\}/gi, (m, k) => `<span class="pill info">${esc(labelOf[k] || k)}</span>`).replace(/\n/g, '<br>');
    const mapping = Object.fromEntries(a.slots.map((s) => [s.id, a.saved_mapping?.[s.id] || { mode: s.suggestion.mode, pattern: s.suggestion.pattern || '' }]));
    const visible = a.slots.filter((s) => !s.suggestion.quiet);
    const needs = visible.filter((s) => s.suggestion.confidence !== 'high');
    const auto = visible.filter((s) => s.suggestion.confidence === 'high' && mapping[s.id].mode === 'field');
    const blanks = a.slots.filter((s) => mapping[s.id].mode === 'blank');
    const confirmed = new Set();
    const coverage = () => a.required_fields.map((r) => ({ label: r.label, ok: r.keys.some((k) => Object.values(mapping).some((m) => m.mode === 'field' && new RegExp(`\\{\\{\\s*${k}(:|\\s*\\}\\})`).test(m.pattern || ''))) }));
    const fieldOpts = a.fields.map((f) => `<option value="{{${f.key}${f.date ? ':dash' : ''}}}">${esc(f.label)}</option>`).join('');
    const check = (ok, text) => `<li style="list-style:none">${ok ? '✅' : '⚠️'} ${text}</li>`;

    const d = openModal('مراجعة نموذج شهادة الإنجاز', `${companyBanner('هذا النموذج خاص بـ')}
      <div class="stack">
        <div class="card stack" id="rv-status"></div>
        <div class="card stack"><h3 style="margin:0">ما يحتاج تدخلك (${needs.length})</h3>
          ${needs.length ? needs.map((s) => `<div class="card stack" data-need="${s.id}" style="background:var(--bg)">
            <div class="spread"><b>${esc(s.suggestion.label || s.id)}</b><span data-badge>${pill('warn', 'بانتظار موافقتك')}</span></div>
            <div class="small"><span class="muted">مكتوب حاليًا في الملف:</span><div style="white-space:pre-wrap">${esc(s.text)}</div></div>
            <div class="small"><span class="muted">سيُربط بـ:</span> <span data-human>${human(mapping[s.id].pattern)}</span></div>
            <div class="small muted">${esc(s.suggestion.reason || '')}</div>
            <div data-edit hidden class="stack" style="gap:4px">
              <textarea data-pattern rows="${Math.max(1, (mapping[s.id].pattern || '').split('\n').length)}" dir="auto" class="small">${esc(mapping[s.id].pattern || '')}</textarea>
              <select data-insert><option value="">+ إدراج حقل…</option>${fieldOpts}</select>
              <label class="check small"><input type="checkbox" data-fixed> أبقِ نص الخانة كما هو (بدون ربط)</label></div>
            <div class="row"><button class="btn small primary" type="button" data-ok>موافق</button><button class="btn small" type="button" data-change>تعديل</button></div>
          </div>`).join('') : '<span class="muted small">لا شيء — كل الخانات متعرَّف عليها.</span>'}
        </div>
        <details class="card"><summary><b>رُبط تلقائيًا (${auto.length})</b> <span class="muted small">— لا يحتاج تدخلك</span></summary>
          <div class="table-wrap" style="margin-top:8px"><table><tbody>${auto.map((s) => `<tr><td class="small">${esc(s.suggestion.label || s.id)}</td><td class="small">${human(mapping[s.id].pattern)}</td></tr>`).join('')}
            <tr><td class="small">خانات التوقيع والتاريخ (${blanks.length})</td><td class="small">تبقى فارغة</td></tr></tbody></table></div></details>
        <div id="rv-trial"></div>
        <button class="btn small" type="button" id="rv-advanced" style="align-self:flex-start">إعداد متقدم: عرض كل الخانات</button>
      </div><p class="error-text" id="rv-err" hidden></p>`,
    '<button class="btn primary" type="button" id="rv-run">تأكيد الربط وتجربة النموذج</button><button class="btn primary" type="button" id="rv-approve" hidden>اعتماد هذا الإصدار</button><button class="btn" type="button" data-close>إغلاق</button>');
    d.classList.add('wide');
    let pdfUrl = null;
    let draftId = null;
    d.addEventListener('close', () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); });
    $('[data-close]', d).addEventListener('click', () => d.close());
    $('#rv-advanced', d).addEventListener('click', () => { d.close(); openMapping(id, reload); });

    const renderStatus = (trial) => {
      const cov = coverage();
      const pending = needs.filter((s) => !confirmed.has(s.id)).length;
      const ready = !!trial && trial.ok;
      $('#rv-status', d).innerHTML = `
        <h2 style="margin:0">${ready ? '✅ جاهز للاعتماد — بانتظار موافقتك' : '⏳ غير جاهز للاعتماد بعد'}</h2>
        <ul class="small" style="margin:0;padding:0">
          ${check(cov.every((c) => c.ok), `الحقول المطلوبة: ${cov.map((c) => `${c.ok ? '' : '✗ '}${esc(c.label)}`).join('، ')}`)}
          ${check(true, 'أسماء المعتمدين الثلاثة تُدخل عند كل إصدار؛ التوقيعات وتواريخها تبقى فارغة')}
          ${check(pending === 0, pending ? `خانات تحتاج موافقتك: ${pending}` : 'راجعتَ كل الخانات التي تحتاج تدخلك')}
          ${check(!!trial && trial.format, trial ? (trial.format ? 'التصميم محفوظ — لم يتغير شيء خارج الخانات المربوطة' : 'لم يُحافَظ على التصميم') : 'التصميم: يُفحص عند التجربة')}
          ${check(!!trial && trial.clean, trial ? (trial.clean ? 'الشهادة التجريبية خالية من بيانات المستند الأصلي ومن المواضع الفارغة' : 'مشكلات في الشهادة التجريبية') : 'التجربة ببيانات وهمية: لم تُجرَ بعد')}
          ${check(false, 'الاعتماد: لا يتم إلا بضغطك «اعتماد هذا الإصدار»')}
        </ul>
        ${trial?.problems?.length ? `<div class="notice small">${trial.problems.map(esc).join('<br>')}</div>` : ''}`;
      $('#rv-run', d).disabled = pending > 0 || !cov.every((c) => c.ok);
      $('#rv-approve', d).hidden = !ready;
    };
    renderStatus(null);

    $$('[data-need]', d).forEach((card) => {
      const sid = card.dataset.need;
      const sync = () => {
        const fixed = $('[data-fixed]', card).checked;
        mapping[sid] = fixed ? { mode: 'fixed', pattern: '' } : { mode: 'field', pattern: $('[data-pattern]', card).value };
        $('[data-human]', card).innerHTML = fixed ? '<span class="muted">يبقى النص كما هو</span>' : human(mapping[sid].pattern);
      };
      $('[data-ok]', card).addEventListener('click', () => {
        sync(); confirmed.add(sid);
        $('[data-badge]', card).innerHTML = pill('ok', 'وافقتَ عليها');
        $('[data-edit]', card).hidden = true;
        renderStatus(null);
      });
      $('[data-change]', card).addEventListener('click', () => { $('[data-edit]', card).hidden = false; confirmed.delete(sid); $('[data-badge]', card).innerHTML = pill('warn', 'بانتظار موافقتك'); renderStatus(null); });
      $('[data-pattern]', card).addEventListener('input', sync);
      $('[data-fixed]', card).addEventListener('change', sync);
      $('[data-insert]', card).addEventListener('change', (e) => { const ta = $('[data-pattern]', card); ta.value += e.target.value; e.target.value = ''; sync(); });
    });

    $('#rv-run', d).addEventListener('click', async (e) => {
      const err = $('#rv-err', d); err.hidden = true;
      e.target.disabled = true;
      $('#rv-trial', d).innerHTML = '<div class="card muted small">جارٍ إنشاء الإصدار الجديد (مسودة) والشهادة التجريبية ببيانات وهمية ومعاينة PDF… قد يستغرق ذلك عدة ثوانٍ.</div>';
      try {
        const m = await api(`/api/admin/templates/${id}/mapping`, { method: 'POST', body: { mapping } });
        draftId = m.template_id;
        const t = await api(`/api/admin/templates/${draftId}/trial`, { method: 'POST', body: { pdf: true } });
        const c = t.checks;
        if (t.has_pdf) { const res = await api(`/api/admin/templates/${draftId}/trial/pdf`, { raw: true }); pdfUrl = URL.createObjectURL(new Blob([await res.blob()], { type: 'application/pdf' })); }
        const problems = [...(c.format_problems || []), ...(c.trial_problems || []), ...(c.missing_required || []).map((x) => `غير مربوط: ${x}`)];
        renderStatus({ ok: c.format_ok !== false && c.trial_ok && !(c.missing_required || []).length && !(c.unknown || []).length, format: c.format_ok !== false, clean: !!c.trial_ok, problems });
        $('#rv-trial', d).innerHTML = `<div class="card stack"><div class="spread"><h3 style="margin:0">الشهادة التجريبية (بيانات وهمية) — الإصدار ${m.version} مسودة</h3>
          <button class="btn small" type="button" id="rv-docx">تنزيل ملف Word</button></div>
          ${pdfUrl ? `<iframe src="${pdfUrl}" title="معاينة الشهادة التجريبية" style="width:100%;height:65vh;border:1px solid var(--border);border-radius:8px;background:#fff"></iframe>` : `<div class="notice small">${esc(t.pdf_note || 'لا توجد معاينة PDF؛ نزّل ملف Word.')}</div>`}</div>`;
        $('#rv-docx', d).addEventListener('click', () => download(`/api/admin/templates/${draftId}/trial/docx`, 'شهادة تجريبية.docx').catch((x) => toast(x.message, 'error')));
        $('#rv-run', d).hidden = true;
        reload();
      } catch (x) {
        if (x.code === 'company_changed') return d.close();
        $('#rv-trial', d).innerHTML = '';
        err.textContent = x.message; err.hidden = false; e.target.disabled = false;
      }
    });
    $('#rv-approve', d).addEventListener('click', async () => { if (!draftId) return; d.close(); await approve(draftId, reload); });
  }

  // ---------- linking dialog ----------
  async function openMapping(id, reload) {
    const a = await api(`/api/admin/templates/${id}/analysis`);
    const saved = a.saved_mapping || {};
    const fieldOpts = a.fields.map((f) => `<option value="{{${f.key}${f.date ? ':dash' : ''}}}">${esc(f.label)}</option>`).join('');
    const show = (s) => !s.suggestion.quiet || saved[s.id] && saved[s.id].mode !== 'fixed';
    const counts = { high: 0, check: 0, unknown: 0 };
    a.slots.filter(show).forEach((s) => counts[s.suggestion.confidence]++);
    const decision = (s) => saved[s.id] || { mode: s.suggestion.mode, pattern: s.suggestion.pattern || '' };
    const rowHtml = (s) => {
      const d = decision(s);
      const [cls, conf] = CONF[s.suggestion.confidence];
      const needsCheck = s.suggestion.confidence !== 'high';
      return `<tr data-slot="${s.id}" ${show(s) ? '' : 'data-extra hidden'}>
        <td class="small" style="white-space:normal;max-width:180px"><b>${esc(s.suggestion.label || (s.kind === 'paragraph' ? 'فقرة' : '—'))}</b><div class="muted ltr">${esc(s.id)}</div></td>
        <td class="small" style="white-space:pre-wrap;max-width:240px">${s.text ? esc(s.text) : '<span class="muted">(فارغة)</span>'}${s.drawing ? '<div class="muted">+ صورة (تبقى كما هي)</div>' : ''}</td>
        <td style="min-width:300px"><div class="stack" style="gap:6px">
          <select data-mode aria-label="نوع الربط">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${k === d.mode ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <div data-field-box ${d.mode === 'field' ? '' : 'hidden'} class="stack" style="gap:4px">
            <textarea data-pattern rows="${Math.max(1, (d.pattern || '').split('\n').length)}" dir="auto" class="small" style="font-family:inherit">${esc(d.pattern || '')}</textarea>
            <select data-insert aria-label="إدراج حقل"><option value="">+ إدراج حقل…</option>${fieldOpts}</select>
            <span class="muted small">كل سطر = سطر في الخانة. النص خارج {{…}} يبقى كما هو.</span></div>
          <div class="small">${pill(cls, conf)} <span class="muted">${esc(s.suggestion.reason || '')}</span></div>
          ${needsCheck ? '<label class="check small"><input type="checkbox" data-reviewed> راجعتُ هذه الخانة</label>' : ''}
        </div></td></tr>`;
    };
    const tables = [...new Set(a.slots.filter((s) => s.kind === 'cell').map((s) => s.table))];
    const body = `${companyBanner('هذا النموذج خاص بـ')}
      <div class="stack">
        <div class="card stack" style="background:var(--bg)">
          <div><b>${esc(a.template.file)}</b> <span class="muted small">— الإصدار ${a.template.version}${a.template.source_version !== a.template.version ? ` (الربط يُطبَّق على نسخة من الإصدار ${a.template.source_version})` : ''}</span></div>
          <div class="small">وُجد: ${a.tables} جدول، ${a.parts.images} صورة، ${a.parts.headers} ترويسة، ${a.parts.footers} تذييل.
            الخانات: ${pill('ok', `${counts.high} متعرَّف عليها`)} ${pill('warn', `${counts.check} تحتاج تأكيدًا`)} ${pill('danger', `${counts.unknown} غير معروفة`)}</div>
          ${a.nested ? '<div class="notice small">النموذج يحتوي جداول متداخلة؛ قد لا يمكن الحفاظ على التنسيق تلقائيًا.</div>' : ''}
          <p class="small muted" style="margin:0">يُطبَّق الربط على نسخة جديدة من الملف (مسودة)؛ يبقى الملف الأصلي وكل الإصدارات السابقة كما هي. عناوين الخانات والنصوص الرسمية لا تتغير، وتبقى التوقيعات وتواريخها فارغة.
            المطلوب للاعتماد: ${a.required.map(esc).join('، ')}.</p>
        </div>
        ${tables.map((ti) => `<div class="stack"><h3 style="margin:0">الجدول ${ti + 1}</h3><div class="table-wrap"><table><thead><tr><th>عنوان الخانة</th><th>النص الحالي في الملف</th><th>الربط</th></tr></thead><tbody>
          ${a.slots.filter((s) => s.kind === 'cell' && s.table === ti).map(rowHtml).join('')}</tbody></table></div></div>`).join('')}
        ${a.slots.some((s) => s.kind === 'paragraph' && show(s)) ? `<div class="stack"><h3 style="margin:0">فقرات خارج الجداول</h3><div class="table-wrap"><table><tbody>${a.slots.filter((s) => s.kind === 'paragraph').map(rowHtml).join('')}</tbody></table></div></div>` : `<table hidden><tbody>${a.slots.filter((s) => s.kind === 'paragraph').map(rowHtml).join('')}</tbody></table>`}
        <label class="check small"><input type="checkbox" id="tm-all"> عرض كل الخانات (العناوين والفقرات الثابتة) لتحديد خانة يدويًا</label>
      </div><p class="error-text" id="tm-err" hidden></p><div id="tm-result"></div>`;
    const d = openModal('ربط خانات نموذج شهادة الإنجاز', body, '<button class="btn primary" type="button" id="tm-save">حفظ الربط وإنشاء إصدار جديد (مسودة)</button><button class="btn" type="button" data-close>إغلاق</button>');
    d.classList.add('wide');
    $('[data-close]', d).addEventListener('click', () => d.close());
    $('#tm-all', d).addEventListener('change', (e) => {
      $$('[data-extra]', d).forEach((tr) => (tr.hidden = !e.target.checked));
      $$('table[hidden]', d).forEach((t) => (t.hidden = !e.target.checked));
    });
    $$('[data-slot]', d).forEach((tr) => {
      const mode = $('[data-mode]', tr);
      mode.addEventListener('change', () => ($('[data-field-box]', tr).hidden = mode.value !== 'field'));
      $('[data-insert]', tr).addEventListener('change', (e) => {
        const ta = $('[data-pattern]', tr);
        const at = ta.selectionStart ?? ta.value.length;
        ta.value = ta.value.slice(0, at) + e.target.value + ta.value.slice(ta.selectionEnd ?? at);
        e.target.value = '';
        mode.value = 'field'; $('[data-field-box]', tr).hidden = false;
      });
    });
    $('#tm-save', d).addEventListener('click', async (e) => {
      const err = $('#tm-err', d); err.hidden = true;
      const unchecked = $$('[data-slot]', d).filter((tr) => !tr.hidden && $('[data-reviewed]', tr) && !$('[data-reviewed]', tr).checked).map((tr) => tr.dataset.slot);
      if (unchecked.length) { err.textContent = `راجع الخانات التي تحتاج تأكيدًا وحدّد «راجعتُ هذه الخانة»: ${unchecked.join('، ')}`; err.hidden = false; return; }
      const mapping = Object.fromEntries($$('[data-slot]', d).map((tr) => [tr.dataset.slot, { mode: $('[data-mode]', tr).value, pattern: $('[data-pattern]', tr).value }]));
      e.target.disabled = true;
      try {
        const r = await api(`/api/admin/templates/${id}/mapping`, { method: 'POST', body: { mapping } });
        const c = r.checks;
        $('#tm-result', d).innerHTML = `<div class="card stack" style="margin-top:12px"><h3 style="margin:0">أُنشئ الإصدار ${r.version} (مسودة — غير مفعّل)</h3>
          <div>${c.format_ok ? pill('ok', 'التنسيق محفوظ — لم يتغير شيء خارج الخانات المربوطة') : pill('danger', 'لم يُحافَظ على التنسيق')}</div>
          ${c.format_problems.length ? `<ul class="small">${c.format_problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          <div class="small">الحقول المربوطة: ${c.placeholders.length}</div>
          ${c.missing_required.length ? `<div class="notice small">حقول مطلوبة غير مربوطة: ${c.missing_required.map(esc).join('، ')}</div>` : pill('ok', 'كل الحقول المطلوبة مربوطة')}
          <div class="row"><button class="btn primary" type="button" id="tm-go-trial">تجربة النموذج ببيانات وهمية</button></div></div>`;
        $('#tm-go-trial', d).addEventListener('click', () => { d.close(); openTrial(r.template_id, reload, true); });
        reload();
      } catch (e2) { if (e2.code === 'company_changed') return d.close(); err.textContent = e2.message; err.hidden = false; }
      finally { e.target.disabled = false; }
    });
  }

  // ---------- trial dialog: PDF preview + Word file, then approval ----------
  async function openTrial(id, reload, run) {
    const d = openModal('تجربة نموذج شهادة الإنجاز', `${companyBanner('النموذج خاص بـ')}<div id="tr-body" class="stack"><span class="muted small">${run ? 'جارٍ إنشاء شهادة تجريبية ببيانات وهمية ومعاينتها في Word… قد يستغرق ذلك عدة ثوانٍ.' : 'جارٍ التحميل…'}</span></div>`,
      '<button class="btn primary" type="button" id="tr-approve" disabled>اعتماد هذا الإصدار</button><button class="btn" type="button" id="tr-docx" disabled>تنزيل ملف Word التجريبي</button><button class="btn" type="button" data-close>إغلاق</button>');
    d.classList.add('wide');
    let pdfUrl = null;
    d.addEventListener('close', () => { if (pdfUrl) URL.revokeObjectURL(pdfUrl); });
    $('[data-close]', d).addEventListener('click', () => d.close());
    try {
      let checks, hasPdf, note;
      if (run) { const r = await api(`/api/admin/templates/${id}/trial`, { method: 'POST', body: { pdf: true } }); checks = r.checks; hasPdf = r.has_pdf; note = r.pdf_note; reload(); }
      else { const list = await api('/api/admin/templates'); const v = list.find((x) => x.id === id); checks = JSON.parse(v.checks_json || '{}'); hasPdf = !!v.has_trial_pdf; }
      if (hasPdf) { const res = await api(`/api/admin/templates/${id}/trial/pdf`, { raw: true }); pdfUrl = URL.createObjectURL(new Blob([await res.blob()], { type: 'application/pdf' })); }
      const problems = [...(checks.format_problems || []), ...(checks.trial_problems || [])];
      const ready = checks.trial_ok && checks.format_ok !== false && !(checks.missing_required || []).length && !(checks.unknown || []).length;
      $('#tr-body', d).innerHTML = `
        <div class="row" style="gap:6px;flex-wrap:wrap">${checks.format_ok === false ? pill('danger', 'التنسيق لم يُحفظ') : pill('ok', 'التنسيق محفوظ')}
          ${checks.trial_ok ? pill('ok', 'لا مواضع فارغة ولا بيانات من المستند الأصلي') : pill('danger', 'مشكلات في الشهادة التجريبية')}
          ${(checks.missing_required || []).length ? pill('warn', `ناقص: ${checks.missing_required.join('، ')}`) : pill('ok', 'الحقول المطلوبة مربوطة')}</div>
        ${problems.length ? `<div class="notice small"><ul style="margin:0">${problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
        <p class="small muted" style="margin:0">البيانات في هذه الشهادة وهمية بالكامل (استشاري تجريبي، آيبان أصفار، معتمدون تجريبيون). راجع الشكل ثم اعتمد إن كان مطابقًا للنموذج الرسمي.</p>
        ${pdfUrl ? `<iframe src="${pdfUrl}" title="معاينة الشهادة التجريبية" style="width:100%;height:70vh;border:1px solid var(--border);border-radius:8px;background:#fff"></iframe>` : `<div class="notice small">${esc(note || 'لا توجد معاينة PDF لهذا الإصدار؛ نزّل ملف Word التجريبي للمراجعة.')}</div>`}`;
      $('#tr-docx', d).disabled = false;
      $('#tr-docx', d).addEventListener('click', () => download(`/api/admin/templates/${id}/trial/docx`, 'شهادة تجريبية.docx').catch((e) => toast(e.message, 'error')));
      $('#tr-approve', d).disabled = !ready;
      $('#tr-approve', d).addEventListener('click', async () => { d.close(); await approve(id, reload); });
    } catch (e) {
      if (e.code === 'company_changed') return d.close();
      $('#tr-body', d).innerHTML = `<div class="notice">${esc(e.message)}</div>`;
    }
  }

  return { versionsTable, bind, stateOf };
}
