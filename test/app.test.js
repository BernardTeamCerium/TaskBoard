import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import { runReminders } from '../src/notify.js';

delete process.env.ANTHROPIC_API_KEY; // keep tests deterministic (rule-based parser only)
delete process.env.SMTP_URL;

let server;
let base;
let db;

function client() {
  let cookie = '';
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b),
  };
}

const owner = client();
const clientUser = client();
let project; let hiddenProject; let token;

before(async () => {
  db = openDb(':memory:');
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await owner.post('/api/setup', { name: 'Bernard F', email: 'bernard@example.com', password: 'password123', business: 'Allied Elite Financial' })).status, 200);
  const boot = (await owner.get('/api/bootstrap')).data;
  project = boot.projects[0];
  await owner.patch(`/api/projects/${project.id}`, { key: 'AEF', client_visible: true });
  hiddenProject = (await owner.post('/api/projects', { business_id: boot.businesses[0].id, name: 'Internal Ops', key: 'OPS' })).data;

  await owner.post('/api/users', { name: 'Pete Russo', email: 'pete@example.com', password: 'password123', role: 'member', business_ids: [boot.businesses[0].id] });
  const c = await owner.post('/api/users', { name: 'Client Carl', email: 'carl@client.com', password: 'password123', role: 'client', project_ids: [project.id, hiddenProject.id] });
  assert.equal(c.status, 200);
  assert.equal((await clientUser.post('/api/login', { email: 'carl@client.com', password: 'password123' })).status, 200);
  token = (await owner.post('/api/tokens', { name: 'test' })).data.token;
});

after(() => server.close());

test('clients only see client-visible tasks in client-visible tabs they were given', async () => {
  const shared = (await owner.post('/api/tasks', { project_id: project.id, title: 'Shared deliverable', client_visible: true })).data;
  const secret = (await owner.post('/api/tasks', { project_id: project.id, title: 'Internal margin notes' })).data;
  const opsTask = (await owner.post('/api/tasks', { project_id: hiddenProject.id, title: 'Ops thing', client_visible: true })).data;

  const boot = (await clientUser.get('/api/bootstrap')).data;
  assert.deepEqual(boot.projects.map((p) => p.key), ['AEF']); // OPS tab is hidden even though shared
  assert.equal(boot.people.length, 1); // can't enumerate the team

  const tasks = (await clientUser.get('/api/tasks')).data;
  assert.deepEqual(tasks.map((t) => t.title), ['Shared deliverable']);

  assert.equal((await clientUser.get(`/api/tasks/${secret.id}`)).status, 404);
  assert.equal((await clientUser.get(`/api/tasks/${opsTask.id}`)).status, 404);
  assert.equal((await clientUser.patch(`/api/tasks/${shared.id}`, { title: 'hacked' })).status, 403);

  // internal notes are hidden; client comments are allowed
  await owner.post(`/api/tasks/${shared.id}/comments`, { body: 'Internal: they pay late', internal: true });
  await owner.post(`/api/tasks/${shared.id}/comments`, { body: 'Draft attached' });
  assert.equal((await clientUser.post(`/api/tasks/${shared.id}/comments`, { body: 'Looks good!', internal: true })).status, 200);
  const detail = (await clientUser.get(`/api/tasks/${shared.id}`)).data;
  assert.deepEqual(detail.comments.map((c) => c.body), ['Draft attached', 'Looks good!']);
  assert.equal(detail.comments[1].internal, 0); // client can't post internal notes
  assert.deepEqual(detail.activity, []);
});

