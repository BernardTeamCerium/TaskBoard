// Netlify runtime for TaskBoard.
//
// The whole SQLite database is one blob in Netlify Blobs. Each function instance
// keeps a copy in memory and, per request:
//   1. checks the blob's ETag (strongly consistent) and reloads if another
//      instance has saved since;
//   2. runs the request through the normal API (src/server.js);
//   3. if anything changed, saves with `onlyIfMatch` so two instances can never
//      overwrite each other. On a conflict it reloads and replays the request.
// Requests within one instance run one at a time.
import { createApp } from '../../src/server.js';
import { runReminders, runDailyDigest } from '../../src/notify.js';
import { runMonthlyReport } from '../../src/reports.js';
import { initSql, openDbFromBytes, totalChanges, applyTimezone } from './db-netlify.js';

const KEY = 'taskboard.sqlite';

export function createRuntime({ getStore }) {
  let state = null; // { db, app, etag, version, exists }
  let queue = Promise.resolve();

  // Netlify hands each function call its own short-lived Blobs credentials, so the
  // store must be created per call — never cached across requests (that gives 401s).
  let store = null;
  const getS = () => store;
  const exclusive = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  };

  // Each save stamps a random version into the blob's metadata; comparing it is a
  // cheap way to notice that another instance has saved since we last loaded.
  const newVersion = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  async function etagFromList() {
    const { blobs } = await getS().list({ prefix: KEY });
    return blobs.find((b) => b.key === KEY)?.etag || null;
  }

  async function load(force = false) {
    await initSql();
    const s = getS();
    if (state && !force) {
      const meta = await s.getMetadata(KEY, { consistency: 'strong' });
      if ((meta?.metadata?.version ?? null) === state.version) return state;
    }
    const found = await s.getWithMetadata(KEY, { type: 'arrayBuffer', consistency: 'strong' });
    const db = openDbFromBytes(found?.data);
    state = {
      db,
      app: createApp(db),
      exists: !!found,
      version: found?.metadata?.version ?? null,
      // Netlify returns the ETag with the data; local emulators may not, so fall back to a listing.
      etag: found ? (found.etag || await etagFromList()) : null,
    };
    return state;
  }

  async function save(st) {
    const bytes = st.db.export();
    const version = newVersion();
    let res;
    if (!st.exists) res = await getS().set(KEY, bytes, { onlyIfNew: true, metadata: { version } });
    else if (st.etag) res = await getS().set(KEY, bytes, { onlyIfMatch: st.etag, metadata: { version } });
    else res = await getS().set(KEY, bytes, { metadata: { version } }); // no ETag available: last resort
    if (!res.modified) return false;
    Object.assign(st, { exists: true, version, etag: res.etag || null });
    return true;
  }

  /** Run fn(db) with the latest data and persist any changes, retrying on conflicts. */
  async function withDb(fn) {
    return exclusive(async () => {
      store = getStore();
      for (let attempt = 0; attempt < 10; attempt++) {
        // back off a little (with jitter) after a conflict so instances don't keep colliding
        if (attempt) await new Promise((r) => setTimeout(r, Math.random() * 40 * attempt));
        const st = await load(attempt > 0);
        applyTimezone(st.db);
        const before = totalChanges(st.db);
        const out = await fn(st);
        if (totalChanges(st.db) === before) return out;
        if (await save(st)) return out;
        state = null; // someone else saved first: reload and replay
      }
      throw Object.assign(new Error('The board is busy — please try again.'), { status: 503 });
    });
  }

  async function readBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return undefined;
    const type = request.headers.get('content-type') || '';
    try {
      if (type.includes('application/json')) return await request.json();
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        const form = await request.formData();
        const out = {};
        for (const [k, v] of form.entries()) if (typeof v === 'string') out[k] = v;
        return out;
      }
      const text = await request.text();
      return text ? { text } : {};
    } catch {
      return {};
    }
  }

  function toResponse(res) {
    const headers = new Headers(res.headers);
    const secure = (process.env.URL || process.env.APP_URL || '').startsWith('https://') ? '; Secure' : '';
    for (const c of res.cookies) {
      const maxAge = Math.floor((c.maxAge ?? 0) / 1000);
      headers.append('set-cookie', `${c.name}=${encodeURIComponent(c.value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
    }
    headers.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.statusCode, headers });
  }

  async function handleRequest(request, context = {}) {
    const url = new URL(request.url);
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const body = await readBody(request);
    const ip = context.ip || headers['x-nf-client-connection-ip'] || headers['x-forwarded-for']?.split(',')[0]?.trim() || '0.0.0.0';
    try {
      const res = await withDb((st) => st.app.handle({
        method: request.method.toUpperCase(),
        url: url.pathname + url.search,
        headers,
        // each attempt gets its own copy so a replay sees the original input
        body: body === undefined ? undefined : structuredClone(body),
        ip,
      }));
      return toResponse(res);
    } catch (err) {
      console.error('[taskboard]', err);
      if (err.name === 'BlobsInternalError' || err.name === 'MissingBlobsEnvironmentError') {
        // A storage problem, not the visitor's fault — don't pass Netlify's status (e.g. 401) through.
        return Response.json({ error: `Storage error: ${err.message}` }, { status: 503 });
      }
      return Response.json({ error: err.status ? err.message : 'Something went wrong' }, { status: err.status || 500 });
    }
  }

  async function runScheduled(now = new Date()) {
    const summary = await withDb(async ({ db }) => {
      const reminders = runReminders(db, now);
      // Emails are sent inside these; the "already sent" markers are saved with the data.
      const digests = await runDailyDigest(db, now);
      const reports = await runMonthlyReport(db, now);
      return { reminders, digests, reports };
    });
    // Daily backup copy (kept as a separate blob per day).
    await exclusive(async () => {
      if (!state) return;
      store = getStore();
      const day = now.toISOString().slice(0, 10);
      await getS().set(`backups/${day}.sqlite`, state.db.export(), { onlyIfNew: true });
    });
    return summary;
  }

  return { handleRequest, runScheduled, withDb };
}
