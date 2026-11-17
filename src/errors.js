export class HttpError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code || undefined;
    this.details = details || undefined; // e.g. the existing record a duplicate points to
  }
}

// Translate SQLite constraint failures into user-facing errors.
export function mapDbError(e) {
  const msg = String(e?.message || '');
  if (msg.includes('FOREIGN KEY constraint failed'))
    return new HttpError(400, 'السجل المرتبط غير موجود في الشركة الحالية.', 'cross_company_reference');
  if (msg.includes('UNIQUE constraint failed'))
    return new HttpError(409, 'توجد قيمة مكررة لسجل آخر في نفس الشركة.', 'duplicate');
  if (msg.includes('company_id is immutable'))
    return new HttpError(400, 'لا يمكن نقل سجل من شركة إلى أخرى.', 'company_immutable');
  if (msg.includes('CHECK constraint failed'))
    return new HttpError(400, 'قيمة غير صالحة.', 'invalid');
  return e;
}
