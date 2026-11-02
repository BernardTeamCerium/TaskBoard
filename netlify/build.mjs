// Bundles the TaskBoard API for Netlify Functions into netlify/dist/runtime.mjs.
// Runs automatically on Netlify (see netlify.toml); locally: npm run build:netlify
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = (f) => path.join(root, 'netlify/runtime', f);

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['netlify/runtime/entry.js'],
  outfile: 'netlify/dist/runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  loader: { '.wasm': 'binary' },
  alias: { express: runtime('express-shim.js'), multer: runtime('multer-shim.js') },
  inject: [runtime('cjs-globals.js')],
  plugins: [{
    name: 'netlify-swaps',
    setup(build) {
      // sql.js calls require("node:fs"/"node:crypto"); esbuild would route those through
      // a helper that needs a global `require`. Point them at the injected one instead.
      build.onLoad({ filter: /[\\/]sql\.js[\\/]dist[\\/]sql-wasm\.js$/ }, async (args) => ({
        contents: (await fs.readFile(args.path, 'utf8')).replace(/\brequire\("node:/g, '__tbNodeRequire("node:'),
        loader: 'js',
      }));
      // Use the Blobs-backed sql.js driver instead of src/db.js.
      build.onResolve({ filter: /^\.\/db\.js$/ }, (args) => (
        args.importer.includes(`${path.sep}src${path.sep}`) ? { path: runtime('db-netlify.js') } : undefined));
      // The Anthropic SDK is loaded on demand only if ANTHROPIC_API_KEY is set.
      build.onResolve({ filter: /^@anthropic-ai\/sdk$/ }, () => ({ path: '@anthropic-ai/sdk', external: true }));
    },
  }],
  logLevel: 'warning',
});
console.log('Built netlify/dist/runtime.mjs');
