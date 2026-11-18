// HC Operations Hub — client shell. The server decides which company's data is
// returned (from the session); the page only displays it and always declares
// which company it believes is active via the X-Company-Id header.

import { createConsultingViews } from './consulting.js';
import { createAttestationViews } from './attestations.js';
import { createAirTicketViews } from './airtickets.js';
import { createProcedureViews } from './procedures.js';
import { createTemplateMappingUI } from './template-mapping.js';
import { createEmployeeViews } from './employees.js';
import { createReportViews } from './reports.js';

const state = { session: null, company: null };
const app = document.getElementById('app');

// ---------- utils ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
// SQLite stores UTC; show Riyadh local time.
const fmtTime = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { timeZone: 'Asia/Riyadh', dateStyle: 'short', timeStyle: 'short' }) : '');
const isAdmin = () => state.session?.user.role === 'admin';

let toastTimer;
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

class ApiError extends Error {
  constructor(status, body) { super(body?.error || 'خطأ'); this.status = status; this.code = body?.code; this.details = body?.details; }
}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'X-Requested-With': 'hub' };
  if (state.company) headers['X-Company-Id'] = String(state.company.id);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, { error: 'تعذّر الاتصال بالمنصة. تأكد أنها تعمل ثم أعد المحاولة.' });
  }
  if (res.ok) return raw ? res : res.json();
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { state.session = null; renderLogin(); throw new ApiError(401, data); }
  if (data.code === 'password_change_required') { await loadSession(); renderShell(); throw new ApiError(403, data); }
  if (data.code === 'company_changed') {
    toast('تم تغيير الشركة المختارة من نافذة أخرى، تم تحديث العرض.');
    await loadSession();
    renderShell();
    throw new ApiError(409, data);
  }
  throw new ApiError(res.status, data);
}

const fileToUpload = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ filename: file.name, data: String(r.result).split(',')[1] });
  r.onerror = reject;
  r.readAsDataURL(file);
});

async function blobUrl(path) {
  const res = await api(path, { raw: true });
  return URL.createObjectURL(await res.blob());
}

// Readable text colour on top of the brand colour.
function onColor(hex) {
  if (!hex) return '#ffffff';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111111' : '#ffffff';
}

// ---------- branding ----------
function applyBrand(company) {
  const root = document.documentElement.style;
  const c = company?.colors || {};
  const set = (k, v) => (v ? root.setProperty(k, v) : root.removeProperty(k));
  set('--brand', c.primary);
  set('--brand-2', c.secondary || c.primary);
  set('--brand-3', c.accent || c.secondary || c.primary);
  set('--brand-ink', c.ink);
  set('--on-brand', onColor(c.primary));
  // each company's own Arabic font (see styles.css: :root[data-co])
  if (company?.code) document.documentElement.dataset.co = company.code; else delete document.documentElement.dataset.co;
  document.title = company ? `HC Operations Hub — ${company.name_en}` : 'HC Operations Hub';
}

const logoImg = (company, cls = 'brand-logo') =>
  company?.logo_url
    ? `<img class="${cls}" src="${esc(company.logo_url)}" alt="${esc(company.name_ar)}">`
    : `<span class="brand-fallback">${esc(company?.name_ar || '')}</span>`;

// ---------- icons ----------
const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  employees: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.5 0 4.2 1.6 4.6 4.5"/>',
  consulting_contracts: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  tickets: '<path d="M3 8a2 2 0 0 0 0 4v4h18v-4a2 2 0 0 1 0-4V4H3z" transform="translate(0 2)"/><path d="M14 6v14" stroke-dasharray="2 2"/>',
  attestations: '<circle cx="12" cy="10" r="6"/><path d="M9 10l2 2 4-4M8.5 15.5L7 22l5-3 5 3-1.5-6.5"/>',
  bank_accounts: '<path d="M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18"/>',
  attestations: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><circle cx="12" cy="14" r="3"/><path d="M10.5 16.5 9.5 20l2.5-1 2.5 1-1-3.5"/>',
  backup: '<path d="M12 3v12M7 10l5 5 5-5M4 17v3h16v-3"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  procedures: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12l2 2 4-4M9 17h6"/>',
  'air-tickets': '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  consulting: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h4"/><path d="M14 3v5h5"/>',
  contracts: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h4"/><path d="M14 3v5h5"/>',
  consultants: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21c.6-4 3.4-6 7-6s6.4 2 7 6"/><path d="M12 15l-1.5 3 1.5 2 1.5-2z"/>',
  letters: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  brand: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1.3"/><circle cx="12" cy="7.5" r="1.3"/><circle cx="15.5" cy="10" r="1.3"/><path d="M12 21a3 3 0 0 1 0-6h2"/>',
  template: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 11h7M9 15h7M9 7h3"/>',
  stamp: '<path d="M9 3h6l-1 8h-4zM5 15h14v3H5zM4 21h16"/>',
  companies: '<path d="M4 21V5l8-3v19M12 9l8 3v9M8 8v.01M8 12v.01M8 16v.01M16 15v.01M16 18v.01"/>',
  users: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ''}</svg>`;

// ---------- session ----------
async function loadSession() {
  const s = await api('/api/session');
  state.session = s;
  state.company = s.companies.find((c) => c.id === s.current_company_id) || null;
  applyBrand(state.company);
  return s;
}

async function switchCompany(id) {
  if (id === state.company?.id) return;
  await api('/api/session/company', { method: 'POST', body: { company_id: id } });
  await loadSession();
  renderShell();
  toast(`تم الانتقال إلى مساحة عمل ${state.company.name_ar}`);
}

// ---------- login ----------
function renderLogin() {
  applyBrand(null);
  app.innerHTML = `
    <div class="login-wrap">
      <form class="card login-card stack" id="login">
        <div>
          <h1>HC Operations Hub</h1>
          <p class="muted small" style="margin:0">منصة عمليات رأس المال البشري</p>
        </div>
        <label class="field">اسم المستخدم<input type="text" name="username" autocomplete="username" dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <label class="field">كلمة المرور<input type="password" name="password" id="login-pw" autocomplete="current-password" dir="ltr" autocapitalize="off" autocorrect="off" spellcheck="false" required></label>
        <label class="small muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="login-show"> إظهار كلمة المرور</label>
        <p class="error-text" id="login-err" hidden></p>
        <button class="btn primary" type="submit">تسجيل الدخول</button>
      </form>
    </div>`;
  $('#login-show').addEventListener('change', (e) => { $('#login-pw').type = e.target.checked ? 'text' : 'password'; });
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const username = String(fd.get('username') || '').trim();
    const password = String(fd.get('password') || '').trim();
    try {
      await api('/api/login', { method: 'POST', body: { username, password } });
      await loadSession();
      renderShell();
    } catch (err) {
      let msg = err.message;
      // Arabic letters in the name/password almost always mean the keyboard was on Arabic
      if (err.status === 401 && /[؀-ۿ]/.test(username + password)) msg += ' يبدو أن لوحة المفاتيح على اللغة العربية — حوّلها إلى الإنجليزية وأعد الكتابة.';
      const el = $('#login-err'); el.textContent = msg; el.hidden = false;
    }
  });
}

// ---------- shell ----------
function navItems() {
  const ents = state.session.entities;
  const items = [
    { section: 'مساحة العمل' },
    { href: '#/', key: 'home', label: 'الرئيسية' },
    ...Object.keys(ents).flatMap((k) => {
      const item = { href: `#/records/${k}`, key: k, label: ents[k].label };
      return k === 'consultants' ? [{ href: '#/consulting', key: 'consulting', label: 'إدارة الاستشاريين والعقود الاستشارية' }] : [item];
    }),
    { href: '#/procedures', key: 'procedures', label: 'متابعة إجراءات الموظفين' },
    { href: '#/air-tickets', key: 'air-tickets', label: 'تذاكر الطيران' },
    { href: '#/attestations', key: 'attestations', label: 'تصديقات الغرفة التجارية' },
    { href: '#/letters', key: 'letters', label: 'إصدار الخطابات' },
    { href: '#/reports', key: 'reports', label: 'التقارير' },
  ];
  if (isAdmin()) {
    items.push(
      { section: 'الإدارة' },
      { href: '#/admin/team', key: 'employees', label: 'فريق الإدارة' },
      { href: '#/admin/branding', key: 'brand', label: 'هوية الشركة' },
      { href: '#/admin/templates', key: 'template', label: 'نماذج المستندات' },
      { href: '#/admin/assets', key: 'stamp', label: 'التواقيع والأختام' },
      { href: '#/admin/letter-types', key: 'list', label: 'أنواع الخطابات' },
      { href: '#/admin/companies', key: 'companies', label: 'الشركات' },
      { href: '#/admin/users', key: 'users', label: 'المستخدمون' },
      { href: '#/admin/backup', key: 'backup', label: 'النسخ الاحتياطي' },
    );
  }
  return items;
}

function switcherHtml() {
  const cs = state.session.companies;
  if (cs.length <= 1) return '';
  // Segmented buttons for a few companies, a dropdown when the list grows.
  if (cs.length > 4) {
    return `<div class="switcher"><label class="switcher-label" for="co-select">الشركة</label>
      <select id="co-select">${cs.map((c) => `<option value="${c.id}" ${c.id === state.company?.id ? 'selected' : ''}>${esc(c.name_ar)} — ${esc(c.name_en)}</option>`).join('')}</select></div>`;
  }
  return `<div class="switcher" role="group" aria-label="اختيار الشركة">
    <span class="switcher-label">الشركة</span>
    <div class="switcher-options">
      ${cs.map((c) => `<button type="button" class="switch-opt" data-company="${c.id}" aria-pressed="${c.id === state.company?.id}" title="${esc(c.name_en)}">
        ${c.logo_url ? `<img src="${esc(c.logo_url)}" alt="">` : ''}<span>${esc(c.name_ar)}</span></button>`).join('')}
    </div></div>`;
}

