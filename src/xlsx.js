// Minimal .xlsx writer (no external dependencies): inline strings, numbers,
// a bold header row, column widths, right-to-left sheets and a frozen header.
import { writeZip } from './docx/zip.js';

const xml = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// Style ids: 0 normal, 1 header, 2 money (#,##0.00), 3 integer, 4 title.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="13"/><name val="Arial"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF3F3F46"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cell(ref, value, type, style) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'auto' && typeof value === 'number') type = 'number';
  if ((type === 'money' || type === 'int' || type === 'number') && Number.isFinite(Number(value))) {
    return `<c r="${ref}" s="${style ?? (type === 'money' ? 2 : type === 'int' ? 3 : 0)}"><v>${Number(value)}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

/**
 * sheets: [{ name, title?, columns: [{ header, type?: 'text'|'money'|'int'|'number'|'auto', width? }], rows: [[...]] }]
 * A sheet with `title` gets a title row above the header.
 */
export function buildXlsx(sheets) {
  const files = new Map();
  const safeName = (n, i) => (String(n).replace(/[\[\]:*?/\\]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`);
  sheets.forEach((sh, i) => {
    const rowsXml = [];
    let r = 1;
    if (sh.title) rowsXml.push(`<row r="${r}">${cell(`A${r++}`, sh.title, 'text', 4)}</row>`);
    const headerRow = r;
    rowsXml.push(`<row r="${r}" ht="30" customHeight="1">${sh.columns.map((c, j) => cell(`${colName(j)}${r}`, c.header, 'text', 1)).join('')}</row>`);
    r++;
    for (const row of sh.rows) {
      rowsXml.push(`<row r="${r}">${sh.columns.map((c, j) => cell(`${colName(j)}${r}`, row[j], c.type || 'text')).join('')}</row>`);
      r++;
    }
    const cols = `<cols>${sh.columns.map((c, j) => `<col min="${j + 1}" max="${j + 1}" width="${c.width || 16}" customWidth="1"/>`).join('')}</cols>`;
    const pane = `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`;
    files.set(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1">${pane}</sheetView></sheetViews>${cols}<sheetData>${rowsXml.join('')}</sheetData></worksheet>`, 'utf8'));
  });
  files.set('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`, 'utf8'));
  files.set('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`, 'utf8'));
  files.set('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets.map((sh, i) => `<sheet name="${xml(safeName(sh.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`, 'utf8'));
  files.set('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, 'utf8'));
  files.set('xl/styles.xml', Buffer.from(STYLES, 'utf8'));
  // [Content_Types].xml first, as Office writes it.
  return writeZip(new Map([...files].sort(([a], [b]) => (a === '[Content_Types].xml' ? -1 : b === '[Content_Types].xml' ? 1 : 0))));
}
