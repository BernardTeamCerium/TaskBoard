// Netlify Function that runs the whole TaskBoard API (DEMO deployment).
// Netlify functions have no persistent disk, so this uses an in-memory database
// that is filled with demo data on each cold start. Changes reset periodically.
// For real use, run `npm start` on a host with a disk (see README).
import serverless from 'serverless-http';

process.env.DB_DRIVER ??= 'sqljs';
process.env.DEMO_MODE ??= '1';

const ready = (async () => {
  const { openDb } = await import('../../src/db.js');
  const { createApp } = await import('../../src/server.js');
  const { seedDemo } = await import('../../src/demo.js');
  const db = openDb(':memory:');
  seedDemo(db);
  return serverless(createApp(db));
})();

export const handler = async (event, context) => (await ready)(event, context);
