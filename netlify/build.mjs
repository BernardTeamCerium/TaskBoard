// Bundles the TaskBoard API for Netlify Functions into netlify/dist/runtime.mjs.
// Runs automatically on Netlify (see netlify.toml); locally: npm run build:netlify
import * as esbuild from 'esbuild';
import path from 'node:path';
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
  // Bundled CommonJS packages (sql.js, nodemailer) expect require(), __dirname and
  // __filename, which don't exist in an ES module — provide them.
  banner: {
    js: [
      "import { createRequire as __tbRequire } from 'node:module';",
      "import { fileURLToPath as __tbPath } from 'node:url';",
      "import { dirname as __tbDir } from 'node:path';",
      'const require = __tbRequire(import.meta.url);',
      'const __filename = __tbPath(import.meta.url);',
      'const __dirname = __tbDir(__filename);',
    ].join('\n'),
  },
  plugins: [{
    name: 'netlify-swaps',
    setup(build) {
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
