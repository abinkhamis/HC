// Letter issuing: resolves the selected company's approved template and assets,
// fills the placeholders and stores the result. Every lookup is bound to the
// session company; issued_letters' composite keys enforce the same rule in the DB.
import { HttpError } from './errors.js';
import { readFile, saveFile } from './files.js';
import { renderDocx, findPlaceholders } from './docx/merge.js';
import { tx } from './db.js';

const fmtNum = (v) => (v === null || v === undefined || v === '' ? null : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : null); // YYYY-MM-DD -> DD/MM/YYYY

function todayParts(now = new Date()) {
  const opt = { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Riyadh' };
  const g = Object.fromEntries(new Intl.DateTimeFormat('en-GB', opt).formatToParts(now).map((p) => [p.type, p.value]));
  const h = Object.fromEntries(new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', opt).formatToParts(now).map((p) => [p.type, p.value]));
  return { gregorian: `${g.day}/${g.month}/${g.year}`, hijri: `${h.day}/${h.month}/${h.year}`, year: g.year };
}

const total = (e) => {
  const parts = [e.basic_salary, e.housing_allowance, e.transport_allowance, e.other_allowance];
  if (e.basic_salary === null || e.basic_salary === undefined) return null;
  return parts.reduce((s, v) => s + (Number(v) || 0), 0);
};

// The placeholder catalogue. `get(ctx)` returns the value or null when missing.
export const PLACEHOLDERS = [
  { key: 'date_gregorian', label: 'تاريخ اليوم (ميلادي)', group: 'الخطاب', get: (c) => c.today.gregorian },
  { key: 'date_hijri', label: 'تاريخ اليوم (هجري — أم القرى)', group: 'الخطاب', get: (c) => c.today.hijri },
  { key: 'reference_no', label: 'رقم الخطاب', group: 'الخطاب', get: (c) => c.referenceNo },
  { key: 'addressee_ar', label: 'الجهة الموجّه إليها (عربي)', group: 'الخطاب', get: (c) => c.input.addressee_ar },
  { key: 'addressee_en', label: 'الجهة الموجّه إليها (إنجليزي)', group: 'الخطاب', get: (c) => c.input.addressee_en },

  { key: 'company_name_ar', label: 'اسم الشركة (عربي)', group: 'الشركة', get: (c) => c.company.legal_name_ar || c.company.name_ar },
  { key: 'company_name_en', label: 'اسم الشركة (إنجليزي)', group: 'الشركة', get: (c) => c.company.legal_name_en || c.company.name_en },

  { key: 'title_ar', label: 'اللقب (الأستاذ / الأستاذة)', group: 'الموظف', get: (c) => ({ male: 'الأستاذ', female: 'الأستاذة' })[c.employee.gender] ?? null },
  { key: 'respect_ar', label: 'المحترم / المحترمة', group: 'الموظف', get: (c) => ({ male: 'المحترم', female: 'المحترمة' })[c.employee.gender] ?? null },
  { key: 'title_en', label: 'Mr. / Ms.', group: 'الموظف', get: (c) => ({ male: 'Mr.', female: 'Ms.' })[c.employee.gender] ?? null },
  { key: 'employee_name_ar', label: 'اسم الموظف (عربي)', group: 'الموظف', get: (c) => c.employee.full_name_ar },
  { key: 'employee_name_en', label: 'اسم الموظف (إنجليزي)', group: 'الموظف', get: (c) => c.employee.full_name_en },
  { key: 'employee_no', label: 'الرقم الوظيفي', group: 'الموظف', get: (c) => c.employee.employee_no },
  { key: 'national_id', label: 'رقم الهوية / الإقامة', group: 'الموظف', get: (c) => c.employee.national_id },
  { key: 'nationality_ar', label: 'الجنسية (عربي)', group: 'الموظف', get: (c) => c.employee.nationality_ar },
  { key: 'nationality_en', label: 'الجنسية (إنجليزي)', group: 'الموظف', get: (c) => c.employee.nationality_en },
  { key: 'job_title_ar', label: 'المسمى الوظيفي (عربي)', group: 'الموظف', get: (c) => c.employee.job_title },
  { key: 'job_title_en', label: 'المسمى الوظيفي (إنجليزي)', group: 'الموظف', get: (c) => c.employee.job_title_en },
  { key: 'department', label: 'الإدارة', group: 'الموظف', get: (c) => c.employee.department },
  { key: 'hire_date', label: 'تاريخ المباشرة', group: 'الموظف', get: (c) => fmtDate(c.employee.hire_date) },
  { key: 'end_date', label: 'تاريخ انتهاء الخدمة', group: 'الموظف', get: (c) => fmtDate(c.employee.end_date) },

  { key: 'basic_salary', label: 'الراتب الأساسي', group: 'الراتب', get: (c) => fmtNum(c.employee.basic_salary) },
  { key: 'housing_allowance', label: 'بدل السكن', group: 'الراتب', get: (c) => fmtNum(c.employee.housing_allowance) },
  { key: 'transport_allowance', label: 'بدل النقل', group: 'الراتب', get: (c) => fmtNum(c.employee.transport_allowance) },
  { key: 'other_allowance', label: 'بدلات أخرى', group: 'الراتب', get: (c) => fmtNum(c.employee.other_allowance) },
  { key: 'total_salary', label: 'الراتب الإجمالي', group: 'الراتب', get: (c) => fmtNum(total(c.employee)) },

  { key: 'signatory_name', label: 'اسم صاحب التوقيع', group: 'التوقيع', get: (c) => c.signature?.signatory_name },
  { key: 'signatory_title', label: 'مسمى صاحب التوقيع', group: 'التوقيع', get: (c) => c.signature?.signatory_title },
];

export const IMAGE_PLACEHOLDERS = [
  { key: 'logo', label: 'شعار الشركة', maxHeightCm: 1.8, maxWidthCm: 6 },
  { key: 'signature', label: 'التوقيع', maxHeightCm: 1.6, maxWidthCm: 5 },
  { key: 'stamp', label: 'الختم', maxHeightCm: 3.2, maxWidthCm: 4 },
];

// Placeholders with a date value also accept {{key:dash}} → 01-10-2026.
const LETTER_DATE_KEYS = new Set(['date_gregorian', 'date_hijri', 'hire_date', 'end_date']);
export const LETTER_CATALOG = {
  text: PLACEHOLDERS.map((p) => ({ ...p, date: LETTER_DATE_KEYS.has(p.key) })),
  images: IMAGE_PLACEHOLDERS,
};

export function placeholderCatalog(catalog = LETTER_CATALOG) {
  return {
    text: catalog.text.map(({ key, label, group, date, row }) => ({ key, label, group, date: !!date, row: !!row })),
    images: catalog.images.map(({ key, label }) => ({ key, label })),
    row_prefix: catalog.rowPrefix || null,
  };
}

function knownKeys(catalog) {
  const keys = new Set(catalog.images.map((p) => p.key));
  for (const p of catalog.text) {
    keys.add(p.key);
    if (p.date) keys.add(`${p.key}:dash`);
  }
  return keys;
}

// Validates an uploaded template against the catalogue of its document kind;
// returns the placeholders it uses.
export function analyzeTemplate(buffer, catalog = LETTER_CATALOG) {
  let keys;
  try { keys = findPlaceholders(buffer); } catch { throw new HttpError(400, 'تعذّر قراءة ملف Word. تأكد أنه بصيغة .docx سليمة.'); }
  const known = knownKeys(catalog);
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) {
    throw new HttpError(400, `النموذج يحتوي على مواضع غير معروفة: ${unknown.map((k) => `{{${k}}}`).join('، ')}. راجع قائمة المواضع المتاحة لهذا النوع.`, 'unknown_placeholders');
  }
  return keys;
}

// Adds {{key}} (DD/MM/YYYY) and {{key:dash}} (DD-MM-YYYY) for an ISO date.
export function putDate(values, key, iso) {
  values[key] = fmtDate(iso);
  values[`${key}:dash`] = iso ? iso.split('-').reverse().join('-') : null;
}

export { fmtNum, fmtDate, todayParts };

export function createLetterService(db, storageDir) {
  // Resolve everything for the current company; throws if anything is missing.
  function resolve(company, tenant, input) {
    const type = db.prepare('SELECT id, code, name_ar FROM letter_types WHERE id = ? AND is_active = 1 AND category = \'letter\'').get(Number(input?.letter_type_id));
    if (!type) throw new HttpError(400, 'اختر نوع الخطاب.');
    if (!input?.employee_id) throw new HttpError(400, 'اختر الموظف.');
    const employee = tenant.get('employees', input.employee_id); // 404 if not in this company
    const template = db.prepare(`SELECT t.*, f.original_name FROM letter_templates t
                                 JOIN files f ON f.company_id = t.company_id AND f.id = t.file_id
                                 WHERE t.company_id = ? AND t.letter_type_id = ? AND t.is_active = 1`).get(company.id, type.id);
    if (!template) throw new HttpError(422, `لا يوجد نموذج معتمد لـ«${type.name_ar}» في ${company.name_ar}. يرجى التواصل مع مسؤول النظام.`, 'no_template');
    const used = new Set(JSON.parse(template.placeholders || '[]'));

    const pickAsset = (kind, id) => {
      const row = id
        ? db.prepare('SELECT * FROM brand_assets WHERE company_id = ? AND kind = ? AND id = ? AND is_active = 1').get(company.id, kind, Number(id))
        : db.prepare('SELECT * FROM brand_assets WHERE company_id = ? AND kind = ? AND is_active = 1 ORDER BY id LIMIT 1').get(company.id, kind);
      if (!row) throw new HttpError(422, kind === 'signature' ? `لا يوجد توقيع معتمد لـ ${company.name_ar}.` : `لا يوجد ختم معتمد لـ ${company.name_ar}.`);
      return row;
    };
    const wantSig = !!input.include_signature || used.has('signatory_name') || used.has('signatory_title');
    const signature = wantSig ? pickAsset('signature', input.signature_id) : null;
    const stamp = input.include_stamp ? pickAsset('stamp', input.stamp_id) : null;
    if (input.include_logo && !company.logo_file_id) throw new HttpError(422, `لا يوجد شعار معتمد لـ ${company.name_ar}.`);

    for (const r of [employee, template, signature, stamp]) {
      if (r && r.company_id !== company.id) throw new HttpError(500, 'تعارض في بيانات الشركة.');
    }

    const ctx = {
      company, employee, signature, today: todayParts(),
      referenceNo: input.__referenceNo || '(يُحدَّد عند الإصدار)',
      input: { addressee_ar: input.addressee_ar?.trim() || null, addressee_en: input.addressee_en?.trim() || null },
    };
    const fields = [...used].map((k) => {
      const [base, fmt] = k.split(':');
      const p = PLACEHOLDERS.find((x) => x.key === base);
      if (!p) return null; // image placeholder
      let v = p.get(ctx);
      if (fmt === 'dash' && typeof v === 'string') v = v.replace(/\//g, '-');
      return { key: k, label: p.label, value: v ?? null, missing: v === null || v === undefined || v === '' };
    }).filter(Boolean);
    const images = IMAGE_PLACEHOLDERS.filter((p) => used.has(p.key)).map((p) => ({
      key: p.key, label: p.label,
      included: p.key === 'logo' ? !!input.include_logo : p.key === 'signature' ? !!input.include_signature : !!input.include_stamp,
    }));
    return { type, employee, template, signature, stamp, fields, images, used };
  }

  function preview(company, tenant, input) {
    const r = resolve(company, tenant, input);
    return {
      company: { id: company.id, name_ar: company.name_ar },
      letter_type: { id: r.type.id, name_ar: r.type.name_ar },
      employee: { id: r.employee.id, full_name_ar: r.employee.full_name_ar },
      template: { id: r.template.id, version: r.template.version, file: r.template.original_name },
      signature: r.signature && { id: r.signature.id, label: r.signature.label, signatory_name: r.signature.signatory_name },
      stamp: r.stamp && { id: r.stamp.id, label: r.stamp.label },
      fields: r.fields,
      images: r.images,
      missing: r.fields.filter((f) => f.missing).map((f) => f.label),
    };
  }

  function issue(company, tenant, input, userId) {
    return tx(db, () => {
      const year = todayParts().year;
      const seq = db.prepare(`SELECT COUNT(*) + 1 AS n FROM issued_letters WHERE company_id = ? AND reference_no LIKE ?`).get(company.id, `%/${year}/%`).n;
      const referenceNo = `${company.code.toUpperCase()}/HR/${year}/${String(seq).padStart(4, '0')}`;
      const r = resolve(company, tenant, { ...input, __referenceNo: referenceNo });
      const missing = r.fields.filter((f) => f.missing);
      if (missing.length) throw new HttpError(422, `بيانات ناقصة مطلوبة في النموذج: ${missing.map((f) => f.label).join('، ')}.`, 'missing_fields');

      const values = Object.fromEntries(r.fields.map((f) => [f.key, f.value]));
      const img = (key, fileId) => {
        if (!r.used.has(key)) return undefined;
        const spec = IMAGE_PLACEHOLDERS.find((p) => p.key === key);
        return fileId ? { buffer: readFile(db, storageDir, company.id, fileId).buffer, maxHeightCm: spec.maxHeightCm, maxWidthCm: spec.maxWidthCm } : null;
      };
      const images = {};
      for (const [key, fileId] of [
        ['logo', input.include_logo ? company.logo_file_id : null],
        ['signature', input.include_signature ? r.signature?.file_id : null],
        ['stamp', input.include_stamp ? r.stamp?.file_id : null],
      ]) {
        const v = img(key, fileId);
        if (v !== undefined) images[key] = v;
      }

      const tpl = readFile(db, storageDir, company.id, r.template.file_id).buffer;
      let out;
      try { out = renderDocx(tpl, values, images); } catch (e) {
        if (e.message === 'IMAGE_FORMAT') throw new HttpError(422, 'صيغة صورة الشعار/التوقيع/الختم غير مدعومة في Word. استخدم PNG أو JPG.');
        throw e;
      }
      const safe = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').trim();
      const filename = `${safe(r.type.name_ar)} - ${safe(r.employee.full_name_ar)} - ${safe(referenceNo)}.docx`;
      const outId = saveFile(db, storageDir, { companyId: company.id, kind: 'letter', filename, buffer: out, allowed: ['docx'], userId });
      const ins = db.prepare(`INSERT INTO issued_letters (company_id, employee_id, letter_type_id, template_id, signature_asset_id, stamp_asset_id,
                              include_logo, reference_no, output_file_id, issued_by, addressee_ar, addressee_en, values_json)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        company.id, r.employee.id, r.type.id, r.template.id,
        input.include_signature ? r.signature?.id ?? null : null, input.include_stamp ? r.stamp?.id ?? null : null,
        input.include_logo ? 1 : 0, referenceNo, outId, userId, input.addressee_ar || null, input.addressee_en || null, JSON.stringify(values));
      return { id: Number(ins.lastInsertRowid), reference_no: referenceNo, filename };
    });
  }

  function list(company) {
    return db.prepare(`SELECT l.id, l.reference_no, l.issued_at, lt.name_ar AS letter_type, e.full_name_ar AS employee,
                              t.version AS template_version, u.display_name AS issued_by
                       FROM issued_letters l
                       JOIN letter_types lt ON lt.id = l.letter_type_id
                       JOIN employees e ON e.company_id = l.company_id AND e.id = l.employee_id
                       JOIN letter_templates t ON t.company_id = l.company_id AND t.id = l.template_id
                       LEFT JOIN users u ON u.id = l.issued_by
                       WHERE l.company_id = ? ORDER BY l.id DESC LIMIT 200`).all(company.id);
  }

  function file(company, id) {
    const l = db.prepare('SELECT output_file_id FROM issued_letters WHERE company_id = ? AND id = ?').get(company.id, Number(id));
    if (!l?.output_file_id) throw new HttpError(404, 'الخطاب غير موجود في الشركة الحالية.');
    return readFile(db, storageDir, company.id, l.output_file_id);
  }

  return { preview, issue, list, file };
}

