// Driver-independent database pieces: schema and helpers.

export const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- owner: sees and manages everything
  -- member: internal team, sees everything in businesses they belong to
  -- client: sees only client-visible tasks in projects shared with them
  role TEXT NOT NULL CHECK (role IN ('owner','member','client')),
  email_notifications INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#4f46e5',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_members (
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- short code used by email/message automation, e.g. "WEB" -> "[WEB] Fix login"
  key TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  -- 0 = the whole tab is hidden from clients, even ones it is shared with
  client_visible INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- which client accounts may open which project tabs
CREATE TABLE IF NOT EXISTS project_clients (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS columns (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_done INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  column_id INTEGER NOT NULL REFERENCES columns(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  due_at TEXT,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- 0 = internal only (default), 1 = clients with access to the project can see it
  client_visible INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  -- internal notes are never shown to clients
  internal INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  -- de-duplicates scheduled reminders (e.g. "due_soon:42:2026-11-05T17:00")
  dedupe_key TEXT UNIQUE,
  read INTEGER NOT NULL DEFAULT 0,
  emailed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

-- one-time "set your password" links for invited people
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS inbound_log (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  body TEXT,
  parser TEXT,
  result TEXT,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- monthly report snapshots (kept even if tasks are later edited or deleted)
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  month TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',
  client_view INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (month, scope, client_view)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_COLUMNS = [
  { name: 'To Do', is_done: 0 },
  { name: 'In Progress', is_done: 0 },
  { name: 'Waiting on Client', is_done: 0 },
  { name: 'Done', is_done: 1 },
];

/** Minimal node:sqlite-compatible wrapper around a sql.js database. */
export class SqlJsDatabase {
  /** @param SQL initialised sql.js module; @param bytes optional saved database */
  constructor(SQL, bytes) { this.db = bytes ? new SQL.Database(bytes) : new SQL.Database(); }
  exec(sql) { this.db.exec(sql); }
  /** Serialise the whole database to bytes. */
  export() { const bytes = this.db.export(); this.db.exec('PRAGMA foreign_keys = ON'); return bytes; }
  prepare(sql) {
    const db = this.db;
    const bind = (stmt, params) => {
      if (!params.length) return;
      if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
        stmt.bind(Object.fromEntries(Object.entries(params[0]).map(([k, v]) => [`@${k}`, v])));
      } else {
        stmt.bind(params);
      }
    };
    const rows = (params, one) => {
      const stmt = db.prepare(sql);
      try {
        bind(stmt, params);
        const out = [];
        while (stmt.step()) { out.push(stmt.getAsObject()); if (one) break; }
        return out;
      } finally { stmt.free(); }
    };
    return {
      get: (...params) => rows(params, true)[0],
      all: (...params) => rows(params, false),
      run: (...params) => {
        const stmt = db.prepare(sql);
        try { bind(stmt, params); stmt.step(); } finally { stmt.free(); }
        const changes = db.getRowsModified();
        const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
        return { changes, lastInsertRowid: id };
      },
    };
  }
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Point Node's local time at the workspace timezone (Netlify/Lambda servers run on UTC). */
export function applyTimezone(db) {
  const tz = getSetting(db, 'timezone', null);
  if (validTimezone(tz) && process.env.TZ !== tz) process.env.TZ = tz;
}
