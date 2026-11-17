// Certificate templates without editing Word: analyse → link boxes → new draft
// version → trial with fake data (Word + PDF) → Admin approval. A certificate
// template is only ever activated by an explicit approval after its checks pass.
// Every company has its own templates; earlier versions are never changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { HttpError } from './errors.js';
import { tx } from './db.js';
import { readFile, saveFile } from './files.js';
import { findPlaceholders, renderDocx, PLACEHOLDER_RE } from './docx/merge.js';
import { analyzeDocx, applyMapping, verifyFormatting, documentText } from './docx/template-mapping.js';
import { CERTIFICATE_CATALOG } from './consulting.js';

// What a completion certificate must contain before it can be approved.
export const REQUIRED_CERT = [
  { keys: ['consultant_name_ar'], label: 'اسم الاستشاري' },
  { keys: ['deliverable_title'], label: 'وصف المخرج' },
  { keys: ['deliverable_amount', 'certificate_total'], label: 'قيمة المخرج أو الإجمالي' },
  { keys: ['approver_1_name'], label: 'اسم المعتمد 1' },
  { keys: ['approver_2_name'], label: 'اسم المعتمد 2' },
  { keys: ['approver_3_name'], label: 'اسم المعتمد 3' },
];
const KNOWN = new Set(CERTIFICATE_CATALOG.text.flatMap((p) => (p.date ? [p.key, `${p.key}:dash`] : [p.key])).concat(CERTIFICATE_CATALOG.images.map((p) => p.key)));

// Clearly fake values for the trial certificate (never real people or accounts).
export function fakeCertificateValues() {
  const v = {};
  for (const p of CERTIFICATE_CATALOG.text) {
    v[p.key] = p.date ? '01/01/2030' : `[${p.label} — تجريبي]`;
    if (p.date) v[`${p.key}:dash`] = '01-01-2030';
  }
  Object.assign(v, {
    consultant_name_ar: 'استشاري تجريبي (وهمي)', consultant_name_en: 'Test Consultant (fake)', consultant_bank_name: 'بنك تجريبي',
    consultant_iban: 'SA0000000000000000000000', consultant_id_number: '0000000000', consultant_mobile: '0500000000',
    deliverable_title: 'مخرج تجريبي — بيانات وهمية للاختبار', deliverable_amount: '12,345', certificate_total: '12,345', contract_total: '12,345',
    deliverable_no: '1', certificate_ref: 'TEST/CERT/0000', contract_ref: 'TEST/CC/0000',
    'deliverable_period_from:dash': '01-01-2030', deliverable_period_from: '01/01/2030', 'deliverable_period_to:dash': '31-01-2030', deliverable_period_to: '31/01/2030',
    approver_1_name: 'معتمد تجريبي ١', approver_2_name: 'معتمد تجريبي ٢', approver_3_name: 'معتمد تجريبي ٣',
    approver_1_title: '', approver_2_title: '', approver_3_title: '', signatory_name: '', signatory_title: '',
  });
  return v;
}

