// Demo data modelled on the current Trello board. Usage:
//   npm run seed            (only if the database is empty)
//   npm run seed -- --force (wipe and reseed — destroys existing data!)
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { seedDemo, DEMO_ACCOUNTS, DEMO_PASSWORD } from '../src/demo.js';

const force = process.argv.includes('--force');
const file = process.env.DB_PATH || 'data/taskboard.db';
if (force && fs.existsSync(file)) for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
const db = openDb(file);
if (db.prepare('SELECT 1 FROM users').get()) {
  console.error('Database already has data. Use --force to wipe it and reseed.');
  process.exit(1);
}
seedDemo(db);
console.log(`Seeded demo data into ${file}. Sign in with any of these (password: ${DEMO_PASSWORD}):`);
for (const [email, role] of DEMO_ACCOUNTS) console.log(`  ${email.padEnd(24)} ${role}`);
