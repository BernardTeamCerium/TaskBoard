// Browser stand-in for src/db.js: sql.js (WebAssembly) database saved to localStorage.
import initSqlJs from 'sql.js';
import { SCHEMA, SqlJsDatabase } from '../src/db-core.js';

export { DEFAULT_COLUMNS, tx, getSetting, setSetting, SCHEMA } from '../src/db-core.js';

const KEY = 'taskboard-demo-db-v1';
let SQL = null;

export async function initDriver(wasmUrl) {
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
}

function loadSaved() {
  try {
    const b64 = localStorage.getItem(KEY);
    if (!b64) return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

export function openDb() {
  let db;
  try { db = new SqlJsDatabase(SQL, loadSaved()); db.exec(SCHEMA); } catch {
    db = new SqlJsDatabase(SQL); db.exec(SCHEMA); // corrupt save: start fresh
  }
  return db;
}

export function persist(db) {
  try {
    const bytes = db.export();
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    localStorage.setItem(KEY, btoa(bin));
  } catch (err) { console.warn('[demo] could not save:', err); }
}

export function resetSaved() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
