// Builds the static, server-less demo into netlify-demo/.  Run: npm run build:demo
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'netlify-demo');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/sql.js/dist/sql-wasm.wasm'), path.join(out, 'sql-wasm.wasm'));

const indexPath = path.join(out, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8');
const appTag = '<script type="module" src="app.js"></script>';
if (!html.includes(appTag)) throw new Error('index.html no longer contains the app.js script tag');
fs.writeFileSync(indexPath, html.replace(appTag, `<script type="module" src="demo-backend.js"></script>\n  ${appTag}`));

const shim = (f) => path.join(root, 'demo/shims', f);
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['demo/entry.js'],
  outfile: path.join(out, 'demo-backend.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  inject: [shim('process.js')],
  alias: {
    express: shim('express.js'),
    multer: shim('multer.js'),
    nodemailer: shim('nodemailer.js'),
    'node:path': shim('node-path.js'),
    'node:url': shim('node-url.js'),
  },
  plugins: [{
    name: 'browser-swaps',
    setup(build) {
      // Swap the Node-only database driver and crypto for browser versions.
      build.onResolve({ filter: /^\.\/(db|crypto)\.js$/ }, (args) => {
        if (!args.importer.includes(`${path.sep}src${path.sep}`)) return undefined;
        return { path: path.join(root, 'demo', args.path === './db.js' ? 'browser-db.js' : 'browser-crypto.js') };
      });
      // AI features are off in the demo; never bundle the SDK.
      build.onResolve({ filter: /^@anthropic-ai\/sdk$/ }, () => ({ path: '@anthropic-ai/sdk', external: true }));
    },
  }],
  logLevel: 'warning',
});
const kb = (f) => `${Math.round(fs.statSync(path.join(out, f)).size / 1024)} KB`;
console.log(`Built ${path.relative(root, out)}/ — demo-backend.js ${kb('demo-backend.js')}, sql-wasm.wasm ${kb('sql-wasm.wasm')}`);
