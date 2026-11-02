// Runs the built Netlify bundle (netlify/dist/runtime.mjs) as two independent
// "function instances" sharing one blob store, to check shared data, invites
// and that simultaneous writes are never lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

/** Strict in-memory stand-in for Netlify Blobs: atomic conditional writes, content-hash ETags. */
function fakeStore() {
  const entries = new Map();
  const tag = (bytes, version) => `"${crypto.createHash('sha256').update(bytes).update(String(version)).digest('hex')}"`;
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 3));
  return {
    async getMetadata(key) { await tick(); const e = entries.get(key); return e ? { etag: e.etag, metadata: e.metadata } : null; },
    async getWithMetadata(key) { await tick(); const e = entries.get(key); return e ? { data: e.data.slice().buffer, etag: e.etag, metadata: e.metadata } : null; },
    async list({ prefix }) { return { blobs: [...entries].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, etag: e.etag })), directories: [] }; },
    async set(key, data, opts = {}) {
      await tick();
      const cur = entries.get(key); // check-and-write happens atomically below (no await)
      if (opts.onlyIfNew && cur) return { modified: false };
      if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return { modified: false };
      const bytes = Buffer.from(data);
      const e = { data: bytes, metadata: opts.metadata || {}, etag: tag(bytes, opts.metadata?.version) };
      entries.set(key, e);
      return { modified: true, etag: e.etag };
    },
  };
}

// Netlify's packager prepends this to every ES-module function (zip-it-and-ship-it's CJS_SHIM).
// A bundle that declares the same names fails to load with "Identifier ... has already been declared".
const NETLIFY_CJS_SHIM = `
import {createRequire as ___nfyCreateRequire} from "module";
import {fileURLToPath as ___nfyFileURLToPath} from "url";
import {dirname as ___nfyPathDirname} from "path";
let __filename=___nfyFileURLToPath(import.meta.url);
let __dirname=___nfyPathDirname(___nfyFileURLToPath(import.meta.url));
let require=___nfyCreateRequire(import.meta.url);
`;

test('bundle still loads with the header Netlify adds to functions', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const src = fs.readFileSync(new URL('../netlify/dist/runtime.mjs', import.meta.url), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-netlify-'));
  const file = path.join(dir, 'api.mjs');
  fs.writeFileSync(file, NETLIFY_CJS_SHIM + src);
  const mod = await import(file);
  assert.equal(typeof mod.handleRequest, 'function');
  fs.rmSync(dir, { recursive: true, force: true });
});

const { createRuntime } = await import('../netlify/dist/runtime.mjs');
const store = fakeStore();

// Like Netlify: every function call gets short-lived credentials. A runtime that
// caches its store across requests ends up using expired ones and gets a 401.
const CREDENTIAL_LIFETIME_MS = 1000;
function perCallStore() {
  return () => {
    const issued = Date.now();
    const guard = (fn) => (...args) => {
      if (Date.now() - issued > CREDENTIAL_LIFETIME_MS) {
        const e = new Error('Netlify Blobs has generated an internal error (401 status code)');
        e.name = 'BlobsInternalError'; e.status = 401;
        return Promise.reject(e);
      }
      return fn(...args);
    };
    return Object.fromEntries(Object.entries(store).map(([k, fn]) => [k, guard(fn)]));
  };
}
const A = createRuntime({ getStore: perCallStore() });
const B = createRuntime({ getStore: perCallStore() });
const base = 'https://taskboard.example';
const jars = {};
async function call(inst, who, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (jars[who]) headers.cookie = jars[who];
  const res = await inst.handleRequest(new Request(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined }));
  const sc = res.headers.get('set-cookie');
  if (sc) jars[who] = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => null) };
}

test('netlify runtime: shared data, invites and no lost concurrent writes', async () => {
  delete process.env.ADMIN_EMAIL;
  let r = await call(A, 'admin', 'POST', '/api/setup', { name: 'Admin', email: 'admin@example.com', password: 'password123', business: 'Acme', timezone: 'America/Chicago' });
  assert.equal(r.status, 200);
  r = await call(B, 'admin', 'GET', '/api/bootstrap');
  assert.equal(r.data.me.role, 'owner', 'session created on A is valid on B');
  // later requests on the same warm instance must not reuse expired credentials
  await new Promise((done) => setTimeout(done, CREDENTIAL_LIFETIME_MS + 200));
  r = await call(A, 'admin', 'GET', '/api/bootstrap');
  assert.equal(r.status, 200, `warm instance after credentials expired: ${JSON.stringify(r.data)}`);
  const project = r.data.projects[0];

  r = await call(B, 'admin', 'POST', '/api/users', { name: 'Client Carla', email: 'carla@client.com', role: 'client', project_ids: [project.id] });
  const invite = r.data.invite_token;
  assert.ok(invite);
  assert.equal((await call(A, 'carla', 'POST', `/api/invite/${invite}`, { password: 'carlapass1' })).status, 200);
  assert.equal((await call(B, 'carla', 'GET', '/api/bootstrap')).data.me.role, 'client');

  const titles = Array.from({ length: 30 }, (_, i) => `Parallel ${i}`);
  const results = await Promise.all(titles.map((title, i) => call(i % 2 ? A : B, 'admin', 'POST', '/api/tasks', { project_id: project.id, title })));
  assert.ok(results.every((x) => x.status === 200), JSON.stringify(results.filter((x) => x.status !== 200)));
  const all = (await call(A, 'admin', 'GET', `/api/tasks?project_id=${project.id}`)).data.map((t) => t.title);
  for (const t of titles) assert.ok(all.includes(t), `missing ${t}`);
  assert.equal(new Set(all).size, all.length, 'no task was created twice');

  const sched = await B.runScheduled();
  assert.equal(typeof sched.reminders, 'number');
});
