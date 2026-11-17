// Import of the company's "active employees" Excel file into the employee directory.
//
// Rules (agreed with the HR team):
//  - Matching is by employee number inside the selected company only.
//  - Found → the same record is updated (only cells that have a value; empty cells
//    never erase data). Not found → a new record, created only after the preview.
//  - A person recruitment added earlier («قيد الانضمام») is the same record: the
//    import updates it and never activates it (operations confirm the start).
//  - Employees missing from the file are not deleted and their status is not changed.
//  - No number, a number repeated in the file, or data that contradicts the record
//    (ID / name / an ended employee) → manual review, never an automatic merge.
//  - Procedures, bank accounts, attachments and history are linked to the record's
//    internal id and are never touched by an import.
// Preview and import run the very same code; the preview is rolled back.
import crypto from 'node:crypto';
import { readZip } from './docx/zip.js';
import { HttpError } from './errors.js';
import { tx } from './db.js';
import { normEmployeeNo, latinDigits, EMPLOYEE_STATUS } from './employees.js';

// ---------- reading .xlsx ----------
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const serialToIso = (n) => new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);

function dateStyles(entries) {
  const xml = entries.get('xl/styles.xml')?.toString('utf8') || '';
  const custom = new Map([...xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)].map((m) => [Number(m[1]), decode(m[2])]));
  const isDateFmt = (id) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47) ||
    (custom.has(id) && /[dmy]/i.test(custom.get(id).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')) && !/^[#0.,%\s]+$/.test(custom.get(id)));
  const xfs = (xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  return [...xfs.matchAll(/<xf\b([^>]*)/g)].map((m) => isDateFmt(Number((m[1].match(/numFmtId="(\d+)"/) || [])[1] || 0)));
}

/** Reads one sheet as rows of plain values (text, numbers; date cells as YYYY-MM-DD). */
export function readWorkbook(buffer, sheetIndex = 0) {
  let entries;
  try { entries = readZip(buffer); } catch { throw new HttpError(400, 'الملف ليس ملف Excel صالحًا (xlsx).', 'not_xlsx'); }
  const wb = entries.get('xl/workbook.xml')?.toString('utf8');
  if (!wb) throw new HttpError(400, 'الملف ليس ملف Excel صالحًا (xlsx).', 'not_xlsx');
  const rels = new Map([...(entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '').matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const sheets = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)].map((m) => {
    const t = rels.get(m[2]) || '';
    return { name: decode(m[1]), path: t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}` };
  }).filter((s) => entries.has(s.path));
  if (!sheets.length) throw new HttpError(400, 'لا توجد أوراق في الملف.', 'not_xlsx');
  const si = Math.min(Math.max(0, Number(sheetIndex) || 0), sheets.length - 1);
  const shared = [...(entries.get('xl/sharedStrings.xml')?.toString('utf8') || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const isDate = dateStyles(entries);
  const xml = entries.get(sheets[si].path).toString('utf8');
  const rows = [];
  let seq = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number((rm[1].match(/\br="(\d+)"/) || [])[1]) || seq + 1;
    seq = rowNo;
    const cells = [];
    let ci = -1;
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      ci = ref ? colIndex(ref) : ci + 1;
      const t = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const s = Number((attrs.match(/\bs="(\d+)"/) || [])[1] || 0);
      const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let val = null;
      if (t === 's') val = v !== undefined ? shared[Number(v)] ?? null : null;
      else if (t === 'inlineStr') val = textOf(inner);
      else if (t === 'str' || t === 'e') val = v !== undefined ? decode(v) : null;
      else if (t === 'b') val = v === '1';
      else if (v !== undefined) { const n = Number(v); val = isDate[s] && n > 0 && n < 2958466 ? serialToIso(n) : n; }
      if (typeof val === 'string') val = val.trim() || null;
      cells[ci] = val;
    }
    if (cells.some((c) => c !== null && c !== undefined && c !== '')) rows.push({ rowNo, cells });
  }
  return { sheets: sheets.map((s) => s.name), sheet: si, rows };
}

// ---------- columns ----------
export const IMPORT_FIELDS = {
  employee_no: 'الرقم الوظيفي', full_name_ar: 'الاسم بالعربية', full_name_en: 'الاسم بالإنجليزية', national_id: 'رقم الهوية / الإقامة',
  gender: 'الجنس', nationality_ar: 'الجنسية (عربي)', nationality_en: 'الجنسية (إنجليزي)', job_title: 'المسمى الوظيفي (عربي)',
  job_title_en: 'المسمى الوظيفي (إنجليزي)', department: 'الإدارة', hire_date: 'تاريخ المباشرة',
  basic_salary: 'الراتب الأساسي', housing_allowance: 'بدل السكن', transport_allowance: 'بدل النقل', other_allowance: 'بدلات أخرى',
};
const normHeader = (s) => latinDigits(String(s ?? '')).replace(/[ـً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .toLowerCase().replace(/[\s:./\\\-_()#*]+/g, '');
const SYNONYMS = {
  employee_no: ['الرقم الوظيفي', 'رقم وظيفي', 'رقم الموظف', 'كود الموظف', 'الكود الوظيفي', 'employee no', 'employee number', 'emp no', 'emp id', 'employee id', 'employee code', 'staff id', 'staff no', 'emp code'],
  national_id: ['رقم الهوية', 'الهوية', 'رقم الاقامة', 'الاقامة', 'رقم الهوية الاقامة', 'الهوية الاقامة', 'رقم الهويه', 'national id', 'iqama', 'iqama no', 'iqama number', 'id number', 'national id iqama', 'id iqama'],
  full_name_ar: ['الاسم', 'اسم الموظف', 'الاسم بالعربي', 'الاسم بالعربية', 'الاسم الكامل', 'الاسم عربي', 'arabic name', 'name ar', 'name arabic'],
  full_name_en: ['الاسم بالانجليزي', 'الاسم بالانجليزيه', 'الاسم انجليزي', 'english name', 'name en', 'name english', 'employee name', 'full name', 'name'],
  gender: ['الجنس', 'gender', 'sex'],
  nationality_ar: ['الجنسية', 'الجنسيه', 'الجنسية عربي'],
  nationality_en: ['nationality', 'الجنسية انجليزي'],
  job_title: ['المسمى الوظيفي', 'المسمي الوظيفي', 'المسمى', 'الوظيفة', 'المهنة', 'المسمى الوظيفي عربي'],
  job_title_en: ['job title', 'position', 'designation', 'title', 'المسمى الوظيفي انجليزي'],
  department: ['الادارة', 'القسم', 'الاداره', 'department', 'dept'],
  hire_date: ['تاريخ المباشرة', 'تاريخ المباشره', 'تاريخ التعيين', 'تاريخ الالتحاق', 'hire date', 'joining date', 'date of joining', 'doj', 'start date', 'join date'],
  basic_salary: ['الراتب الاساسي', 'الاساسي', 'basic salary', 'basic'],
  housing_allowance: ['بدل السكن', 'السكن', 'housing', 'housing allowance'],
  transport_allowance: ['بدل النقل', 'بدل المواصلات', 'النقل', 'transport', 'transportation', 'transport allowance', 'transportation allowance'],
  other_allowance: ['بدلات اخرى', 'بدلات اخري', 'other allowance', 'other allowances'],
};
const SYN = new Map(Object.entries(SYNONYMS).flatMap(([f, list]) => list.map((h) => [normHeader(h), f])));

function detectHeader(rows) {
  let best = null;
  for (const r of rows.slice(0, 15)) {
    const fields = r.cells.map((c) => (typeof c === 'string' ? SYN.get(normHeader(c)) ?? null : null));
    const n = new Set(fields.filter(Boolean)).size;
    if (n >= 2 && (!best || n > best.n)) best = { row: r, fields, n };
  }
  return best;
}

// ---------- values ----------
const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;
const DMY_RE = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
function cleanValue(field, raw, warn) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (field === 'employee_no') return normEmployeeNo(typeof raw === 'number' ? String(Math.round(raw * 1e6) / 1e6) : raw);
  if (field === 'national_id') return latinDigits(typeof raw === 'number' ? String(Math.round(raw)) : raw).replace(/\s+/g, '').toUpperCase() || null;
  if (field === 'hire_date') {
    if (typeof raw === 'number') {
      if (raw > 20000 && raw < 80000) return serialToIso(raw);
      warn(`«${IMPORT_FIELDS[field]}» غير مفهوم (${raw}) — لم يُستورد`); return null;
    }
    const s = latinDigits(raw).trim();
    let y, m, d;
    if (DATE_RE.test(s)) [, y, m, d] = s.match(DATE_RE);
    else if (DMY_RE.test(s)) [, d, m, y] = s.match(DMY_RE);
    else { warn(`«${IMPORT_FIELDS[field]}» غير مفهوم (${s}) — لم يُستورد`); return null; }
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (Number(y) < 1950 || Number.isNaN(Date.parse(iso)) || new Date(iso).toISOString().slice(0, 10) !== iso) {
      warn(`«${IMPORT_FIELDS[field]}» غير صالح (${s}) — هل هو هجري؟ لم يُستورد`); return null;
    }
    return iso;
  }
  if (/salary|allowance/.test(field)) {
    const n = typeof raw === 'number' ? raw : Number(latinDigits(raw).replace(/[,\s٬]/g, ''));
    if (!Number.isFinite(n)) { warn(`«${IMPORT_FIELDS[field]}» ليس رقمًا — لم يُستورد`); return null; }
    return n;
  }
  if (field === 'gender') {
    const g = normHeader(raw);
    if (['ذكر', 'male', 'm'].includes(g)) return 'male';
    if (['انثي', 'female', 'f'].includes(g)) return 'female';
    warn(`«الجنس» غير مفهوم (${raw}) — لم يُستورد`); return null;
  }
  return String(raw).replace(/\s+/g, ' ').trim() || null;
}
const normName = (s) => String(s || '').replace(/[ـً-ْ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim().toLowerCase();
const normId = (s) => latinDigits(String(s || '')).replace(/\s+/g, '').toUpperCase();
const same = (field, a, b) => {
  if (a === null || a === undefined || a === '') return b === null || b === undefined || b === '';
  if (/salary|allowance/.test(field)) return Number(a) === Number(b);
  if (field === 'employee_no') return normEmployeeNo(a) === normEmployeeNo(b);
  if (field === 'national_id') return normId(a) === normId(b);
  return String(a).trim() === String(b ?? '').trim();
};
const namesClash = (a, b) => { const x = normName(a), y = normName(b); return !!x && !!y && x !== y && !x.includes(y) && !y.includes(x); };

// ---------- plan + run ----------
export function createEmployeeImport(db) {
  const REASON = {
    no_number: 'لا يوجد رقم وظيفي في الملف',
    dup_in_file: 'الرقم الوظيفي مكرر داخل الملف',
    conflict: 'بيانات الملف تتعارض مع السجل',
    link_candidate: 'سجل موجود بنفس رقم الهوية بدون رقم وظيفي (غالبًا أضافه التوظيف)',
    possible_match: 'سجل موجود بنفس الاسم',
  };

  function plan(company, rows, columns) {
    const emps = db.prepare('SELECT * FROM employees WHERE company_id = ?').all(company.id);
    const byNo = new Map(emps.filter((e) => normEmployeeNo(e.employee_no)).map((e) => [normEmployeeNo(e.employee_no), e]));
    const byNid = new Map();
    for (const e of emps) if (normId(e.national_id)) byNid.set(normId(e.national_id), e);
    const label = (e) => ({ id: e.id, employee_no: e.employee_no, full_name_ar: e.full_name_ar, status: e.status, status_label: EMPLOYEE_STATUS[e.status] ?? e.status });
    const fieldCols = columns.filter((c) => c.field);
    const records = rows.map((r) => {
      const warnings = [];
      const rec = {};
      for (const c of fieldCols) {
        const v = cleanValue(c.field, r.cells[c.index], (w) => warnings.push(w));
        if (v !== null && v !== undefined && rec[c.field] == null) rec[c.field] = v;
      }
      return { row: r.rowNo, rec, warnings };
    }).filter((x) => Object.keys(x.rec).length);
    const countNo = new Map();
    for (const x of records) if (x.rec.employee_no) countNo.set(x.rec.employee_no, (countNo.get(x.rec.employee_no) || 0) + 1);
    const diff = (e, rec) => Object.keys(rec).filter((f) => !same(f, rec[f], e[f])).map((f) => ({ field: f, label: IMPORT_FIELDS[f], from: e[f] ?? null, to: rec[f] }));

    const out = records.map(({ row, rec, warnings }) => {
      const base = { row, employee_no: rec.employee_no ?? null, name: rec.full_name_ar || rec.full_name_en || null, warnings, rec };
      const nidHit = rec.national_id ? byNid.get(normId(rec.national_id)) : null;
      const nameHits = emps.filter((e) => (rec.full_name_ar && normName(e.full_name_ar) === normName(rec.full_name_ar)) || (rec.full_name_en && e.full_name_en && normName(e.full_name_en) === normName(rec.full_name_en)));
      const linkable = (e) => !normEmployeeNo(e.employee_no);
      if (!rec.employee_no) {
        const cands = [...new Set([nidHit, ...nameHits].filter(Boolean))];
        return { ...base, kind: 'review', reason: 'no_number', candidates: cands.map(label),
          options: ['skip', ...cands.filter(linkable).map((e) => `link:${e.id}`), 'create'], default: 'skip' };
      }
      if (countNo.get(rec.employee_no) > 1) return { ...base, kind: 'review', reason: 'dup_in_file', options: ['skip'], default: 'skip' };
      const e = byNo.get(rec.employee_no);
      if (e) {
        const issues = [];
        if (rec.national_id && e.national_id && normId(rec.national_id) !== normId(e.national_id)) issues.push(`رقم الهوية في الملف (${rec.national_id}) يختلف عن السجل (${e.national_id})`);
        if (nidHit && nidHit.id !== e.id) issues.push(`رقم الهوية في الملف مسجل لموظف آخر: ${nidHit.full_name_ar}${nidHit.employee_no ? ` (${nidHit.employee_no})` : ''}`);
        if (namesClash(rec.full_name_ar, e.full_name_ar)) issues.push(`الاسم في الملف «${rec.full_name_ar}» يختلف عن السجل «${e.full_name_ar}»`);
        if (e.status === 'inactive') issues.push('الموظف «منتهي الخدمة» في المنصة لكنه في ملف النشطين — لن تتغير حالته');
        const changes = diff(e, rec);
        if (issues.length) {
          const blocked = nidHit && nidHit.id !== e.id;
          return { ...base, kind: 'review', reason: 'conflict', issues, employee: label(e), changes, options: blocked || !changes.length ? ['skip'] : ['skip', `update:${e.id}`], default: 'skip' };
        }
        return { ...base, kind: changes.length ? 'update' : 'unchanged', employee: label(e), changes, onboarding: e.status === 'onboarding' };
      }
      if (nidHit) {
        if (!linkable(nidHit)) {
          return { ...base, kind: 'review', reason: 'conflict', issues: [`رقم الهوية مسجل لموظف آخر برقم وظيفي مختلف: ${nidHit.full_name_ar} (${nidHit.employee_no})`], employee: label(nidHit), options: ['skip'], default: 'skip' };
        }
        const issues = namesClash(rec.full_name_ar, nidHit.full_name_ar) ? [`الاسم في الملف «${rec.full_name_ar}» يختلف عن السجل «${nidHit.full_name_ar}»`] : [];
        return { ...base, kind: 'review', reason: 'link_candidate', issues, employee: label(nidHit), changes: diff(nidHit, rec),
          options: ['skip', `link:${nidHit.id}`], default: issues.length ? 'skip' : `link:${nidHit.id}` };
      }
      if (nameHits.length) {
        return { ...base, kind: 'review', reason: 'possible_match', candidates: nameHits.map(label),
          options: ['skip', ...nameHits.filter(linkable).map((x) => `link:${x.id}`), 'create'], default: 'skip' };
      }
      return { ...base, kind: 'create' };
    });
    const inFile = new Set(records.map((x) => x.rec.employee_no).filter(Boolean));
    const linkedIds = new Set(out.filter((r) => r.kind === 'review' && String(r.default).startsWith('link:')).map((r) => Number(r.default.split(':')[1])));
    const notInFile = emps.filter((e) => e.status !== 'inactive' && !(normEmployeeNo(e.employee_no) && inFile.has(normEmployeeNo(e.employee_no))) && !linkedIds.has(e.id)).map(label);
    return { rows: out, notInFile };
  }

  // Runs the plan inside a transaction; dryRun rolls everything back (the preview).
  function run(company, tenant, input, { dryRun, userId }) {
    input = input || {};
    if (!input.file || typeof input.file.data !== 'string') throw new HttpError(400, 'أرفق ملف Excel للموظفين النشطين.');
    const buffer = Buffer.from(input.file.data, 'base64');
    if (!buffer.length) throw new HttpError(400, 'الملف فارغ.');
    if (buffer.length > 15 * 1024 * 1024) throw new HttpError(413, 'حجم الملف يتجاوز 15 ميجابايت.');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!dryRun && input.sha256 && input.sha256 !== sha256) throw new HttpError(409, 'الملف تغيّر بعد المعاينة. أعد المعاينة.', 'file_changed');
    const wb = readWorkbook(buffer, input.sheet);
    const header = detectHeader(wb.rows);
    const headerRow = input.header_row ? wb.rows.find((r) => r.rowNo === Number(input.header_row)) : header?.row;
    if (!headerRow) throw new HttpError(400, 'لم أتعرف على صف العناوين في الملف (مثل «الرقم الوظيفي» و«الاسم»). تأكد أن أول صفوف الورقة تحتوي العناوين.', 'no_header');
    const dataRows = wb.rows.filter((r) => r.rowNo > headerRow.rowNo);
    if (dataRows.length > 5000) throw new HttpError(400, 'الملف أكبر من 5000 صف.');
    const auto = header && header.row === headerRow ? header.fields : headerRow.cells.map((c) => (typeof c === 'string' ? SYN.get(normHeader(c)) ?? null : null));
    const mapping = input.mapping && typeof input.mapping === 'object' ? input.mapping : null;
    const width = Math.max(headerRow.cells.length, ...dataRows.slice(0, 50).map((r) => r.cells.length));
    const used = new Set();
    const columns = Array.from({ length: width }, (_, i) => {
      let field = mapping ? (mapping[i] ?? mapping[String(i)] ?? null) : auto[i] ?? null;
      if (field && (!IMPORT_FIELDS[field] || used.has(field))) field = null; // unknown or mapped twice
      if (field) used.add(field);
      return { index: i, header: headerRow.cells[i] == null ? '' : String(headerRow.cells[i]), field, sample: dataRows.slice(0, 3).map((r) => r.cells[i]).filter((v) => v != null).map(String) };
    }).filter((c) => c.header || c.sample.length);
    const base = { filename: String(input.file.filename || '').slice(0, 200), sha256, sheets: wb.sheets, sheet: wb.sheet, header_row: headerRow.rowNo, columns, fields: IMPORT_FIELDS };
    const previous = db.prepare(`SELECT i.created_at, u.display_name AS user_name FROM employee_imports i LEFT JOIN users u ON u.id = i.user_id
                                 WHERE i.company_id = ? AND i.sha256 = ? ORDER BY i.id DESC LIMIT 1`).get(company.id, sha256) || null;
    if (!used.has('employee_no')) {
      return { ...base, previous_import: previous, missing_employee_no: true, summary: null, rows: [], not_in_file: [] };
    }

    const { rows, notInFile } = plan(company, dataRows, columns);
    const decisions = input.decisions && typeof input.decisions === 'object' ? input.decisions : {};
    const counts = { total: rows.length, create: 0, update: 0, linked: 0, unchanged: 0, skipped: 0, review: 0, error: 0 };
    const execute = () => {
      const importId = Number(db.prepare(`INSERT INTO employee_imports (company_id, filename, sha256, rows_total, mapping_json, user_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(company.id, base.filename, sha256, rows.length, JSON.stringify(Object.fromEntries(columns.filter((c) => c.field).map((c) => [c.header, c.field]))), userId ?? null).lastInsertRowid);
      const tag = `استيراد ملف النشطين «${base.filename}» (صف ${'{row}'})`;
      for (const r of rows) {
        let action = r.kind === 'create' ? 'create' : r.kind === 'update' ? `update:${r.employee.id}` : r.kind === 'unchanged' ? 'none' : 'skip';
        if (r.kind === 'review') {
          counts.review++;
          const chosen = decisions[r.row] ?? r.default;
          r.action = r.options.includes(chosen) ? chosen : r.default;
          action = r.action;
        }
        const detail = tag.replace('{row}', r.row);
        try {
          tx(db, () => { // one savepoint per row: a bad row never blocks the others
            if (action === 'create') {
              const e = tenant.create('employees', { ...r.rec, status: 'active' }, userId, { event: 'imported', detail: `${detail} — سجل جديد`, importId });
              r.result = { employee_id: e.id };
              counts.create++;
            } else if (action.startsWith('update:') || action.startsWith('link:')) {
              const id = Number(action.split(':')[1]);
              const e = tenant.get('employees', id);
              const ch = Object.fromEntries(Object.keys(r.rec).filter((f) => !same(f, r.rec[f], e[f])).map((f) => [f, r.rec[f]]));
              // the status is never changed by an import (onboarding stays onboarding)
              if (Object.keys(ch).length) tenant.update('employees', id, ch, userId, { event: action.startsWith('link:') ? 'import_linked' : 'import_updated', detail: `${detail}${action.startsWith('link:') ? ' — رُبط بسجل موجود' : ''}`, importId });
              r.result = { employee_id: id };
              if (action.startsWith('link:')) counts.linked++; else counts.update++;
            } else if (action === 'none') counts.unchanged++;
            else counts.skipped++;
          });
        } catch (err) {
          r.kind = 'error';
          r.error = err.message;
          counts.error++;
        }
      }
      db.prepare(`UPDATE employee_imports SET created_count = ?, updated_count = ?, linked_count = ?, unchanged_count = ?, skipped_count = ? WHERE company_id = ? AND id = ?`)
        .run(counts.create, counts.update, counts.linked, counts.unchanged, counts.skipped + counts.error, company.id, importId);
      return importId;
    };

    let importId = null;
    if (dryRun) {
      db.exec('BEGIN IMMEDIATE');
      try { execute(); } finally { db.exec('ROLLBACK'); }
    } else {
      importId = tx(db, execute);
    }
    const reasonText = (r) => r.reason ? REASON[r.reason] : null;
    return {
      ...base, dry_run: dryRun, import_id: importId, previous_import: previous, summary: counts,
      rows: rows.map(({ rec, ...r }) => ({ ...r, reason_text: reasonText(r), fields: Object.keys(rec) })),
      not_in_file: notInFile,
    };
  }

  const history = (company) => db.prepare(`SELECT i.id, i.filename, i.rows_total, i.created_count, i.updated_count, i.linked_count, i.unchanged_count, i.skipped_count, i.created_at, u.display_name AS user_name
                                           FROM employee_imports i LEFT JOIN users u ON u.id = i.user_id WHERE i.company_id = ? ORDER BY i.id DESC LIMIT 50`).all(company.id);

  return {
    preview: (company, tenant, input, userId) => run(company, tenant, input, { dryRun: true, userId }),
    apply: (company, tenant, input, userId) => run(company, tenant, input, { dryRun: false, userId }),
    history,
  };
}
