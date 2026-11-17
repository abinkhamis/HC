// Turns an official Word document (often a filled-in example) into a reusable
// template WITHOUT the user editing Word: the document's boxes (table cells and
// paragraphs) are listed, a field is suggested for each one, and the user's
// choices are applied to a COPY of the file. Only the text of the linked boxes
// changes; each line keeps its own paragraph and run formatting and any image
// in the box (e.g. the riyal symbol) stays where it is. Everything else (images,
// tables, fonts, headers/footers, page setup, other parts) is untouched, and
// verifyFormatting() proves it before a version can be approved.
import { readZip, writeZip } from './zip.js';

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[e]) return map[e];
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const encode = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- minimal balanced-element scanner for WordprocessingML ----------
// Top-level elements <w:tag …>…</w:tag> (or self-closing) between from and to.
function elements(xml, tag, from = 0, to = xml.length) {
  const open = new RegExp(`<w:${tag}(?=[\\s>/])`, 'g');
  const any = new RegExp(`<w:${tag}(?=[\\s>/])|</w:${tag}>`, 'g');
  const out = [];
  let i = from;
  while (i < to) {
    open.lastIndex = i;
    const m = open.exec(xml);
    if (!m || m.index >= to) break;
    const start = m.index;
    const gt = xml.indexOf('>', start);
    if (xml[gt - 1] === '/') { out.push({ start, end: gt + 1 }); i = gt + 1; continue; }
    let depth = 1;
    let j = gt + 1;
    while (depth > 0) {
      any.lastIndex = j;
      const n = any.exec(xml);
      if (!n) throw new Error('MALFORMED');
      if (n[0].startsWith('</')) { depth--; j = n.index + n[0].length; } else { const g = xml.indexOf('>', n.index); if (xml[g - 1] !== '/') depth++; j = g + 1; }
    }
    out.push({ start, end: j });
    i = j;
  }
  return out;
}
const T_RE = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
const textOf = (xml) => decode([...xml.matchAll(T_RE)].map((m) => m[1]).join(''));
// One line per paragraph (a cell may hold several lines, e.g. method / bank / IBAN).
const linesOf = (xml) => {
  const ls = elements(xml, 'p').map((p) => textOf(xml.slice(p.start, p.end)).trim());
  return ls.filter((l) => l).length ? ls.filter((l) => l) : [''];
};
const hasDrawing = (xml) => /<w:drawing>|<w:pict>|<w:object/.test(xml);

/** Lists the boxes of document.xml: every table cell and every top-level paragraph. */
export function listSlots(docXml) {
  const bodyStart = docXml.indexOf('<w:body>') + '<w:body>'.length;
  const bodyEnd = docXml.lastIndexOf('</w:body>');
  const slots = [];
  const tables = elements(docXml, 'tbl', bodyStart, bodyEnd);
  const inTable = (pos) => tables.some((t) => pos >= t.start && pos < t.end);
  let nested = false;
  tables.forEach((t, ti) => {
    elements(docXml, 'tr', t.start, t.end).forEach((r, ri) => {
      const cells = elements(docXml, 'tc', r.start, r.end);
      cells.forEach((c, ci) => {
        const xml = docXml.slice(c.start, c.end);
        if (/<w:tbl>/.test(xml)) nested = true;
        slots.push({ id: `t${ti}.r${ri}.c${ci}`, kind: 'cell', table: ti, row: ri, col: ci, cols: cells.length, start: c.start, end: c.end,
          text: linesOf(xml).join('\n'), drawing: hasDrawing(xml), merged: /<w:gridSpan\b/.test(xml) });
      });
    });
  });
  let pi = 0;
  for (const p of elements(docXml, 'p', bodyStart, bodyEnd)) {
    if (inTable(p.start)) continue;
    const xml = docXml.slice(p.start, p.end);
    slots.push({ id: `p${pi++}`, kind: 'paragraph', start: p.start, end: p.end, text: textOf(xml).trim(), drawing: hasDrawing(xml) });
  }
  return { slots, nested, tables: tables.length };
}

