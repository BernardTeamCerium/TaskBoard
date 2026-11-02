// Bundled CommonJS packages (sql.js, nodemailer) expect `require`, `__dirname` and
// `__filename`, which don't exist in an ES module. Provided via esbuild `inject`
// (not a raw banner), so the names are real module bindings that later bundling
// steps — like Netlify's, which adds its own banner defining the same names —
// can rename instead of colliding with.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const file = fileURLToPath(import.meta.url);
const req = createRequire(import.meta.url);
const dir = dirname(file);

export { req as require, file as __filename, dir as __dirname };
// sql.js's two require("node:…") calls are rewritten to this at build time (see build.mjs).
export { req as __tbNodeRequire };
