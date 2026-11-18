// Personal login accounts for the department team («فريق الإدارة»).
// Every team account has the same role ('team'): it can use all the tools, but nothing
// administrative (policies, templates, branding, companies, accounts) — that stays with the Admin.
// A team member of a company can be given an account, or linked to an existing one
// (the same person in both companies, or the Admin herself as a member of the team).
import crypto from 'node:crypto';
import { tx } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { HttpError } from './errors.js';

const MIN_PASSWORD = 10;
// temporary passwords: no look-alike characters (0/O, 1/l/I)
const tempPassword = () => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join('');
};
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/;

export function createAccounts(db) {
  const member = (company, id) => {
    const m = db.prepare('SELECT * FROM proc_team_members WHERE company_id = ? AND id = ?').get(company.id, Number(id));
    if (!m) throw new HttpError(404, 'هذا الاسم غير موجود في فريق الشركة الحالية.');
    return m;
  };
  const userById = (id) => db.prepare('SELECT id, username, display_name, role, is_active, must_change_password FROM users WHERE id = ?').get(Number(id));
  const grantCompany = (userId, companyId) => db.prepare('INSERT OR IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)').run(userId, companyId);
  const assertFreeLink = (company, userId, exceptMemberId) => {
    const other = db.prepare('SELECT name FROM proc_team_members WHERE company_id = ? AND user_id = ? AND id <> ?').get(company.id, userId, exceptMemberId);
    if (other) throw new HttpError(409, `هذا الحساب مربوط من قبل بـ «${other.name}» في فريق هذه الشركة.`);
  };

  // New personal account for a team member. The temporary password is returned once, to hand over;
  // it must be changed at the first login.
  function createForMember(company, memberId, input) {
    const m = member(company, memberId);
    if (m.user_id) throw new HttpError(409, 'لهذا الموظف حساب دخول من قبل.');
    const username = String(input?.username ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) throw new HttpError(400, 'اسم المستخدم: أحرف إنجليزية صغيرة وأرقام و . _ - فقط (من 3 إلى 40 حرفًا).');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'اسم المستخدم مستخدم من قبل، اختر اسمًا آخر.');
    const password = tempPassword();
    return tx(db, () => {
      const userId = Number(db.prepare(`INSERT INTO users (username, display_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'team', 1)`)
        .run(username, m.name, hashPassword(password)).lastInsertRowid);
      grantCompany(userId, company.id);
      db.prepare('UPDATE proc_team_members SET user_id = ? WHERE company_id = ? AND id = ?').run(userId, company.id, m.id);
      return { username, temporary_password: password };
    });
  }

  // Link a member to an existing account (same person in the other company, or the Admin herself).
  function linkMember(company, memberId, userId) {
    const m = member(company, memberId);
    const u = userById(userId);
    if (!u) throw new HttpError(404, 'الحساب غير موجود.');
    assertFreeLink(company, u.id, m.id);
    return tx(db, () => {
      if (u.role !== 'admin') grantCompany(u.id, company.id);
      db.prepare('UPDATE proc_team_members SET user_id = ? WHERE company_id = ? AND id = ?').run(u.id, company.id, m.id);
      return { ok: true };
    });
  }

  function unlinkMember(company, memberId) {
    const m = member(company, memberId);
    db.prepare('UPDATE proc_team_members SET user_id = NULL WHERE company_id = ? AND id = ?').run(company.id, m.id);
    return { ok: true };
  }

  function resetPassword(adminUser, userId) {
    const u = userById(userId);
    if (!u) throw new HttpError(404, 'الحساب غير موجود.');
    if (u.role === 'admin') throw new HttpError(403, 'كلمة مرور حساب المسؤول تُغيّر من «تغيير كلمة المرور» بعد الدخول به.');
    const password = tempPassword();
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hashPassword(password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    });
    return { username: u.username, temporary_password: password };
  }

  function setActive(adminUser, userId, active) {
    const u = userById(userId);
    if (!u) throw new HttpError(404, 'الحساب غير موجود.');
    if (u.role === 'admin') throw new HttpError(403, 'لا يمكن إيقاف حساب المسؤول.');
    tx(db, () => {
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(active ? 1 : 0, u.id);
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    });
    return { ok: true };
  }

  // Any signed-in user changes their own password (required after a temporary one).
  function changeOwnPassword(user, sessionId, input) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(input?.current_password ?? '').trim(), row.password_hash)) throw new HttpError(400, 'كلمة المرور الحالية غير صحيحة.');
    const next = String(input?.new_password ?? '');
    if (next !== next.trim()) throw new HttpError(400, 'كلمة المرور الجديدة لا يجب أن تبدأ أو تنتهي بمسافة.');
    if (next.length < MIN_PASSWORD) throw new HttpError(400, `كلمة المرور الجديدة يجب أن تكون ${MIN_PASSWORD} أحرف على الأقل.`);
    if (!/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) throw new HttpError(400, 'كلمة المرور الجديدة يجب أن تحتوي على حروف إنجليزية وأرقام.');
    if (verifyPassword(next, row.password_hash)) throw new HttpError(400, 'اختر كلمة مرور مختلفة عن الحالية.');
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hashPassword(next), user.id);
      // other devices are signed out; this one stays
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(user.id, sessionId);
    });
    return { ok: true };
  }

  return { createForMember, linkMember, unlinkMember, resetPassword, setActive, changeOwnPassword };
}