// ---------- suggestions ----------
const IBAN_RE = /\bSA\d{2}[0-9A-Z]{18,20}\b/i;
const DATE_RE = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g;
const AMOUNT_RE = /^[\d,٬.\s]+(ر\.?س|SAR|ريال)?$/i;
// Label words (Arabic / English) → field. More specific first.
const LABELS = [
  { re: /الإجمالي|الاجمالي|total/i, field: 'certificate_total' },
  { re: /قيمة|المبلغ|amount|value/i, field: 'deliverable_amount' },
  { re: /فترة|period|delivery date/i, field: 'period' },
  { re: /المخرجات|المخرج|وصف|details|description|deliverable/i, field: 'deliverable_title' },
  { re: /رقم العقد|contract no|contract number/i, field: 'contract_ref' },
  { re: /رقم الشهادة|certificate no/i, field: 'certificate_ref' },
  { re: /الآيبان|الايبان|iban/i, field: 'consultant_iban' },
  { re: /البنك|bank/i, field: 'consultant_bank_name' },
  { re: /اسم الاستشاري|consultant name|اسم الموظف|employee name|^الاسم\b|name/i, field: 'consultant_name_ar' },
];
const labelish = (text) => !!text && text.length <= 60 && !IBAN_RE.test(text) && !/\d{3,}/.test(text);
const bilingual = (text) => labelish(text) && /[a-z]{3,}/i.test(text) && /[؀-ۿ]/.test(text) && text.includes('/');
const wordLabel = (text) => labelish(text) && LABELS.some((l) => l.re.test(text));
// Which cells of a row are labels: bilingual "عربي / English" cells when the row has
// any; otherwise cells matching label words — but only if the row is not ambiguous.
function rowLabels(row) {
  const strong = row.filter((c) => bilingual(c.text));
  if (strong.length) return new Set(strong.map((c) => c.id));
  const weak = row.filter((c) => wordLabel(c.text));
  return new Set(weak.length && weak.length < row.filter((c) => c.text).length ? weak.map((c) => c.id) : []);
}

// "method / bank / IBAN" on separate lines (or one line separated by "/").
function bankPattern(text) {
  const multi = text.includes('\n');
  const parts = (multi ? text.split('\n') : text.split('/')).map((x) => x.trim()).filter(Boolean);
  const mapped = parts.map((p) => (IBAN_RE.test(p) ? '{{consultant_iban}}' : /مصرف|بنك|bank/i.test(p) && !/تحويل|transfer/i.test(p) ? '{{consultant_bank_name}}' : p));
  return mapped.join(multi ? '\n' : ' / ');
}
function periodPattern(text) {
  const dates = [...text.matchAll(DATE_RE)];
  if (dates.length !== 2) return null;
  const sep = text.slice(dates[0].index + dates[0][0].length, dates[1].index).trim() || '-';
  const dash = dates[0][0].includes('-') ? ':dash' : '';
  return `{{deliverable_period_from${dash}}} ${sep} {{deliverable_period_to${dash}}}`;
}

/**
 * Suggests a decision for every box. confidence: 'high' (label and content agree),
 * 'check' (one signal only or label/content mismatch — must be confirmed),
 * 'unknown' (cannot tell — the user decides). Labels stay fixed text.
 */