test('inbound email creates and updates tasks', async () => {
  const auth = { authorization: `Bearer ${token}` };
  const created = await owner.post('/api/inbound/email', {
    subject: '[AEF] Publish SEO citations due:tomorrow 2pm !high @pete',
    'body-plain': 'List is in the shared drive.\n\n-- \nBernard',
    sender: 'Bernard F <bernard@example.com>',
  }, auth);
  assert.equal(created.status, 200);
  assert.equal(created.data.ok, true, JSON.stringify(created.data));
  const ref = created.data.results[0].task; // e.g. AEF-4
  const id = Number(ref.split('-')[1]);

  const task = (await owner.get(`/api/tasks/${id}`)).data;
  assert.equal(task.title, 'Publish SEO citations');
  assert.equal(task.priority, 'high');
  assert.equal(task.assignee_name, 'Pete Russo');
  assert.equal(task.description, 'List is in the shared drive.');
  assert.equal(new Date(task.due_at).getHours(), 14);
  assert.equal(task.source, 'email');

  // Pete got an assignment notification
  const pete = db.prepare("SELECT id FROM users WHERE email = 'pete@example.com'").get();
  assert.ok(db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND kind = 'assigned'").get(pete.id));

  // Reply from Pete marks it done with a comment
  const upd = await owner.post('/api/inbound/email', {
    subject: `RE: [${ref}] Publish SEO citations`,
    'body-plain': 'status: done\nAll 40 citations submitted.\n\nOn Tue someone wrote:\n> quoted',
    sender: 'pete@example.com',
  }, auth);
  assert.equal(upd.data.ok, true, JSON.stringify(upd.data));
  const after = (await owner.get(`/api/tasks/${id}`)).data;
  assert.equal(after.column_name, 'Done');
  assert.ok(after.completed_at);
  assert.equal(after.comments.at(-1).body, 'All 40 citations submitted.');
  assert.equal(after.comments.at(-1).user_name, 'Pete Russo');
});

test('inbound rejects bad tokens and unknown senders; clients can only comment', async () => {
  assert.equal((await owner.post('/api/inbound/message', { text: 'AEF: x' }, { authorization: 'Bearer nope' })).status, 401);
  const auth = { authorization: `Bearer ${token}` };
  const stranger = await owner.post('/api/inbound/email', { subject: '[AEF] spam', sender: 'evil@spam.com' }, auth);
  assert.equal(stranger.data.ok, false);
  assert.match(stranger.data.errors[0], /not a TaskBoard user/);

  const asClient = await owner.post('/api/inbound/email', { subject: '[AEF] New thing', sender: 'carl@client.com' }, auth);
  assert.equal(asClient.data.ok, false);
  assert.match(asClient.data.errors.join(), /Clients can only/);
});

test('text messages without a project go to the Inbox project when configured', async () => {
  const auth = { authorization: `Bearer ${token}` };
  const r1 = await owner.post('/api/inbound/message', { text: 'Call the printer' }, auth);
  assert.equal(r1.data.ok, false);
  await owner.patch('/api/settings', { inbox_project_id: hiddenProject.id });
  const r2 = await owner.post('/api/inbound/message', { text: 'Call the printer\ndue: friday' }, auth);
  assert.equal(r2.data.ok, true, JSON.stringify(r2.data));
  assert.match(r2.data.results[0].task, /^OPS-/);
});

test('reminders fire once per deadline', async () => {
  const soon = new Date(Date.now() + 2 * 3600e3).toISOString();
  const t = (await owner.post('/api/tasks', { project_id: project.id, title: 'Renewal call', due_at: soon })).data;
  const first = runReminders(db);
  assert.ok(first >= 1);
  assert.equal(runReminders(db), 0);
  const n = (await owner.get('/api/notifications')).data.find((x) => x.task_id === t.id);
  assert.equal(n.kind, 'due_soon');
});

test('trello import maps lists to businesses', async () => {
  const board = {
    name: '2026 Task Management',
    lists: [{ id: 'l1', name: 'Spectaculeads', pos: 1 }, { id: 'l2', name: 'Old', pos: 2, closed: true }],
    cards: [
      { id: 'c1', idList: 'l1', name: 'Spectaculeads App', desc: 'App build', pos: 1, labels: [{ name: 'Design' }] },
      { id: 'c2', idList: 'l1', name: 'App Preview', pos: 2, dueComplete: true, due: '2026-05-01T17:00:00.000Z' },
    ],
    checklists: [{ idCard: 'c1', name: 'Launch', checkItems: [{ name: 'iOS', state: 'complete', pos: 1 }] }],
    actions: [{ type: 'commentCard', data: { card: { id: 'c1' }, text: 'Screens uploaded' }, memberCreator: { fullName: 'Pete' } }],
  };
  const r = await owner.post('/api/import/trello', { board });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { businesses: 1, projects: 1, tasks: 2, comments: 1 });
  const tasks = (await owner.get('/api/tasks?q=App')).data;
  const app = tasks.find((t) => t.title === 'Spectaculeads App');
  assert.match(app.description, /- \[x\] iOS/);
  assert.equal(app.client_visible, 0);
  assert.equal(tasks.find((t) => t.title === 'App Preview').column_name, 'Done');
});

