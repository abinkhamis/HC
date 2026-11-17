// Fills {{placeholders}} inside a .docx (body, headers, footers). Word often
// splits typed text across several runs, so placeholders are matched on the
// paragraph's combined text and rewritten back into the original runs.
import { readZip, writeZip } from './zip.js';

// {{key}} or {{key:format}} (e.g. {{start_date:dash}} → 01-10-2026)
export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+(?::[a-z]+)?)\s*\}\}/g;
const T_RE = /<w:t(\s[^>]*)?>([^<]*)<\/w:t>|<w:t(\s[^>]*)?\/>/g;
const IMG_MARK = (k) => `\u0001${k}\u0002`;
const IMG_MARK_RE = /\u0001([a-z_]+)\u0002/;

const decode = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[e]) return map[e];
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const encode = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const isTextPart = (name) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name);

// Calls fn(fullText, nodes) for each paragraph; fn may return new texts per node.
function eachParagraph(xml, fn) {
  return xml.split('</w:p>').map((seg) => {
    const nodes = [];
    seg.replace(T_RE, (m, a1, text, a3, offset) => { nodes.push({ m, offset, attrs: a1 ?? a3 ?? '', text: decode(text ?? '') }); return m; });
    if (!nodes.length) return seg;
    const full = nodes.map((n) => n.text).join('');
    const out = fn(full, nodes);
    if (!out) return seg;
    let i = 0;
    return seg.replace(T_RE, (m) => {
      const n = nodes[i], t = out[i++];
      if (t === n.text) return m;
      return `<w:t xml:space="preserve">${encode(t)}</w:t>`;
    });
  }).join('</w:p>');
}

export function findPlaceholders(docxBuffer) {
  const entries = readZip(docxBuffer);
  const keys = new Set();
  for (const [name, data] of entries) {
    if (!isTextPart(name)) continue;
    eachParagraph(data.toString('utf8'), (full) => {
      for (const m of full.matchAll(PLACEHOLDER_RE)) keys.add(m[1]);
      return null;
    });
  }
  return [...keys];
}

// Word saves a page thumbnail (docProps/thumbnail.*) rendered from whatever the
// file last contained. Left in place it would show a previous employee's data
// in file previews, so it is removed from every template and generated letter.
function stripThumbnail(entries) {
  const thumbs = [...entries.keys()].filter((k) => /^docProps\/thumbnail\.\w+$/i.test(k));
  if (!thumbs.length) return;
  thumbs.forEach((k) => entries.delete(k));
  if (entries.has('_rels/.rels')) {
    const rels = entries.get('_rels/.rels').toString('utf8').replace(/<Relationship\b[^>]*Target="\/?docProps\/thumbnail\.\w+"[^>]*\/>/gi, '');
    entries.set('_rels/.rels', Buffer.from(rels, 'utf8'));
  }
  const ct = entries.get('[Content_Types].xml');
  if (ct) entries.set('[Content_Types].xml', Buffer.from(ct.toString('utf8').replace(/<Override\b[^>]*PartName="\/docProps\/thumbnail\.\w+"[^>]*\/>/gi, ''), 'utf8'));
}

export function cleanTemplate(docxBuffer) {
  const entries = readZip(docxBuffer);
  stripThumbnail(entries);
  return writeZip(entries);
}

// Replaces literal text (even when split across runs). Used to turn an existing
// filled letter into a template: replaceText(buf, [['Employee Name', '{{employee_name_en}}'], ...]).
export function replaceText(docxBuffer, pairs) {
  const entries = readZip(docxBuffer);
  const counts = Object.fromEntries(pairs.map(([from]) => [from, 0]));
  for (const [name, data] of [...entries]) {
    if (!isTextPart(name)) continue;
    const xml = eachParagraph(data.toString('utf8'), (full, nodes) => {
      const owner = [];
      nodes.forEach((n, i) => { for (let k = 0; k < n.text.length; k++) owner.push(i); });
      const hits = [];
      for (const [from, to] of pairs) {
        let i = full.indexOf(from);
        while (i >= 0) {
          if (!hits.some((h) => i < h.end && i + from.length > h.start)) { hits.push({ start: i, end: i + from.length, to }); counts[from]++; }
          i = full.indexOf(from, i + from.length);
        }
      }
      if (!hits.length) return null;
      hits.sort((a, b) => a.start - b.start);
      const out = nodes.map(() => '');
      let pos = 0;
      for (const h of hits) {
        for (; pos < h.start; pos++) out[owner[pos]] += full[pos];
        out[owner[h.start]] += h.to;
        pos = h.end;
      }
      for (; pos < full.length; pos++) out[owner[pos]] += full[pos];
      return out;
    });
    entries.set(name, Buffer.from(xml, 'utf8'));
  }
  stripThumbnail(entries);
  return { buffer: writeZip(entries), counts };
}

function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png', mime: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p < buf.length) {
      if (buf[p] !== 0xff) { p++; continue; }
      const marker = buf[p + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7), ext: 'jpeg', mime: 'image/jpeg' };
      }
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  throw new Error('IMAGE_FORMAT');
}

