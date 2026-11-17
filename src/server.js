import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from './db.js';
import * as auth from './auth.js';
import { tenantRepo } from './tenancy.js';
import { ENTITIES, entityMeta } from './entities.js';
import { HttpError, mapDbError } from './errors.js';
import { saveFile, fromUpload, readFile, IMAGE_TYPES, DOCX_TYPES, XLSX_TYPES } from './files.js';
import { findXlsxPlaceholders, cleanXlsx } from './xlsx-fill.js';
import { createTemplateWorkflow } from './template-workflow.js';
import { createLetterService, analyzeTemplate, placeholderCatalog } from './letters.js';
import { cleanTemplate } from './docx/merge.js';
import { createConsultingService, CATALOG_BY_CATEGORY } from './consulting.js';
import { createAttestationService } from './attestations.js';
import { createAirTicketService } from './airtickets.js';
import { createProcedureService } from './procedures.js';
import { annotateEmployees, statusCounts, DISPLAY_STATUS } from './employees.js';
import { createEmployeeImport } from './employee-import.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEX = /^#[0-9A-Fa-f]{6}$/;
const MAX_BODY = 25 * 1024 * 1024;
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

// Validates an official Excel template: only known payment-request placeholders are accepted.
function analyzeXlsxTemplate(buffer, filename) {
  if (!/\.xlsx$/i.test(String(filename || ''))) throw new HttpError(400, 'نموذج طلب الدفعة يجب أن يكون ملف Excel بصيغة .xlsx.');
  let keys;
  try { keys = findXlsxPlaceholders(buffer); } catch { throw new HttpError(400, 'تعذّر قراءة ملف Excel. تأكد أنه بصيغة .xlsx سليمة.'); }
  const cat = CATALOG_BY_CATEGORY.payment_request;
  const known = new Set(cat.text.flatMap((p) => (p.date ? [p.key, `${p.key}:dash`] : [p.key])));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) throw new HttpError(400, `النموذج يحتوي على مواضع غير معروفة: ${unknown.map((k) => `{{${k}}}`).join('، ')}. راجع قائمة المواضع المتاحة لطلب الدفعة.`, 'unknown_placeholders');
  return keys;
}