test('monthly report: completed this month, planned next month, client version hides internal work', async () => {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const nextMonthDue = new Date(now.getFullYear(), now.getMonth() + 1, 10, 17).toISOString();
  const shared = (await owner.post('/api/tasks', { project_id: project.id, title: 'Report: shared win', client_visible: true })).data;
  const internal = (await owner.post('/api/tasks', { project_id: project.id, title: 'Report: internal win' })).data;
  await owner.patch(`/api/tasks/${shared.id}`, { status: { done: true } });
  await owner.patch(`/api/tasks/${internal.id}`, { status: { done: true } });
  await owner.post('/api/tasks', { project_id: project.id, title: 'Report: next month plan', due_at: nextMonthDue, client_visible: true });

  const titles = (groups) => groups.flatMap((b) => b.projects.flatMap((p) => p.tasks.map((t) => t.title)));
  const team = (await owner.get(`/api/reports/monthly?month=${month}`)).data;
  assert.ok(titles(team.completed).includes('Report: shared win'));
  assert.ok(titles(team.completed).includes('Report: internal win'));
  assert.ok(titles(team.planned).includes('Report: next month plan'));
  assert.ok(team.byPerson.length >= 1);

  const clientCopy = (await owner.get(`/api/reports/monthly?month=${month}&client_view=1`)).data;
  assert.ok(titles(clientCopy.completed).includes('Report: shared win'));
  assert.ok(!titles(clientCopy.completed).includes('Report: internal win'));

  // a client asking for the team version still only gets client-visible work
  const asClient = (await clientUser.get(`/api/reports/monthly?month=${month}`)).data;
  assert.equal(asClient.clientView, true);
  assert.ok(!titles(asClient.completed).includes('Report: internal win'));

  const txt = await fetch(`${base}/api/reports/monthly.txt?month=${month}`, { headers: { cookie: '' } });
  assert.equal(txt.status, 401);
  assert.equal((await owner.post('/api/reports/save', { month })).status, 200);
  assert.equal((await owner.get('/api/reports/saved')).data.length, 1);
});

test('invites: admin adds someone without a password, they set their own via a one-time link', async () => {
  const r = await owner.post('/api/users', { name: 'Christine', email: 'christine@example.com', role: 'member', business_ids: [] });
  assert.equal(r.status, 200);
  assert.ok(r.data.invite_token);
  assert.equal(r.data.password, undefined);
  const users = (await owner.get('/api/users')).data;
  assert.equal(users.find((u) => u.email === 'christine@example.com').pending, true);

  const christine = client();
  assert.equal((await christine.post('/api/login', { email: 'christine@example.com', password: `invite$${r.data.invite_token}` })).status, 401);
  assert.equal((await christine.get(`/api/invite/${r.data.invite_token}`)).data.email, 'christine@example.com');
  assert.equal((await christine.post(`/api/invite/${r.data.invite_token}`, { password: 'short' })).status, 400);
  assert.equal((await christine.post(`/api/invite/${r.data.invite_token}`, { password: 'christine123' })).status, 200);
  assert.equal((await christine.get('/api/me')).data.name, 'Christine');
  assert.equal((await christine.post(`/api/invite/${r.data.invite_token}`, { password: 'again12345' })).status, 404);

  // reset link: new link replaces the password; old sessions are signed out
  const reset = (await owner.post(`/api/users/${r.data.id}/invite`, {})).data.invite_token;
  assert.equal((await client().post(`/api/invite/${reset}`, { password: 'newpass1234' })).status, 200);
  assert.equal((await christine.get('/api/me')).status, 401);
  assert.equal((await client().post('/api/login', { email: 'christine@example.com', password: 'newpass1234' })).status, 200);

  // only admins can create links
  assert.equal((await christine.post(`/api/users/${r.data.id}/invite`, {})).status, 403);
});

test('timezone setting is validated and used for deadlines', async () => {
  assert.equal((await owner.patch('/api/settings', { timezone: 'Mars/Olympus' })).status, 400);
  assert.equal((await owner.patch('/api/settings', { timezone: 'America/Los_Angeles' })).status, 200);
  const r = await owner.post('/api/command', { text: `AEF: TZ check due:2026-12-01` });
  const id = Number(r.data.results[0].task.split('-')[1]);
  const t = (await owner.get(`/api/tasks/${id}`)).data;
  assert.equal(t.due_at, '2026-12-02T01:00:00.000Z'); // 5pm Pacific
  await owner.patch('/api/settings', { timezone: 'UTC' });
});