export function suggest(slots) {
  const byRow = new Map();
  for (const s of slots.filter((x) => x.kind === 'cell')) {
    const k = `${s.table}.${s.row}`;
    if (!byRow.has(k)) byRow.set(k, []);
    byRow.get(k).push(s);
  }
  const out = {};
  for (const s of slots) {
    if (s.kind === 'paragraph') {
      const data = IBAN_RE.test(s.text) || [...s.text.matchAll(DATE_RE)].length > 0 || (AMOUNT_RE.test(s.text) && /\d/.test(s.text));
      out[s.id] = data ? { mode: 'fixed', confidence: 'unknown', reason: 'فقرة تحتوي بيانات تبدو متغيرة (تاريخ / مبلغ / آيبان)؛ حدّد هل تُربط بحقل.' }
        : { mode: 'fixed', confidence: 'high', reason: s.text ? 'نص ثابت من النموذج' : 'فقرة فارغة', quiet: true };
      continue;
    }
    const row = byRow.get(`${s.table}.${s.row}`);
    if (row.length === 1 && s.merged && s.text && !IBAN_RE.test(s.text) && !/\d{3,}/.test(s.text)) { out[s.id] = { mode: 'fixed', confidence: 'high', reason: 'عنوان الجدول (نص ثابت)', quiet: true, is_label: true }; continue; }
    const labels = rowLabels(row);
    if (labels.has(s.id)) { out[s.id] = { mode: 'fixed', confidence: 'high', reason: 'عنوان خانة (نص ثابت)', quiet: true, is_label: true }; continue; }
    const labelCell = row.find((c) => c !== s && labels.has(c.id));
    const label = labelCell?.text || '';
    if (s.drawing && !s.text) { out[s.id] = { mode: 'fixed', confidence: 'high', reason: 'تحتوي صورة فقط — تبقى كما هي', quiet: true, label }; continue; }
    // approvals table: «الاسم / Full Name | n1 | n2 | n3», then signature and date rows
    if (labelCell && /الاسم|full name/i.test(label) && row.length >= 3) {
      const n = row.filter((c) => c !== labelCell).indexOf(s) + 1;
      out[s.id] = { mode: 'field', pattern: `{{approver_${n}_name}}`, confidence: 'high', reason: `اسم المعتمد ${n} (يُدخل عند كل إصدار)`, label };
      continue;
    }
    if (labelCell && /التوقيع|signature|التاريخ|date/i.test(label) && !/فترة|delivery/i.test(label)) {
      out[s.id] = { mode: 'blank', confidence: 'high', reason: 'خانة توقيع / تاريخ توقيع — تبقى فارغة', label };
      continue;
    }
    if (!s.text) { out[s.id] = { mode: 'fixed', confidence: 'high', reason: 'خانة فارغة', quiet: true, label }; continue; }
    const byLabel = LABELS.find((l) => l.re.test(label))?.field || null;
    const byContent = IBAN_RE.test(s.text) ? 'bank' : periodPattern(s.text) ? 'period' : AMOUNT_RE.test(s.text) && /\d/.test(s.text) ? 'amount' : null;
    let pattern = null;
    let confidence = 'unknown';
    let reason = 'لم يُتعرَّف على هذه الخانة؛ اختر الحقل المناسب أو أبقها نصًا ثابتًا.';
    if (byContent === 'bank') {
      pattern = bankPattern(s.text);
      confidence = byLabel === 'consultant_iban' || byLabel === 'consultant_bank_name' ? 'high' : 'check';
      reason = confidence === 'high' ? 'بيانات بنكية' : `تحتوي بيانات بنكية بينما عنوانها «${label}» — راجع الربط`;
    } else if (byContent === 'period') {
      pattern = periodPattern(s.text);
      confidence = byLabel === 'period' ? 'high' : 'check';
      reason = 'فترة من … إلى …';
    } else if (byContent === 'amount') {
      pattern = byLabel === 'certificate_total' ? '{{certificate_total}}' : '{{deliverable_amount}}';
      confidence = byLabel === 'certificate_total' || byLabel === 'deliverable_amount' ? 'high' : 'check';
      reason = byLabel === 'certificate_total' ? 'إجمالي قيمة المخرجات المشمولة في الشهادة' : 'قيمة المخرج';
    } else if (byLabel && !['consultant_iban', 'consultant_bank_name', 'period'].includes(byLabel)) {
      pattern = `{{${byLabel}}}`;
      confidence = byLabel === 'consultant_name_ar' && /موظف|employee/i.test(label) ? 'check' : 'high';
      reason = confidence === 'check' ? `العنوان «${label}» — يُقترح ربطها باسم الاستشاري` : `حسب عنوان الخانة «${label}»`;
    }
    out[s.id] = pattern ? { mode: 'field', pattern, confidence, reason, label } : { mode: 'fixed', confidence, reason, label };
  }
  return out;
}

// ---------- apply ----------
// Rewrites one paragraph's text, keeping its paragraph properties, the formatting
// of its first text run and any image runs exactly where they are.
// Fields whose values read left-to-right (dates, numbers, IBAN, references, English text).
const LTR_KEY = /(_date|_from|_to|iban|swift|amount|total|_ref|_no\b|_en\b|mobile|email|id_number)/;
const ARABIC = /[؀-ۿ]/;
const run = (rPr, text) => `<w:r>${rPr}<w:t xml:space="preserve">${encode(text)}</w:t></w:r>`;

