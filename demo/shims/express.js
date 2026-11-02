// The small part of Express that src/server.js uses, running on fetch-style
// Request/Response objects so the real API routes work inside the browser.
function compile(path) {
  const keys = [];
  const re = new RegExp(`^${path.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}\\/?$`);
  return { re, keys };
}

class Res {
  constructor() { this.statusCode = 200; this.headers = new Headers(); this.body = ''; this.cookies = []; this.done = false; }
  status(code) { this.statusCode = code; return this; }
  type(t) { this.headers.set('content-type', t.includes('/') ? t : t === 'text/xml' ? 'text/xml' : `text/${t}`); return this; }
  attachment(name) { this.headers.set('content-disposition', `attachment; filename="${name}"`); return this; }
  json(obj) { this.headers.set('content-type', 'application/json'); this.body = JSON.stringify(obj); this.done = true; return this; }
  send(text) { if (!this.headers.has('content-type')) this.headers.set('content-type', 'text/html'); this.body = String(text); this.done = true; return this; }
  cookie(name, value, opts = {}) { this.cookies.push({ name, value, maxAge: opts.maxAge }); return this; }
  clearCookie(name) { this.cookies.push({ name, value: '', maxAge: 0 }); return this; }
}

function express() {
  const layers = [];
  const add = (method, path, handlers) => {
    for (const fn of handlers.flat()) layers.push({ method, path, fn, ...(method === 'USE' ? {} : compile(path)) });
  };
  const app = {
    disable() {}, set() {}, listen() { throw new Error('listen() is not available in the browser'); },
    use(path, ...fns) { if (typeof path === 'function') add('USE', null, [path, ...fns]); else add('USE', path, fns); return app; },
    get: (p, ...f) => (add('GET', p, f), app),
    post: (p, ...f) => (add('POST', p, f), app),
    patch: (p, ...f) => (add('PATCH', p, f), app),
    put: (p, ...f) => (add('PUT', p, f), app),
    delete: (p, ...f) => (add('DELETE', p, f), app),

    /** Handle one request. Returns { status, headers, body, cookies }. */
    async handle({ method, url, headers, body }) {
      const u = new URL(url, 'http://demo.local');
      const req = {
        method, url: u.pathname + u.search, path: u.pathname,
        query: Object.fromEntries(u.searchParams), headers, body: body ?? {}, params: {}, ip: '127.0.0.1',
        is: (t) => (headers['content-type'] || '').includes(t.replace('application/', '')),
      };
      const res = new Res();
      let i = 0;
      let error = null;
      const fullPath = () => req.url.split('?')[0];
      while (i < layers.length && !res.done) {
        const layer = layers[i++];
        const isErrorHandler = layer.fn.length === 4;
        if (error ? !isErrorHandler : isErrorHandler) continue;
        const p = fullPath();
        if (layer.method === 'USE') {
          if (layer.path && !(p === layer.path || p.startsWith(`${layer.path}/`))) continue;
          req.path = layer.path ? p.slice(layer.path.length) || '/' : p;
        } else {
          if (layer.method !== method) continue;
          const m = p.match(layer.re);
          if (!m) continue;
          req.params = Object.fromEntries(layer.keys.map((k, idx) => [k, decodeURIComponent(m[idx + 1])]));
          req.path = p;
        }
        let nextCalled = false;
        let nextErr = null;
        const next = (err) => { nextCalled = true; nextErr = err || null; };
        try {
          if (isErrorHandler) await layer.fn(error, req, res, next);
          else await layer.fn(req, res, next);
          if (isErrorHandler && !res.done && !nextCalled) break;
        } catch (err) {
          error = err;
          continue;
        }
        if (nextCalled) { if (nextErr) error = nextErr; continue; }
        if (!res.done) break; // handler neither responded nor called next
      }
      if (!res.done) res.status(error ? 500 : 404).json({ error: error ? error.message : 'Not found' });
      return res;
    },
  };
  return app;
}
const passthrough = () => (_req, _res, next) => next();
express.json = passthrough;
express.urlencoded = passthrough;
express.static = passthrough;
export default express;
