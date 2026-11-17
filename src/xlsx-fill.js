// Fills {{placeholders}} in an official Excel (.xlsx) template while keeping its
// design: styles, merged cells, column widths, formulas and other text stay as
// they are. Only cells whose text contains a placeholder are rewritten:
//   - a cell that is exactly one numeric placeholder becomes a real number
//     (so the template's own formulas and number formats keep working);
//   - any other cell becomes text with the placeholders replaced;
//   - a placeholder with no value is left empty.
// Formulas are recalculated by Excel on open.
import { readZip, writeZip } from './docx/zip.js';

export const XLSX_PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+(?::[a-z]+)?)\s*\}\}/g;

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const encode = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function sharedStrings(entries) {
  const xml = entries.get('xl/sharedStrings.xml')?.toString('utf8');
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

const sheetNames = (entries) => [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
const CELL_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;

function cellText(attrs, inner, shared) {
  if (!inner || /<f[\s>]/.test(inner)) return null; // empty or formula cell
  if (/\bt="s"/.test(attrs)) { const m = inner.match(/<v>(\d+)<\/v>/); return m ? shared[Number(m[1])] ?? null : null; }
  if (/\bt="inlineStr"/.test(attrs)) return textOf(inner);
  return null;
}

/** Placeholders used anywhere in the workbook (validated against a catalogue on upload). */
export function findXlsxPlaceholders(buffer) {
  const entries = readZip(buffer);
  if (!entries.has('xl/workbook.xml')) throw new Error('NOT_XLSX');
  const shared = sharedStrings(entries);
  const keys = new Set();
  for (const name of sheetNames(entries)) {
    const xml = entries.get(name).toString('utf8');
    for (const m of xml.matchAll(CELL_RE)) {
      const t = cellText(m[1], m[3], shared);
      if (t) for (const p of t.matchAll(XLSX_PLACEHOLDER_RE)) keys.add(p[1]);
    }
  }
  return [...keys];
}

/** Removes the page thumbnail Excel may store (it can show a previous request's data). */
export function cleanXlsx(buffer) {
  const entries = readZip(buffer);
  let changed = false;
  for (const k of [...entries.keys()]) if (/^docProps\/thumbnail\./i.test(k)) { entries.delete(k); changed = true; }
  return changed ? writeZip(entries) : buffer;
}

// <calcPr> must follow sheets / functionGroups / externalReferences / definedNames (schema order).
function insertCalcPr(wb) {
  for (const tag of ['</definedNames>', '</externalReferences>', '</functionGroups>', '</sheets>']) {
    const i = wb.lastIndexOf(tag);
    if (i >= 0) return wb.slice(0, i + tag.length) + '<calcPr fullCalcOnLoad="1"/>' + wb.slice(i + tag.length);
  }
  return wb;
}

/**
 * values: { key: string|number|null }, numericKeys: keys whose value must be written as a number.
 */
export function fillXlsx(buffer, values, numericKeys = new Set()) {
  const entries = readZip(buffer);
  const shared = sharedStrings(entries);
  const valueOf = (k) => (values[k] === null || values[k] === undefined ? '' : String(values[k]));
  for (const name of sheetNames(entries)) {
    const xml = entries.get(name).toString('utf8');
    const out = xml.replace(CELL_RE, (whole, attrs, _end, inner) => {
      const t = cellText(attrs, inner, shared);
      if (!t || !XLSX_PLACEHOLDER_RE.test(t)) { XLSX_PLACEHOLDER_RE.lastIndex = 0; return whole; }
      XLSX_PLACEHOLDER_RE.lastIndex = 0;
      const base = attrs.replace(/\s+t="[^"]*"/, '');
      const only = t.trim().match(/^\{\{\s*([a-zA-Z0-9_]+(?::[a-z]+)?)\s*\}\}$/);
      if (only && numericKeys.has(only[1]) && values[only[1]] !== null && values[only[1]] !== undefined && values[only[1]] !== '' && Number.isFinite(Number(values[only[1]]))) {
        return `<c${base}><v>${Number(values[only[1]])}</v></c>`;
      }
      const text = t.replace(XLSX_PLACEHOLDER_RE, (_, k) => valueOf(k));
      return text === '' ? `<c${base}/>` : `<c${base} t="inlineStr"><is><t xml:space="preserve">${encode(text)}</t></is></c>`;
    });
    entries.set(name, Buffer.from(out, 'utf8'));
  }
  // Ask Excel to recalculate the template's formulas with the new values.
  const wb = entries.get('xl/workbook.xml').toString('utf8');
  const wb2 = /<calcPr\b/.test(wb)
    ? wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (m, a, sl) => `<calcPr${a.replace(/\s+fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${sl}>`)
    : insertCalcPr(wb);
  entries.set('xl/workbook.xml', Buffer.from(wb2, 'utf8'));
  for (const k of [...entries.keys()]) if (/^docProps\/thumbnail\./i.test(k)) entries.delete(k);
  return writeZip(entries);
}
