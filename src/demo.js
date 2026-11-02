// Demo workspace modelled on the team's Trello board. Used by `npm run seed`
// and by the Netlify demo deployment.
import { tx } from './db.js';
import { hashPassword } from './auth.js';
import { createProject } from './projects.js';

export const DEMO_PASSWORD = 'changeme123';
export const DEMO_ACCOUNTS = [
  ['bernard@example.com', 'owner'],
  ['pete@example.com', 'team member'],
  ['christine@example.com', 'team member'],
  ['client@example.com', 'client (sees only shared AEF tabs + client-visible tasks)'],
];

const day = (n, hour = 17) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(hour, 0, 0, 0); return d.toISOString(); };

export function seedDemo(db) {
  return tx(db, () => {
  const user = (name, email, role) => Number(db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email, hashPassword(DEMO_PASSWORD), role).lastInsertRowid);
  const bernard = user('Bernard', 'bernard@example.com', 'owner');
  const pete = user('Pete Russo', 'pete@example.com', 'member');
  const christine = user('Christine', 'christine@example.com', 'member');
  const client = user('AEF Client', 'client@example.com', 'client');

  const colors = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777'];
  let bi = 0;
  const business = (name) => Number(db.prepare('INSERT INTO businesses (name, color, position) VALUES (?, ?, ?)').run(name, colors[bi % colors.length], bi++).lastInsertRowid);
  const member = (b, ...users) => users.forEach((u) => db.prepare('INSERT INTO business_members VALUES (?, ?)').run(b, u));
  const task = (p, title, opts = {}) => {
    const cols = db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position').all(p.id);
    const col = opts.done ? cols.find((c) => c.is_done) : cols[opts.col ?? 0];
    const r = db.prepare(`INSERT INTO tasks (project_id, column_id, title, description, priority, due_at, assignee_id, client_visible, position, created_by, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(p.id, col.id, title, opts.desc || '', opts.priority || 'normal', opts.due ?? null,
      opts.who ?? null, opts.client ? 1 : 0, Math.random(), bernard, opts.done ? (opts.doneAt != null ? day(opts.doneAt, 14) : new Date().toISOString()) : null);
    return Number(r.lastInsertRowid);
  };

  const aef = business('Allied Elite Financial');
  member(aef, pete, christine);
  const aefSeo = createProject(db, aef, 'SEO & Citations', 'AEF', { client_visible: true });
  const aefContent = createProject(db, aef, 'Content', 'AEFC', { client_visible: true });
  const aefInternal = createProject(db, aef, 'Internal', 'AEFI');
  db.prepare('INSERT INTO project_clients VALUES (?, ?), (?, ?)').run(aefSeo.id, client, aefContent.id, client);
  const seoTask = task(aefSeo, 'AEF SEO & Citations', { due: day(3), who: christine, client: true, col: 1, desc: 'Submit the agency to the top 40 citation sites.' });
  task(aefSeo, 'Google Business Profile cleanup', { due: day(-1), who: pete, client: true, priority: 'high' });
  task(aefSeo, 'Keyword research for agent pages', { due: day(10), who: christine });
  task(aefContent, 'AEF Content', { due: day(6), who: pete, client: true });
  task(aefContent, 'Compliance for Ad Campaigns', { due: day(0, 15), who: bernard, priority: 'urgent', client: true, col: 2 });
  task(aefInternal, 'Margin review on AEF retainer', { due: day(14), who: bernard, desc: 'Internal only — never shared with the client.' });
  db.prepare('INSERT INTO comments (task_id, user_id, body, internal) VALUES (?, ?, ?, 0), (?, ?, ?, 1)')
    .run(seoTask, christine, '22 of 40 citations submitted so far.', seoTask, bernard, 'They’re slow to approve — chase on Friday.');

  const spec = business('Spectaculeads');
  member(spec, pete);
  const specApp = createProject(db, spec, 'App', 'SPEC');
  task(specApp, 'SPECTACULEADS APP', { due: day(21), who: pete, col: 1, desc: '12 screen designs attached in Trello.' });
  task(specApp, 'Spectaculeads App - App Preview', { done: true, doneAt: -25, who: pete });

  const pr = business('Pete Russo');
  member(pr, pete, christine);
  const prBrand = createProject(db, pr, 'Personal Brand', 'PR', { client_visible: true });
  task(prBrand, 'Google Knowledge Panel', { due: day(5), who: christine, client: true });
  task(prBrand, 'Video Content Plan', { due: day(2), who: pete, client: true });
  task(prBrand, 'Build a sample library of recording content (Shawn Sparks, Grant Cardone examples)', { who: pete });
  task(prBrand, 'Viral content ideas', {});
  task(prBrand, 'Google Search Presence', { due: day(12), who: christine });

  const teag = business('The Exclusive Advisor Group');
  member(teag, christine);
  const teagMain = createProject(db, teag, 'Onboarding', 'TEAG');
  task(teagMain, 'Portal and training videos - use AEF as an example', { due: day(4), who: christine });
  task(teagMain, 'Send over logins for all platforms', { due: day(-2), who: bernard, priority: 'high' });

  const osw = business('One Stop Web');
  member(osw, pete, christine);
  const oswSites = createProject(db, osw, 'Websites', 'OSW');
  const oswIdeas = createProject(db, osw, 'Ideas', 'OSI');
  task(oswSites, 'Sheet Follow Up - Websites', { due: day(1), who: christine });
  task(oswSites, 'Menu of Items - One Stop', { who: bernard });
  task(oswSites, 'LinkedIn Research', { who: pete });
  [['James R. Kirchner', -40, christine], ['Howard Frenia', -35, christine], ['Michael Mussleman', -28, pete],
    ['Lilach West', -20, christine], ['James Wale', -12, pete], ['Charles Bonilla', -1, christine]]
    .forEach(([n, d, who], i) => task(oswSites, `Website: ${n}`, { done: true, doneAt: d, who, client: false, due: day(d + (i % 3 === 2 ? -2 : 1)) }));
  task(oswIdeas, 'Build a plan to promote each agent and their websites', { desc: 'Create a process to generate leads and appointments.' });
  task(oswIdeas, '3rd Party Compliance for Websites', { due: day(9) });
  task(oswIdeas, 'Get to Know Your Agents', {});
  task(oswIdeas, 'AI Agents - Prospecting and Management of Business', { priority: 'high' });
  task(oswIdeas, 'Outsourced Call Center', {});
  task(oswIdeas, 'Website redesign with new copy and packages', { done: true, doneAt: -33, who: bernard });
  task(aefSeo, 'Claim and verify AEF directory listings', { done: true, doneAt: -30, who: christine, client: true, due: day(-29) });
  task(aefContent, 'October newsletter', { done: true, doneAt: -24, who: pete, client: true, due: day(-24, 17) });
  task(prBrand, 'Podcast guest pitch list', { done: true, doneAt: -18, who: christine, client: true });
  task(teagMain, 'Kickoff call and onboarding checklist', { done: true, doneAt: -15, who: bernard });
  task(aefSeo, 'Next quarter citation audit', { due: day(34), who: christine, client: true });
  task(prBrand, 'Holiday video series', { due: day(40), who: pete, client: true });
  task(teagMain, 'Advisor training module 2', { due: day(45), who: christine });

  const nbv = business('New Business Ventures');
  const nbvMain = createProject(db, nbv, 'Ideas', 'NBV');
  task(nbvMain, 'New Production Company + Video Editing and Billing', {});
  task(nbvMain, 'Status and Thoughts on Jaden campaigns and CardVaulters', { due: day(7) });
  task(nbvMain, 'Starting New Tech Company', {});
  task(nbvMain, 'CardVaulters campaign launch', { done: true, doneAt: -8, who: pete });

  db.prepare("INSERT INTO settings (key, value) VALUES ('inbox_project_id', ?)").run(JSON.stringify(nbvMain.id));
});
}
