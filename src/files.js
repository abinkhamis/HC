// Company-scoped file storage: storage/companies/<companyId>/<kind>/<uuid>.<ext>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './errors.js';

const MAX_BYTES = 15 * 1024 * 1024;

const TYPES = {
  png: { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  pdf: { mime: 'application/pdf', test: (b) => b.toString('latin1', 0, 5) === '%PDF-' },
  docx: {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    test: (b, name) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && /\.docx$/i.test(name) && b.includes('word/'),
  },
  xlsx: {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    test: (b, name) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && /\.xlsx$/i.test(name) && b.includes('xl/'),
  },
};

export const IMAGE_TYPES = ['png', 'jpg', 'webp'];
export const DOCX_TYPES = ['docx'];
export const XLSX_TYPES = ['xlsx'];

export function saveFile(db, storageDir, { companyId, kind, filename, buffer, allowed, userId }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new HttpError(400, 'الملف فارغ.');
  if (buffer.length > MAX_BYTES) throw new HttpError(413, 'حجم الملف يتجاوز 15 ميجابايت.');
  const name = String(filename || 'file').slice(0, 200);
  const ext = allowed.find((t) => TYPES[t].test(buffer, name));
  if (!ext) throw new HttpError(400, `نوع الملف غير مسموح. المسموح: ${allowed.join(', ')}`);
  const rel = path.posix.join('companies', String(companyId), kind, `${crypto.randomUUID()}.${ext}`);
  const abs = path.join(storageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const r = db.prepare(`INSERT INTO files (company_id, kind, original_name, mime, size, sha256, storage_path, uploaded_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(companyId, kind, name, TYPES[ext].mime, buffer.length, sha, rel, userId ?? null);
  return Number(r.lastInsertRowid);
}

export function fromUpload(upload) {
  if (!upload || typeof upload.data !== 'string') throw new HttpError(400, 'لم يتم إرفاق ملف.');
  return { filename: upload.filename, buffer: Buffer.from(upload.data, 'base64') };
}

// Always looked up together with the owning company id.
export function readFile(db, storageDir, companyId, fileId) {
  const f = db.prepare('SELECT * FROM files WHERE company_id = ? AND id = ?').get(companyId, fileId);
  if (!f) throw new HttpError(404, 'الملف غير موجود.');
  const abs = path.join(storageDir, f.storage_path);
  if (!abs.startsWith(path.resolve(storageDir))) throw new HttpError(400, 'مسار غير صالح.');
  return { meta: f, buffer: fs.readFileSync(abs) };
}