const EMU_PER_CM = 360000;
function drawingXml({ rid, cx, cy, id, name }) {
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="${name}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">`
    + `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

/**
 * values: { key: string }  — text placeholders
 * images: { key: { buffer, maxHeightCm, maxWidthCm } | null } — image placeholders; null removes the placeholder
 */
// Replaces text/image placeholders in one XML fragment.
function fillText(xml, values, images) {
  return eachParagraph(xml, (full, nodes) => {
    if (!full.includes('{{')) return null;
    const owner = [];
    nodes.forEach((n, i) => { for (let k = 0; k < n.text.length; k++) owner.push(i); });
    const out = nodes.map(() => '');
    let pos = 0;
    let changed = false;
    for (const m of full.matchAll(PLACEHOLDER_RE)) {
      const key = m[1];
      let rep;
      if (Object.hasOwn(images, key)) rep = images[key] ? IMG_MARK(key) : '';
      else if (Object.hasOwn(values, key)) rep = String(values[key] ?? '');
      else continue; // unknown keys are rejected at upload time
      for (; pos < m.index; pos++) out[owner[pos]] += full[pos];
      out[owner[m.index]] += rep;
      pos = m.index + m[0].length;
      changed = true;
    }
    if (!changed) return null;
    for (; pos < full.length; pos++) out[owner[pos]] += full[pos];
    return out;
  });
}

// A table row whose text contains a {{<prefix>...}} placeholder is repeated once
// per item (e.g. one row per contract deliverable), keeping the row formatting.
const ROW_RE = /<w:tr\b[\s\S]*?<\/w:tr>/g;
function expandRows(xml, { prefix, items }, images) {
  const re = new RegExp('\\{\\{\\s*' + prefix);
  return xml.replace(ROW_RE, (row) => {
    if (!re.test(row.replace(/<[^>]+>/g, ''))) return row;
    return items.map((it) => fillText(row, it, images)).join('');
  });
}

/**
 * values: { key: string }  — text placeholders
 * images: { key: { buffer, maxHeightCm, maxWidthCm } | null } — image placeholders; null removes the placeholder
 * options.rows: { prefix, items } — repeat table rows containing {{prefix…}} placeholders
 */
export function renderDocx(templateBuffer, values, images = {}, { rows } = {}) {
  const entries = readZip(templateBuffer);
  let imgCounter = 0;
  const usedExt = new Set();

  for (const [name, data] of [...entries]) {
    if (!isTextPart(name)) continue;
    let xml = data.toString('utf8');
    if (rows) xml = expandRows(xml, rows, images);
    xml = fillText(xml, values, images);

    // Turn image markers into inline pictures (one run per picture).
    if (IMG_MARK_RE.test(xml)) {
      const relsName = name.replace(/^word\//, 'word/_rels/') + '.rels';
      let rels = entries.has(relsName)
        ? entries.get(relsName).toString('utf8')
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      let guard = 0;
      while (IMG_MARK_RE.test(xml) && guard++ < 50) {
        const tRe = /<w:t xml:space="preserve">([^<]*?)\u0001([a-z_]+)\u0002([^<]*)<\/w:t>/;
        const m = tRe.exec(xml);
        if (!m) break;
        const img = images[m[2]];
        const info = imageSize(img.buffer);
        usedExt.add(info.ext);
        const n = ++imgCounter;
        const target = `media/hub_${m[2]}_${n}.${info.ext}`;
        entries.set(`word/${target}`, img.buffer);
        const rid = `rIdHub${n}`;
        rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`);
        let cy = Math.round(img.maxHeightCm * EMU_PER_CM);
        let cx = Math.round(cy * (info.w / info.h));
        const maxCx = Math.round((img.maxWidthCm ?? 99) * EMU_PER_CM);
        if (cx > maxCx) { cy = Math.round(cy * (maxCx / cx)); cx = maxCx; }
        // Find the run properties of the enclosing run so surrounding text keeps its format.
        const runStart = Math.max(xml.lastIndexOf('<w:r>', m.index), xml.lastIndexOf('<w:r ', m.index));
        const rPr = runStart < 0 ? '' : /^<w:r(?:\s[^>]*)?>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/.exec(xml.slice(runStart, m.index))?.[1] || '';
        const before = m[1] ? `<w:t xml:space="preserve">${m[1]}</w:t>` : '';
        const after = m[3] ? `<w:t xml:space="preserve">${m[3]}</w:t>` : '';
        const replacement = `${before}</w:r><w:r>${rPr}${drawingXml({ rid, cx, cy, id: 9000 + n, name: `${m[2]} ${n}` })}</w:r><w:r>${rPr}${after}`;
        xml = xml.slice(0, m.index) + replacement + xml.slice(m.index + m[0].length);
      }
      entries.set(relsName, Buffer.from(rels, 'utf8'));
      xml = xml.replace(/\u0001[a-z_]+\u0002/g, ''); // never leave control chars in XML
    }
    entries.set(name, Buffer.from(xml, 'utf8'));
  }

  stripThumbnail(entries);
  if (usedExt.size) {
    let ct = entries.get('[Content_Types].xml').toString('utf8');
    for (const ext of usedExt) {
      if (!new RegExp(`Extension="${ext}"`, 'i').test(ct)) {
        ct = ct.replace('</Types>', `<Default Extension="${ext}" ContentType="${ext === 'png' ? 'image/png' : 'image/jpeg'}"/></Types>`);
      }
    }
    entries.set('[Content_Types].xml', Buffer.from(ct, 'utf8'));
  }
  return writeZip(entries);
}
