import { DEFAULT_COLUMNS } from './db.js';
import { HttpError } from './tasks.js';

export function suggestKey(db, name) {
  const words = String(name).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] || 'P').slice(0, 4);
  if (!/^[A-Z]/.test(base)) base = `P${base}`.slice(0, 4);
  let key = base;
  for (let i = 2; db.prepare('SELECT 1 FROM projects WHERE key = ?').get(key); i++) key = `${base}${i}`;
  return key;
}

export function createProject(db, businessId, name, key, { client_visible = false, description = '', columns = DEFAULT_COLUMNS } = {}) {
  const k = key ? String(key).toUpperCase() : suggestKey(db, name);
  if (!/^[A-Z][A-Z0-9]{0,9}$/.test(k)) throw new HttpError(400, 'Key must be 1-10 letters/digits starting with a letter');
  if (db.prepare('SELECT 1 FROM projects WHERE key = ?').get(k)) throw new HttpError(400, `Key ${k} is already used`);
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM projects WHERE business_id = ?').get(businessId).p;
  const r = db.prepare('INSERT INTO projects (business_id, name, key, description, client_visible, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(businessId, name, k, description, client_visible ? 1 : 0, pos);
  const id = Number(r.lastInsertRowid);
  columns.forEach((c, i) => db.prepare('INSERT INTO columns (project_id, name, position, is_done) VALUES (?, ?, ?, ?)').run(id, c.name, i, c.is_done ? 1 : 0));
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function createBusinessWithProject(db, name, color) {
  const palette = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#2563eb'];
  const n = db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n;
  const r = db.prepare('INSERT INTO businesses (name, color, position) VALUES (?, ?, ?)').run(name, color || palette[n % palette.length], n);
  const id = Number(r.lastInsertRowid);
  createProject(db, id, 'General', null);
  return db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);
}