// Change own password. forced = after a temporary password (nothing else is allowed until it is changed).
function passwordForm(forced) {
  const body = `${forced ? '<p class="notice small" style="margin:0 0 12px">هذه كلمة مرور مؤقتة. اختر كلمة مرور خاصة بك للمتابعة.</p>' : ''}
    <form id="pw-form" class="stack">
      <label class="field">كلمة المرور الحالية${forced ? ' (المؤقتة)' : ''}<input type="password" name="current" dir="ltr" autocomplete="current-password" required></label>
      <label class="field">كلمة المرور الجديدة<input type="password" name="next" dir="ltr" autocomplete="new-password" minlength="10" required></label>
      <label class="field">تأكيد كلمة المرور الجديدة<input type="password" name="again" dir="ltr" autocomplete="new-password" required></label>
      <label class="small muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pw-show"> إظهار كلمات المرور</label>
      <p class="small muted" style="margin:0">١٠ أحرف على الأقل، فيها حروف إنجليزية وأرقام.</p>
      <p class="error-text" id="pw-err" hidden></p>
      <button class="btn primary" type="submit">حفظ كلمة المرور</button>
    </form>`;
  return body;
}
function bindPasswordForm(root, onDone) {
  $('#pw-show', root).addEventListener('change', (e) => $$('input[type=password], input[data-pw]', root).forEach((i) => { i.dataset.pw = 1; i.type = e.target.checked ? 'text' : 'password'; }));
  $('#pw-form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target; const err = $('#pw-err', root);
    if (f.next.value !== f.again.value) { err.textContent = 'كلمتا المرور الجديدتان غير متطابقتين.'; err.hidden = false; return; }
    try { await api('/api/account/password', { method: 'POST', body: { current_password: f.current.value, new_password: f.next.value } }); onDone(); }
    catch (x) { err.textContent = x.message; err.hidden = false; }
  });
}
function renderForcedPassword() {
  applyBrand(null);
  app.innerHTML = `<div class="login-wrap"><div class="card login-card stack" id="pw-card"><div><h1>مرحبًا ${esc(state.session.user.display_name)}</h1>
    <p class="muted small" style="margin:0">اسم المستخدم: <span dir="ltr">${esc(state.session.user.username)}</span></p></div>${passwordForm(true)}
    <button class="btn small" id="pw-logout" type="button">خروج</button></div></div>`;
  bindPasswordForm($('#pw-card'), async () => { await loadSession(); renderShell(); toast('تم حفظ كلمة المرور الجديدة'); });
  $('#pw-logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); state.session = null; renderLogin(); });
}

function renderShell() {
  if (!state.session) return renderLogin();
  if (state.session.user.must_change_password) return renderForcedPassword();
  const u = state.session.user;
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <div class="brand-block">
          ${state.company ? logoImg(state.company) : ''}
          <div class="platform-name"><b>HC Operations Hub</b><span>منصة عمليات رأس المال البشري</span></div>
        </div>
        ${switcherHtml()}
        <div class="user-block">
          <span class="small">${esc(u.display_name)}</span>
          <span class="role-badge ${u.role === 'admin' ? 'admin' : ''}">${u.role === 'admin' ? 'مسؤول' : 'الفريق'}</span>
          <button class="btn small" id="my-pw" type="button">كلمة المرور</button>
          <button class="btn small" id="logout" type="button">خروج</button>
        </div>
      </div>
      <div class="brand-stripe"></div>
    </header>
    <div class="layout">
      <aside class="sidebar"><nav class="nav" aria-label="القائمة الرئيسية">
        ${navItems().map((i) => (i.section ? `<div class="nav-section">${i.section}</div>` : `<a href="${i.href}" data-key="${i.key}">${icon(i.key)}<span>${esc(i.label)}</span></a>`)).join('')}
      </nav></aside>
      <main id="main"></main>
    </div>`;

  $$('.switch-opt').forEach((b) => b.addEventListener('click', () => switchCompany(Number(b.dataset.company)).catch((e) => toast(e.message, 'error'))));
  $('#co-select')?.addEventListener('change', (e) => switchCompany(Number(e.target.value)).catch((err) => toast(err.message, 'error')));
  $('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); state.session = null; state.company = null; renderLogin(); });
  $('#my-pw').addEventListener('click', () => { const d = openModal('تغيير كلمة المرور', passwordForm(false), ''); bindPasswordForm(d, () => { d.close(); toast('تم حفظ كلمة المرور الجديدة. أُخرجت الأجهزة الأخرى من حسابك.'); }); });
  renderRoute();
}

const routeParts = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

function renderRoute() {
  const main = $('#main');
  if (!main) return;
  const [a, b, c] = routeParts();
  $$('.nav a').forEach((el) => { const h = el.getAttribute('href'); el.classList.toggle('active', h === '#/' + [a, b].filter(Boolean).join('/') || ((a === 'contracts' || a === 'consulting' || (a === 'records' && b === 'consultants')) && h === '#/consulting') || (a === 'attestations' && h === '#/attestations') || (a === 'air-tickets' && h === '#/air-tickets') || (a === 'procedures' && h === '#/procedures') || (a === 'reports' && h === '#/reports') || (!a && h === '#/')); });
  if (!state.company) { main.innerHTML = '<div class="card empty">لا توجد شركة متاحة لحسابك. تواصل مع مسؤول النظام.</div>'; return; }
  const view =
    !a ? viewDashboard :
    a === 'records' && b === 'employees' ? () => ev().directory(main, c) :
    a === 'records' ? () => viewRecords(b) :
    a === 'letters' ? viewLetters :
    a === 'consulting' ? () => cc().hub(main, b, c) :
    a === 'contracts' ? (b ? () => cc().viewContract(main, b) : () => cc().hub(main, 'contracts')) :
    a === 'records' && b === 'consultants' ? () => cc().hub(main, 'consultants') :
    a === 'attestations' ? () => av().view(main, b) :
    a === 'air-tickets' ? () => tv().view(main, b, c) :
    a === 'procedures' ? () => pv().view(main, b, c) :
    a === 'reports' ? () => rv().view(main, b) :
    a === 'admin' ? (isAdmin() ? ADMIN_VIEWS[b] : () => (main.innerHTML = '<div class="card empty">هذه الصفحة متاحة لحساب المسؤول فقط.</div>')) :
    null;
  if (!view) { main.innerHTML = '<div class="card empty">الصفحة غير موجودة.</div>'; return; }
  Promise.resolve(view(main)).catch((e) => { if (e.code !== 'company_changed') main.innerHTML = `<div class="card error-text">${esc(e.message)}</div>`; });
}

const workspaceHead = (title, actions = '') => `
  <div class="workspace-head">
    <div><div class="crumb">مساحة عمل ${esc(state.company.name_ar)} · ${esc(state.company.name_en)}</div><h1>${esc(title)}</h1></div>
    <div class="row">${actions}</div>
  </div>`;

const companyBanner = (verb = 'سيُحفظ هذا السجل في') => `
  <div class="company-banner">${state.company.logo_url ? `<img src="${esc(state.company.logo_url)}" alt="">` : ''}
    <div>${verb} شركة: <b>${esc(state.company.name_ar)}</b> <span class="muted small">(${esc(state.company.name_en)})</span></div></div>`;

// ---------- dashboard ----------
// Greeting by Riyadh time: «صباح الخير» until noon, then «مساء الخير».
const riyadhHour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Riyadh', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const greeting = () => { const h = riyadhHour(); return h >= 4 && h < 12 ? 'صباح الخير' : 'مساء الخير'; };
const todayLine = () => {
  const d = new Date();
  const g = new Intl.DateTimeFormat('ar-SA-u-ca-gregory-nu-arab', { timeZone: 'Asia/Riyadh', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  const h = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', { timeZone: 'Asia/Riyadh', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  return `${g} · ${h}`;
};
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const dayBox = (d) => (d ? `<div class="home-date"><b>${Number(d.slice(8, 10))}</b><span>${MONTHS_AR[Number(d.slice(5, 7)) - 1]}</span></div>` : '<div class="home-date"><b>—</b></div>');
let greetTimer;

async function viewDashboard(main) {
  const [h] = await Promise.all([api('/api/home')]);
  const u = state.session.user;
  const firstName = h.greeting_name || String(u.display_name || '').split(' ')[0];
  const n = h.counts;
  const WHEN = { late: ['var(--red)', 'متأخرة'], today: ['var(--amber)', 'اليوم'], week: ['var(--muted)', 'هذا الأسبوع'], later: ['var(--border)', 'لاحقًا'] };
  const taskRows = (list) => (list.length ? list.map((t) => `<a class="home-row" href="${t.link}" style="--c:${WHEN[t.when][0]}"><span class="bar"></span>
      <div><div class="t">${esc(t.title)}</div><div class="s">${esc(t.sub)}${t.date ? ` · ${esc(t.date.split('-').reverse().join('/'))}` : ''}</div></div><span class="go">${esc(t.action)}</span></a>`).join('')
    : '<div class="home-row"><span class="muted small">لا توجد مهام هنا. 👌</span></div>');
  const prog = (p) => (p && p.total ? `${p.finished} من ${p.total} خطوات` : '');
  const sumLine = [n.tasks_today ? `<b>${n.tasks_today} ${n.tasks_today === 1 ? 'مهمة' : 'مهام'}</b> تحتاج انتباهك اليوم` : 'لا توجد مهام عاجلة اليوم',
    n.starters_upcoming > 0 ? `و<b>${n.starters_upcoming}</b> يباشرون خلال الأيام القادمة` : ''].filter(Boolean).join('، ');
  const q = (href, label, ico, main_ = false) => `<a href="${href}" ${main_ ? 'class="main"' : ''}>${icon(ico)}${label}</a>`;

  main.innerHTML = `<div class="home">
    <div class="home-hello"><h1 id="greet">${greeting()}، ${esc(firstName)}</h1>
      <p class="when">${esc(todayLine())} · ${esc(state.company.name_ar)}</p><p class="sum">${sumLine}.</p></div>
    <nav class="home-quick" aria-label="إجراءات سريعة">
      ${q('#/procedures/new', 'موظف جديد', 'employees', true)}${q('#/letters', 'إصدار خطاب', 'letters')}${q('#/air-tickets', 'صرف تذكرة', 'air-tickets')}
      ${q('#/attestations', 'تسجيل تصديق', 'attestations')}${q('#/consulting/contracts', 'العقود الاستشارية', 'consulting')}${q('#/reports', 'التقارير', 'reports')}
    </nav>
    <h2>هذا الشهر <small>${MONTHS_AR[Number(h.month.from.slice(5, 7)) - 1]}</small></h2>
    <section class="home-nums">
      <a href="#starters"><div class="l">يباشرون هذا الشهر</div><div class="v">${n.starters}</div><div class="s">${n.starters_started} باشروا · ${n.starters - n.starters_started} لم تُؤكَّد مباشرتهم بعد</div></a>
      <a href="#leavers"><div class="l">تنتهي خدماتهم</div><div class="v">${n.leavers}</div><div class="s">${h.leavers[0] ? `أقربها ${esc(h.leavers[0].last_day.split('-').reverse().join('/'))}` : 'لا يوجد'}</div></a>
      <a href="#/air-tickets"><div class="l">تذاكر مستحقة</div><div class="v">${n.tickets_due}</div><div class="s">تستحق خلال الشهر</div></a>
      <a href="#/consulting/deliverables"><div class="l">مخرجات استشارية مستحقة</div><div class="v">${n.deliverables_due}</div><div class="s">${n.deliverables_late ? `${n.deliverables_late} متأخر` : 'لا يوجد متأخر'}</div></a>
    </section>
    <section class="home-cols">
      <div>
        <h2>مهام للإجراء <small>${h.tasks.length} مهمة</small></h2>
        <div class="home-tabs" id="task-tabs">
          ${[['all', 'الكل', h.tasks.length], ['late', 'متأخرة', h.tasks.filter((t) => t.when === 'late').length], ['today', 'اليوم', h.tasks.filter((t) => t.when === 'today').length], ['week', 'هذا الأسبوع', h.tasks.filter((t) => t.when === 'week').length]]
            .map(([k, l, c], i) => `<button type="button" data-when="${k}" class="${i ? '' : 'on'}">${l} ${c}</button>`).join('')}
        </div>
        <div class="home-list" id="task-list">${taskRows(h.tasks)}</div>
      </div>
      <div>
        <div class="maha" aria-label="مها">
          <div class="maha-head"><div class="maha-av">م</div><div><b>مها</b><span>الموظفة الرقمية · الدعم والمساعدة</span></div><em>قريبًا</em></div>
          <p class="maha-msg">أهلًا ${esc(firstName)}! أنا مها 👋 قريبًا تقدر تسألني عن أي شيء في المنصة.</p>
          <div class="maha-chips"><span>كيف أصدر خطاب تعريف؟</span><span>المخرجات المستحقة خلال ٣٠ يومًا</span><span>من يباشر هذا الأسبوع؟</span></div>
          <div class="maha-input">اكتب سؤالك لمها… <span class="small">قريبًا</span></div>
        </div>
        <h2 id="starters">المباشرون هذا الشهر<a href="#/procedures/cases">الكل</a></h2>
        <div class="home-list">${h.starters.length ? h.starters.map((s) => `<a class="home-row" href="${s.case_id ? `#/procedures/case/${s.case_id}` : '#/records/employees'}">${dayBox(s.hire_date)}
          <div><div class="t">${esc(s.full_name_ar)}</div><div class="s">${esc([s.job_title, prog(s.progress)].filter(Boolean).join(' · ') || '—')}</div></div>
          <span class="tag ${s.started ? 'ok' : ''}">${s.started ? 'باشر' : s.awaiting_confirmation ? 'بانتظار التأكيد' : 'قادم'}</span></a>`).join('') : '<div class="home-row"><span class="muted small">لا يوجد مباشرون هذا الشهر.</span></div>'}</div>
        <h2 id="leavers" style="margin-top:22px">تنتهي خدماتهم هذا الشهر</h2>
        <div class="home-list">${h.leavers.length ? h.leavers.map((s) => `<a class="home-row" href="${s.case_id ? `#/procedures/case/${s.case_id}` : '#/records/employees'}">${dayBox(s.last_day)}
          <div><div class="t">${esc(s.full_name_ar)}</div><div class="s">${esc([s.job_title, prog(s.progress)].filter(Boolean).join(' · ') || '—')}</div></div>
          <span class="tag">${s.status === 'inactive' ? 'انتهت' : 'قيد الإنهاء'}</span></a>`).join('') : '<div class="home-row"><span class="muted small">لا يوجد.</span></div>'}</div>
      </div>
    </section>
    <details class="home-more"><summary>تفاصيل الأدوات (العقود، التصديقات، التذاكر، الإجراءات)</summary><div id="home-tools"></div></details>
  </div>`;
  $$('#task-tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('#task-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $('#task-list').innerHTML = taskRows(b.dataset.when === 'all' ? h.tasks : h.tasks.filter((t) => t.when === b.dataset.when));
  }));
  $$('.home-nums a[href^="#starters"], .home-nums a[href^="#leavers"]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); document.getElementById(a.getAttribute('href').slice(1))?.scrollIntoView({ behavior: 'smooth' }); }));
  clearInterval(greetTimer);
  greetTimer = setInterval(() => { const g = document.getElementById('greet'); if (!g) return clearInterval(greetTimer); g.textContent = `${greeting()}، ${firstName}`; }, 60000);
  // the tools' own dashboards stay available, folded, and load only when opened
  const more = $('.home-more');
  more.addEventListener('toggle', async () => {
    if (!more.open || more.dataset.loaded) return;
    more.dataset.loaded = '1';
    await toolDashboards($('#home-tools'));
  });
}

async function toolDashboards(main) {
  const follow = document.createElement('div');
  main.appendChild(follow);
  await cc().dashboardSection(follow);
  const att = document.createElement('div');
  main.appendChild(att);
  await av().dashboardSection(att);
  const air = document.createElement('div');
  main.appendChild(air);
  await tv().dashboardSection(air);
  const proc = document.createElement('div');
  main.appendChild(proc);
  await pv().dashboardSection(proc);
}

// Consulting views are created lazily so they can use the helpers below.
let ccViews;
let attViews;
let airViews;
let procViews;
let tmUI;
let empViews;
let repViews;
const rv = () => (repViews ||= createReportViews({ api, esc, $, $$, toast, workspaceHead, download, state }));
const ev = () => (empViews ||= createEmployeeViews({ api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, fmtTime, openRecordForm, state, fileToUpload }));
const tm = () => (tmUI ||= createTemplateMappingUI({ api, esc, $, $$, toast, openModal, companyBanner, download, fmtTime }));
const pv = () => (procViews ||= createProcedureViews({ api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, state }));
const tv = () => (airViews ||= createAirTicketViews({ api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, state }));
const av = () => (attViews ||= createAttestationViews({ api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, state }));
const cc = () => (ccViews ||= createConsultingViews({ api, esc, $, $$, toast, openModal, workspaceHead, companyBanner, download, fmtTime, openRecordForm, state, fileToUpload }));

// ---------- generic records ----------
function cellValue(f, row) {
  const v = row[f.name];
  if (f.type === 'ref') return esc(row[`${f.name}__label`] ?? '—');
  if (v === null || v === undefined || v === '') return '<span class="muted">—</span>';
  if (f.type === 'select') return esc(f.options.find(([k]) => k === v)?.[1] ?? v);
  if (f.type === 'checkbox') return v ? '<span class="pill ok">نعم</span>' : '<span class="muted">—</span>';
  if (f.type === 'iban') return `<span class="ltr">•••• ${esc(String(v).slice(-4))}</span>`;
  if (f.type === 'number') return `<span class="ltr">${Number(v).toLocaleString('en-US')}</span>`;
  if (f.type === 'date') return `<span class="ltr">${esc(v)}</span>`;
  return esc(v);
}

async function viewRecords(entity, main = $('#main')) {
  const meta = state.session.entities[entity];
  if (!meta) { main.innerHTML = '<div class="card empty">نوع السجل غير معروف.</div>'; return; }
  main.innerHTML = workspaceHead(meta.label, `<button class="btn primary" id="add">+ إضافة ${esc(meta.singular)}</button>`) + `
    <div class="toolbar"><input type="search" id="q" placeholder="بحث…" style="max-width:320px"></div>
    <div class="table-wrap" id="tbl"><div class="empty">جارٍ التحميل…</div></div>`;
  const fields = meta.list.map((n) => meta.fields.find((f) => f.name === n));
  const load = async () => {
    const { rows } = await api(`/api/records/${entity}?q=${encodeURIComponent($('#q').value)}`);
    $('#tbl').innerHTML = rows.length
      ? `<table><thead><tr>${fields.map((f) => `<th>${esc(f.label)}</th>`).join('')}<th></th></tr></thead><tbody>
          ${rows.map((r) => `<tr>${fields.map((f) => `<td>${cellValue(f, r)}</td>`).join('')}<td><button class="btn small" data-edit="${r.id}">تعديل</button></td></tr>`).join('')}
        </tbody></table>`
      : `<div class="empty">لا توجد سجلات في ${esc(state.company.name_ar)} بعد.</div>`;
    $$('[data-edit]').forEach((b) => b.addEventListener('click', async () => openRecordForm(entity, await api(`/api/records/${entity}/${b.dataset.edit}`), load)));
  };
  let t; $('#q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
  $('#add').addEventListener('click', () => openRecordForm(entity, null, load));
  await load();
}

async function fieldInput(f, value) {
  const req = f.required ? 'required' : '';
  const v = value ?? f.default ?? '';
  switch (f.type) {
    case 'textarea': return `<textarea name="${f.name}" ${req}>${esc(v)}</textarea>`;
    case 'select': return `<select name="${f.name}" ${req}><option value="">—</option>${f.options.map(([k, l]) => `<option value="${esc(k)}" ${k === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    case 'checkbox': return `<input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}>`;
    case 'date': return `<input type="date" name="${f.name}" value="${esc(v)}" ${req}>`;
    case 'number': return `<input type="number" step="any" name="${f.name}" value="${esc(v)}" ${req} class="ltr">`;
    case 'iban': return `<input type="text" name="${f.name}" value="${esc(v)}" ${req} class="ltr" placeholder="SA00 0000 0000 0000 0000 0000">`;
    case 'ref': {
      // Options come from the same company only (server-scoped list).
      const { rows } = await api(`/api/records/${f.ref}`);
      const labelField = f.ref === 'employees' ? 'full_name_ar' : 'id';
      return `<select name="${f.name}" ${req}><option value="">—</option>${rows.map((r) => `<option value="${r.id}" ${r.id === value ? 'selected' : ''}>${esc(r[labelField])}${r.employee_no ? ' · ' + esc(r.employee_no) : ''}</option>`).join('')}</select>`;
    }
    default: return `<input type="text" name="${f.name}" value="${esc(v)}" ${req}>`;
  }
}

function openModal(title, bodyHtml, footHtml) {
  const d = document.createElement('dialog');
  d.innerHTML = `<form method="dialog" class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" aria-label="إغلاق">×</button></form>
    <div class="modal-body">${bodyHtml}</div><div class="modal-foot">${footHtml}</div>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

async function openRecordForm(entity, record, onSaved) {
  const meta = state.session.entities[entity];
  const company = state.company;
  const inputs = await Promise.all(meta.fields.map((f) => fieldInput(f, record?.[f.name])));
  const body = `${companyBanner(record ? 'هذا السجل تابع لـ' : 'سيُحفظ هذا السجل في')}
    <form id="rec-form" class="form-grid">
      ${meta.fields.map((f, i) => f.type === 'checkbox'
        ? `<label class="check full">${inputs[i]} ${esc(f.label)}</label>`
        : `<label class="field ${f.type === 'textarea' ? 'full' : ''}"><span>${esc(f.label)} ${f.required ? '<span class="req">*</span>' : ''}</span>${inputs[i]}</label>`).join('')}
    </form><p class="error-text" id="rec-err" hidden></p>`;
  const d = openModal(record ? `تعديل ${meta.singular}` : `إضافة ${meta.singular}`, body,
    `<button class="btn primary" form="rec-form" type="submit">حفظ في ${esc(company.name_ar)}</button><button class="btn" type="button" data-close>إلغاء</button>`);
  $('[data-close]', d).addEventListener('click', () => d.close());
  $('#rec-form', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of meta.fields) {
      const el = e.target.elements[f.name];
      data[f.name] = f.type === 'checkbox' ? el.checked : el.value;
    }
    try {
      if (record) await api(`/api/records/${entity}/${record.id}`, { method: 'PATCH', body: data });
      else await api(`/api/records/${entity}`, { method: 'POST', body: data });
      d.close();
      toast(`تم الحفظ في ${company.name_ar}`);
      onSaved?.();
    } catch (err) {
      if (err.code === 'company_changed') return d.close();
      const el = $('#rec-err', d); el.textContent = err.message; el.hidden = false;
      // a number already used by another employee: offer to open that record
      if (err.code === 'employee_no_taken' && err.details?.employee_id) {
        el.insertAdjacentHTML('beforeend', ` <a href="#/records/employees/${Number(err.details.employee_id)}">فتح السجل الموجود</a>`);
        $('a', el).addEventListener('click', () => d.close());
      }
    }
  });
}

// ---------- letters (all users) ----------
async function download(path, filename) {
  const a = document.createElement('a');
  a.href = await blobUrl(path);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

const IMG_LABEL = { logo: 'شعار الشركة', signature: 'التوقيع المعتمد', stamp: 'الختم المعتمد' };

async function viewLetters(main) {
  const [cat, emps, issued] = await Promise.all([api('/api/letters/catalog'), api('/api/records/employees'), api('/api/letters/issued')]);
  const co = state.company;
  main.innerHTML = workspaceHead('إصدار الخطابات') + `
    <div class="grid cols-2">
      <form class="card stack" id="letter-form">
        ${companyBanner('سيُصدر الخطاب باسم')}
        <label class="field">نوع الخطاب
          <select name="letter_type_id" required><option value="">اختر…</option>
          ${cat.types.map((t) => `<option value="${t.id}" ${t.template ? '' : 'disabled'}>${esc(t.name_ar)}${t.template ? '' : ' — لا يوجد نموذج معتمد'}</option>`).join('')}</select></label>
        <div id="tpl-info" class="small muted"></div>
        <label class="field">الموظف (من ${esc(co.name_ar)} فقط)
          <select name="employee_id" required><option value="">اختر…</option>
          ${emps.rows.map((e) => `<option value="${e.id}">${esc(e.full_name_ar)}${e.employee_no ? ' · ' + esc(e.employee_no) : ''}</option>`).join('')}</select></label>
        <div id="addressee" class="form-grid" hidden>
          <label class="field" data-ph="addressee_ar">الجهة الموجّه إليها (عربي)<input type="text" name="addressee_ar" placeholder="مثال: بنك …"></label>
          <label class="field" data-ph="addressee_en">الجهة الموجّه إليها (إنجليزي)<input type="text" name="addressee_en" class="ltr" placeholder="e.g. … Bank"></label>
        </div>
        <fieldset id="identity" class="stack" style="border:1px solid var(--border);border-radius:8px;padding:12px" hidden>
          <legend class="small muted">إضافات الهوية المعتمدة لـ ${esc(co.name_ar)}</legend>
          <div id="identity-opts" class="stack"></div>
        </fieldset>
        <p class="error-text" id="letter-err" hidden></p>
        <div class="row"><button class="btn" type="submit">معاينة البيانات</button></div>
      </form>
      <div class="card stack" id="letter-result">
        <h2>المعاينة</h2>
        <p class="muted small">اختر نوع الخطاب والموظف ثم اضغط «معاينة البيانات» لعرض القيم التي ستُكتب في نموذج ${esc(co.name_ar)} المعتمد قبل الإصدار.</p>
      </div>
    </div>
    <h2 style="margin:24px 0 10px">الخطابات الصادرة — ${esc(co.name_ar)}</h2>
    <div class="table-wrap">${issued.length ? `<table><thead><tr><th>رقم الخطاب</th><th>النوع</th><th>الموظف</th><th>النموذج</th><th>أصدره</th><th>التاريخ</th><th></th></tr></thead><tbody>
      ${issued.map((l) => `<tr><td class="ltr">${esc(l.reference_no)}</td><td>${esc(l.letter_type)}</td><td>${esc(l.employee)}</td><td>v${l.template_version}</td>
        <td>${esc(l.issued_by || '')}</td><td class="ltr small">${esc(fmtTime(l.issued_at))}</td>
        <td><button class="btn small" data-dl="${l.id}" data-name="${esc(`${l.letter_type} - ${l.employee}.docx`)}">تنزيل</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty">لم يُصدر أي خطاب بعد.</div>'}</div>`;

  $$('[data-dl]').forEach((b) => b.addEventListener('click', () => download(`/api/letters/issued/${b.dataset.dl}/file`, b.dataset.name).catch((e) => toast(e.message, 'error'))));

  const form = $('#letter-form');
  const result = $('#letter-result');
  const currentType = () => cat.types.find((x) => x.id === Number(form.letter_type_id.value));
  const resetResult = () => { result.innerHTML = '<h2>المعاينة</h2><p class="muted small">اضغط «معاينة البيانات» لعرض القيم قبل الإصدار.</p>'; };

  const assetSelect = (name, list) => list.length > 1
    ? `<select name="${name}">${list.map((s) => `<option value="${s.id}">${esc(s.label)}${s.signatory_name ? ' — ' + esc(s.signatory_name) : ''}</option>`).join('')}</select>` : '';

  form.letter_type_id.addEventListener('change', () => {
    const t = currentType();
    resetResult();
    const ph = new Set(t?.template?.placeholders || []);
    $('#tpl-info').innerHTML = t?.template ? `النموذج المعتمد: <b>${esc(t.template.original_name)}</b> · الإصدار ${t.template.version}` : '';
    $('#addressee').hidden = !(ph.has('addressee_ar') || ph.has('addressee_en'));
    $$('#addressee [data-ph]').forEach((el) => (el.hidden = !ph.has(el.dataset.ph)));
    const avail = { logo: cat.has_logo, signature: cat.signatures.length > 0, stamp: cat.stamps.length > 0 };
    const keys = ['logo', 'signature', 'stamp'].filter((k) => ph.has(k));
    $('#identity').hidden = !keys.length;
    $('#identity-opts').innerHTML = keys.map((k) => `
      <label class="check"><input type="checkbox" name="include_${k}" ${avail[k] ? 'checked' : 'disabled'}> ${IMG_LABEL[k]}
        ${avail[k] ? '' : '<span class="muted small">(لم يُرفع بعد — تواصل مع المسؤول)</span>'}</label>
      ${k === 'signature' && avail.signature ? assetSelect('signature_id', cat.signatures) : ''}
      ${k === 'stamp' && avail.stamp ? assetSelect('stamp_id', cat.stamps) : ''}`).join('');
  });
  form.employee_id.addEventListener('change', resetResult);

  const payload = () => ({
    letter_type_id: Number(form.letter_type_id.value),
    employee_id: Number(form.employee_id.value),
    addressee_ar: form.addressee_ar.value, addressee_en: form.addressee_en.value,
    include_logo: !!form.include_logo?.checked, include_signature: !!form.include_signature?.checked, include_stamp: !!form.include_stamp?.checked,
    signature_id: form.signature_id ? Number(form.signature_id.value) : undefined,
    stamp_id: form.stamp_id ? Number(form.stamp_id.value) : undefined,
  });

  async function runPreview() {
    const err = $('#letter-err'); err.hidden = true;
    try {
      const r = await api('/api/letters/preview', { method: 'POST', body: payload() });
      const ok = r.missing.length === 0;
      result.innerHTML = `
        <div class="spread"><h2>المعاينة</h2>${ok ? '<span class="pill ok">جاهز للإصدار</span>' : `<span class="pill" style="color:var(--danger)">بيانات ناقصة: ${r.missing.length}</span>`}</div>
        <dl class="kv">
          <dt>الشركة</dt><dd>${esc(r.company.name_ar)}</dd>
          <dt>نوع الخطاب</dt><dd>${esc(r.letter_type.name_ar)}</dd>
          <dt>النموذج</dt><dd>${esc(r.template.file)} · الإصدار ${r.template.version}</dd>
          ${r.images.map((i) => `<dt>${esc(i.label)}</dt><dd>${i.included ? 'يُضاف' : 'لا يُضاف'}</dd>`).join('')}
        </dl>
        <div class="table-wrap"><table><tbody>
          ${r.fields.map((f) => `<tr><td class="muted small">${esc(f.label)}</td><td>${f.missing ? '<span class="error-text">ناقص</span>' : esc(f.value)}</td></tr>`).join('')}
        </tbody></table></div>
        ${ok ? '' : `<div class="notice">أكمل البيانات الناقصة قبل الإصدار. ${r.fields.some((f) => f.missing && !f.key.startsWith('addressee')) ? '<button class="btn small" type="button" id="edit-emp">تعديل بيانات الموظف</button>' : ''}</div>`}
        <div class="row"><button class="btn primary" type="button" id="issue" ${ok ? '' : 'disabled'}>إصدار الخطاب وتنزيله</button></div>`;
      $('#edit-emp')?.addEventListener('click', async () => openRecordForm('employees', await api(`/api/records/employees/${r.employee.id}`), runPreview));
      $('#issue')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const out = await api('/api/letters/issue', { method: 'POST', body: payload() });
          await download(`/api/letters/issued/${out.id}/file`, out.filename);
          toast(`تم إصدار الخطاب ${out.reference_no}`);
          viewLetters(main);
        } catch (e2) {
          e.target.disabled = false;
          if (e2.code !== 'company_changed') toast(e2.message, 'error');
        }
      });
    } catch (e) {
      if (e.code !== 'company_changed') { err.textContent = e.message; err.hidden = false; }
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); runPreview(); });
}

// ---------- admin views ----------
const ADMIN_VIEWS = {
  // Full backup: download now, or a key for the automatic weekly download on the Admin's computer.
  async backup(main) {
    const st = await api('/api/admin/backup/status');
    main.innerHTML = workspaceHead('النسخ الاحتياطي', '<button class="btn primary" id="bk-now">تنزيل نسخة كاملة الآن</button>') + `
      <div class="grid cols-2">
        <div class="card stack"><h2>ماذا تحتوي النسخة؟</h2>
          <p style="margin:0">ملف واحد (.zip) فيه كل بيانات المنصة لكل الشركات، وكل الملفات المرفوعة (الشعارات، النماذج، التواقيع، الشهادات).</p>
          <p class="small muted" style="margin:0">بهذا الملف تُستعاد المنصة كما هي في أي مكان: هذا الجهاز أو جهاز آخر أو خادم. احفظه في مكان آمن، ففيه كل البيانات.</p></div>
        <div class="card stack"><h2>التنزيل التلقائي الأسبوعي</h2>
          ${st.key ? `<p style="margin:0"><span class="pill ok">مفعّل</span> أُنشئ المفتاح ${esc(fmtTime(st.key.created_at))}${st.key.created_by ? ` بواسطة ${esc(st.key.created_by)}` : ''}.</p>
            <p class="small" style="margin:0">آخر تنزيل تلقائي: ${st.key.last_used_at ? `<b>${esc(fmtTime(st.key.last_used_at))}</b>` : '<span class="muted">لم يتم بعد</span>'}</p>`
          : '<p class="muted" style="margin:0">غير مفعّل. أنشئ مفتاحًا وضعه في أداة النسخ على جهازك.</p>'}
          <p class="small muted" style="margin:0">المفتاح يسمح بتنزيل النسخة فقط — لا يدخل المنصة ولا يغيّر شيئًا. إنشاء مفتاح جديد يلغي القديم.</p>
          <div class="row"><button class="btn" id="bk-key">${st.key ? 'مفتاح جديد' : 'إنشاء مفتاح'}</button>${st.key ? '<button class="btn" id="bk-revoke">إلغاء المفتاح</button>' : ''}</div></div>
      </div>`;
    $('#bk-now').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = 'جارٍ تجهيز النسخة…';
      try { await download('/api/admin/backup', `HC-backup-${new Date().toISOString().slice(0, 10)}.zip`); toast('تم تنزيل النسخة الكاملة'); }
      catch (err) { toast(err.message, 'error'); }
      finally { e.target.disabled = false; e.target.textContent = 'تنزيل نسخة كاملة الآن'; }
    });
    $('#bk-key').addEventListener('click', async () => {
      if (st.key && !confirm('إنشاء مفتاح جديد يوقف المفتاح الحالي، ويجب وضع الجديد في أداة النسخ على جهازك. متابعة؟')) return;
      try {
        const r = await api('/api/admin/backup/key', { method: 'POST' });
        const d = openModal('مفتاح النسخ الاحتياطي', `<p>انسخ المفتاح وضعه في أداة النسخ التلقائي على جهازك. <b>لن يظهر مرة أخرى.</b></p>
          <textarea readonly dir="ltr" style="min-height:70px;font-family:monospace" id="bk-k">${esc(r.key)}</textarea>`,
          '<button class="btn" type="button" data-copy>نسخ</button><button class="btn primary" type="button" data-close>تم</button>');
        $('[data-copy]', d).addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.key); toast('تم النسخ'); } catch { $('#bk-k', d).select(); } });
        $('[data-close]', d).addEventListener('click', () => d.close());
        d.addEventListener('close', () => ADMIN_VIEWS.backup(main));
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#bk-revoke')?.addEventListener('click', async () => {
      if (!confirm('إلغاء المفتاح يوقف التنزيل التلقائي. متابعة؟')) return;
      try { await api('/api/admin/backup/key/revoke', { method: 'POST' }); ADMIN_VIEWS.backup(main); } catch (err) { toast(err.message, 'error'); }
    });
  },

  // Department staff (per company) who can be made responsible for tasks — the same list feeds
  // the «المسؤول» choice in employee procedures (and any later tool that assigns a person).
  async team(main) {
    const [members, users] = await Promise.all([api('/api/procedures/lists').then((l) => l.members), api('/api/admin/users')]);
    const active = members.filter((m) => m.is_active);
    const me = state.session.user;
    const linkedIds = new Set(members.filter((m) => m.user_id).map((m) => m.user_id));
    const accountCell = (m) => {
      if (!m.user_id) return `<span class="muted small">لا يوجد</span>
        <div class="row" style="margin-top:4px"><button class="btn small primary" data-acc-new="${m.id}">إنشاء حساب</button><button class="btn small" data-acc-link="${m.id}">ربط بحساب موجود</button></div>`;
      const isMe = m.user_id === me.id;
      return `<span class="ltr">${esc(m.username)}</span> ${m.account_role === 'admin' ? '<span class="role-badge admin">مسؤول</span>' : ''}
        ${m.account_role !== 'admin' ? (m.account_active ? '<span class="pill ok">الدخول مفعّل</span>' : '<span class="pill">الدخول موقوف</span>') : ''}
        <div class="row" style="margin-top:4px">${m.account_role !== 'admin' ? `<button class="btn small" data-acc-reset="${m.user_id}">كلمة مرور مؤقتة جديدة</button>
          <button class="btn small" data-acc-active="${m.user_id}" data-on="${m.account_active ? 1 : 0}">${m.account_active ? 'إيقاف الدخول' : 'تفعيل الدخول'}</button>` : ''}
          <button class="btn small" data-acc-unlink="${m.id}">${isMe ? 'فك الربط بحسابي' : 'فك الربط'}</button></div>`;
    };
    main.innerHTML = workspaceHead('فريق الإدارة', '<button class="btn primary" id="tm-add">+ إضافة موظف</button>') + `
      ${companyBanner('قائمة فريق')}
      <p class="small muted" style="margin:-4px 0 14px">أسماء موظفي الإدارة الذين يمكن تعيينهم مسؤولين عن المهام. تظهر هذه الأسماء في خانة «المسؤول» في متابعة إجراءات الموظفين، وفي أي مهمة تحتاج مسؤولًا. الموقوف لا يظهر في الاختيار، ويبقى اسمه على المهام السابقة.</p>
      <div class="notice small" style="margin-bottom:14px">لكل موظف حساب دخول خاص به، فيظهر في السجلات والتقارير من قام بكل عملية. كل حسابات الفريق بنفس الصلاحية: استخدام جميع الأدوات وإضافة البيانات. أما الإعدادات والسياسات والنماذج والحسابات فهي لحساب المسؤول فقط.
        ${members.some((m) => m.user_id === me.id) ? '' : '<br>لإضافة نفسك إلى الفريق: أضف اسمك ثم اضغط «ربط بحساب موجود» واختر حسابك.'}</div>
      ${members.length ? `<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>المسمى الوظيفي</th><th>حساب الدخول</th><th>مهام مفتوحة مسندة إليه</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${members.map((m) => `<tr style="${m.is_active ? '' : 'opacity:.55'}"><td><b>${esc(m.name)}</b>${m.user_id === me.id ? ' <span class="small muted">(أنت)</span>' : ''}</td><td>${esc(m.job_title || '—')}</td><td>${accountCell(m)}</td>
          <td>${m.open_tasks ? `<a href="#/procedures">${m.open_tasks} مهمة</a>` : '<span class="muted">لا يوجد</span>'}</td>
          <td>${m.is_active ? '<span class="pill ok">نشط</span>' : '<span class="pill">موقوف</span>'}</td>
          <td class="row" style="justify-content:flex-end"><button class="btn small" data-tm-edit="${m.id}">تعديل</button>
            <button class="btn small" data-tm-toggle="${m.id}">${m.is_active ? 'إيقاف' : 'تفعيل'}</button></td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted">${active.length} نشط من أصل ${members.length}.</p>` : `<div class="card empty">لا يوجد أعضاء في فريق ${esc(state.company.name_ar)} بعد. أضف أسماء موظفي الإدارة ليتمكن الفريق من تعيين مسؤول لكل مهمة.</div>`}`;
    const reload = () => ADMIN_VIEWS.team(main);
    const form = (m) => {
      const d = openModal(m ? `تعديل — ${m.name}` : 'إضافة موظف إلى فريق الإدارة', `${companyBanner(m ? 'هذا الاسم ضمن فريق' : 'سيُضاف إلى فريق')}
        <form id="tm-form" class="form-grid">
          <label class="field"><span>الاسم <span class="req">*</span></span><input type="text" name="name" value="${esc(m?.name || '')}" required maxlength="200"></label>
          <label class="field"><span>المسمى الوظيفي (اختياري)</span><input type="text" name="job_title" value="${esc(m?.job_title || '')}" maxlength="200"></label>
        </form><p class="error-text" id="tm-err" hidden></p>`,
        '<button class="btn primary" form="tm-form" type="submit">حفظ</button><button class="btn" type="button" data-close>إلغاء</button>');
      $('[data-close]', d).addEventListener('click', () => d.close());
      $('#tm-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = { name: e.target.name.value, job_title: e.target.job_title.value };
        try {
          await api(m ? `/api/admin/procedures/members/${m.id}` : '/api/admin/procedures/members', { method: m ? 'PATCH' : 'POST', body });
          d.close(); toast(m ? 'تم الحفظ' : 'تمت الإضافة'); reload();
        } catch (err) { if (err.code === 'company_changed') return d.close(); const x = $('#tm-err', d); x.textContent = err.message; x.hidden = false; }
      });
    };
    // shows a temporary password once, to hand over to the employee (it is not stored readable anywhere)
    const showTemp = (title, r) => {
      const d = openModal(title, `<p>سلّم هذه البيانات للموظف. كلمة المرور مؤقتة، وسيُطلب منه تغييرها عند أول دخول. <b>لن تظهر مرة أخرى.</b></p>
        <dl class="kv"><dt>اسم المستخدم</dt><dd class="ltr">${esc(r.username)}</dd><dt>كلمة المرور المؤقتة</dt><dd class="ltr" style="font-size:18px;letter-spacing:1px"><b>${esc(r.temporary_password)}</b></dd></dl>`,
        '<button class="btn" type="button" data-copy>نسخ</button><button class="btn primary" type="button" data-close>تم</button>');
      $('[data-copy]', d).addEventListener('click', async () => { try { await navigator.clipboard.writeText(`اسم المستخدم: ${r.username}\nكلمة المرور المؤقتة: ${r.temporary_password}`); toast('تم النسخ'); } catch { toast('تعذّر النسخ', 'error'); } });
      $('[data-close]', d).addEventListener('click', () => d.close());
      d.addEventListener('close', reload);
    };
    $$('[data-acc-new]').forEach((b) => b.addEventListener('click', () => {
      const m = members.find((x) => x.id === Number(b.dataset.accNew));
      const d = openModal(`حساب دخول — ${m.name}`, `<form id="acc-form" class="stack">
          <label class="field"><span>اسم المستخدم (بالإنجليزي) <span class="req">*</span></span><input type="text" name="username" dir="ltr" autocapitalize="off" spellcheck="false" required pattern="[a-zA-Z0-9][a-zA-Z0-9._\\-]{2,39}" placeholder="مثال: sara.ahmed"></label>
          <p class="small muted" style="margin:0">سيصل الموظف إلى ${esc(state.company.name_ar)} بصلاحية الفريق. تُنشأ له كلمة مرور مؤقتة تظهر لك مرة واحدة.</p>
        </form><p class="error-text" id="acc-err" hidden></p>`,
        '<button class="btn primary" form="acc-form" type="submit">إنشاء الحساب</button><button class="btn" type="button" data-close>إلغاء</button>');
      $('[data-close]', d).addEventListener('click', () => d.close());
      $('#acc-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        try { const r = await api(`/api/admin/team/${m.id}/account`, { method: 'POST', body: { username: e.target.username.value } }); d.close(); showTemp(`تم إنشاء حساب ${m.name}`, r); }
        catch (err) { const x = $('#acc-err', d); x.textContent = err.message; x.hidden = false; }
      });
    }));
    $$('[data-acc-link]').forEach((b) => b.addEventListener('click', () => {
      const m = members.find((x) => x.id === Number(b.dataset.accLink));
      const choices = users.filter((u) => !linkedIds.has(u.id) && u.username !== 'hcteam');
      const d = openModal(`ربط ${m.name} بحساب موجود`, choices.length ? `<form id="lk-form" class="stack"><label class="field"><span>الحساب</span><select name="user_id">
          ${choices.map((u) => `<option value="${u.id === me.id ? 'me' : u.id}">${esc(u.display_name)} — ${esc(u.username)}${u.id === me.id ? ' (حسابي)' : ''}</option>`).join('')}</select></label>
          <p class="small muted" style="margin:0">مثلًا: نفس الموظف في الشركة الأخرى، أو حسابك أنت لتظهر ضمن الفريق وتُسند إليك المهام.</p></form><p class="error-text" id="lk-err" hidden></p>`
        : '<p class="muted">لا توجد حسابات متاحة للربط.</p>',
        `${choices.length ? '<button class="btn primary" form="lk-form" type="submit">ربط</button>' : ''}<button class="btn" type="button" data-close>إلغاء</button>`);
      $('[data-close]', d).addEventListener('click', () => d.close());
      $('#lk-form', d)?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try { await api(`/api/admin/team/${m.id}/link`, { method: 'POST', body: { user_id: e.target.user_id.value } }); d.close(); toast('تم الربط'); reload(); }
        catch (err) { const x = $('#lk-err', d); x.textContent = err.message; x.hidden = false; }
      });
    }));
    $$('[data-acc-unlink]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('فك ربط الحساب بهذا الاسم؟ الحساب نفسه لا يُحذف.')) return;
      try { await api(`/api/admin/team/${b.dataset.accUnlink}/unlink`, { method: 'POST' }); reload(); } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-acc-reset]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('إنشاء كلمة مرور مؤقتة جديدة؟ ستتوقف كلمة المرور الحالية ويُخرج الموظف من المنصة.')) return;
      try { showTemp('كلمة مرور مؤقتة جديدة', await api(`/api/admin/users/${b.dataset.accReset}/reset-password`, { method: 'POST' })); } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-acc-active]').forEach((b) => b.addEventListener('click', async () => {
      const on = b.dataset.on === '1';
      if (on && !confirm('إيقاف دخول هذا الموظف؟ سيُخرج من المنصة فورًا، وتبقى سجلاته كما هي.')) return;
      try { await api(`/api/admin/users/${b.dataset.accActive}/active`, { method: 'POST', body: { is_active: !on } }); reload(); } catch (err) { toast(err.message, 'error'); }
    }));
    $('#tm-add').addEventListener('click', () => form(null));
    $$('[data-tm-edit]').forEach((b) => b.addEventListener('click', () => form(members.find((m) => m.id === Number(b.dataset.tmEdit)))));
    $$('[data-tm-toggle]').forEach((b) => b.addEventListener('click', async () => {
      const m = members.find((x) => x.id === Number(b.dataset.tmToggle));
      if (m.is_active && m.open_tasks && !confirm(`${m.name} مسؤول عن ${m.open_tasks} مهمة مفتوحة. إيقافه لا يزيل اسمه منها، لكنه لن يظهر في الاختيار للمهام الجديدة. متابعة؟`)) return;
      try { await api(`/api/admin/procedures/members/${m.id}`, { method: 'PATCH', body: { is_active: !m.is_active } }); reload(); } catch (err) { toast(err.message, 'error'); }
    }));
  },

  async branding(main) {
    const companies = await api('/api/admin/companies');
    const c = companies.find((x) => x.id === state.company.id);
    const slots = [['primary', 'اللون الأساسي'], ['secondary', 'اللون الثانوي'], ['accent', 'اللون المميز'], ['ink', 'لون العناوين']];
    main.innerHTML = workspaceHead('هوية الشركة') + `
      ${companyBanner('أنت تعدّل هوية')}
      <div class="grid cols-2">
        <div class="card stack">
          <h2>الشعار الرسمي</h2>
          <div class="logo-stage">${c.logo_url ? `<img src="${esc(c.logo_url)}" alt="">` : '<span class="muted">لم يُرفع شعار بعد</span>'}</div>
          <div class="row"><input type="file" id="logo-file" accept="image/png,image/jpeg,image/webp"><button class="btn primary" id="logo-up">رفع الشعار</button></div>
          <p class="muted small">PNG بخلفية شفافة مفضّل. يُستخدم الملف كما هو دون تعديل.</p>
        </div>
        <form class="card stack" id="colors">
          <h2>ألوان الهوية</h2>
          <p class="muted small">المصدر الحالي: ${esc(c.color_source || '—')}. اترك اللون «غير محدد» إذا لم يكن ضمن دليل الهوية.</p>
          <div class="swatches">${slots.map(([k, l]) => `
            <div class="swatch"><div class="chip" data-chip="${k}" style="${c.colors[k] ? `background:${c.colors[k]}` : ''}"></div>
              <b class="small">${l}</b>
              <input type="color" name="${k}" value="${c.colors[k] || '#ffffff'}" ${c.colors[k] ? '' : 'disabled'}>
              <label class="check small"><input type="checkbox" data-unset="${k}" ${c.colors[k] ? '' : 'checked'}> غير محدد</label>
              <code class="small ltr" data-hex="${k}">${c.colors[k] || '—'}</code></div>`).join('')}</div>
          <div class="row"><button class="btn primary" type="submit">حفظ الألوان</button></div>
        </form>
      </div>`;
    const form = $('#colors');
    const read = () => Object.fromEntries(slots.map(([k]) => [k, $(`[data-unset="${k}"]`).checked ? null : form[k].value.toUpperCase()]));
    const preview = () => {
      const v = read();
      slots.forEach(([k]) => { $(`[data-chip="${k}"]`).style.background = v[k] || ''; $(`[data-hex="${k}"]`).textContent = v[k] || '—'; form[k].disabled = !v[k]; });
      applyBrand({ ...state.company, colors: v });
    };
    form.addEventListener('input', preview);
    form.addEventListener('change', preview);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api(`/api/admin/companies/${c.id}`, { method: 'PATCH', body: { colors: read() } }); await loadSession(); renderShell(); toast('تم حفظ ألوان الهوية'); }
      catch (err) { toast(err.message, 'error'); }
    });
    $('#logo-up').addEventListener('click', async () => {
      const f = $('#logo-file').files[0];
      if (!f) return toast('اختر ملف الشعار أولًا', 'error');
      try { await api(`/api/admin/companies/${c.id}/logo`, { method: 'POST', body: { file: await fileToUpload(f) } }); await loadSession(); renderShell(); toast('تم تحديث الشعار'); }
      catch (err) { toast(err.message, 'error'); }
    });
  },

  async templates(main) {
    const [types, rows, phLetter, phContract, phCert, phReq] = await Promise.all([
      api('/api/admin/letter-types'), api('/api/admin/templates'),
      api('/api/letters/placeholders'), api('/api/letters/placeholders?category=contract'), api('/api/letters/placeholders?category=certificate'),
      api('/api/letters/placeholders?category=payment_request'),
    ]);
    const catalogs = { letter: phLetter, contract: phContract, certificate: phCert, payment_request: phReq };
    const labelOf = Object.fromEntries(Object.values(catalogs).flatMap((ph) => [...ph.text, ...ph.images]).map((p) => [p.key, p.label]));
    const chip = (k) => `<code class="pill ltr" title="${esc(labelOf[k.split(':')[0]] || '')}">{{${esc(k)}}}</code>`;
    const guide = (ph, title, note) => {
      const groups = [...new Set(ph.text.map((p) => p.group))];
      return `<details class="card" style="margin-bottom:12px"><summary><b>${title}</b></summary>
        <div class="stack" style="margin-top:12px">${note}
          ${[...groups.map((g) => [g, ph.text.filter((p) => p.group === g)]), ...(ph.images.length ? [['الصور', ph.images]] : [])].map(([g, list]) => `
            <div><h3 style="margin-bottom:6px">${esc(g)}</h3><div class="table-wrap"><table><tbody>
              ${list.map((p) => `<tr><td style="width:45%">${esc(p.label)}${p.date ? ' <span class="muted small">(يقبل أيضًا <span class="ltr">:dash</span> → 01-10-2026)</span>' : ''}</td><td><button type="button" class="btn small ltr" data-copy="{{${esc(p.key)}}}">{{${esc(p.key)}}}</button></td></tr>`).join('')}
            </tbody></table></div></div>`).join('')}
        </div></details>`;
    };
    const general = '<p class="small muted" style="margin:0">اكتب المواضع داخل ملف Word الرسمي في المكان الذي تريد أن تظهر فيه القيمة؛ يبقى نص النموذج وتصميمه وتنسيقه كما هو. مواضع الصور (الشعار/التوقيع/الختم) تُستبدل بالصورة المعتمدة عند تفعيلها وتُحذف إذا لم تُفعَّل. لا يُقبل نموذج يحتوي على موضع غير معروف لنوعه.</p>';
    const rowNote = '<p class="small muted" style="margin:0"><b>جدول المخرجات:</b> ضع مواضع <span class="ltr">{{d_…}}</span> في صف واحد من جدول الملحق، وسيتكرر ذلك الصف تلقائيًا لكل مخرج بنفس التنسيق.</p>';
    const SECTIONS = [
      ['letter', 'نماذج الخطابات', guide(phLetter, 'دليل مواضع الخطابات', general)],
      ['contract', 'نموذج العقد الاستشاري', guide(phContract, 'دليل مواضع العقد الاستشاري', general + rowNote)],
      ['certificate', 'نموذج شهادة إنجاز الخدمات الاستشارية', guide(phCert, 'دليل مواضع شهادة الإنجاز', general + '<p class="small muted" style="margin:0">تُصدر شهادة لكل مخرج على حدة. أسماء المعتمدين الثلاثة ومسمياتهم تُدخل عند كل إصدار؛ اترك خانات توقيعاتهم وتواريخ التوقيع في النموذج فارغة.</p>')],
      ['payment_request', 'نموذج طلب دفعة الاستشاري (Excel)', guide(phReq, 'دليل مواضع طلب الدفعة', '<p class="small muted" style="margin:0">اكتب المواضع داخل خلايا ملف Excel الرسمي؛ يبقى تصميم الملف وتنسيقه ومعادلاته كما هي. الخلية التي تحتوي على موضع مبلغ فقط تُكتب رقمًا لتعمل معادلات النموذج. لكل مخرج في الطلب سطر: <span class="ltr">{{item_1_…}}</span> ثم <span class="ltr">{{item_2_…}}</span> وهكذا، وتبقى الأسطر غير المستخدمة فارغة. عدد المعتمدين يُحدَّد من مواضع <span class="ltr">{{approver_N_name}}</span> الموجودة في النموذج.</p>')],
    ];
    main.innerHTML = workspaceHead('نماذج المستندات الرسمية') + companyBanner('النماذج أدناه خاصة بـ') + `
      ${SECTIONS.map(([cat, title, guideHtml]) => `<h2 style="margin:20px 0 10px">${title}</h2>${guideHtml}
      <div class="grid cols-2">${types.filter((t) => t.is_active && (t.category || 'letter') === cat).map((t) => {
        const versions = rows.filter((r) => r.letter_type_id === t.id);
        const active = versions.find((v) => v.is_active);
        const used = active ? JSON.parse(active.placeholders || '[]') : [];
        return `<div class="card stack">
          <div class="spread"><h2>${esc(t.name_ar)}</h2>${active ? `<span class="pill ok">معتمد · الإصدار ${active.version}</span>` : '<span class="pill off">لا يوجد نموذج</span>'}</div>
          ${active ? `<div class="small">${esc(active.original_name)} <span class="muted">· ${esc(fmtTime(active.created_at))}</span></div>
            <div class="row" style="gap:4px">${used.length ? used.map(chip).join('') : '<span class="notice small">النموذج لا يحتوي على أي موضع — سيُصدر بنص ثابت.</span>'}</div>` : t.category === 'certificate' && versions.length ? '<span class="notice small">لا يوجد إصدار معتمد. اضغط «مراجعة وإعداد» على الإصدار المرفوع: تظهر لك الخانات التي تحتاج موافقتك فقط، ثم التجربة والمعاينة، ثم الاعتماد.</span>' : ''}
          <div class="row"><input type="file" accept="${t.category === 'payment_request' ? '.xlsx' : '.docx'}" data-file="${t.id}"><button class="btn primary small" data-upload="${t.id}">${t.category === 'payment_request' ? 'رفع نموذج Excel' : t.category === 'certificate' ? 'رفع نموذج Word (مسودة)' : 'رفع نموذج Word'}</button></div>
          ${t.category === 'certificate' ? '<p class="small muted" style="margin:0">ارفع الشهادة الرسمية كما هي — حتى لو كانت مكتملة ببيانات — ثم اربط خاناتها من الشاشة دون تعديل Word، وجرّبها ببيانات وهمية، ثم اعتمدها. لا يُفعَّل أي نموذج شهادة تلقائيًا.</p>' : ''}
          ${t.category === 'certificate' && versions.length ? tm().versionsTable(versions) : versions.length ? `<details><summary class="small">سجل الإصدارات (${versions.length})</summary><table><tbody>
            ${versions.map((v) => `<tr><td>v${v.version}</td><td class="small">${esc(v.original_name)}</td>
              <td>${v.is_active ? '<span class="pill ok">نشط</span>' : `<button class="btn small" data-activate="${v.id}">اعتماد</button>`}</td>
              <td><button class="btn small" data-dl="${v.id}" data-name="${esc(v.original_name)}">تنزيل</button></td></tr>`).join('')}
          </tbody></table></details>` : ''}
        </div>`;
      }).join('')}</div>`).join('')}`;
    $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); toast(`تم النسخ: ${b.dataset.copy}`); } catch { toast(b.dataset.copy); }
    }));
    $$('[data-upload]').forEach((b) => b.addEventListener('click', async () => {
      const f = $(`[data-file="${b.dataset.upload}"]`).files[0];
      if (!f) return toast('اختر ملف النموذج أولًا', 'error');
      try {
        const r = await api('/api/admin/templates', { method: 'POST', body: { letter_type_id: Number(b.dataset.upload), file: await fileToUpload(f) } });
        if (r.draft) {
          toast(`أُضيف الإصدار ${r.version} كمسودة — اربط خاناته ثم جرّبه واعتمده`);
          await ADMIN_VIEWS.templates(main);
          $(`[data-tm-map="${r.template_id}"]`)?.click();
          return;
        }
        toast(`تم اعتماد الإصدار ${r.version} لـ ${state.company.name_ar} (${r.placeholders.length} موضع)`);
        ADMIN_VIEWS.templates(main);
      } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-activate]').forEach((b) => b.addEventListener('click', async () => { await api(`/api/admin/templates/${b.dataset.activate}/activate`, { method: 'POST' }); ADMIN_VIEWS.templates(main); }));
    tm().bind(main, () => ADMIN_VIEWS.templates(main));
    $$('[data-dl]').forEach((b) => b.addEventListener('click', () => download(`/api/admin/templates/${b.dataset.dl}/file`, b.dataset.name).catch((e) => toast(e.message, 'error'))));
  },

  async assets(main) {
    const rows = await api('/api/admin/assets');
    const section = (kind, title) => `
      <div class="card stack"><h2>${title}</h2>
        <div class="grid cols-3">${rows.filter((r) => r.kind === kind).map((r) => `
          <div class="stack" style="gap:6px"><div class="asset-thumb"><img data-asset="${r.id}" alt=""></div>
            <b class="small">${esc(r.label)}</b>${r.signatory_name ? `<span class="small muted">${esc(r.signatory_name)}${r.signatory_title ? ' — ' + esc(r.signatory_title) : ''}</span>` : ''}
            <label class="check small"><input type="checkbox" data-toggle="${r.id}" ${r.is_active ? 'checked' : ''}> معتمد</label></div>`).join('') || '<span class="muted small">لا يوجد</span>'}</div>
      </div>`;
    main.innerHTML = workspaceHead('التواقيع والأختام') + companyBanner('هذه العناصر خاصة بـ') + `
      <div class="stack">
        ${section('signature', 'التواقيع المعتمدة')}
        ${section('stamp', 'الأختام المعتمدة')}
        <form class="card stack" id="asset-form"><h2>رفع توقيع أو ختم</h2>
          <div class="form-grid">
            <label class="field">النوع<select name="kind"><option value="signature">توقيع</option><option value="stamp">ختم</option></select></label>
            <label class="field"><span>الوصف <span class="req">*</span></span><input type="text" name="label" required></label>
            <label class="field">اسم صاحب التوقيع<input type="text" name="signatory_name"></label>
            <label class="field">المسمى<input type="text" name="signatory_title"></label>
            <label class="field full">الملف (PNG بخلفية شفافة)<input type="file" name="file" accept="image/png,image/jpeg,image/webp" required></label>
          </div>
          <div class="row"><button class="btn primary" type="submit">رفع إلى ${esc(state.company.name_ar)}</button></div>
        </form>
      </div>`;
    $$('[data-asset]').forEach(async (img) => { img.src = await blobUrl(`/api/admin/assets/${img.dataset.asset}/file`); });
    $$('[data-toggle]').forEach((c) => c.addEventListener('change', () => api(`/api/admin/assets/${c.dataset.toggle}`, { method: 'PATCH', body: { is_active: c.checked } }).catch((e) => toast(e.message, 'error'))));
    $('#asset-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        await api('/api/admin/assets', { method: 'POST', body: { kind: f.kind.value, label: f.label.value, signatory_name: f.signatory_name.value, signatory_title: f.signatory_title.value, file: await fileToUpload(f.file.files[0]) } });
        toast('تم الرفع'); ADMIN_VIEWS.assets(main);
      } catch (err) { toast(err.message, 'error'); }
    });
  },

  async 'letter-types'(main) {
    const types = await api('/api/admin/letter-types');
    main.innerHTML = workspaceHead('أنواع الخطابات') + `
      <p class="muted small">أنواع الخطابات مشتركة بين جميع الشركات، ولكل شركة نموذج Word مستقل لكل نوع.</p>
      <div class="table-wrap"><table><thead><tr><th>الرمز</th><th>الاسم</th><th>بالإنجليزية</th></tr></thead><tbody>
        ${types.map((t) => `<tr><td class="ltr">${esc(t.code)}</td><td>${esc(t.name_ar)}</td><td class="ltr">${esc(t.name_en || '')}</td></tr>`).join('')}</tbody></table></div>
      <form class="card stack" id="lt-form" style="margin-top:16px"><h2>إضافة نوع</h2>
        <div class="form-grid"><label class="field">الرمز (إنجليزي)<input type="text" name="code" class="ltr" required></label>
        <label class="field">الاسم بالعربية<input type="text" name="name_ar" required></label>
        <label class="field">الاسم بالإنجليزية<input type="text" name="name_en" class="ltr"></label></div>
        <div class="row"><button class="btn primary">إضافة</button></div></form>`;
    $('#lt-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      try { await api('/api/admin/letter-types', { method: 'POST', body: { code: f.code.value, name_ar: f.name_ar.value, name_en: f.name_en.value } }); ADMIN_VIEWS['letter-types'](main); }
      catch (err) { toast(err.message, 'error'); }
    });
  },

  async companies(main) {
    const list = await api('/api/admin/companies');
    main.innerHTML = workspaceHead('الشركات') + `
      <p class="muted small">يمكن إضافة شركات جديدة دون تعديل الكود. بعد الإضافة انتقل إليها من قائمة الشركات لرفع شعارها ونماذجها.</p>
      <div class="table-wrap"><table><thead><tr><th>الشعار</th><th>الاسم</th><th>الرمز</th><th>الألوان</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${list.map((c) => `<tr>
          <td>${c.logo_url ? `<img src="${esc(c.logo_url)}" alt="" style="height:28px;max-width:100px;object-fit:contain">` : '<span class="muted small">—</span>'}</td>
          <td>${esc(c.name_ar)}<div class="muted small">${esc(c.name_en)}</div></td>
          <td class="ltr">${esc(c.code)}</td>
          <td><div class="row" style="gap:4px">${Object.values(c.colors).filter(Boolean).map((h) => `<span title="${h}" style="width:18px;height:18px;border-radius:4px;background:${h};border:1px solid var(--border);display:inline-block"></span>`).join('') || '<span class="muted small">غير محددة</span>'}</div></td>
          <td>${c.is_active ? '<span class="pill ok">نشطة</span>' : '<span class="pill off">موقوفة</span>'}</td>
          <td class="row" style="justify-content:flex-end"><button class="btn small" data-rename="${c.id}">تعديل الاسم</button>
            <button class="btn small" data-toggle="${c.id}" data-active="${c.is_active ? 1 : 0}">${c.is_active ? 'إيقاف' : 'تفعيل'}</button></td></tr>`).join('')}
      </tbody></table></div>
      <form class="card stack" id="co-form" style="margin-top:16px"><h2>إضافة شركة</h2>
        <div class="form-grid">
          <label class="field"><span>الاسم بالعربية <span class="req">*</span></span><input type="text" name="name_ar" required></label>
          <label class="field"><span>الاسم بالإنجليزية <span class="req">*</span></span><input type="text" name="name_en" class="ltr" required></label>
          <label class="field"><span>الرمز (إنجليزي صغير) <span class="req">*</span></span><input type="text" name="code" class="ltr" pattern="[a-z0-9]{2,32}" required></label>
          <label class="check"><input type="checkbox" name="grant" checked> إتاحتها لحساب الفريق المشترك</label>
        </div>
        <p class="muted small">الشعار والألوان تُضاف بعد الإنشاء من صفحة «هوية الشركة» — لا تُعيَّن ألوان افتراضية.</p>
        <div class="row"><button class="btn primary">إضافة الشركة</button></div></form>`;
    $$('[data-rename]').forEach((b) => b.addEventListener('click', () => {
      const c = list.find((x) => x.id === Number(b.dataset.rename));
      const d = openModal(`تعديل اسم الشركة — ${c.name_ar}`, `<form id="cn-form" class="form-grid">
          <label class="field"><span>الاسم بالعربية <span class="req">*</span></span><input type="text" name="name_ar" value="${esc(c.name_ar)}" required maxlength="120"></label>
          <label class="field"><span>الاسم بالإنجليزية <span class="req">*</span></span><input type="text" name="name_en" class="ltr" value="${esc(c.name_en)}" required maxlength="120"></label>
        </form><p class="small muted">الرمز (${esc(c.code)}) لا يتغير. الاسم الجديد يظهر في كل الصفحات والتقارير، ولا يغيّر الخطابات الصادرة سابقًا.</p><p class="error-text" id="cn-err" hidden></p>`,
        '<button class="btn primary" form="cn-form" type="submit">حفظ</button><button class="btn" type="button" data-close>إلغاء</button>');
      $('[data-close]', d).addEventListener('click', () => d.close());
      $('#cn-form', d).addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api(`/api/admin/companies/${c.id}`, { method: 'PATCH', body: { name_ar: e.target.name_ar.value, name_en: e.target.name_en.value } });
          d.close(); await loadSession(); renderShell(); toast('تم حفظ اسم الشركة');
        } catch (err) { const x = $('#cn-err', d); x.textContent = err.message; x.hidden = false; }
      });
    }));
    $$('[data-toggle]').forEach((b) => b.addEventListener('click', async () => {
      try { await api(`/api/admin/companies/${b.dataset.toggle}`, { method: 'PATCH', body: { is_active: b.dataset.active !== '1' } }); await loadSession(); renderShell(); }
      catch (err) { toast(err.message, 'error'); }
    }));
    $('#co-form').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = e.target;
      try {
        await api('/api/admin/companies', { method: 'POST', body: { name_ar: f.name_ar.value, name_en: f.name_en.value, code: f.code.value, grant_team_access: f.grant.checked } });
        await loadSession(); renderShell(); toast('تمت إضافة الشركة');
      } catch (err) { toast(err.message, 'error'); }
    });
  },

  async users(main) {
    const users = await api('/api/admin/users');
    main.innerHTML = workspaceHead('المستخدمون') + `
      <p class="small muted" style="margin:-4px 0 12px">حسابات الموظفين الشخصية تُنشأ من «فريق الإدارة». هنا يمكن إيقاف أي حساب فريق — ومنها الحساب المشترك — أو إنشاء كلمة مرور مؤقتة جديدة له.</p>
      <div class="table-wrap"><table><thead><tr><th>المستخدم</th><th>الاسم</th><th>الدور</th><th>الشركات المتاحة</th><th>الحالة</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr style="${u.is_active ? '' : 'opacity:.6'}"><td class="ltr">${esc(u.username)}</td><td>${esc(u.display_name)}</td>
          <td>${u.role === 'admin' ? '<span class="role-badge admin">مسؤول — إدارة الهوية والقوالب</span>' : '<span class="role-badge">الفريق — استخدام الأدوات فقط</span>'}</td>
          <td>${u.role === 'admin' ? 'جميع الشركات' : esc(u.companies || '—')}</td>
          <td>${u.is_active ? '<span class="pill ok">مفعّل</span>' : '<span class="pill">موقوف</span>'}</td>
          <td class="row" style="justify-content:flex-end">${u.role === 'admin' ? '<span class="small muted">غيّر كلمة مرورك من زر «كلمة المرور» أعلى الصفحة</span>'
            : `<button class="btn small" data-u-reset="${u.id}">كلمة مرور مؤقتة جديدة</button><button class="btn small" data-u-active="${u.id}" data-on="${u.is_active ? 1 : 0}">${u.is_active ? 'إيقاف' : 'تفعيل'}</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
    $$('[data-u-active]').forEach((b) => b.addEventListener('click', async () => {
      const on = b.dataset.on === '1';
      if (on && !confirm('إيقاف هذا الحساب؟ يُخرج من المنصة فورًا ولا يستطيع الدخول حتى تفعيله. سجلاته تبقى كما هي.')) return;
      try { await api(`/api/admin/users/${b.dataset.uActive}/active`, { method: 'POST', body: { is_active: !on } }); ADMIN_VIEWS.users(main); } catch (err) { toast(err.message, 'error'); }
    }));
    $$('[data-u-reset]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('إنشاء كلمة مرور مؤقتة جديدة؟ تتوقف كلمة المرور الحالية ويُخرج صاحب الحساب.')) return;
      try {
        const r = await api(`/api/admin/users/${b.dataset.uReset}/reset-password`, { method: 'POST' });
        const d = openModal('كلمة مرور مؤقتة جديدة', `<p>سلّمها لصاحب الحساب؛ سيُطلب منه تغييرها عند الدخول. <b>لن تظهر مرة أخرى.</b></p>
          <dl class="kv"><dt>اسم المستخدم</dt><dd class="ltr">${esc(r.username)}</dd><dt>كلمة المرور المؤقتة</dt><dd class="ltr" style="font-size:18px"><b>${esc(r.temporary_password)}</b></dd></dl>`,
          '<button class="btn primary" type="button" data-close>تم</button>');
        $('[data-close]', d).addEventListener('click', () => d.close());
      } catch (err) { toast(err.message, 'error'); }
    }));
  },
};

// ---------- boot ----------
window.addEventListener('hashchange', renderRoute);
// Keep tabs in sync: if the company was switched in another tab, refresh on focus.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.session) return;
  const before = state.company?.id;
  try { await loadSession(); } catch { return; }
  if (state.company?.id !== before) { renderShell(); toast(`الشركة المختارة الآن: ${state.company?.name_ar}`); }
});

// Web font: loaded without blocking the first paint (falls back to system Arabic fonts offline).
(() => {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap';
  document.head.appendChild(l);
})();

// Start-up: never leave a blank page. If the server cannot be reached (not
// running, or restarting) show a clear message and retry automatically.
function boot(attempt = 0) {
  loadSession().then(renderShell).catch((e) => {
    if (e.status === 401) return; // login screen already shown
    const offline = !e.status; // network error: the server is not reachable
    app.innerHTML = `<div class="login-wrap"><div class="card stack" style="text-align:center">
      ${offline ? `<b>تعذّر الاتصال بالمنصة</b><span class="small muted">تأكد أن المنصة تعمل (اختصار «تشغيل HC Operations Hub»). ستُعاد المحاولة تلقائيًا…</span>`
        : `<span class="error-text">${esc(e.message)}</span>`}
      <button class="btn" type="button" id="boot-retry">إعادة المحاولة الآن</button></div></div>`;
    $('#boot-retry')?.addEventListener('click', () => boot(0));
    if (offline) setTimeout(() => { if (!state.session) boot(attempt + 1); }, Math.min(10000, 2000 + attempt * 1000));
  });
}
boot();
