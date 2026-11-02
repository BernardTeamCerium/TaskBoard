// In-browser demo backend: runs the real TaskBoard API (src/server.js) inside
// the page and answers the app's /api/* requests, so the demo can be hosted as
// plain static files (e.g. Netlify) with no server. Data is saved in this
// browser's localStorage.
import { initDriver, openDb, persist, resetSaved } from './browser-db.js';
import { createApp } from '../src/server.js';
import { seedDemo } from '../src/demo.js';
import { runReminders } from '../src/notify.js';

const COOKIE_KEY = 'taskboard-demo-cookies';
const realFetch = window.fetch.bind(window);

let started = null;
function start() {
  started ||= (async () => {
    await initDriver(new URL('sql-wasm.wasm', document.baseURI).href);
    const db = openDb();
    if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) seedDemo(db);
    const app = createApp(db);
    const tick = () => { try { runReminders(db); } catch (err) { console.warn('[demo] reminders:', err); } persist(db); };
    tick();
    setInterval(tick, 60e3);
    return { app, db };
  })();
  return started;
}

function loadCookies() {
  try { return JSON.parse(localStorage.getItem(COOKIE_KEY)) || {}; } catch { return {}; }
}
function saveCookies(jar) {
  try { localStorage.setItem(COOKIE_KEY, JSON.stringify(jar)); } catch { /* ignore */ }
}

async function handleApi(url, init = {}) {
  const { app, db } = await start();
  const method = (init.method || 'GET').toUpperCase();
  const headers = {};
  new Headers(init.headers || {}).forEach((v, k) => { headers[k] = v; });
  const jar = loadCookies();
  headers.cookie = Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  let body;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = {}; } }
  const res = await app.handle({ method, url: url.pathname + url.search, headers, body });
  for (const c of res.cookies) {
    if (!c.value || c.maxAge === 0) delete jar[c.name];
    else jar[c.name] = c.value;
  }
  saveCookies(jar);
  if (method !== 'GET') persist(db);
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
}

window.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
    return handleApi(url, init || (typeof input === 'string' ? {} : { method: input.method, headers: input.headers }));
  }
  return realFetch(input, init);
};

// Plain links to /api/... (e.g. "Download text" on reports) would hit the static
// host; serve them from the in-page API and download the result instead.
document.addEventListener('click', async (e) => {
  const a = e.target.closest?.('a[href^="/api/"]');
  if (!a) return;
  e.preventDefault();
  const res = await fetch(a.getAttribute('href'));
  const blob = await res.blob();
  const name = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'download.txt';
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
});

window.taskboardDemoReset = () => {
  resetSaved();
  try { localStorage.removeItem(COOKIE_KEY); } catch { /* ignore */ }
  location.hash = '';
  location.reload();
};

start().catch((err) => console.error('[demo] failed to start:', err));