// Word (installed on this server) renders the PDF preview. Returns null if unavailable.
function wordToPdf(docxBuffer) {
  if (process.platform !== 'win32') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pdf-'));
  const src = path.join(dir, `${crypto.randomUUID()}.docx`);
  const out = src.replace(/\.docx$/, '.pdf');
  try {
    fs.writeFileSync(src, docxBuffer);
    const ps = `$w = New-Object -ComObject Word.Application; $w.Visible = $false; $w.DisplayAlerts = 0;
      try { $d = $w.Documents.Open('${src}', $false, $true); $d.SaveAs2('${out}', 17); $d.Close($false) } finally { $w.Quit(); [System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000, windowsHide: true });
    return r.status === 0 && fs.existsSync(out) ? fs.readFileSync(out) : null;
  } catch { return null; } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

export function createTemplateWorkflow(db, storageDir, { pdf = wordToPdf } = {}) {
  const loadTemplate = (company, id) => {
    const t = db.prepare(`SELECT t.*, lt.code, lt.category, lt.name_ar AS type_name, f.original_name FROM letter_templates t
                          JOIN letter_types lt ON lt.id = t.letter_type_id JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                          WHERE t.company_id = ? AND t.id = ?`).get(company.id, Number(id));
    if (!t) throw new HttpError(404, 'النموذج غير موجود في الشركة الحالية.');
    if (t.category !== 'certificate') throw new HttpError(400, 'إعداد الربط متاح حاليًا لنماذج شهادات الإنجاز فقط.');
    return t;
  };
  const fileOf = (company, fileId) => readFile(db, storageDir, company.id, fileId).buffer;
  // The original document a draft was produced from (or the template itself).
  const sourceOf = (company, t) => (t.source_template_id ? loadTemplate(company, t.source_template_id) : t);

  function evaluate(placeholders) {
    const unknown = placeholders.filter((k) => !KNOWN.has(k));
    const missing = REQUIRED_CERT.filter((r) => !r.keys.some((k) => placeholders.includes(k))).map((r) => r.label);
    return { placeholders, unknown, missing_required: missing };
  }

  function analysis(company, id) {
    const t = loadTemplate(company, id);
    const src = sourceOf(company, t);
    const a = analyzeDocx(fileOf(company, src.file_id));
    const saved = t.mapping_json ? JSON.parse(t.mapping_json) : null;
    const current = findPlaceholders(fileOf(company, t.file_id));
    return {
      template: { id: t.id, version: t.version, review_state: t.review_state, is_active: !!t.is_active, file: t.original_name, source_version: src.version },
      source_template_id: src.id, ...a, saved_mapping: saved, current: evaluate(current),
      fields: CERTIFICATE_CATALOG.text.map(({ key, label, group, date }) => ({ key, label, group, date: !!date })),
      required: REQUIRED_CERT.map((r) => r.label),
      required_fields: REQUIRED_CERT.map((r) => ({ label: r.label, keys: r.keys })),
    };
  }

  // Applies the user's links to a COPY of the source document and stores it as a new draft version.
  function saveMapping(company, id, input, userId) {
    const t = loadTemplate(company, id);
    const src = sourceOf(company, t);
    const mapping = input?.mapping;
    if (!mapping || typeof mapping !== 'object') throw new HttpError(400, 'لا يوجد ربط للحفظ.');
    for (const [slot, m] of Object.entries(mapping)) {
      if (!['field', 'fixed', 'blank'].includes(m?.mode)) throw new HttpError(400, `اختيار غير صالح للخانة ${slot}.`);
      if (m.mode === 'field') {
        const keys = [...String(m.pattern || '').matchAll(PLACEHOLDER_RE)].map((x) => x[1]);
        if (!keys.length) throw new HttpError(400, `الخانة ${slot}: اختر حقلًا واحدًا على الأقل أو اجعلها نصًا ثابتًا.`);
        const bad = keys.filter((k) => !KNOWN.has(k));
        if (bad.length) throw new HttpError(400, `حقول غير معروفة في الخانة ${slot}: ${bad.join('، ')}`);
      }
    }
    const original = fileOf(company, src.file_id);
    let mapped;
    try { mapped = applyMapping(original, mapping); } catch (e) { throw new HttpError(422, e.code ? e.message : 'تعذّر تطبيق الربط على ملف Word.', e.code || 'mapping_failed'); }
    const format = verifyFormatting(original, mapped, mapping);
    const checks = { format_ok: format.ok, format_problems: format.problems, ...evaluate(findPlaceholders(mapped)), mapped_at: new Date().toISOString() };
    return tx(db, () => {
      const fileId = saveFile(db, storageDir, { companyId: company.id, kind: 'template', filename: src.original_name.replace(/\.docx$/i, '') + ' (مربوط).docx', buffer: mapped, allowed: ['docx'], userId });
      const v = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 v FROM letter_templates WHERE company_id = ? AND letter_type_id = ?').get(company.id, t.letter_type_id).v;
      const r = db.prepare(`INSERT INTO letter_templates (company_id, letter_type_id, file_id, version, is_active, notes, uploaded_by, placeholders, review_state, mapping_json, source_template_id, checks_json)
                            VALUES (?, ?, ?, ?, 0, ?, ?, ?, 'draft', ?, ?, ?)`)
        .run(company.id, t.letter_type_id, fileId, v, `ربط خانات من الإصدار ${src.version}`, userId ?? null, JSON.stringify(checks.placeholders), JSON.stringify(mapping), src.id, JSON.stringify(checks));
      return { template_id: Number(r.lastInsertRowid), version: v, checks };
    });
  }

  // Trial certificate with fake data: Word file always, PDF when Word is available.
  function trial(company, id, input, userId) {
    const t = loadTemplate(company, id);
    const buf = fileOf(company, t.file_id);
    const placeholders = findPlaceholders(buf);
    const base = evaluate(placeholders);
    const images = {};
    if (placeholders.includes('logo') && company.logo_file_id) images.logo = { buffer: readFile(db, storageDir, company.id, company.logo_file_id).buffer, maxHeightCm: 2.2, maxWidthCm: 6 };
    const out = renderDocx(buf, fakeCertificateValues(), images);
    const text = documentText(out);
    const problems = [];
    if (/\{\{/.test(text)) problems.push('بقيت مواضع غير معبأة في الشهادة التجريبية.');
    // nothing of the document the template was made from may remain in a linked box
    if (t.source_template_id && t.mapping_json) {
      const src = sourceOf(company, t);
      const mapping = JSON.parse(t.mapping_json);
      const old = analyzeDocx(fileOf(company, src.file_id)).slots.filter((s) => mapping[s.id] && mapping[s.id].mode !== 'fixed' && s.text)
        .flatMap((s) => s.text.split('\n')).map((x) => x.trim())
        .filter((x) => x.length >= 3 && !(mapping && Object.values(mapping).some((m) => String(m.pattern || '').split('\n').map((p) => p.trim()).includes(x))));
      const left = old.filter((x) => text.includes(x));
      if (left.length) problems.push(`بقيت ${left.length} قيمة من بيانات المستند الأصلي داخل الشهادة.`);
    }
    const pdfBuf = input?.pdf === false ? null : pdf(out);
    return tx(db, () => {
      const docxId = saveFile(db, storageDir, { companyId: company.id, kind: 'template-trial', filename: `شهادة تجريبية - الإصدار ${t.version}.docx`, buffer: out, allowed: ['docx'], userId });
      const pdfId = pdfBuf ? saveFile(db, storageDir, { companyId: company.id, kind: 'template-trial', filename: `شهادة تجريبية - الإصدار ${t.version}.pdf`, buffer: pdfBuf, allowed: ['pdf'], userId }) : null;
      const prev = t.checks_json ? JSON.parse(t.checks_json) : {};
      const checks = { ...prev, ...base, format_ok: prev.format_ok ?? true, format_problems: prev.format_problems ?? [], trial_ok: problems.length === 0, trial_problems: problems, pdf: !!pdfId };
      db.prepare(`UPDATE letter_templates SET trial_docx_id = ?, trial_pdf_id = ?, trial_at = datetime('now'), checks_json = ?, review_state = COALESCE(review_state, 'draft')
                  WHERE company_id = ? AND id = ?`).run(docxId, pdfId, JSON.stringify(checks), company.id, t.id);
      return { template_id: t.id, checks, has_pdf: !!pdfId, pdf_note: pdfId || input?.pdf === false ? null : 'تعذّر إنشاء معاينة PDF على هذا الخادم (يتطلب Microsoft Word)؛ راجع ملف Word التجريبي.' };
    });
  }

  function trialFile(company, id, kind) {
    const t = loadTemplate(company, id);
    const fid = kind === 'pdf' ? t.trial_pdf_id : t.trial_docx_id;
    if (!fid) throw new HttpError(404, kind === 'pdf' ? 'لا توجد معاينة PDF لهذا الإصدار.' : 'لم تُنشأ شهادة تجريبية لهذا الإصدار بعد.');
    return readFile(db, storageDir, company.id, fid);
  }

  // Explicit Admin approval; refused with a clear list of what is missing.
  function approve(company, id, userId) {
    const t = loadTemplate(company, id);
    const checks = t.checks_json ? JSON.parse(t.checks_json) : null;
    const missing = [];
    const now = evaluate(findPlaceholders(fileOf(company, t.file_id)));
    if (!now.placeholders.length) missing.push('النموذج لا يحتوي على أي خانة مربوطة');
    if (now.missing_required.length) missing.push(`حقول مطلوبة غير مربوطة: ${now.missing_required.join('، ')}`);
    if (now.unknown.length) missing.push(`مواضع غير معروفة: ${now.unknown.join('، ')}`);
    if (checks && checks.format_ok === false) missing.push(`لم يُحافَظ على التنسيق: ${checks.format_problems.join('؛ ')}`);
    if (!t.trial_at) missing.push('لم تُنشأ شهادة تجريبية بعد («تجربة النموذج»)');
    else if (checks && checks.trial_ok === false) missing.push(`الشهادة التجريبية فيها مشكلات: ${checks.trial_problems.join('؛ ')}`);
    if (missing.length) throw new HttpError(409, `لا يمكن اعتماد الإصدار ${t.version}: ${missing.join(' — ')}.`, 'not_ready');
    return tx(db, () => {
      db.prepare('UPDATE letter_templates SET is_active = 0 WHERE company_id = ? AND letter_type_id = ?').run(company.id, t.letter_type_id);
      db.prepare(`UPDATE letter_templates SET is_active = 1, review_state = 'approved', approved_at = datetime('now'), approved_by = ? WHERE company_id = ? AND id = ?`).run(userId ?? null, company.id, t.id);
      return { ok: true, version: t.version };
    });
  }

  return { analysis, saveMapping, trial, trialFile, approve, loadTemplate };
}
