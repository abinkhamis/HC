// The only way request handlers touch company data. A repository is bound to
// one company id taken from the server-side session; every SELECT/UPDATE adds
// `company_id = ?` and every INSERT writes that id. company_id coming from the
// client is never read.
import { ENTITIES } from './entities.js';
import { HttpError, mapDbError } from './errors.js';
import { normEmployeeNo, assertEmployeeNoFree, logEmployeeEvent } from './employees.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/;

function def(name) {
  const d = Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : null;
  if (!d) throw new HttpError(404, 'نوع السجل غير معروف.');
  return d;
}

function clean(d, input, { partial = false } = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'بيانات غير صالحة.');
  const out = {};
  for (const f of d.fields) {
    if (!(f.name in input)) {
      if (!partial && f.required) throw new HttpError(400, `الحقل «${f.label}» مطلوب.`);
      if (!partial && f.default !== undefined) out[f.name] = f.default;
      continue;
    }
    let v = input[f.name];
    if (typeof v === 'string') v = v.trim();
    if (v === '' || v === undefined) v = null;
    if (v === null) {
      if (f.required) throw new HttpError(400, `الحقل «${f.label}» مطلوب.`);
      out[f.name] = f.type === 'checkbox' ? 0 : f.default ?? null;
      continue;
    }
    switch (f.type) {
      case 'number':
        v = Number(v);
        if (!Number.isFinite(v)) throw new HttpError(400, `«${f.label}» يجب أن يكون رقمًا.`);
        break;
      case 'date':
        if (!DATE_RE.test(String(v))) throw new HttpError(400, `«${f.label}» تاريخ غير صالح.`);
        break;
      case 'checkbox':
        v = v === true || v === 1 || v === '1' || v === 'on' ? 1 : 0;
        break;
      case 'select':
        if (!f.options.some(([k]) => k === v)) throw new HttpError(400, `«${f.label}» قيمة غير مسموحة.`);
        break;
      case 'ref':
        v = Number(v);
        if (!Number.isSafeInteger(v) || v <= 0) throw new HttpError(400, `«${f.label}» غير صالح.`);
        break;
      case 'empno':
        v = normEmployeeNo(v);
        if (v && v.length > 50) throw new HttpError(400, `«${f.label}» طويل جدًا.`);
        break;
      case 'iban':
        v = String(v).replace(/\s+/g, '').toUpperCase();
        if (!IBAN_RE.test(v)) throw new HttpError(400, 'رقم الآيبان غير صالح.');
        break;
      default:
        v = String(v);
        if (v.length > 4000) throw new HttpError(400, `«${f.label}» طويل جدًا.`);
    }
    out[f.name] = v;
  }
  return out;
}

export function tenantRepo(db, companyId) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new Error('tenantRepo requires a valid company id');
  }

  function selectSql(d) {
    const cols = ['t.id', 't.company_id', 't.created_at', 't.updated_at', ...d.fields.map((f) => `t.${f.name}`)];
    const joins = [];
    d.fields.forEach((f, i) => {
      if (f.type !== 'ref') return;
      const r = def(f.ref);
      // Join is also constrained to the same company.
      joins.push(`LEFT JOIN ${r.table} r${i} ON r${i}.company_id = t.company_id AND r${i}.id = t.${f.name}`);
      cols.push(`r${i}.${r.labelField} AS ${f.name}__label`);
    });
    return `SELECT ${cols.join(', ')} FROM ${d.table} t ${joins.join(' ')} WHERE t.company_id = ?`;
  }

  function get(name, id) {
    const d = def(name);
    const n = Number(id);
    if (!Number.isSafeInteger(n)) throw new HttpError(404, 'السجل غير موجود.');
    const row = db.prepare(`${selectSql(d)} AND t.id = ?`).get(companyId, n);
    if (!row) throw new HttpError(404, 'السجل غير موجود في الشركة الحالية.');
    return row;
  }

  return {
    companyId,

    list(name, { q, limit = 500 } = {}) {
      const d = def(name);
      let sql = selectSql(d);
      const params = [companyId];
      if (q && d.search?.length) {
        sql += ` AND (${d.search.map((c) => `t.${c} LIKE ?`).join(' OR ')})`;
        for (let i = 0; i < d.search.length; i++) params.push(`%${q}%`);
      }
      sql += ' ORDER BY t.id DESC LIMIT ?';
      params.push(Math.min(Number(limit) || 500, 2000));
      return db.prepare(sql).all(...params);
    },

    get,

    count(name) {
      const d = def(name);
      return db.prepare(`SELECT COUNT(*) AS n FROM ${d.table} WHERE company_id = ?`).get(companyId).n;
    },

    create(name, input, userId, { event = 'created', detail = 'أُضيف إلى دليل الموظفين', importId = null } = {}) {
      const d = def(name);
      const data = clean(d, input);
      // one employee number per company, whatever the employee's status (clear message + link)
      if (d.table === 'employees') assertEmployeeNoFree(db, companyId, data.employee_no);
      const keys = Object.keys(data);
      const sql = `INSERT INTO ${d.table} (company_id, created_by${keys.map((k) => ', ' + k).join('')})
                   VALUES (?, ?${keys.map(() => ', ?').join('')})`;
      let newId;
      try {
        newId = Number(db.prepare(sql).run(companyId, userId ?? null, ...keys.map((k) => data[k])).lastInsertRowid);
      } catch (e) {
        throw mapDbError(e);
      }
      if (d.table === 'employees') logEmployeeEvent(db, companyId, newId, event, detail, null, userId, importId);
      return get(name, newId);
    },

    update(name, id, input, userId = null, { event = 'updated', detail = 'تعديل من دليل الموظفين', importId = null } = {}) {
      const d = def(name);
      const data = clean(d, input, { partial: true });
      const keys = Object.keys(data);
      if (!keys.length) return get(name, id);
      const before = d.table === 'employees' ? get(name, id) : null;
      if (d.table === 'employees' && 'employee_no' in data) assertEmployeeNoFree(db, companyId, data.employee_no, id);
      const sql = `UPDATE ${d.table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now')
                   WHERE company_id = ? AND id = ?`;
      let r;
      try {
        r = db.prepare(sql).run(...keys.map((k) => data[k]), companyId, Number(id));
      } catch (e) {
        throw mapDbError(e);
      }
      if (r.changes === 0) throw new HttpError(404, 'السجل غير موجود في الشركة الحالية.');
      if (before) {
        const changes = keys.filter((k) => (before[k] ?? null) !== (data[k] ?? null)).map((k) => ({ field: k, from: before[k] ?? null, to: data[k] ?? null }));
        if (changes.length) {
          logEmployeeEvent(db, companyId, Number(id), event, detail, changes, userId, importId);
          // the number shown on procedure cases is a copy: keep it in step with the record
          if (changes.some((c) => c.field === 'employee_no')) {
            db.prepare('UPDATE proc_cases SET employee_no = ? WHERE company_id = ? AND employee_id = ?').run(data.employee_no ?? null, companyId, Number(id));
          }
        }
      }
      return get(name, id);
    },
  };
}
