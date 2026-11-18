// Reports centre: weekly team report (who did what) and exports as Excel or PDF.
// PDF = a printable page opened in a new tab; the browser saves it («حفظ بتنسيق PDF»).
export function createReportViews(ctx) {
  const { api, esc, $, $$, toast, workspaceHead, download, state } = ctx;
  const riyadhToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const dmy = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
  const monthStart = () => riyadhToday().slice(0, 8) + '01';
  const monthEnd = () => { const d = new Date(monthStart() + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().slice(0, 10); };
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined && v !== null)).toString();
  const openPrint = (path, params) => window.open(`${path}?${qs({ ...params, company: state.company.id })}`, '_blank', 'noopener');
  const xlsx = (path, params, name) => download(`${path}?${qs(params)}`, name).catch((e) => toast(e.message, 'error'));

  async function view(main, week) {
    const w = await api(`/api/reports/weekly?${qs({ week: week || riyadhToday() })}`);
    const co = state.company.name_ar;
    main.innerHTML = workspaceHead('التقارير') + `
      <div class="card stack" style="margin-bottom:18px">
        <div class="spread" style="flex-wrap:wrap;gap:10px">
          <div><h2 style="margin:0">التقرير الأسبوعي للفريق</h2>
            <span class="small muted">الأسبوع من الأحد ${dmy(w.from)} إلى السبت ${dmy(w.to)} · ${esc(co)}</span></div>
          <div class="row" style="flex-wrap:wrap">
            <button class="btn small" id="wk-prev">‹ الأسبوع السابق</button>
            <input type="date" id="wk-date" value="${w.from}" style="max-width:160px">
            <button class="btn small" id="wk-next" ${w.to >= riyadhToday() ? 'disabled' : ''}>الأسبوع التالي ›</button>
            <button class="btn" id="wk-xlsx">Excel</button><button class="btn primary" id="wk-pdf">PDF</button>
          </div>
        </div>
        <div class="grid cols-4" style="gap:10px">
          ${[['عملية في المنصة', w.totals.actions], ['موظف شارك', w.totals.people], ['مهمة أُنجزت', w.totals.done_tasks], ['مهمة مفتوحة', w.totals.open_tasks], ['متأخرة', w.totals.overdue]]
            .map(([l, v], i) => `<div class="card stat"><span class="muted small">${l}</span><span class="num" ${i === 4 && v ? 'style="color:var(--danger)"' : ''}>${v}</span></div>`).join('')}
        </div>
        <h3 style="margin:8px 0 0">ماذا أنجز كل موظف</h3>
        ${w.people.length ? `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>عدد العمليات</th><th>مهام أنجزها</th><th>التوزيع حسب الأداة</th><th></th></tr></thead><tbody>
          ${w.people.map((p, i) => `<tr><td><b>${esc(p.user)}</b></td><td>${p.total}</td><td>${p.done_tasks}</td>
            <td class="small">${Object.entries(p.by_source).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ')}</td>
            <td><button class="btn small" data-person="${i}">التفاصيل</button></td></tr>
            <tr data-detail="${i}" hidden><td colspan="5"><div class="table-wrap"><table><thead><tr><th>الوقت</th><th>الأداة</th><th>العملية</th><th>على</th><th>التفاصيل</th></tr></thead><tbody>
              ${p.items.map((it) => `<tr><td class="small ltr">${esc(it.at)}</td><td class="small">${esc(it.source_label)}</td><td>${esc(it.action)}</td><td>${esc(it.subject)}</td><td class="small" style="white-space:normal">${esc(it.detail)}</td></tr>`).join('')}
            </tbody></table></div></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">لا توجد عمليات مسجلة في هذا الأسبوع.</div>'}
        <h3 style="margin:8px 0 0">المهام المفتوحة حسب المسؤول <span class="small muted" style="font-weight:400">(متابعة الإجراءات، حتى اليوم)</span></h3>
        ${w.owners.length ? `<div class="table-wrap"><table><thead><tr><th>المسؤول</th><th>مهام مفتوحة</th><th>منها متأخرة</th></tr></thead><tbody>
          ${w.owners.map((o) => `<tr><td>${esc(o.owner)}</td><td>${o.open}</td><td>${o.overdue ? `<span style="color:var(--danger)">${o.overdue}</span>` : 0}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">لا توجد مهام مفتوحة.</div>'}
      </div>

      <h2 style="margin:6px 0 12px">تقارير أخرى</h2>
      <div class="grid cols-2">
        <div class="card stack"><h3>دليل الموظفين</h3>
          <label class="field"><span>الحالة</span><select id="emp-status"><option value="">الكل</option><option value="active">نشط</option><option value="onboarding">قيد الانضمام</option><option value="offboarding">قيد إنهاء الخدمة</option><option value="inactive">منتهي الخدمة</option></select></label>
          <div class="row"><button class="btn" id="emp-xlsx">Excel</button><button class="btn primary" id="emp-pdf">PDF</button></div></div>
        <div class="card stack"><h3>المباشرون والمنتهية خدماتهم</h3>
          <div class="form-grid"><label class="field"><span>من</span><input type="date" id="mv-from" value="${monthStart()}"></label><label class="field"><span>إلى</span><input type="date" id="mv-to" value="${monthEnd()}"></label></div>
          <div class="row"><button class="btn" id="mv-xlsx">Excel</button><button class="btn primary" id="mv-pdf">PDF</button></div></div>
        <div class="card stack"><h3>سجل نشاط المنصة</h3><span class="small muted">كل عملية: من قام بها، ومتى، وعلى ماذا.</span>
          <div class="form-grid"><label class="field"><span>من</span><input type="date" id="ac-from" value="${monthStart()}"></label><label class="field"><span>إلى</span><input type="date" id="ac-to" value="${riyadhToday()}"></label></div>
          <div class="row"><button class="btn" id="ac-xlsx">Excel</button></div></div>
        <div class="card stack"><h3>تقارير الأدوات</h3><span class="small muted">تقارير تفصيلية من داخل كل أداة:</span>
          <a href="#/air-tickets/reports">تذاكر الطيران ← التقارير (Excel)</a>
          <a href="#/attestations/reports">تصديقات الغرفة التجارية ← التقارير</a>
          <a href="#/procedures">متابعة الإجراءات ← تصدير Excel</a>
          <a href="#/consulting">الاستشاريون والعقود ← لوحة المتابعة</a></div>
      </div>
      <p class="small muted" style="margin-top:14px">PDF: تفتح صفحة التقرير في نافذة جديدة، ثم اختر «حفظ بتنسيق PDF» من نافذة الطباعة.</p>`;

    const go = (d) => view(main, d);
    $('#wk-prev').addEventListener('click', () => go(addDays(w.from, -7)));
    $('#wk-next').addEventListener('click', () => go(addDays(w.from, 7)));
    $('#wk-date').addEventListener('change', (e) => e.target.value && go(e.target.value));
    $('#wk-xlsx').addEventListener('click', () => xlsx('/api/reports/weekly.xlsx', { week: w.from }, `التقرير الأسبوعي ${co} ${w.from}.xlsx`));
    $('#wk-pdf').addEventListener('click', () => openPrint('/api/reports/weekly/print', { week: w.from }));
    $$('[data-person]').forEach((b) => b.addEventListener('click', () => { const r = $(`[data-detail="${b.dataset.person}"]`); r.hidden = !r.hidden; b.textContent = r.hidden ? 'التفاصيل' : 'إخفاء'; }));
    const st = () => $('#emp-status').value;
    $('#emp-xlsx').addEventListener('click', () => xlsx('/api/reports/employees.xlsx', { status: st() }, `دليل الموظفين ${co}.xlsx`));
    $('#emp-pdf').addEventListener('click', () => openPrint('/api/reports/employees/print', { status: st() }));
    const mv = () => ({ from: $('#mv-from').value, to: $('#mv-to').value });
    $('#mv-xlsx').addEventListener('click', () => xlsx('/api/reports/movements.xlsx', mv(), `المباشرون والمنتهية خدماتهم ${co}.xlsx`));
    $('#mv-pdf').addEventListener('click', () => openPrint('/api/reports/movements/print', mv()));
    $('#ac-xlsx').addEventListener('click', () => xlsx('/api/reports/activity.xlsx', { from: $('#ac-from').value, to: $('#ac-to').value }, `سجل النشاط ${co}.xlsx`));
  }
  return { view };
}
