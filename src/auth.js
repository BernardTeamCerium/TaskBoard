import { hashPassword, verifyPassword, sha256, randomToken } from './crypto.js';

export { hashPassword, verifyPassword, sha256, randomToken };

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'tb_session';

export function createSession(db, userId) {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 864e5 };
}

export function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export function userFromSession(db, token) {
  if (!token) return null;
  return db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.email_notifications
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), new Date().toISOString()) || null;
}

/** API tokens are used by email/webhook automation. Returns the owning user. */
export function userFromApiToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT t.id AS token_id, u.id, u.email, u.name, u.role
    FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`).get(sha256(token));
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?").run(row.token_id);
  return row;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Tiny in-memory login throttle: 10 failed attempts per email+ip per 15 minutes.
const failures = new Map();
export function loginThrottled(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(key); return false; }
  return f.count >= 10;
}
export function recordLoginFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
export const clearLoginFailures = (key) => failures.delete(key);