// Builds the runs of one line. A line that mixes Arabic text and left-to-right
// values (e.g. "{{from}} حتى {{to}}") is split so each part reuses the formatting
// the original used for Arabic text or for numbers — otherwise Word's bidi
// algorithm can reverse dates such as 31-01-2030.
function lineRuns(text, rprs) {
  const parts = text.split(/(\{\{\s*[a-zA-Z0-9_]+(?::[a-z]+)?\s*\}\})/).filter((x) => x !== '');
  if (parts.length <= 1) return run(rprs.first, text);
  return parts.map((part) => {
    const key = part.match(/^\{\{\s*([a-zA-Z0-9_]+)/)?.[1];
    const ltr = key ? LTR_KEY.test(key) : !ARABIC.test(part) && /[0-9A-Za-z]/.test(part);
    return run(ltr ? rprs.ltr : rprs.rtl, part);
  }).join('');
}

function rewriteParagraph(p, text) {
  const openTag = p.match(/^<w:p\b[^>]*>/)?.[0] || '<w:p>';
  const pPr = p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || '';
  const runs = elements(p, 'r').map((r) => p.slice(r.start, r.end));
  const markRPr = pPr.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/);
  const rPrOf = (r) => r?.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || '';
  const textRuns = runs.filter((r) => !hasDrawing(r) && /<w:t[\s>]/.test(r));
  const first = textRuns.length ? rPrOf(textRuns[0]) : markRPr ? `<w:rPr>${markRPr[1]}</w:rPr>` : '';
  const rprs = {
    first,
    rtl: rPrOf(textRuns.find((r) => ARABIC.test(textOf(r)))) || first,
    ltr: rPrOf(textRuns.find((r) => /[0-9A-Za-z]/.test(textOf(r)) && !ARABIC.test(textOf(r)))) || first,
  };
  let placed = false;
  const out = [];
  for (const r of runs) {
    if (hasDrawing(r)) { out.push(r); continue; }
    if (!/<w:t[\s>]/.test(r)) continue; // breaks/tabs/empty runs of the old text are dropped
    if (!placed && text) out.push(lineRuns(text, rprs));
    placed = true;
  }
  if (!placed && text) out.push(lineRuns(text, rprs));
  return `${openTag}${pPr}${out.join('')}</w:p>`;
}

// A box's text becomes the given lines (one per paragraph). Extra old lines are
// removed unless they hold an image; extra new lines reuse the last line's format.
function rewriteBox(xml, pattern) {
  const paras = elements(xml, 'p');
  if (!paras.length) throw new Error('NO_PARAGRAPH');
  const ps = paras.map((p) => xml.slice(p.start, p.end));
  // empty lines of the original (spacing) are kept as they are
  const textual = ps.map((p, i) => ({ p, i, hasText: !!textOf(p).trim() }));
  const lines = pattern === '' ? [] : String(pattern).split('\n');
  const target = textual.filter((x) => x.hasText);
  const outs = ps.slice();
  if (!target.length) {
    if (lines.length) outs[0] = rewriteParagraph(ps[0], lines[0]);
    for (let k = 1; k < lines.length; k++) outs.splice(1 + k - 1, 0, rewriteParagraph(ps[0], lines[k]));
  } else {
    const drop = new Set();
    target.forEach((x, k) => {
      if (k < lines.length) outs[x.i] = rewriteParagraph(x.p, lines[k]);
      else if (hasDrawing(x.p)) outs[x.i] = rewriteParagraph(x.p, '');
      else drop.add(x.i);
    });
    const last = target[target.length - 1];
    const extra = lines.slice(target.length).map((l) => rewriteParagraph(last.p, l));
    if (extra.length) outs[last.i] = outs[last.i] + extra.join('');
    for (const i of [...drop].sort((a, b) => b - a)) outs.splice(i, 1);
  }
  return xml.slice(0, paras[0].start) + outs.join('') + xml.slice(paras[paras.length - 1].end);
}

/**
 * mapping: { slotId: { mode: 'field', pattern } | { mode: 'blank' } | { mode: 'fixed' } }
 * Returns a new .docx buffer. Throws with code when a box cannot be rewritten safely.
 */
export function applyMapping(docxBuffer, mapping) {
  const entries = readZip(docxBuffer);
  const doc = entries.get('word/document.xml').toString('utf8');
  const { slots, nested } = listSlots(doc);
  if (nested) throw Object.assign(new Error('النموذج يحتوي جداول متداخلة؛ لا يمكن ضمان الحفاظ على التنسيق تلقائيًا.'), { code: 'nested_tables' });
  const edits = [];
  for (const [id, m] of Object.entries(mapping || {})) {
    if (!m || m.mode === 'fixed') continue;
    const s = slots.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error(`الخانة ${id} غير موجودة في النموذج.`), { code: 'unknown_slot' });
    const box = doc.slice(s.start, s.end);
    const pattern = m.mode === 'blank' ? '' : String(m.pattern ?? '');
    let xml;
    if (s.kind === 'cell') {
      const head = box.match(/^<w:tc>\s*(<w:tcPr>[\s\S]*?<\/w:tcPr>)?/)[0];
      xml = head + rewriteBox(box.slice(head.length, box.length - '</w:tc>'.length), pattern) + '</w:tc>';
    } else {
      xml = rewriteBox(box, pattern.replace(/\n/g, ' '));
    }
    edits.push({ start: s.start, end: s.end, xml });
  }
  let out = doc;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.xml + out.slice(e.end);
  entries.set('word/document.xml', Buffer.from(out, 'utf8'));
  return writeZip(entries);
}

