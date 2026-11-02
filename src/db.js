import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SCHEMA, SqlJsDatabase } from './db-core.js';

export { DEFAULT_COLUMNS, tx, getSetting, setSetting, SCHEMA, validTimezone, applyTimezone } from './db-core.js';

// Prefer Node's built-in SQLite (file-backed). Fall back to sql.js (WebAssembly,
// in-memory) where node:sqlite isn't available or DB_DRIVER=sqljs. (The Netlify
// build swaps this file for netlify/runtime/db-netlify.js.)
let NodeDatabaseSync = null;
if (process.env.DB_DRIVER !== 'sqljs') {
  try { ({ DatabaseSync: NodeDatabaseSync } = await import('node:sqlite')); } catch { /* fall back */ }
}
let SQL = null;
async function loadSqlJs() {
  const require = createRequire(import.meta.url);
  const initSqlJs = require('sql.js');
  const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  return initSqlJs({ wasmBinary });
}
if (!NodeDatabaseSync) SQL = await loadSqlJs();

export function openDb(file = process.env.DB_PATH || 'data/taskboard.db') {
  let db;
  if (NodeDatabaseSync) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    db = new NodeDatabaseSync(file);
  } else {
    db = new SqlJsDatabase(SQL); // in-memory only
  }
  db.exec(SCHEMA);
  return db;
}

