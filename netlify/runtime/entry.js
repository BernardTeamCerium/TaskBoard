// Bundled by netlify/build.mjs into netlify/dist/runtime.mjs.
import { getStore } from '@netlify/blobs';
import { createRuntime } from './handler.js';

const runtime = createRuntime({ getStore: () => getStore({ name: 'taskboard', consistency: 'strong' }) });
export const handleRequest = runtime.handleRequest;
export const runScheduled = runtime.runScheduled;

// Exposed for tests (test/netlify-runtime.test.js) to run against a fake store.
export { createRuntime };
