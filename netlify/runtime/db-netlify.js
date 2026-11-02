// Netlify build of src/db.js: sql.js (SQLite compiled to WebAssembly) with the
// .wasm embedded in the bundle, so nothing has to be found on disk at runtime.
// The database bytes live in Netlify Blobs (see handler.js).
import initSqlJs from 'sql.js';
import wasmBinary from 'sql.js/dist/sql-wasm.wasm';
import { SCHEMA, SqlJsDatabase } from '../../src/db-core.js';

export { DEFAULT_COLUMNS, tx, getSetting, setSetting, SCHEMA, validTimezone, applyTimezone } from '../../src/db-core.js';

let SQL = null;
export async function initSql() {
  SQL ||= await initSqlJs({ wasmBinary });
  return SQL;
}

/** Open a database from saved bytes (or a new empty one). */
export function openDbFromBytes(bytes) {
  const db = new SqlJsDatabase(SQL, bytes && bytes.byteLength ? new Uint8Array(bytes) : undefined);
  db.exec(SCHEMA);
  return db;
}

export function totalChanges(db) {
  return db.db.exec('SELECT total_changes()')[0].values[0][0];
}

// src/server.js imports openDb for local use; never called on Netlify.
export function openDb() { throw new Error('openDb() is not used on Netlify'); }