// ---------- verification ----------
const props = (xml, slot) => ({
  tcPr: slot.kind === 'cell' ? (xml.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0] : '',
  pPr: (xml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0],
  images: (xml.match(/<w:drawing>[\s\S]*?<\/w:drawing>/g) || []).join(''),
});

/** Proves that only the linked boxes' text changed. Returns { ok, problems[] }. */
export function verifyFormatting(originalBuf, mappedBuf, mapping) {
  const problems = [];
  const a = readZip(originalBuf);
  const b = readZip(mappedBuf);
  const names = (z) => [...z.keys()].filter((k) => !/^docProps\/thumbnail\./i.test(k)).sort();
  if (JSON.stringify(names(a)) !== JSON.stringify(names(b))) problems.push('تغيّرت أجزاء الملف (صور أو ترويسات أو تذييلات أو أنماط).');
  for (const k of names(a)) {
    if (k === 'word/document.xml' || !b.has(k)) continue;
    if (!a.get(k).equals(b.get(k))) problems.push(`تغيّر جزء من الملف: ${k}`);
  }
  const da = a.get('word/document.xml').toString('utf8');
  const db = b.get('word/document.xml').toString('utf8');
  const sa = listSlots(da);
  const sb = listSlots(db);
  const count = (x, re) => (x.match(re) || []).length;
  const checks = [['الجداول', /<w:tbl>/g], ['الصفوف', /<w:tr[\s>]/g], ['الخلايا', /<w:tc>/g], ['الصور', /<w:drawing>|<w:pict>/g], ['إعدادات الصفحة', /<w:sectPr/g]];
  for (const [label, re] of checks) if (count(da, re) !== count(db, re)) problems.push(`تغيّر عدد ${label}.`);
  const sect = (x) => (x.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g) || []).join();
  if (sect(da) !== sect(db)) problems.push('تغيّرت إعدادات الصفحة أو الترويسة/التذييل.');
  if (da.slice(0, da.indexOf('<w:body>')) !== db.slice(0, db.indexOf('<w:body>'))) problems.push('تغيّر رأس المستند.');
  if (sa.slots.length !== sb.slots.length) problems.push('تغيّر عدد الخانات.');
  else {
    sa.slots.forEach((s, i) => {
      const t = sb.slots[i];
      const xa = da.slice(s.start, s.end);
      const xb = db.slice(t.start, t.end);
      const m = mapping?.[s.id];
      if (!m || m.mode === 'fixed') { if (xa !== xb) problems.push(`تغيّرت خانة غير مربوطة (${s.id}).`); return; }
      const pa = props(xa, s);
      const pb = props(xb, t);
      if (pa.tcPr !== pb.tcPr || pa.pPr !== pb.pPr) problems.push(`تغيّر تنسيق الخانة ${s.id}.`);
      if (pa.images !== pb.images) problems.push(`تغيّرت صورة داخل الخانة ${s.id}.`);
    });
  }
  return { ok: problems.length === 0, problems };
}

export function documentText(docxBuffer) {
  const z = readZip(docxBuffer);
  return [...z.keys()].filter((k) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(k)).map((k) => {
    const xml = z.get(k).toString('utf8');
    return elements(xml, 'p').map((p) => textOf(xml.slice(p.start, p.end))).join('\n');
  }).join('\n');
}

export function analyzeDocx(docxBuffer) {
  const z = readZip(docxBuffer);
  const doc = z.get('word/document.xml')?.toString('utf8');
  if (!doc) throw new Error('NOT_DOCX');
  const { slots, nested, tables } = listSlots(doc);
  const sugg = suggest(slots);
  return {
    tables, nested,
    parts: { headers: [...z.keys()].filter((k) => /^word\/header\d*\.xml$/.test(k)).length, footers: [...z.keys()].filter((k) => /^word\/footer\d*\.xml$/.test(k)).length, images: [...z.keys()].filter((k) => /^word\/media\//.test(k)).length },
    slots: slots.map(({ start, end, ...s }) => ({ ...s, suggestion: sugg[s.id] })),
  };
}
