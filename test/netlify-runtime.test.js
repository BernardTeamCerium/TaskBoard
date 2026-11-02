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

const { createRuntime } = await import('../netlify/dist/runtime.mjs');
const store = fakeStore();
const A = createRuntime({ getStore: () => store });
const B = createRuntime({ getStore: () => store });
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