export function createApp({ dbFile = path.join(ROOT, 'data', 'hub.db'), storageDir = path.join(ROOT, 'storage'), publicDir = path.join(ROOT, 'public') } = {}) {
  const db = openDb(dbFile);
  storageDir = path.resolve(storageDir);
  const routes = [];
  const letters = createLetterService(db, storageDir);
  const consulting = createConsultingService(db, storageDir);
  const attestations = createAttestationService(db);
  const airTickets = createAirTicketService(db);
  const procedures = createProcedureService(db);
  const employeeImport = createEmployeeImport(db);
  const templateFlow = createTemplateWorkflow(db, storageDir);

  // opts: { auth = true, admin = false, tenant = false }
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
    routes.push({ method, re, keys, opts, handler });
  };

  // ---------- helpers ----------
  const companyPublic = (c) => ({
    id: c.id, code: c.code, name_ar: c.name_ar, name_en: c.name_en,
    has_logo: !!c.logo_file_id,
    logo_url: c.logo_file_id ? `/api/companies/${c.id}/logo?v=${c.logo_file_id}` : null,
    colors: { primary: c.color_primary, secondary: c.color_secondary, accent: c.color_accent, ink: c.color_ink },
  });

  const companyById = (id) => db.prepare('SELECT * FROM companies WHERE id = ?').get(id);

  function resolveCompany(session) {
    const list = auth.accessibleCompanies(db, session.user);
    let current = list.find((c) => c.id === session.companyId) || null;
    if (!current && list.length) {
      current = list[0];
      db.prepare('UPDATE sessions SET company_id = ? WHERE id = ?').run(current.id, session.id);
      session.companyId = current.id;
    }
    return { list, current };
  }

  const colorOrNull = (v, label) => {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    if (!HEX.test(v)) throw new HttpError(400, `لون غير صالح في «${label}».`);
    return v.toUpperCase();
  };

  // ---------- session & company switching ----------
  route('POST', '/api/login', { auth: false }, ({ body, req, res }) => {
    // Spaces around the name or password (common when copying from INITIAL_CREDENTIALS.txt) are ignored;
    // platform passwords are generated from letters, digits, '-' and '_' and never contain spaces.
    const u = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(String(body?.username || '').trim());
    if (!u || !auth.verifyPassword(String(body?.password || '').trim(), u.password_hash)) throw new HttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة.');
    const sid = auth.createSession(db, u.id);
    res.setHeader('Set-Cookie', `${cookieName(req)}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
    return { ok: true };
  });

  route('POST', '/api/logout', {}, ({ session, req, res }) => {
    auth.destroySession(db, session.id);
    res.setHeader('Set-Cookie', `${cookieName(req)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  route('GET', '/api/session', {}, ({ session }) => {
    const { list, current } = resolveCompany(session);
    return {
      user: session.user,
      permissions: { manage_branding: session.user.role === 'admin' },
      companies: list.map(companyPublic),
      current_company_id: current?.id ?? null,
      entities: entityMeta(),
    };
  });

  route('POST', '/api/session/company', {}, ({ session, body }) => {
    const id = Number(body?.company_id);
    const { list } = resolveCompany(session);
    if (!list.some((c) => c.id === id)) throw new HttpError(403, 'لا تملك صلاحية الوصول إلى هذه الشركة.');
    db.prepare('UPDATE sessions SET company_id = ? WHERE id = ?').run(id, session.id);
    return { current_company_id: id };
  });

  route('GET', '/api/companies/:id/logo', {}, ({ session, params, res }) => {
    const { list } = resolveCompany(session);
    const c = list.find((x) => x.id === Number(params.id));
    if (!c || !c.logo_file_id) throw new HttpError(404, 'لا يوجد شعار.');
    const f = readFile(db, storageDir, c.id, c.logo_file_id);
    return sendFile(res, f, { cache: true });
  });

  // ---------- company-scoped records ----------
  route('GET', '/api/dashboard', { tenant: true }, ({ tenant }) => ({
    counts: Object.fromEntries(Object.keys(ENTITIES).map((k) => [k, tenant.count(k)])),
  }));

  route('GET', '/api/records/:entity', { tenant: true }, ({ tenant, params, query }) => {
    let rows = tenant.list(params.entity, { q: query.get('q') || '' });
    if (params.entity !== 'employees') return { rows };
    // the directory shows one status per employee: onboarding / active / offboarding / ended
    rows = annotateEmployees(db, tenant.companyId, rows);
    const st = query.get('status');
    if (st && DISPLAY_STATUS[st]) rows = rows.filter((r) => r.display_status === st);
    return { rows, counts: statusCounts(db, tenant.companyId), status_labels: DISPLAY_STATUS };
  });
  route('GET', '/api/records/:entity/:id', { tenant: true }, ({ tenant, params }) => {
    const row = tenant.get(params.entity, params.id);
    return params.entity === 'employees' ? annotateEmployees(db, tenant.companyId, [row])[0] : row;
  });
  route('GET', '/api/employees/:id/history', { tenant: true }, ({ tenant, params }) => {
    const e = tenant.get('employees', params.id); // 404 for another company's employee
    return {
      events: db.prepare(`SELECT ev.event, ev.detail, ev.changes_json, ev.import_id, ev.created_at, u.display_name AS user_name FROM employee_events ev
                          LEFT JOIN users u ON u.id = ev.user_id WHERE ev.company_id = ? AND ev.employee_id = ? ORDER BY ev.id DESC`).all(tenant.companyId, e.id)
        .map(({ changes_json, ...r }) => ({ ...r, changes: changes_json ? JSON.parse(changes_json) : null })),
      cases: db.prepare('SELECT id, case_no, case_type, status, key_date FROM proc_cases WHERE company_id = ? AND employee_id = ? ORDER BY key_date DESC').all(tenant.companyId, e.id),
      bank_accounts: db.prepare('SELECT COUNT(*) n FROM bank_accounts WHERE company_id = ? AND employee_id = ?').get(tenant.companyId, e.id).n,
    };
  });
  // active-employees Excel file: preview (nothing saved) then import, Admin only, current company only
  route('POST', '/api/employees/import/preview', { admin: true, tenant: true }, ({ company, tenant, body, session }) => employeeImport.preview(company, tenant, body, session.user.id));
  route('POST', '/api/employees/import/apply', { admin: true, tenant: true }, ({ company, tenant, body, session }) => employeeImport.apply(company, tenant, body, session.user.id));
  route('GET', '/api/employees/imports', { tenant: true }, ({ company }) => employeeImport.history(company));
  route('POST', '/api/records/:entity', { tenant: true }, ({ tenant, params, body, session }) =>
    tenant.create(params.entity, body, session.user.id));
  route('PATCH', '/api/records/:entity/:id', { tenant: true }, ({ tenant, params, body, session }) =>
    tenant.update(params.entity, params.id, body, session.user.id));

  // ---------- letters (team can use, cannot edit) ----------
  route('GET', '/api/letters/catalog', { tenant: true }, ({ company }) => {
    const types = db.prepare("SELECT id, code, name_ar, name_en FROM letter_types WHERE is_active = 1 AND category = 'letter' ORDER BY id").all();
    const tpl = db.prepare(`SELECT t.id, t.letter_type_id, t.version, t.created_at, t.placeholders, f.original_name
                            FROM letter_templates t JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                            WHERE t.company_id = ? AND t.is_active = 1`).all(company.id);
    const assets = db.prepare(`SELECT id, kind, label, signatory_name, signatory_title FROM brand_assets
                               WHERE company_id = ? AND is_active = 1 ORDER BY id`).all(company.id);
    return {
      types: types.map((t) => {
        const x = tpl.find((r) => r.letter_type_id === t.id);
        return { ...t, template: x ? { ...x, placeholders: JSON.parse(x.placeholders || '[]') } : null };
      }),
      signatures: assets.filter((a) => a.kind === 'signature'),
      stamps: assets.filter((a) => a.kind === 'stamp'),
      has_logo: !!company.logo_file_id,
    };
  });

  route('GET', '/api/letters/placeholders', {}, ({ query }) => placeholderCatalog(CATALOG_BY_CATEGORY[query.get('category')] || undefined));

  // Preview shows exactly which template/signature/stamp of the current company
  // will be used and which employee data is still missing.
  route('POST', '/api/letters/preview', { tenant: true }, ({ tenant, company, body }) => letters.preview(company, tenant, body));
  route('POST', '/api/letters/issue', { tenant: true }, ({ tenant, company, body, session }) => letters.issue(company, tenant, body, session.user.id));
  route('GET', '/api/letters/issued', { tenant: true }, ({ company }) => letters.list(company));
  route('GET', '/api/letters/issued/:id/file', { tenant: true }, ({ company, params, res }) =>
    sendFile(res, letters.file(company, params.id), { download: true }));

  // ---------- consulting contracts (team + admin; always the session company) ----------
  const T = { tenant: true };
  route('GET', '/api/consulting/summary', T, ({ company, query }) => consulting.summary(company, { days: query.get('days') }));
  route('GET', '/api/consulting/templates', T, ({ company }) => consulting.templateStatus(company));
  route('GET', '/api/consulting/contracts', T, ({ company, query }) => consulting.listContracts(company, { status: query.get('status'), q: query.get('q') }));
  route('POST', '/api/consulting/contracts', T, ({ company, body, session }) => consulting.createContract(company, body, session.user.id));
  route('GET', '/api/consulting/contracts/:id', T, ({ company, params }) => consulting.getContract(company, params.id));
  route('PATCH', '/api/consulting/contracts/:id', T, ({ company, params, body, session }) => consulting.updateContract(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/contracts/:id/status', T, ({ company, params, body, session }) => consulting.changeStatus(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/contracts/:id/signed-copy', T, ({ company, params, body, session }) => consulting.attachSigned(company, params.id, body, session.user.id));
  route('GET', '/api/consulting/contracts/:id/signed-copy', T, ({ company, params, res }) => sendFile(res, consulting.file(company, 'signed', params.id), { download: true }));
  route('POST', '/api/consulting/contracts/:id/document/preview', T, ({ company, params, body }) => consulting.previewContract(company, params.id, body));
  route('POST', '/api/consulting/contracts/:id/document', T, ({ company, params, body, session }) => consulting.generateContract(company, params.id, body, session.user.id));
  route('GET', '/api/consulting/contracts/:id/document', T, ({ company, params, res }) => sendFile(res, consulting.file(company, 'contract', params.id), { download: true }));
  route('POST', '/api/consulting/deliverables/:id/certificate/preview', T, ({ company, params, body }) => consulting.previewCertificate(company, params.id, body));
  route('POST', '/api/consulting/deliverables/:id/certificate', T, ({ company, params, body, session }) => consulting.issueCertificate(company, params.id, body, session.user.id));
  route('GET', '/api/consulting/deliverables/:id/certificate', T, ({ company, params, res }) => sendFile(res, consulting.file(company, 'certificate', params.id), { download: true }));
  route('POST', '/api/consulting/deliverables/:id/certificate-sent', T, ({ company, params, body, session }) => consulting.markCertificateSent(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/deliverables/:id/payments', T, ({ company, params, body, session }) => consulting.recordPayment(company, params.id, body, session.user.id));
  route('DELETE', '/api/consulting/payments/:id', { admin: true, tenant: true }, ({ company, params, body, session }) => consulting.voidPayment(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/payments/:id/void', { admin: true, tenant: true }, ({ company, params, body, session }) => consulting.voidPayment(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/payments/:id/correct', { admin: true, tenant: true }, ({ company, params, body, session }) => consulting.correctPayment(company, params.id, body, session.user.id));
  // consultants overview, one-step consultant + contract, deliverables across contracts
  route('GET', '/api/consulting/consultants', T, ({ company, query }) => consulting.listConsultants(company, { q: query.get('q') }));
  route('GET', '/api/consulting/consultants/:id', T, ({ company, params }) => consulting.getConsultant(company, params.id));
  route('GET', '/api/consulting/consultant-match', T, ({ company, query }) => consulting.consultantMatch(company, Object.fromEntries(query)));
  route('POST', '/api/consulting/contracts-with-consultant', T, ({ company, tenant, body, session }) => consulting.createContractWithConsultant(company, tenant, body, session.user.id));
  route('GET', '/api/consulting/deliverables', T, ({ company, query }) => consulting.listDeliverables(company, Object.fromEntries(query)));
  route('GET', '/api/consulting/deliverables/:id/certificates', T, ({ company, params }) => consulting.certificateHistory(company, params.id));
  route('GET', '/api/consulting/approver-suggestions', T, ({ company }) => consulting.approverSuggestions(company));
  route('GET', '/api/consulting/ready', T, ({ company }) => consulting.ready(company));
  // consultant payment requests
  route('GET', '/api/consulting/contracts/:id/requestable', T, ({ company, params, query }) => consulting.requestable(company, params.id, query.get('exclude_request_id') ? Number(query.get('exclude_request_id')) : null));
  route('GET', '/api/consulting/payment-requests', T, ({ company, query }) => consulting.listRequests(company, Object.fromEntries(query)));
  route('POST', '/api/consulting/payment-requests', T, ({ company, body, session }) => consulting.createRequest(company, body, session.user.id));
  route('GET', '/api/consulting/payment-requests/:id', T, ({ company, params }) => consulting.getRequest(company, params.id));
  route('PATCH', '/api/consulting/payment-requests/:id', T, ({ company, params, body, session }) => consulting.updateRequest(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/payment-requests/:id/document/preview', T, ({ company, params, body }) => consulting.previewRequest(company, params.id, body));
  route('POST', '/api/consulting/payment-requests/:id/document', T, ({ company, params, body, session }) => consulting.issueRequest(company, params.id, body, session.user.id));
  route('GET', '/api/consulting/payment-requests/:id/document', T, ({ company, params, res }) => sendFile(res, consulting.requestFile(company, params.id), { download: true }));
  route('POST', '/api/consulting/payment-requests/:id/sent', T, ({ company, params, body, session }) => consulting.markRequestSent(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/payment-requests/:id/cancel', T, ({ company, params, body, session }) => consulting.cancelRequest(company, params.id, body, session.user.id));
  route('POST', '/api/consulting/payment-requests/:id/payments', T, ({ company, params, body, session }) => consulting.recordRequestPayment(company, params.id, body, session.user.id));

  // ---------- employee procedures: onboarding / offboarding (session company only) ----------
  const P_ADMIN = { admin: true, tenant: true };
  route('GET', '/api/procedures/meta', T, () => procedures.meta());
  route('GET', '/api/procedures/summary', T, ({ company }) => procedures.summary(company));
  route('GET', '/api/procedures/outstanding', T, ({ company, query }) => procedures.outstanding(company, Object.fromEntries(query)));
  route('GET', '/api/procedures/events', T, ({ company }) => procedures.events(company));
  route('GET', '/api/procedures/lists', T, ({ company }) => procedures.lists(company));
  route('POST', '/api/admin/procedures/lists', P_ADMIN, ({ company, body, session }) => procedures.addListItem(company, body, session.user.id));
  route('PATCH', '/api/admin/procedures/lists/:id', P_ADMIN, ({ company, params, body, session }) => procedures.updateListItem(company, params.id, body, session.user.id));
  route('GET', '/api/procedures/checklists', T, ({ company, query }) => procedures.checklist(company, query.get('case_type')));
  route('POST', '/api/admin/procedures/checklists', P_ADMIN, ({ company, body, session }) => procedures.saveChecklistStep(company, body, session.user.id));
  route('GET', '/api/procedures/export.xlsx', T, ({ company, query, res }) => {
    const buf = procedures.exportXlsx(company, Object.fromEntries(query));
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`متابعة إجراءات الموظفين ${company.name_ar}.xlsx`)}` });
    res.end(buf);
    return SENT;
  });
  route('POST', '/api/admin/procedures/members', P_ADMIN, ({ company, body, session }) => procedures.addMember(company, body, session.user.id));
  route('PATCH', '/api/admin/procedures/members/:id', P_ADMIN, ({ company, params, body, session }) => procedures.updateMember(company, params.id, body, session.user.id));
  route('GET', '/api/procedures/employee-match', T, ({ company, query }) => procedures.employeeMatch(company, Object.fromEntries(query)));
  route('POST', '/api/procedures/onboarding', T, ({ company, tenant, body, session }) => procedures.createOnboardingWithEmployee(company, tenant, body, session.user.id));
  route('GET', '/api/procedures/cases', T, ({ company, query }) => procedures.listCases(company, Object.fromEntries(query)));
  route('POST', '/api/procedures/cases', T, ({ company, tenant, body, session }) => procedures.createCase(company, tenant, body, session.user.id));
  route('GET', '/api/procedures/cases/:id', T, ({ company, params }) => procedures.getCase(company, params.id));
  route('PATCH', '/api/procedures/cases/:id', T, ({ company, params, body, session }) => procedures.updateCase(company, params.id, body, session.user.id));
  route('GET', '/api/procedures/cases/:id/documents-ready', T, ({ company, params }) => procedures.documentsReady(company, params.id));
  route('POST', '/api/procedures/cases/:id/steps', T, ({ company, params, body, session }) => procedures.addStep(company, params.id, body, session.user.id));
  route('POST', '/api/procedures/cases/:id/close', T, ({ company, params, body, session }) => procedures.closeCase(company, params.id, body, session.user.id));
  route('POST', '/api/procedures/cases/:id/cancel', T, ({ company, params, body, session }) => procedures.cancelCase(company, params.id, body, session.user.id));
  route('POST', '/api/procedures/cases/:id/confirm-start', T, ({ company, tenant, params, body, session }) => procedures.confirmStart(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/procedures/cases/:id/confirm-end', T, ({ company, tenant, params, body, session }) => procedures.confirmEnd(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/procedures/cases/:id/employee-no', T, ({ company, tenant, params, body, session }) => procedures.setEmployeeNo(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/procedures/cases/:id/reopen', P_ADMIN, ({ company, params, body, session }) => procedures.reopenCase(company, params.id, body, session.user.id));
  route('DELETE', '/api/procedures/cases/:id', P_ADMIN, ({ company, params, body, session }) => procedures.deleteCase(company, params.id, body, session.user.id));
  route('PATCH', '/api/procedures/steps/:id', T, ({ company, params, body, session }) => procedures.updateStep(company, params.id, body, session.user.id));
  route('DELETE', '/api/procedures/steps/:id', T, ({ company, params, body, session }) => procedures.removeStep(company, params.id, body, session.user.id));
  route('POST', '/api/procedures/steps/:id/letter', T, ({ company, params, body, session }) => procedures.linkLetter(company, params.id, body, session.user.id));

  // ---------- air tickets for non-Saudi employees (session company only) ----------
  const ADMIN_T = { admin: true, tenant: true };
  route('GET', '/api/air-tickets/meta', T, () => airTickets.meta());
  route('GET', '/api/air-tickets/policy', T, ({ company }) => airTickets.policyInfo(company));
  route('POST', '/api/admin/air-tickets/policy', ADMIN_T, ({ company, body, session }) => airTickets.updatePolicy(company, body, session.user.id));
  route('GET', '/api/air-tickets/summary', T, ({ company, query }) => airTickets.summary(company, { from: query.get('from'), to: query.get('to') }));
  route('GET', '/api/air-tickets/balances', T, ({ company, query }) => airTickets.balances(company, Object.fromEntries(query)));
  route('GET', '/api/air-tickets/events', T, ({ company, query }) => airTickets.events(company, { employee_id: query.get('employee_id') }));
  route('GET', '/api/air-tickets/export.xlsx', T, ({ company, query, res }) => {
    const buf = airTickets.exportXlsx(company, { from: query.get('from'), to: query.get('to') });
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`تذاكر الطيران ${company.name_ar}.xlsx`)}` });
    res.end(buf);
    return SENT;
  });
  route('GET', '/api/air-tickets/employees/:id', T, ({ company, tenant, params }) => airTickets.employee(company, tenant, params.id));
  route('PATCH', '/api/air-tickets/employees/:id/profile', T, ({ company, tenant, params, body, session }) => airTickets.updateProfile(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/air-tickets/employees/:id/family', T, ({ company, tenant, params, body, session }) => airTickets.addFamily(company, tenant, params.id, body, session.user.id));
  route('DELETE', '/api/air-tickets/family/:id', T, ({ company, tenant, params, body, session }) => airTickets.deleteFamily(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/air-tickets/employees/:id/opening-balance/approve', ADMIN_T, ({ company, tenant, params, body, session }) => airTickets.approveOpening(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/air-tickets/employees/:id/opening-balance/revoke', ADMIN_T, ({ company, tenant, params, body, session }) => airTickets.revokeOpening(company, tenant, params.id, body, session.user.id));
  route('GET', '/api/air-tickets/disbursements', T, ({ company, query }) => airTickets.listDisbursements(company, Object.fromEntries(query)));
  route('POST', '/api/air-tickets/disbursements', T, ({ company, tenant, body, session }) => airTickets.createDisbursement(company, tenant, body, session.user.id));
  route('PATCH', '/api/air-tickets/disbursements/:id', T, ({ company, tenant, params, body, session }) => airTickets.updateDisbursement(company, tenant, params.id, body, session.user.id));
  route('DELETE', '/api/air-tickets/disbursements/:id', ADMIN_T, ({ company, params, body, session }) => airTickets.deleteDisbursement(company, params.id, body, session.user.id));

  // ---------- chamber of commerce attestations (session company only) ----------
  route('GET', '/api/attestations/meta', T, () => attestations.meta());
  route('GET', '/api/attestations/policy', T, ({ company }) => attestations.policyInfo(company));
  route('POST', '/api/admin/attestations/policy', { admin: true, tenant: true }, ({ company, body, session }) => attestations.updatePolicy(company, body || {}, session.user.id));
  route('GET', '/api/attestations/employee-status', T, ({ company, tenant, query }) => attestations.employeeStatus(company, tenant, query.get('employee_id'), query.get('date')));
  route('GET', '/api/attestations/summary', T, ({ company, query }) => attestations.summary(company, { from: query.get('from'), to: query.get('to') }));
  route('GET', '/api/attestations/events', T, ({ company }) => attestations.events(company));
  route('GET', '/api/attestations/export.csv', T, ({ company, query, res }) => {
    const csv = Buffer.from(attestations.exportCsv(company, Object.fromEntries(query)), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Length': csv.length, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`تصديقات ${company.name_ar}.csv`)}` });
    res.end(csv);
    return SENT;
  });
  route('GET', '/api/attestations', T, ({ company, query }) => attestations.list(company, Object.fromEntries(query)));
  route('POST', '/api/attestations', T, ({ company, tenant, body, session }) => attestations.create(company, tenant, body, session.user.id));
  route('GET', '/api/attestations/:id', T, ({ company, params }) => attestations.get(company, params.id));
  route('PATCH', '/api/attestations/:id', T, ({ company, tenant, params, body, session }) => attestations.update(company, tenant, params.id, body, session.user.id));
  route('POST', '/api/attestations/:id/status', T, ({ company, params, body, session }) => attestations.setStatus(company, params.id, body, session.user.id));
  route('DELETE', '/api/attestations/:id', { admin: true, tenant: true }, ({ company, params, body, session }) => attestations.remove(company, params.id, body, session.user.id));
  route('POST', '/api/attestations/:id/deduction/confirm', T, ({ company, params, body, session }) => attestations.confirmDeduction(company, params.id, body, session.user.id));
  route('POST', '/api/attestations/:id/deduction/revert', { admin: true, tenant: true }, ({ company, params, body, session }) => attestations.revertDeduction(company, params.id, body, session.user.id));
  route('POST', '/api/attestations/:id/deduction/waive', { admin: true, tenant: true }, ({ company, params, body, session }) => attestations.waiveDeduction(company, params.id, body, session.user.id));

  // ---------- admin: companies & identity ----------
  route('GET', '/api/admin/companies', { admin: true }, () =>
    db.prepare('SELECT * FROM companies ORDER BY sort_order, id').all().map((c) => ({
      ...companyPublic(c), is_active: !!c.is_active, sort_order: c.sort_order, color_source: c.color_source,
      legal_name_ar: c.legal_name_ar, legal_name_en: c.legal_name_en,
    })));

  route('POST', '/api/admin/companies', { admin: true }, ({ body }) => {
    const code = String(body?.code || '').trim().toLowerCase();
    if (!/^[a-z0-9]{2,32}$/.test(code)) throw new HttpError(400, 'رمز الشركة: أحرف إنجليزية صغيرة وأرقام فقط (2–32).');
    if (!body?.name_ar?.trim() || !body?.name_en?.trim()) throw new HttpError(400, 'اسم الشركة بالعربية والإنجليزية مطلوب.');
    return tx(db, () => {
      try {
        const r = db.prepare(`INSERT INTO companies (code, name_ar, name_en, legal_name_ar, legal_name_en, color_primary, color_secondary, color_accent, color_ink, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM companies))`).run(
          code, body.name_ar.trim(), body.name_en.trim(), body.legal_name_ar || null, body.legal_name_en || null,
          colorOrNull(body.colors?.primary, 'الأساسي') ?? null, colorOrNull(body.colors?.secondary, 'الثانوي') ?? null,
          colorOrNull(body.colors?.accent, 'المميز') ?? null, colorOrNull(body.colors?.ink, 'النص') ?? null);
        const id = Number(r.lastInsertRowid);
        if (body.grant_team_access !== false) {
          db.prepare(`INSERT OR IGNORE INTO user_companies (user_id, company_id) SELECT id, ? FROM users WHERE role = 'team'`).run(id);
        }
        return companyPublic(companyById(id));
      } catch (e) { throw mapDbError(e); }
    });
  });

  route('PATCH', '/api/admin/companies/:id', { admin: true }, ({ params, body }) => {
    const c = companyById(Number(params.id));
    if (!c) throw new HttpError(404, 'الشركة غير موجودة.');
    const set = {};
    for (const k of ['name_ar', 'name_en', 'legal_name_ar', 'legal_name_en']) {
      if (body?.[k] !== undefined) set[k] = String(body[k] || '').trim() || null;
    }
    if (set.name_ar === null || set.name_en === null) throw new HttpError(400, 'اسم الشركة لا يمكن أن يكون فارغًا.');
    const map = { primary: 'color_primary', secondary: 'color_secondary', accent: 'color_accent', ink: 'color_ink' };
    for (const [k, col] of Object.entries(map)) {
      const v = colorOrNull(body?.colors?.[k], k);
      if (v !== undefined) set[col] = v;
    }
    if (body?.colors) set.color_source = 'admin';
    if (body?.is_active !== undefined) {
      if (!body.is_active && db.prepare('SELECT COUNT(*) n FROM companies WHERE is_active = 1 AND id != ?').get(c.id).n === 0)
        throw new HttpError(400, 'يجب أن تبقى شركة واحدة نشطة على الأقل.');
      set.is_active = body.is_active ? 1 : 0;
    }
    const keys = Object.keys(set);
    if (keys.length) {
      db.prepare(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
        .run(...keys.map((k) => set[k]), c.id);
    }
    return companyPublic(companyById(c.id));
  });

  route('POST', '/api/admin/companies/:id/logo', { admin: true }, ({ params, body, session }) => {
    const c = companyById(Number(params.id));
    if (!c) throw new HttpError(404, 'الشركة غير موجودة.');
    const { filename, buffer } = fromUpload(body?.file);
    return tx(db, () => {
      const fileId = saveFile(db, storageDir, { companyId: c.id, kind: 'logo', filename, buffer, allowed: IMAGE_TYPES, userId: session.user.id });
      db.prepare(`UPDATE companies SET logo_file_id = ?, updated_at = datetime('now') WHERE id = ?`).run(fileId, c.id);
      return companyPublic(companyById(c.id));
    });
  });

  route('GET', '/api/admin/users', { admin: true }, () =>
    db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.is_active,
                (SELECT group_concat(c.name_ar, '، ') FROM user_companies uc JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = u.id) AS companies
                FROM users u ORDER BY u.id`).all());

  // ---------- admin: letter catalogue ----------
  route('GET', '/api/admin/letter-types', { admin: true }, () => db.prepare('SELECT * FROM letter_types ORDER BY id').all());
  route('POST', '/api/admin/letter-types', { admin: true }, ({ body }) => {
    const code = String(body?.code || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{2,40}$/.test(code)) throw new HttpError(400, 'الرمز: أحرف إنجليزية صغيرة وأرقام و _ فقط.');
    if (!body?.name_ar?.trim()) throw new HttpError(400, 'اسم النوع مطلوب.');
    try {
      const r = db.prepare('INSERT INTO letter_types (code, name_ar, name_en) VALUES (?, ?, ?)').run(code, body.name_ar.trim(), body.name_en?.trim() || null);
      return db.prepare('SELECT * FROM letter_types WHERE id = ?').get(Number(r.lastInsertRowid));
    } catch (e) { throw mapDbError(e); }
  });

  // ---------- admin: templates, signatures, stamps (scoped to selected company) ----------
  route('GET', '/api/admin/templates', { admin: true, tenant: true }, ({ company }) =>
    db.prepare(`SELECT t.id, t.letter_type_id, lt.name_ar AS letter_type, t.version, t.is_active, t.notes, t.created_at, t.placeholders,
                       t.review_state, t.source_template_id, t.checks_json, t.trial_at, t.trial_pdf_id IS NOT NULL AS has_trial_pdf, t.approved_at,
                       f.original_name, f.size, u.display_name AS uploaded_by
                FROM letter_templates t
                JOIN letter_types lt ON lt.id = t.letter_type_id
                JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                LEFT JOIN users u ON u.id = t.uploaded_by
                WHERE t.company_id = ? ORDER BY lt.id, t.version DESC`).all(company.id));

  route('POST', '/api/admin/templates', { admin: true, tenant: true }, ({ company, body, session }) => {
    const type = db.prepare('SELECT id, category FROM letter_types WHERE id = ?').get(Number(body?.letter_type_id));
    if (!type) throw new HttpError(400, 'اختر نوع الخطاب.');
    const { filename, buffer } = fromUpload(body?.file);
    const isExcel = type.category === 'payment_request';
    const placeholders = isExcel ? analyzeXlsxTemplate(buffer, filename) : analyzeTemplate(buffer, CATALOG_BY_CATEGORY[type.category] || undefined);
    const cleaned = isExcel ? cleanXlsx(buffer) : cleanTemplate(buffer);
    return tx(db, () => {
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: 'template', filename, buffer: cleaned, allowed: isExcel ? XLSX_TYPES : DOCX_TYPES, userId: session.user.id });
      // Certificate templates are never activated on upload: link boxes → trial → Admin approval.
      const isCert = type.category === 'certificate';
      if (!isCert) db.prepare('UPDATE letter_templates SET is_active = 0 WHERE company_id = ? AND letter_type_id = ?').run(company.id, type.id);
      const v = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM letter_templates WHERE company_id = ? AND letter_type_id = ?').get(company.id, type.id).v;
      const r = db.prepare(`INSERT INTO letter_templates (company_id, letter_type_id, file_id, version, is_active, notes, uploaded_by, placeholders, review_state)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(company.id, type.id, fileId, v, isCert ? 0 : 1, body.notes || null, session.user.id, JSON.stringify(placeholders), isCert ? 'draft' : null);
      return { ok: true, version: v, placeholders, template_id: Number(r.lastInsertRowid), draft: isCert };
    });
  });

  route('POST', '/api/admin/templates/:id/activate', { admin: true, tenant: true }, ({ company, params }) => {
    const t = db.prepare('SELECT t.*, lt.category FROM letter_templates t JOIN letter_types lt ON lt.id = t.letter_type_id WHERE t.company_id = ? AND t.id = ?').get(company.id, Number(params.id));
    if (!t) throw new HttpError(404, 'النموذج غير موجود في الشركة الحالية.');
    if (t.category === 'certificate' && t.review_state !== 'approved') throw new HttpError(409, 'نموذج الشهادة يُفعَّل بعد ربط خاناته وتجربته واعتماده فقط.', 'not_approved');
    tx(db, () => {
      db.prepare('UPDATE letter_templates SET is_active = 0 WHERE company_id = ? AND letter_type_id = ?').run(company.id, t.letter_type_id);
      db.prepare('UPDATE letter_templates SET is_active = 1 WHERE company_id = ? AND id = ?').run(company.id, t.id);
    });
    return { ok: true };
  });

  // certificate template set-up without editing Word (Admin only, current company only)
  route('GET', '/api/admin/templates/:id/analysis', { admin: true, tenant: true }, ({ company, params }) => templateFlow.analysis(company, params.id));
  route('POST', '/api/admin/templates/:id/mapping', { admin: true, tenant: true }, ({ company, params, body, session }) => templateFlow.saveMapping(company, params.id, body, session.user.id));
  route('POST', '/api/admin/templates/:id/trial', { admin: true, tenant: true }, ({ company, params, body, session }) => templateFlow.trial(company, params.id, body, session.user.id));
  route('GET', '/api/admin/templates/:id/trial/:kind', { admin: true, tenant: true }, ({ company, params, res }) => sendFile(res, templateFlow.trialFile(company, params.id, params.kind), { download: params.kind !== 'pdf' }));
  route('POST', '/api/admin/templates/:id/approve', { admin: true, tenant: true }, ({ company, params, session }) => templateFlow.approve(company, params.id, session.user.id));
  route('GET', '/api/admin/templates/:id/file', { admin: true, tenant: true }, ({ company, params, res }) => {
    const t = db.prepare('SELECT file_id FROM letter_templates WHERE company_id = ? AND id = ?').get(company.id, Number(params.id));
    if (!t) throw new HttpError(404, 'النموذج غير موجود في الشركة الحالية.');
    return sendFile(res, readFile(db, storageDir, company.id, t.file_id), { download: true });
  });

  route('GET', '/api/admin/assets', { admin: true, tenant: true }, ({ company }) =>
    db.prepare(`SELECT a.id, a.kind, a.label, a.signatory_name, a.signatory_title, a.is_active, a.created_at
                FROM brand_assets a WHERE a.company_id = ? ORDER BY a.kind, a.id DESC`).all(company.id));

  route('POST', '/api/admin/assets', { admin: true, tenant: true }, ({ company, body, session }) => {
    if (!['signature', 'stamp'].includes(body?.kind)) throw new HttpError(400, 'النوع يجب أن يكون توقيعًا أو ختمًا.');
    if (!body?.label?.trim()) throw new HttpError(400, 'الوصف مطلوب.');
    const { filename, buffer } = fromUpload(body?.file);
    return tx(db, () => {
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: body.kind, filename, buffer, allowed: IMAGE_TYPES, userId: session.user.id });
      const r = db.prepare(`INSERT INTO brand_assets (company_id, kind, label, signatory_name, signatory_title, file_id, uploaded_by)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(company.id, body.kind, body.label.trim(), body.signatory_name || null, body.signatory_title || null, fileId, session.user.id);
      return { id: Number(r.lastInsertRowid) };
    });
  });

  route('PATCH', '/api/admin/assets/:id', { admin: true, tenant: true }, ({ company, params, body }) => {
    const r = db.prepare('UPDATE brand_assets SET is_active = ? WHERE company_id = ? AND id = ?').run(body?.is_active ? 1 : 0, company.id, Number(params.id));
    if (!r.changes) throw new HttpError(404, 'غير موجود في الشركة الحالية.');
    return { ok: true };
  });

  route('GET', '/api/admin/assets/:id/file', { admin: true, tenant: true }, ({ company, params, res }) => {
    const a = db.prepare('SELECT file_id FROM brand_assets WHERE company_id = ? AND id = ?').get(company.id, Number(params.id));
    if (!a) throw new HttpError(404, 'غير موجود في الشركة الحالية.');
    return sendFile(res, readFile(db, storageDir, company.id, a.file_id));
  });

  // ---------- plumbing ----------
  function sendFile(res, { meta, buffer }, { cache = false, download = false } = {}) {
    res.writeHead(200, {
      'Content-Type': meta.mime,
      'Content-Length': buffer.length,
      'Cache-Control': cache ? 'private, max-age=86400' : 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(download ? { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(meta.original_name)}` } : {}),
    });
    res.end(buffer);
    return SENT;
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const abs = path.resolve(publicDir, rel);
    if (!abs.startsWith(path.resolve(publicDir)) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(abs)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'",
    });
    fs.createReadStream(abs).pipe(res);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'الطلب كبير جدًا.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'JSON غير صالح.')); }
      });
      req.on('error', reject);
    });
  }

  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p[0]));
  // One cookie name per port (hub_sid_4300, hub_sid_4301, …): cookies on localhost are shared
  // across ports, so without this a test instance would log the main platform out.
  const cookieName = (req) => `hub_sid_${(String(req.headers.host || '').match(/:(\d+)$/) || [, '80'])[1]}`;

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(obj));
    };
    try {
      // CSRF: state-changing calls must come from our own script (custom header + SameSite=Strict cookie).
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'hub') throw new HttpError(403, 'طلب مرفوض.');
      let match, params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { match = r; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]))); break; }
      }
      if (!match) throw new HttpError(404, 'غير موجود.');
      const ctx = { req, res, params, query: url.searchParams };
      if (match.opts.auth !== false) {
        ctx.session = auth.loadSession(db, cookies(req)[cookieName(req)]);
        if (!ctx.session) throw new HttpError(401, 'يجب تسجيل الدخول.', 'unauthenticated');
        if (match.opts.admin && ctx.session.user.role !== 'admin') throw new HttpError(403, 'هذه العملية متاحة لحساب المسؤول فقط.', 'forbidden');
        if (match.opts.tenant) {
          const { current } = resolveCompany(ctx.session);
          if (!current) throw new HttpError(403, 'لا توجد شركة متاحة لحسابك.');
          // The page must declare which company it believes is active. If another
          // tab switched company meanwhile, refuse instead of reading/writing the wrong one.
          if (Number(req.headers['x-company-id']) !== current.id) throw new HttpError(409, 'تم تغيير الشركة المختارة. سيتم تحديث الصفحة.', 'company_changed');
          ctx.company = companyById(current.id);
          ctx.tenant = tenantRepo(db, current.id);
        }
      }
      if (req.method !== 'GET') ctx.body = await readBody(req);
      const result = await match.handler(ctx);
      if (result !== SENT) send(200, result ?? { ok: true });
    } catch (e) {
      const err = e instanceof HttpError ? e : mapDbError(e);
      if (err instanceof HttpError) return send(err.status, { error: err.message, code: err.code, details: err.details });
      console.error(e);
      send(500, { error: 'خطأ غير متوقع في الخادم.' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.db = db;
  return server;
}

const SENT = Symbol('sent');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pi = process.argv.indexOf('--port');
  const port = Number(pi > 0 ? process.argv[pi + 1] : process.env.PORT) || 4300;
  const i = process.argv.indexOf('--data-dir');
  // Hosting: DATA_DIR = persistent disk, HOST=0.0.0.0 to accept outside connections (default: this computer only)
  const dataDir = i > 0 ? path.resolve(process.argv[i + 1]) : process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : null;
  const host = process.env.HOST || '127.0.0.1';
  const opts = dataDir ? { dbFile: path.join(dataDir, 'hub.db'), storageDir: path.join(dataDir, 'storage') } : {};
  // First start on a new server: create the companies and accounts (passwords from ADMIN_PASSWORD / TEAM_PASSWORD when set).
  if (process.env.AUTO_SEED === '1') {
    const { seed } = await import('./seed.js');
    const r = seed({ ...opts, demo: false, adminPassword: process.env.ADMIN_PASSWORD, teamPassword: process.env.TEAM_PASSWORD });
    r.db.close();
  }
  const server = createApp(opts);
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(`HC Operations Hub is already running on http://localhost:${port} - nothing else started.`);
      process.exit(0);
    }
    throw e;
  });
  server.listen(port, host, () => console.log(`HC Operations Hub -> http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
