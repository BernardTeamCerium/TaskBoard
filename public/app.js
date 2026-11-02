// TaskBoard front end — dependency-free, hash-routed single page app.

// ---------- tiny helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { state.boot = null; route(); throw new Error('Please sign in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), isErr ? 5000 : 2800);
}
const fail = (err) => toast(err.message || String(err), true);

const initials = (name = '?') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(`tb:${k}`)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`tb:${k}`, JSON.stringify(v)); } catch { /* ignore */ } },
};

function startOfDay(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }

/** Deadline chip text + urgency class. */
function dueInfo(task) {
  if (!task.due_at) return null;
  const due = new Date(task.due_at);
  const now = new Date();
  const days = Math.round((startOfDay(due) - startOfDay(now)) / 864e5);
  const time = due.getHours() === 17 && due.getMinutes() === 0 ? '' : ` ${due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  let text;
  if (days === 0) text = `Today${time}`;
  else if (days === 1) text = `Tomorrow${time}`;
  else if (days === -1) text = `Yesterday${time}`;
  else if (days > 1 && days < 7) text = `${due.toLocaleDateString([], { weekday: 'short' })}${time}`;
  else text = due.toLocaleDateString([], { month: 'short', day: 'numeric', year: due.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  let cls = '';
  if (task.completed_at) cls = 'done';
  else if (due < now) cls = 'overdue';
  else if (days === 0) cls = 'today';
  else if (days <= 3) cls = 'soon';
  return { text: cls === 'overdue' ? `Overdue · ${text}` : text, cls };
}

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ---------- state ----------
const state = {
  boot: null,
  clientPreview: store.get('clientPreview', false),
  lastMain: '#/',
  drawerTaskId: null,
};
const isStaff = () => state.boot && state.boot.me.role !== 'client';
const isOwner = () => state.boot && state.boot.me.role === 'owner';
const projectById = (id) => state.boot.projects.find((p) => p.id === Number(id));
const businessById = (id) => state.boot.businesses.find((b) => b.id === Number(id));
const staffPeople = () => state.boot.people.filter((p) => p.role !== 'client');

async function loadBoot() {
  state.boot = await api('GET', '/api/bootstrap');
}

// ---------- routing ----------
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

async function route() {
  const app = $('#app');
  const invite = (location.hash || '').match(/^#\/invite\/([\w-]+)/);
  if (invite) return renderInvite(app, invite[1]);
  if (!state.boot) {
    try {
      const setupRes = await fetch('/api/setup');
      if (!setupRes.ok) throw new Error(`The server returned an error (${setupRes.status}). If you just deployed, check the Netlify function log.`);
      const { needsSetup } = await setupRes.json();
      if (needsSetup) return renderSetup(app);
      const me = await fetch('/api/me');
      if (me.status === 401) return renderLogin(app);
      await loadBoot();
    } catch (err) {
      app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' }, h('h1', {}, 'Can’t reach the server'), h('p', { class: 'muted' }, err.message))));
      return;
    }
  }
  const hash = location.hash || '#/';
  const parts = hash.replace(/^#\/?/, '').split('/');

  if (parts[0] === 'task' && parts[1]) {
    if (!$('.shell')) renderShell();
    if (!$('.content').childElementCount) renderMain(state.lastMain);
    openTask(Number(parts[1]));
    history.replaceState(null, '', state.lastMain);
    return;
  }
  state.lastMain = hash;
  renderShell();
  renderMain(hash);
}

function renderMain(hash) {
  const parts = hash.replace(/^#\/?/, '').split('/');
  const content = $('.content');
  content.replaceChildren();
  highlightNav(hash);
  if (parts[0] === 'p' && projectById(parts[1])) return renderProject(content, projectById(parts[1]));
  if (parts[0] === 'b' && businessById(parts[1])) {
    const first = state.boot.projects.find((p) => p.business_id === Number(parts[1]) && !p.archived);
    if (first) { location.hash = `#/p/${first.id}`; return; }
    return renderEmptyBusiness(content, businessById(parts[1]));
  }
  if (parts[0] === 'reports') return renderReports(content, parts[1]);
  if (parts[0] === 'notifications') return renderNotifications(content);
  if (parts[0] === 'settings') return renderSettings(content, parts[1] || (isOwner() ? 'businesses' : 'profile'));
  return renderDashboard(content);
}

// ---------- auth screens ----------
function renderLogin(app) {
  const err = h('div', { class: 'error' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
        await loadBoot();
        route();
      } catch (e2) { err.textContent = e2.message; }
    },
  },
  h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { type: 'email', name: 'email', required: true, autocomplete: 'username', autofocus: true })),
  h('label', { class: 'field' }, h('span', {}, 'Password'), h('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' })),
  err,
  h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' } }, 'Sign in'));
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('h1', {}, 'TaskBoard'), h('p', { class: 'muted' }, 'Sign in to your workspace'), form,
    h('p', { class: 'small muted', style: { marginTop: '14px', marginBottom: 0 } }, 'Forgot your password? Ask your admin to send you a new sign-in link.'))));
}

async function renderInvite(app, token) {
  const card = h('div', { class: 'card' }, h('h1', {}, 'TaskBoard'), h('p', { class: 'muted' }, 'Checking your link…'));
  app.replaceChildren(h('div', { class: 'auth' }, card));
  let who;
  try { who = await api('GET', `/api/invite/${token}`); } catch (err) {
    card.replaceChildren(h('h1', {}, 'Link not valid'), h('p', { class: 'muted' }, err.message),
      h('a', { class: 'btn', href: '#/', onclick: () => { location.hash = ''; route(); } }, 'Go to sign in'));
    return;
  }
  const err = h('div', { class: 'error' });
  const pw = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password', autofocus: true });
  const pw2 = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (pw.value !== pw2.value) { err.textContent = 'The passwords don’t match'; return; }
      try {
        await api('POST', `/api/invite/${token}`, { password: pw.value });
        history.replaceState(null, '', '#/');
        await loadBoot();
        route();
      } catch (e2) { err.textContent = e2.message; }
    },
  },
  h('label', { class: 'field' }, h('span', {}, 'Email (your sign-in)'), h('input', { type: 'email', value: who.email, disabled: true, autocomplete: 'username' })),
  h('label', { class: 'field' }, h('span', {}, 'Choose a password (8+ characters)'), pw),
  h('label', { class: 'field' }, h('span', {}, 'Type it again'), pw2),
  err,
  h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' } }, 'Set password and sign in'));
  card.replaceChildren(h('h1', {}, `Welcome, ${who.name.split(' ')[0]}`), h('p', { class: 'muted' }, 'Set a password to finish setting up your TaskBoard account.'), form);
}

const inviteUrl = (token) => `${location.origin}/#/invite/${token}`;

/** Show a sign-in link to copy (and optionally email) to someone. */
function showInviteLink(person, token) {
  const url = inviteUrl(token);
  const input = h('input', { type: 'text', value: url, readonly: true, onclick: (e) => e.target.select() });
  modal(`Sign-in link for ${person.name}`, h('div', {},
    h('p', {}, `Send this link to ${person.name} (${person.email}). It lets them choose their own password and works once, for 7 days.`),
    h('div', { class: 'row' }, input,
      h('button', { class: 'btn primary', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { input.select(); document.execCommand('copy'); toast('Link copied'); } } }, 'Copy')),
    state.boot.features.email ? h('div', { style: { marginTop: '12px' } }, h('button', {
      class: 'btn',
      onclick: async () => {
        try {
          const r = await api('POST', `/api/users/${person.id}/invite`, { send: true, link: inviteUrl('{token}') });
          if (r.emailed) { closeModal(); toast(`Emailed a sign-in link to ${person.email}`); }
        } catch (err) { fail(err); }
      },
    }, '✉ Email it to them instead')) : h('p', { class: 'small muted', style: { marginTop: '10px' } }, 'Tip: set up email (SMTP_URL) and TaskBoard can send this for you.')),
  [h('button', { class: 'btn', onclick: closeModal }, 'Done')]);
}

function renderSetup(app) {
  const err = h('div', { class: 'error' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      try {
        await api('POST', '/api/setup', { ...f, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
        await loadBoot();
        location.hash = '#/';
        route();
      } catch (e2) { err.textContent = e2.message; }
    },
  },
  h('label', { class: 'field' }, h('span', {}, 'Your name'), h('input', { type: 'text', name: 'name', required: true })),
  h('label', { class: 'field' }, h('span', {}, 'Email'), h('input', { type: 'email', name: 'email', required: true })),
  h('label', { class: 'field' }, h('span', {}, 'Password (8+ characters)'), h('input', { type: 'password', name: 'password', required: true, minlength: 8 })),
  h('label', { class: 'field' }, h('span', {}, 'First business'), h('input', { type: 'text', name: 'business', placeholder: 'e.g. Allied Elite Financial' })),
  err,
  h('button', { class: 'btn primary', style: { width: '100%', justifyContent: 'center' } }, 'Create workspace'));
  app.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'card' },
    h('h1', {}, 'Welcome to TaskBoard'), h('p', { class: 'muted' }, 'Create the owner account. You can invite your team and clients afterwards.'), form)));
}

// ---------- shell ----------
function renderShell() {
  const b = state.boot;
  const app = $('#app');
  const existing = $('.shell');
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, '▦'), 'TaskBoard'),
    h('nav', { class: 'nav', onclick: (e) => { if (e.target.closest('a')) $('.sidebar').classList.remove('open'); } },
      h('a', { href: '#/', 'data-nav': '#/' }, h('span', {}, '📅'), 'Deadlines'),
      h('a', { href: '#/reports', 'data-nav': '#/reports' }, h('span', {}, '📊'), 'Monthly reports'),
      h('a', { href: '#/notifications', 'data-nav': '#/notifications' }, h('span', {}, '🔔'), 'Notifications',
        b.unread ? h('span', { class: 'badge', id: 'unread-badge' }, b.unread) : h('span', { id: 'unread-badge' })),
      h('div', { class: 'section' }, isStaff() ? 'Businesses' : 'Projects',
        isOwner() ? h('button', { class: 'btn ghost sm', title: 'Add business', onclick: addBusiness }, '+') : null),
      b.businesses.map((biz) => {
        const projects = b.projects.filter((p) => p.business_id === biz.id && !p.archived);
        return [
          h('a', { href: `#/b/${biz.id}`, 'data-biz': biz.id },
            h('span', { class: 'biz-dot', style: { background: biz.color } }), biz.name),
          projects.length > 1 || !isStaff() ? projects.map((p) => h('a', { class: 'sub', href: `#/p/${p.id}`, 'data-nav': `#/p/${p.id}` },
            p.name, isStaff() && !p.client_visible ? h('span', { class: 'count', title: 'Hidden from clients' }, '🔒') : null)) : null,
        ];
      }),
      !b.businesses.length ? h('div', { class: 'muted small', style: { padding: '6px 10px' } }, isStaff() ? 'No businesses yet' : 'Nothing has been shared with you yet') : null,
      h('div', { class: 'section' }, 'Account'),
      h('a', { href: '#/settings', 'data-nav': '#/settings' }, h('span', {}, '⚙️'), isOwner() ? 'Settings' : 'Profile'),
    ),
    h('div', { class: 'me' },
      h('span', { class: 'avatar lg' }, initials(b.me.name)),
      h('div', { class: 'grow' }, h('div', {}, b.me.name), h('div', { class: 'muted small' }, b.me.role === 'client' ? 'Client' : b.me.role === 'owner' ? 'Admin' : 'Team')),
      h('button', { class: 'btn ghost sm', onclick: async () => { await api('POST', '/api/logout', {}); state.boot = null; location.hash = ''; route(); } }, 'Sign out')),
  );

  if (existing) {
    existing.replaceChild(sidebar, $('.sidebar', existing));
    return;
  }
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'btn ghost menu-btn', onclick: () => $('.sidebar').classList.toggle('open') }, '☰'),
    isStaff() ? commandBar() : h('div', { class: 'grow' }),
    isStaff() ? h('button', { class: 'btn primary', onclick: () => newTaskModal() }, '+ Task') : null,
  );
  app.replaceChildren(h('div', { class: 'shell' }, sidebar, h('div', { class: 'main' }, topbar, h('main', { class: 'content' }))));
}

function highlightNav(hash) {
  for (const a of document.querySelectorAll('.nav a')) a.classList.remove('active');
  const p = hash.match(/^#\/p\/(\d+)/);
  const exact = document.querySelector(`.nav a[data-nav="${hash.split('?')[0]}"]`);
  if (exact) exact.classList.add('active');
  if (p) {
    const proj = projectById(p[1]);
    const biz = proj && document.querySelector(`.nav a[data-biz="${proj.business_id}"]`);
    if (biz && !exact) biz.classList.add('active');
  }
  if (hash.startsWith('#/reports')) document.querySelector('.nav a[data-nav="#/reports"]')?.classList.add('active');
  if (hash.startsWith('#/settings')) document.querySelector('.nav a[data-nav="#/settings"]')?.classList.add('active');
}

function commandBar() {
  const input = h('input', {
    type: 'text',
    placeholder: 'Quick command — e.g. "AEF: Send logins due:fri !high @pete" or "AEF-12 done"',
    onkeydown: async (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return;
      input.disabled = true;
      try {
        const r = await api('POST', '/api/command', { text: input.value });
        showCommandResult(r);
        if (r.ok) { input.value = ''; await refreshAll(); }
      } catch (err) { fail(err); } finally { input.disabled = false; input.focus(); }
    },
  });
  return h('div', { class: 'command' }, input);
}

function showCommandResult(r) {
  const lines = r.results.map((x) => x.action === 'created' ? `✓ Created ${x.task}: ${x.title}` : `✓ ${x.task}: ${x.changes.join(', ')}`);
  lines.push(...r.errors.map((e) => `✗ ${e}`));
  toast(lines.join('\n') || 'Nothing to do', !r.ok);
}

async function refreshAll() {
  await loadBoot();
  renderShell();
  renderMain(state.lastMain);
  if (state.drawerTaskId) openTask(state.drawerTaskId, { keepScroll: true });
}

// Poll for new notifications every minute.
setInterval(async () => {
  if (!state.boot) return;
  try {
    const list = await api('GET', '/api/notifications');
    const unread = list.filter((n) => !n.read).length;
    if (unread !== state.boot.unread) {
      state.boot.unread = unread;
      const badge = $('#unread-badge');
      if (badge) { badge.className = unread ? 'badge' : ''; badge.textContent = unread || ''; }
    }
  } catch { /* ignore */ }
}, 60e3);

// ---------- task rendering ----------
function chips(task, { showProject = false } = {}) {
  const due = dueInfo(task);
  return [
    showProject ? h('span', { class: 'chip' }, task.project_name) : null,
    due ? h('span', { class: `chip ${due.cls}`, title: new Date(task.due_at).toLocaleString() }, '⏰ ', due.text) : null,
    task.priority === 'urgent' ? h('span', { class: 'chip p-urgent' }, 'Urgent') : null,
    task.priority === 'high' ? h('span', { class: 'chip p-high' }, 'High') : null,
    task.priority === 'low' ? h('span', { class: 'chip p-low' }, 'Low') : null,
    isStaff() ? (task.client_visible ? h('span', { class: 'chip client', title: 'Clients can see this task' }, '👁 Client') : h('span', { class: 'chip internal', title: 'Hidden from clients' }, '🔒 Internal')) : null,
    task.comment_count ? h('span', { class: 'chip' }, '💬 ', task.comment_count) : null,
  ];
}

function cardEl(task) {
  const el = h('div', {
    class: `card${task.client_visible ? '' : ' is-internal'}${task.completed_at ? ' is-done' : ''}`,
    draggable: isStaff() ? 'true' : null,
    'data-id': task.id,
    onclick: () => openTask(task.id),
  },
  h('div', { class: 'key' }, `${task.project_key}-${task.id}`),
  h('div', { class: 'title' }, task.title),
  h('div', { class: 'meta' }, chips(task), task.assignee_name ? h('span', { class: 'avatar', title: task.assignee_name }, initials(task.assignee_name)) : null));
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(task.id)); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  return el;
}

function listRow(task, opts = {}) {
  return h('div', { class: 'list-row', onclick: () => openTask(task.id) },
    h('button', {
      class: `check${task.completed_at ? ' on' : ''}`,
      title: task.completed_at ? 'Reopen' : 'Mark done',
      disabled: !isStaff(),
      onclick: async (e) => {
        e.stopPropagation();
        try {
          await api('PATCH', `/api/tasks/${task.id}`, { status: task.completed_at ? { first: true } : { done: true } });
          refreshAll();
        } catch (err) { fail(err); }
      },
    }, task.completed_at ? '✓' : ''),
    h('div', {},
      h('div', {}, task.title),
      h('div', { class: 'sub' }, `${task.project_key}-${task.id}`, opts.showProject ? ` · ${businessById(task.business_id)?.name || ''} › ${task.project_name}` : '', ` · ${task.column_name}`)),
    h('div', { class: 'right' }, chips(task), task.assignee_name ? h('span', { class: 'avatar', title: task.assignee_name }, initials(task.assignee_name)) : null));
}

// ---------- dashboard ----------
async function renderDashboard(content) {
  const mine = store.get('dashMine', false);
  const view = store.get('dashView', 'list');
  const head = h('div', { class: 'page-head' },
    h('h1', { class: 'grow' }, 'Deadlines'),
    isStaff() ? h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: mine, onchange: (e) => { store.set('dashMine', e.target.checked); renderMain('#/'); } }), 'Only my tasks') : null,
    h('div', { class: 'seg' },
      h('button', { class: view === 'list' ? 'active' : '', onclick: () => { store.set('dashView', 'list'); renderMain('#/'); } }, 'List'),
      h('button', { class: view === 'calendar' ? 'active' : '', onclick: () => { store.set('dashView', 'calendar'); renderMain('#/'); } }, 'Calendar')));
  content.append(head);
  const tasks = await api('GET', `/api/tasks?sort=due${mine ? '&assignee=me' : ''}`);

  if (view === 'calendar') { content.append(calendar(tasks, { showProject: true })); return; }

  const open = tasks.filter((t) => !t.completed_at);
  const now = new Date();
  const endToday = startOfDay(); endToday.setDate(endToday.getDate() + 1);
  const endWeek = startOfDay(); endWeek.setDate(endWeek.getDate() + 7);
  const groups = [
    ['Overdue', 'overdue', open.filter((t) => t.due_at && new Date(t.due_at) < now)],
    ['Due today', 'today', open.filter((t) => t.due_at && new Date(t.due_at) >= now && new Date(t.due_at) < endToday)],
    ['Next 7 days', '', open.filter((t) => t.due_at && new Date(t.due_at) >= endToday && new Date(t.due_at) < endWeek)],
    ['Later', '', open.filter((t) => t.due_at && new Date(t.due_at) >= endWeek)],
    ['No deadline', '', open.filter((t) => !t.due_at)],
  ];
  content.append(h('div', { class: 'stats' },
    h('div', { class: 'stat overdue' }, h('div', { class: 'v' }, groups[0][2].length), h('div', { class: 'muted' }, 'Overdue')),
    h('div', { class: 'stat today' }, h('div', { class: 'v' }, groups[1][2].length), h('div', { class: 'muted' }, 'Due today')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, groups[2][2].length), h('div', { class: 'muted' }, 'Next 7 days')),
    h('div', { class: 'stat' }, h('div', { class: 'v' }, groups[4][2].length), h('div', { class: 'muted' }, 'Open, no deadline'))));

  if (!open.length) { content.append(h('div', { class: 'list' }, h('div', { class: 'empty' }, 'Nothing open. 🎉'))); return; }
  content.append(h('div', { class: 'list' }, groups.filter((g) => g[2].length).map(([name, cls, items]) => [
    h('div', { class: 'list-group-head' }, name, h('span', { class: `chip ${cls}` }, items.length)),
    items.map((t) => listRow(t, { showProject: true })),
  ])));
}

// ---------- project (tab) page ----------
function projectView(p) { return store.get(`view:${p.id}`, 'board'); }

async function renderProject(content, project) {
  const biz = businessById(project.business_id);
  const tabs = state.boot.projects.filter((p) => p.business_id === biz.id && (!p.archived || p.id === project.id));
  const view = projectView(project);
  const preview = isStaff() && state.clientPreview;
  const search = h('input', { type: 'search', placeholder: 'Search…', style: { width: '180px' }, value: store.get(`q:${project.id}`, '') });

  content.append(
    h('div', { class: 'page-head' },
      h('span', { class: 'biz-dot', style: { background: biz.color, width: '14px', height: '14px', borderRadius: '4px', display: 'inline-block' } }),
      h('h1', {}, biz.name),
      h('span', { class: 'grow' }),
      isStaff() ? h('label', { class: 'switch', title: 'See exactly what your client sees' },
        h('input', { type: 'checkbox', checked: preview, onchange: (e) => { state.clientPreview = e.target.checked; store.set('clientPreview', e.target.checked); renderMain(state.lastMain); } }), 'Client view') : null,
    ),
    h('div', { class: 'tabs' },
      tabs.filter((p) => !preview || p.client_visible).map((p) => h('a', { href: `#/p/${p.id}`, class: p.id === project.id ? 'active' : '' },
        p.name, isStaff() && !p.client_visible ? h('span', { title: 'Hidden from clients' }, '🔒') : null, p.archived ? h('span', { class: 'chip' }, 'archived') : null)),
      isStaff() ? h('button', { onclick: () => addProject(biz.id), title: 'Add a tab' }, '+ Tab') : null,
    ),
  );

  if (preview) {
    content.append(h('div', { class: 'banner' }, h('span', {}, '👁'),
      project.client_visible
        ? `Client view: showing only what ${clientNames(project) || 'clients with access'} can see. Internal tasks and notes are hidden.`
        : 'Client view: this whole tab is hidden from clients — they would not see it at all.'));
  } else if (isStaff() && !project.client_visible) {
    content.append(h('div', { class: 'banner' }, h('span', {}, '🔒'), 'This tab is internal — clients can’t see it, even if they have access to other tabs of this business.'));
  }

  content.append(h('div', { class: 'page-head' },
    h('div', { class: 'seg' }, ['board', 'list', 'calendar'].map((v) => h('button', {
      class: view === v ? 'active' : '',
      onclick: () => { store.set(`view:${project.id}`, v); renderMain(state.lastMain); },
    }, v[0].toUpperCase() + v.slice(1)))),
    search,
    h('span', { class: 'grow' }),
    h('span', { class: 'muted small' }, `Email/message key: `, h('code', {}, project.key)),
    isStaff() ? h('button', { class: 'btn', onclick: () => projectSettingsModal(project) }, '⚙ Tab settings') : null,
  ));

  const area = h('div');
  content.append(area);
  let tasks = await api('GET', `/api/tasks?project_id=${project.id}${preview ? '&client_view=1' : ''}`);
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    store.set(`q:${project.id}`, search.value);
    const shown = q ? tasks.filter((t) => `${t.title} ${t.description} ${t.project_key}-${t.id}`.toLowerCase().includes(q)) : tasks;
    area.replaceChildren(
      view === 'list' ? listView(project, shown)
        : view === 'calendar' ? calendar(shown)
          : boardView(project, shown, preview, async () => { tasks = await api('GET', `/api/tasks?project_id=${project.id}${preview ? '&client_view=1' : ''}`); draw(); }),
    );
  };
  search.addEventListener('input', draw);
  if (preview && !project.client_visible) tasks = [];
  draw();
}

function clientNames(project) {
  return (project.client_ids || []).map((id) => state.boot.people.find((p) => p.id === id)?.name).filter(Boolean).join(', ');
}

function boardView(project, tasks, preview, reload) {
  const board = h('div', { class: 'board' });
  for (const col of project.columns) {
    const colTasks = tasks.filter((t) => t.column_id === col.id).sort((a, b) => a.position - b.position);
    // Keep Done columns tidy: show the last 30 days; older work lives on in Reports.
    const cutoff = Date.now() - 30 * 864e5;
    const showAll = store.get(`allDone:${project.id}`, false);
    const older = col.is_done && !showAll ? colTasks.filter((t) => t.completed_at && new Date(t.completed_at) < cutoff) : [];
    const shown = older.length ? colTasks.filter((t) => !older.includes(t)) : colTasks;
    const body = h('div', { class: 'col-body' }, shown.map(cardEl),
      older.length ? h('button', { class: 'btn ghost sm', onclick: () => { store.set(`allDone:${project.id}`, true); reload(); } }, `Show ${older.length} completed over 30 days ago`) : null,
      col.is_done && showAll && colTasks.some((t) => t.completed_at && new Date(t.completed_at) < cutoff)
        ? h('button', { class: 'btn ghost sm', onclick: () => { store.set(`allDone:${project.id}`, false); reload(); } }, 'Hide older completed') : null);
    const colEl = h('div', { class: 'col' },
      h('div', { class: 'col-head' }, col.is_done ? '✅' : null, col.name, h('span', { class: 'n' }, colTasks.length)),
      body);
    if (isStaff() && !preview) {
      colEl.append(quickAdd(project, col, reload));
      colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drop'); });
      colEl.addEventListener('dragleave', (e) => { if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('drop'); });
      colEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        colEl.classList.remove('drop');
        const id = Number(e.dataTransfer.getData('text/plain'));
        if (!id) return;
        // position between neighbours under the cursor
        const cards = [...body.querySelectorAll('.card')].filter((c) => Number(c.dataset.id) !== id);
        const after = cards.find((c) => e.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2);
        const pos = (el) => colTasks.find((t) => t.id === Number(el?.dataset.id))?.position;
        let position;
        if (!cards.length) position = 1;
        else if (!after) position = (pos(cards.at(-1)) ?? 0) + 1;
        else {
          const idx = cards.indexOf(after);
          const before = idx > 0 ? pos(cards[idx - 1]) : (pos(after) ?? 1) - 1;
          position = ((before ?? 0) + (pos(after) ?? 1)) / 2;
        }
        try {
          await api('PATCH', `/api/tasks/${id}`, { column_id: col.id, position });
          await reload();
        } catch (err) { fail(err); }
      });
    }
    board.append(colEl);
  }
  return board;
}

function quickAdd(project, col, reload) {
  const wrap = h('div', { class: 'add-card' });
  const button = h('button', { class: 'btn ghost', style: { width: '100%', justifyContent: 'flex-start' } }, '+ Add task');
  const input = h('textarea', { rows: 2, placeholder: 'Title — add due:fri !high @name +client', style: { minHeight: '54px' } });
  const reset = () => wrap.replaceChildren(button);
  button.onclick = () => { wrap.replaceChildren(input, h('div', { class: 'small muted', style: { marginTop: '4px' } }, 'Enter to add · Esc to cancel')); input.focus(); };
  input.onkeydown = async (e) => {
    if (e.key === 'Escape') return reset();
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      const r = await api('POST', '/api/command', { subject: `[${project.key}] ${text}`, body: `status: ${col.name}` });
      if (!r.ok) { showCommandResult(r); return; }
      input.value = '';
      await reload();
      wrap.replaceChildren(input);
      input.focus();
    } catch (err) { fail(err); }
  };
  input.onblur = () => { if (!input.value.trim()) setTimeout(reset, 150); };
  reset();
  return wrap;
}

function listView(project, tasks) {
  const showDone = store.get('showDone', true);
  const list = h('div', { class: 'list' });
  for (const col of project.columns) {
    if (col.is_done && !showDone) continue;
    const items = tasks.filter((t) => t.column_id === col.id).sort((a, b) => (a.due_at || '9') < (b.due_at || '9') ? -1 : 1);
    list.append(h('div', { class: 'list-group-head' }, col.name, h('span', { class: 'chip' }, items.length)), items.map((t) => listRow(t)));
  }
  return h('div', {},
    h('label', { class: 'switch', style: { marginBottom: '10px' } }, h('input', { type: 'checkbox', checked: showDone, onchange: (e) => { store.set('showDone', e.target.checked); renderMain(state.lastMain); } }), 'Show completed'),
    list);
}

let calMonth = startOfDay(); calMonth.setDate(1);
function calendar(tasks, opts = {}) {
  const wrap = h('div');
  const draw = () => {
    const first = new Date(calMonth);
    const start = new Date(first); start.setDate(1 - first.getDay());
    const today = startOfDay().getTime();
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const dayTasks = tasks.filter((t) => t.due_at && startOfDay(new Date(t.due_at)).getTime() === d.getTime());
      cells.push(h('div', { class: `day${d.getMonth() !== first.getMonth() ? ' other' : ''}${d.getTime() === today ? ' today' : ''}` },
        h('span', { class: 'd' }, d.getDate()),
        dayTasks.map((t) => {
          const info = dueInfo(t);
          return h('div', { class: `ev ${info.cls}`, title: `${t.project_key}-${t.id} ${t.title}`, onclick: () => openTask(t.id) },
            opts.showProject ? `${t.project_key} · ` : '', t.title);
        })));
    }
    wrap.replaceChildren(
      h('div', { class: 'page-head' },
        h('button', { class: 'btn', onclick: () => { calMonth.setMonth(calMonth.getMonth() - 1); draw(); } }, '‹'),
        h('h2', {}, first.toLocaleDateString([], { month: 'long', year: 'numeric' })),
        h('button', { class: 'btn', onclick: () => { calMonth.setMonth(calMonth.getMonth() + 1); draw(); } }, '›'),
        h('button', { class: 'btn ghost', onclick: () => { calMonth = startOfDay(); calMonth.setDate(1); draw(); } }, 'Today')),
      h('div', { class: 'cal' }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => h('div', { class: 'dow' }, d)), cells));
  };
  draw();
  return wrap;
}

function renderEmptyBusiness(content, biz) {
  content.append(h('div', { class: 'page-head' }, h('h1', {}, biz.name)),
    h('div', { class: 'panel empty' }, 'No tabs yet. ', isStaff() ? h('button', { class: 'btn primary', onclick: () => addProject(biz.id) }, '+ Add a tab') : null));
}

// ---------- task drawer ----------
async function openTask(id) {
  state.drawerTaskId = id;
  let task;
  try { task = await api('GET', `/api/tasks/${id}`); } catch (err) { state.drawerTaskId = null; return fail(err); }
  closeDrawer(false);
  const staff = isStaff();
  const project = projectById(task.project_id);
  const save = async (patch) => {
    try {
      await api('PATCH', `/api/tasks/${id}`, patch);
      await refreshAll();
    } catch (err) { fail(err); openTask(id); }
  };

  const titleEl = staff
    ? h('input', { type: 'text', class: 'title-input', value: task.title, onchange: (e) => save({ title: e.target.value }) })
    : h('h2', {}, task.title);

  const fields = staff ? h('div', { class: 'grid2' },
    h('label', { class: 'field' }, h('span', {}, 'Status'),
      h('select', { onchange: (e) => save({ column_id: Number(e.target.value) }) },
        project.columns.map((c) => h('option', { value: c.id, selected: c.id === task.column_id }, c.name)))),
    h('label', { class: 'field' }, h('span', {}, 'Deadline'),
      h('div', { class: 'row' },
        h('input', { type: 'datetime-local', value: toLocalInput(task.due_at), onchange: (e) => save({ due_at: e.target.value ? new Date(e.target.value).toISOString() : null }) }),
        task.due_at ? h('button', { class: 'btn ghost sm', title: 'Clear deadline', onclick: () => save({ due_at: null }) }, '✕') : null)),
    h('label', { class: 'field' }, h('span', {}, 'Assignee'),
      h('select', { onchange: (e) => save({ assignee_id: e.target.value ? Number(e.target.value) : null }) },
        h('option', { value: '' }, 'Unassigned'),
        staffPeople().map((p) => h('option', { value: p.id, selected: p.id === task.assignee_id }, p.name)))),
    h('label', { class: 'field' }, h('span', {}, 'Priority'),
      h('select', { onchange: (e) => save({ priority: e.target.value }) },
        ['low', 'normal', 'high', 'urgent'].map((p) => h('option', { value: p, selected: p === task.priority }, p[0].toUpperCase() + p.slice(1))))),
  ) : h('div', { class: 'row', style: { flexWrap: 'wrap', marginBottom: '14px' } },
    h('span', { class: 'chip' }, task.column_name), chips(task));

  const visBox = staff ? h('div', { class: `vis-box ${task.client_visible ? 'client' : 'internal'}` },
    h('label', { class: 'switch grow' },
      h('input', { type: 'checkbox', checked: !!task.client_visible, onchange: (e) => save({ client_visible: e.target.checked }) }),
      h('div', {},
        h('strong', {}, task.client_visible ? '👁 Visible to client' : '🔒 Internal only'),
        h('div', { class: 'small' }, task.client_visible
          ? (project.client_visible ? `Seen by: ${clientNames(project) || 'no clients have access to this tab yet'}` : 'Note: this tab itself is hidden from clients.')
          : 'Clients never see this task.')))) : null;

  let descEditing = false;
  const descWrap = h('div');
  const drawDesc = () => {
    if (descEditing) {
      const ta = h('textarea', { rows: 6 }, task.description);
      descWrap.replaceChildren(ta, h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary sm', onclick: () => save({ description: ta.value }) }, 'Save'),
        h('button', { class: 'btn sm', onclick: () => { descEditing = false; drawDesc(); } }, 'Cancel')));
      ta.focus();
    } else {
      descWrap.replaceChildren(h('div', {
        class: 'desc-view', style: { cursor: staff ? 'text' : 'default', minHeight: '24px' },
        onclick: () => { if (staff) { descEditing = true; drawDesc(); } },
      }, task.description || h('span', { class: 'muted' }, staff ? 'Add a description…' : 'No description')));
    }
  };
  drawDesc();

  const internalToggle = h('input', { type: 'checkbox' });
  const commentBox = h('textarea', { rows: 3, placeholder: staff ? 'Write a comment…' : 'Write a message to the team…' });
  const composer = h('div', {},
    commentBox,
    h('div', { class: 'row', style: { marginTop: '6px' } },
      staff ? h('label', { class: 'switch small' }, internalToggle, 'Internal note (hidden from client)') : null,
      h('span', { class: 'grow' }),
      h('button', {
        class: 'btn primary sm',
        onclick: async () => {
          if (!commentBox.value.trim()) return;
          try {
            await api('POST', `/api/tasks/${id}/comments`, { body: commentBox.value, internal: internalToggle.checked });
            openTask(id);
            refreshList();
          } catch (err) { fail(err); }
        },
      }, 'Post')));
  internalToggle.addEventListener('change', () => { commentBox.placeholder = internalToggle.checked ? 'Internal note — only your team sees this' : 'Write a comment…'; });

  const drawer = h('div', { class: 'drawer', role: 'dialog', 'aria-label': task.title },
    h('div', { class: 'drawer-head' },
      h('span', { class: 'chip' }, `${task.project_key}-${task.id}`),
      h('span', { class: 'muted small grow' }, businessById(task.business_id)?.name, ' › ', task.project_name),
      staff ? h('button', {
        class: 'btn ghost sm danger',
        onclick: async () => {
          if (!confirm('Delete this task?')) return;
          try { await api('DELETE', `/api/tasks/${id}`); closeDrawer(); refreshAll(); } catch (err) { fail(err); }
        },
      }, 'Delete') : null,
      h('button', { class: 'btn ghost', onclick: () => closeDrawer(), 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'drawer-body' },
      titleEl,
      h('div', { style: { height: '12px' } }),
      fields,
      visBox,
      h('h3', { style: { margin: '6px 0' } }, 'Description'),
      descWrap,
      h('h3', { style: { margin: '20px 0 8px' } }, 'Comments'),
      task.comments.length ? task.comments.map((c) => h('div', { class: `comment${c.internal ? ' internal' : ''}` },
        h('div', { class: 'who' }, h('strong', {}, c.user_name || 'Someone'), c.user_role === 'client' ? h('span', { class: 'chip client' }, 'client') : null,
          c.internal ? h('span', { class: 'chip internal' }, '🔒 internal') : null,
          c.source !== 'web' ? h('span', { class: 'chip' }, `via ${c.source}`) : null,
          h('span', {}, new Date(c.created_at.replace(' ', 'T') + (c.created_at.includes('Z') || c.created_at.includes('+') ? '' : 'Z')).toLocaleString())),
        h('div', { class: 'body' }, c.body))) : h('div', { class: 'muted small', style: { marginBottom: '8px' } }, 'No comments yet.'),
      composer,
      staff && task.activity.length ? [
        h('h3', { style: { margin: '20px 0 6px' } }, 'Activity'),
        task.activity.map((a) => h('div', { class: 'activity' },
          `${a.user_name || 'System'} ${a.action}${a.detail ? ` — ${a.detail}` : ''}${a.source !== 'web' ? ` (via ${a.source})` : ''} · ${new Date(a.created_at.replace(' ', 'T') + 'Z').toLocaleString()}`)),
      ] : null,
    ));
  document.body.append(h('div', { class: 'overlay', onclick: () => closeDrawer() }), drawer);
}

function closeDrawer(clearState = true) {
  document.querySelectorAll('.drawer, .overlay').forEach((el) => el.remove());
  if (clearState) state.drawerTaskId = null;
}

async function refreshList() {
  // light refresh of the main area without rebuilding the shell
  renderMain(state.lastMain);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); closeDrawer(); }
});

// ---------- modals ----------
function modal(title, body, actions = []) {
  closeModal();
  const m = h('div', { class: 'modal', role: 'dialog' }, h('h2', {}, title), body, actions.length ? h('div', { class: 'actions' }, actions) : null);
  document.body.append(h('div', { class: 'overlay', 'data-modal': '1', onclick: closeModal }), m);
  m.querySelector('input, select, textarea')?.focus();
  return m;
}
function closeModal() { document.querySelectorAll('.modal, .overlay[data-modal]').forEach((el) => el.remove()); }

function newTaskModal(defaults = {}) {
  const projects = state.boot.projects.filter((p) => !p.archived);
  if (!projects.length) return toast('Create a business first (Settings).', true);
  const current = state.lastMain.match(/^#\/p\/(\d+)/)?.[1];
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      try {
        const t = await api('POST', '/api/tasks', {
          project_id: Number(f.project_id),
          title: f.title,
          description: f.description,
          due_at: f.due_at ? new Date(f.due_at).toISOString() : null,
          priority: f.priority,
          assignee_id: f.assignee_id ? Number(f.assignee_id) : null,
          client_visible: !!f.client_visible,
        });
        closeModal();
        await refreshAll();
        toast(`Created ${projectById(t.project_id).key}-${t.id}`);
      } catch (err) { fail(err); }
    },
  },
  h('label', { class: 'field' }, h('span', {}, 'Title'), h('input', { type: 'text', name: 'title', required: true })),
  h('label', { class: 'field' }, h('span', {}, 'Business › Tab'),
    h('select', { name: 'project_id' }, state.boot.businesses.map((b) => h('optgroup', { label: b.name },
      projects.filter((p) => p.business_id === b.id).map((p) => h('option', { value: p.id, selected: String(p.id) === String(defaults.project_id || current) }, `${p.name} (${p.key})`)))))),
  h('div', { class: 'grid2' },
    h('label', { class: 'field' }, h('span', {}, 'Deadline'), h('input', { type: 'datetime-local', name: 'due_at' })),
    h('label', { class: 'field' }, h('span', {}, 'Priority'), h('select', { name: 'priority' }, ['normal', 'low', 'high', 'urgent'].map((p) => h('option', { value: p }, p[0].toUpperCase() + p.slice(1))))),
    h('label', { class: 'field' }, h('span', {}, 'Assignee'), h('select', { name: 'assignee_id' }, h('option', { value: '' }, 'Unassigned'), staffPeople().map((p) => h('option', { value: p.id, selected: p.id === state.boot.me.id }, p.name)))),
    h('label', { class: 'field switch', style: { marginTop: '22px' } }, h('input', { type: 'checkbox', name: 'client_visible' }), 'Visible to client')),
  h('label', { class: 'field' }, h('span', {}, 'Description'), h('textarea', { name: 'description', rows: 3 })),
  h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: closeModal }, 'Cancel'), h('button', { class: 'btn primary' }, 'Create task')));
  modal('New task', form);
}

async function addBusiness() {
  const name = prompt('Business name');
  if (!name) return;
  try {
    const b = await api('POST', '/api/businesses', { name });
    await loadBoot();
    location.hash = `#/b/${b.id}`;
    renderShell();
  } catch (err) { fail(err); }
}

async function addProject(businessId) {
  const name = prompt('Tab / project name (e.g. "SEO & Citations", "Website", "Internal")');
  if (!name) return;
  try {
    const p = await api('POST', '/api/projects', { business_id: businessId, name });
    await loadBoot();
    renderShell();
    location.hash = `#/p/${p.id}`;
    toast(`Created tab ${p.name} — email key ${p.key}`);
  } catch (err) { fail(err); }
}

function projectSettingsModal(project) {
  const clients = state.boot.people.filter((p) => p.role === 'client');
  const nameIn = h('input', { type: 'text', value: project.name });
  const keyIn = h('input', { type: 'text', value: project.key, maxlength: 10, style: { textTransform: 'uppercase' } });
  const visIn = h('input', { type: 'checkbox', checked: !!project.client_visible });
  const clientChecks = clients.map((c) => h('label', {}, h('input', { type: 'checkbox', value: c.id, checked: (project.client_ids || []).includes(c.id) }), c.name));
  const colList = h('div');
  const drawCols = () => colList.replaceChildren(...project.columns.map((c) => h('div', { class: 'row', style: { marginBottom: '6px' } },
    h('input', { type: 'text', value: c.name, onchange: (e) => api('PATCH', `/api/columns/${c.id}`, { name: e.target.value }).then(refreshAll).catch(fail) }),
    h('label', { class: 'switch small', title: 'Tasks moved here count as completed' }, h('input', { type: 'checkbox', checked: !!c.is_done, onchange: (e) => api('PATCH', `/api/columns/${c.id}`, { is_done: e.target.checked }).then(refreshAll).catch(fail) }), 'Done'),
    h('button', { class: 'btn ghost sm danger', onclick: async () => { if (confirm(`Delete column "${c.name}"? Its tasks move to the first column.`)) { await api('DELETE', `/api/columns/${c.id}`).catch(fail); closeModal(); refreshAll(); } } }, '✕'))));
  drawCols();

  modal(`Tab settings — ${project.name}`, h('div', {},
    h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
    h('label', { class: 'field' }, h('span', {}, 'Key used in emails & messages (e.g. [KEY] Task title)'), keyIn),
    h('div', { class: 'vis-box' }, h('label', { class: 'switch' }, visIn, h('div', {}, h('strong', {}, 'Clients can open this tab'), h('div', { class: 'small muted' }, 'Off = the whole tab is internal. On = clients below see only the tasks you mark “Visible to client”.')))),
    h('label', { class: 'field' }, h('span', {}, 'Clients with access'), clients.length ? h('div', { class: 'checks' }, clientChecks) : h('div', { class: 'muted small' }, 'No client accounts yet — add them in Settings › People.')),
    h('label', { class: 'field' }, h('span', {}, 'Columns'), colList,
      h('button', { class: 'btn sm', onclick: async () => { const n = prompt('Column name'); if (n) { await api('POST', `/api/projects/${project.id}/columns`, { name: n }).catch(fail); closeModal(); refreshAll(); } } }, '+ Add column')),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: async () => { await api('PATCH', `/api/projects/${project.id}`, { archived: !project.archived }).catch(fail); closeModal(); refreshAll(); } }, project.archived ? 'Unarchive tab' : 'Archive tab'),
      isOwner() ? h('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`Delete "${project.name}" and ALL its tasks? This cannot be undone.`)) { await api('DELETE', `/api/projects/${project.id}`).catch(fail); closeModal(); await loadBoot(); location.hash = '#/'; renderShell(); } } }, 'Delete tab') : null),
  ), [
    h('button', { class: 'btn', onclick: closeModal }, 'Close'),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        try {
          await api('PATCH', `/api/projects/${project.id}`, { name: nameIn.value, key: keyIn.value, client_visible: visIn.checked });
          await api('PUT', `/api/projects/${project.id}/clients`, { user_ids: clientChecks.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value)) });
          closeModal();
          refreshAll();
          toast('Saved');
        } catch (err) { fail(err); }
      },
    }, 'Save'),
  ]);
}

// ---------- monthly reports ----------
const fmtDay = (iso) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

function prevMonthKey() {
  const d = new Date(); d.setDate(1);
  // Early in the month, default to last month's report; otherwise this month so far.
  if (new Date().getDate() <= 7) d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** append() turns null into the text "null"; skip empty slots instead. */
const appendAll = (el, ...kids) => el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));

async function renderReports(content, monthParam) {
  if (monthParam) store.set('reportMonth', monthParam);
  const month = store.get('reportMonth', prevMonthKey());
  const clientVersion = isStaff() ? store.get('reportClient', false) : true;
  const bizFilter = store.get('reportBiz', '');
  const qs = `month=${month}${clientVersion ? '&client_view=1' : ''}${bizFilter ? `&business_id=${bizFilter}` : ''}`;
  const rerender = () => { content.replaceChildren(); renderReports(content); };

  const monthIn = h('input', { type: 'month', value: month, style: { width: '170px' }, onchange: (e) => { store.set('reportMonth', e.target.value); if (location.hash !== '#/reports') location.hash = '#/reports'; else rerender(); } });
  content.append(h('div', { class: 'page-head no-print' },
    h('h1', { class: 'grow' }, 'Monthly report'),
    monthIn,
    isStaff() ? h('select', { style: { width: '220px' }, onchange: (e) => { store.set('reportBiz', e.target.value); rerender(); } },
      h('option', { value: '' }, 'All businesses'),
      state.boot.businesses.map((b) => h('option', { value: b.id, selected: String(b.id) === String(bizFilter) }, b.name))) : null,
    isStaff() ? h('label', { class: 'switch', title: 'Only client-visible work, no names — ready to send to a client' },
      h('input', { type: 'checkbox', checked: clientVersion, onchange: (e) => { store.set('reportClient', e.target.checked); rerender(); } }), 'Client version') : null,
    h('button', { class: 'btn', onclick: () => window.print() }, '🖨 Print / PDF'),
    h('a', { class: 'btn', href: `/api/reports/monthly.txt?${qs}` }, '⬇ Text')));

  const rep = await api('GET', `/api/reports/monthly?${qs}`);
  const summaryBox = h('div');
  const person = (t) => (!rep.clientView && t.assignee_name ? h('span', { class: 'chip' }, t.assignee_name) : null);
  const section = (title, groups, row) => h('div', { class: 'panel' }, h('h2', {}, title),
    groups.length ? groups.map((b) => h('div', { class: 'rep-biz' },
      h('h3', { class: 'row' }, h('span', { class: 'biz-dot', style: { background: b.color, width: '10px', height: '10px', borderRadius: '3px', display: 'inline-block' } }), b.name, h('span', { class: 'chip' }, b.count)),
      b.projects.map((p) => [
        b.projects.length > 1 ? h('div', { class: 'muted small rep-proj' }, p.name) : null,
        p.tasks.map(row),
      ]))) : h('div', { class: 'muted' }, 'Nothing here.'));

  appendAll(content,
    h('div', { class: 'rep-title' },
      h('h1', {}, `${rep.clientView ? 'Monthly update' : 'Team report'} — ${rep.label}`),
      h('div', { class: 'muted small' }, `Generated ${new Date(rep.generatedAt).toLocaleString()}${bizFilter ? ` · ${businessById(bizFilter)?.name}` : ''}${rep.clientView ? ' · client version (internal work and names hidden)' : ''}`)),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'v', style: { color: 'var(--ok)' } }, rep.stats.completed), h('div', { class: 'muted' }, 'Completed')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, rep.stats.onTime), h('div', { class: 'muted' }, 'Finished on time')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, rep.stats.late), h('div', { class: 'muted' }, 'Finished late')),
      h('div', { class: 'stat' }, h('div', { class: 'v' }, rep.stats.planned), h('div', { class: 'muted' }, `Planned for ${rep.nextLabel.split(' ')[0]}`)),
      h('div', { class: `stat${rep.stats.carriedOver ? ' overdue' : ''}` }, h('div', { class: 'v' }, rep.stats.carriedOver), h('div', { class: 'muted' }, 'Carried over (overdue)'))),
    isStaff() && state.boot.features.ai ? h('div', { class: 'panel no-print-empty' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Summary'),
        h('button', {
          class: 'btn sm no-print',
          onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = 'Writing…';
            try {
              const { summary } = await api('POST', '/api/reports/summary', { month: rep.month, client_view: rep.clientView, business_id: bizFilter || null });
              summaryBox.replaceChildren(h('div', { class: 'desc-view' }, summary));
            } catch (err) { fail(err); }
            e.target.disabled = false; e.target.textContent = '✨ Write summary with Claude';
          },
        }, '✨ Write summary with Claude')),
      summaryBox) : null,
    section(`✅ Accomplished in ${rep.label}`, rep.completed, (t) => h('div', { class: 'rep-row' },
      h('span', { class: 'rep-check' }, '✓'),
      h('span', { class: 'grow' }, t.title),
      person(t),
      !rep.clientView && t.due_at ? (t.completed_at <= t.due_at ? h('span', { class: 'chip done' }, 'on time') : h('span', { class: 'chip overdue' }, 'late')) : null,
      h('span', { class: 'muted small' }, fmtDay(t.completed_at)))),
    !rep.clientView && rep.byPerson.length ? h('div', { class: 'panel' }, h('h2', {}, 'By team member'),
      h('div', { class: 'rep-people' }, rep.byPerson.map((p) => h('div', { class: 'rep-person' },
        h('span', { class: 'avatar lg' }, initials(p.name)), h('div', {}, h('strong', {}, p.name), h('div', { class: 'muted small' }, `${p.count} completed`)))))) : null,
    section(`📅 Planned for ${rep.nextLabel}`, rep.planned, (t) => h('div', { class: 'rep-row' },
      h('span', { class: 'rep-check muted' }, '•'),
      h('span', { class: 'grow' }, t.title),
      person(t),
      h('span', { class: 'muted small' }, `due ${fmtDay(t.due_at)}`))),
    rep.carriedOver.length ? h('div', { class: 'panel' }, h('h2', {}, '⚠️ Carried over — still open and past due'),
      rep.carriedOver.map((t) => h('div', { class: 'rep-row' },
        h('span', { class: 'rep-check', style: { color: 'var(--danger)' } }, '!'),
        h('span', { class: 'grow' }, t.title, h('span', { class: 'muted small' }, ` · ${t.business_name}`)),
        person(t),
        h('span', { class: 'chip overdue' }, `was due ${fmtDay(t.due_at)}`)))) : null,
  );

  if (isOwner()) {
    const saved = await api('GET', '/api/reports/saved');
    content.append(h('div', { class: 'panel no-print' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Saved reports'),
      h('button', { class: 'btn sm', onclick: async () => { await api('POST', '/api/reports/save', { month: rep.month, client_view: rep.clientView }).catch(fail); toast('Saved a snapshot of this report'); rerender(); } }, 'Save snapshot')),
      h('p', { class: 'muted small' }, 'A snapshot of each month is saved automatically on the 1st (and emailed to the team if email is set up), so past months stay on record even if tasks are later changed.'),
      saved.length ? h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Month'), h('th', {}, 'Version'), h('th', {}, 'Saved'), h('th', {})),
        saved.map((r) => h('tr', {}, h('td', {}, r.month), h('td', {}, r.client_view ? 'Client' : 'Team'), h('td', { class: 'small' }, r.created_at),
          h('td', { style: { textAlign: 'right' } }, h('button', {
            class: 'btn sm',
            onclick: async () => {
              const data = await api('GET', `/api/reports/saved/${r.id}`);
              const w = window.open('', '_blank');
              if (w) { w.document.title = `Report ${r.month}`; w.document.body.innerHTML = `<pre style="font:14px/1.5 system-ui;white-space:pre-wrap;padding:24px">${escapeHtml(snapshotText(data))}</pre>`; }
            },
          }, 'Open'))))) : h('div', { class: 'muted small' }, 'No snapshots yet.')));
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function snapshotText(rep) {
  const out = [`${rep.clientView ? 'Monthly update' : 'Team report'} — ${rep.label}`, `Completed ${rep.stats.completed} · Planned ${rep.stats.planned} · Carried over ${rep.stats.carriedOver}`, '', 'ACCOMPLISHED'];
  for (const b of rep.completed) { out.push(`\n${b.name}`); for (const p of b.projects) for (const t of p.tasks) out.push(`  ✓ ${t.title}${t.assignee_name && !rep.clientView ? ` — ${t.assignee_name}` : ''} (${fmtDay(t.completed_at)})`); }
  out.push('', `PLANNED FOR ${rep.nextLabel.toUpperCase()}`);
  for (const b of rep.planned) { out.push(`\n${b.name}`); for (const p of b.projects) for (const t of p.tasks) out.push(`  • ${t.title} — due ${fmtDay(t.due_at)}`); }
  return out.join('\n');
}

// ---------- notifications ----------
async function renderNotifications(content) {
  const list = await api('GET', '/api/notifications');
  content.append(
    h('div', { class: 'page-head' }, h('h1', { class: 'grow' }, 'Notifications'),
      h('button', { class: 'btn', onclick: async () => { await api('POST', '/api/notifications/read', { all: true }); refreshAll(); } }, 'Mark all read')),
    h('div', { class: 'list' }, list.length ? list.map((n) => h('div', {
      class: `notif${n.read ? '' : ' unread'}`,
      onclick: async () => {
        if (!n.read) await api('POST', '/api/notifications/read', { ids: [n.id] });
        if (n.task_id) openTask(n.task_id);
        loadBoot().then(renderShell);
        if (!n.read) { n.read = 1; content.replaceChildren(); renderNotifications(content); }
      },
    },
    h('span', {}, { assigned: '👤', due_soon: '⏰', overdue: '🚨', comment: '💬', client_comment: '🗣', completed: '✅', due_changed: '📅' }[n.kind] || '🔔'),
    h('div', { class: 'grow' }, h('div', {}, n.message), h('div', { class: 'muted small' }, new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString())))) : h('div', { class: 'empty' }, 'No notifications yet.')),
  );
}

// ---------- settings ----------
function renderSettings(content, tab) {
  const tabs = isOwner()
    ? [['businesses', 'Businesses & tabs'], ['people', 'People & access'], ['automation', 'Email & automation'], ['import', 'Import from Trello'], ['profile', 'My profile']]
    : [['profile', 'My profile']];
  content.append(
    h('div', { class: 'page-head' }, h('h1', {}, isOwner() ? 'Settings' : 'Profile')),
    ...(tabs.length > 1 ? [h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('a', { href: `#/settings/${k}`, class: k === tab ? 'active' : '' }, label)))] : []),
  );
  const area = h('div', { style: { maxWidth: '900px' } });
  content.append(area);
  const fn = { businesses: settingsBusinesses, people: settingsPeople, automation: settingsAutomation, import: settingsImport, profile: settingsProfile }[tab] || settingsProfile;
  fn(area).catch(fail);
}

async function settingsProfile(area) {
  const me = state.boot.me;
  const nameIn = h('input', { type: 'text', value: me.name });
  const emailIn = h('input', { type: 'checkbox', checked: !!me.email_notifications });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8 });
  area.append(
    h('div', { class: 'panel' }, h('h2', {}, 'Profile'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
      h('label', { class: 'switch', style: { marginBottom: '12px' } }, emailIn, `Email me notifications${state.boot.features.email ? '' : ' (email is not configured on the server yet)'}`),
      h('div', {}, h('button', { class: 'btn primary', onclick: async () => { await api('PATCH', '/api/me', { name: nameIn.value, email_notifications: emailIn.checked }).catch(fail); await refreshAll(); toast('Saved'); } }, 'Save'))),
    h('div', { class: 'panel' }, h('h2', {}, 'Change password'),
      h('label', { class: 'field' }, h('span', {}, 'Current password'), cur),
      h('label', { class: 'field' }, h('span', {}, 'New password'), nw),
      h('button', { class: 'btn', onclick: async () => { try { await api('PATCH', '/api/me', { current_password: cur.value, new_password: nw.value }); cur.value = nw.value = ''; toast('Password changed'); } catch (err) { fail(err); } } }, 'Change password')));
}

async function settingsBusinesses(area) {
  const b = state.boot;
  area.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, h('button', { class: 'btn primary', onclick: addBusiness }, '+ Add business')));
  for (const biz of b.businesses) {
    const projects = b.projects.filter((p) => p.business_id === biz.id);
    area.append(h('div', { class: 'panel' },
      h('div', { class: 'row', style: { marginBottom: '10px' } },
        h('input', { type: 'color', value: biz.color, style: { width: '36px', height: '30px', padding: 0, border: 0, background: 'none' }, onchange: (e) => api('PATCH', `/api/businesses/${biz.id}`, { color: e.target.value }).then(refreshAll).catch(fail) }),
        h('input', { type: 'text', value: biz.name, style: { fontWeight: 700, maxWidth: '360px' }, onchange: (e) => api('PATCH', `/api/businesses/${biz.id}`, { name: e.target.value }).then(refreshAll).catch(fail) }),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => addProject(biz.id) }, '+ Tab'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`Delete ${biz.name} and everything in it?`)) { await api('DELETE', `/api/businesses/${biz.id}`).catch(fail); refreshAll(); } } }, 'Delete')),
      h('table', { class: 't' },
        h('tr', {}, h('th', {}, 'Tab'), h('th', {}, 'Key'), h('th', {}, 'Client access'), h('th', {}, '')),
        projects.map((p) => h('tr', {},
          h('td', {}, h('a', { href: `#/p/${p.id}` }, p.name), p.archived ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, 'archived') : null),
          h('td', {}, h('code', {}, p.key)),
          h('td', {}, p.client_visible ? h('span', { class: 'chip client' }, `👁 ${clientNames(p) || 'visible, no clients yet'}`) : h('span', { class: 'chip internal' }, '🔒 Internal')),
          h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn sm', onclick: () => projectSettingsModal(p) }, 'Edit')))))));
  }
}

async function settingsPeople(area) {
  const users = await api('GET', '/api/users');
  const b = state.boot;
  const draw = () => area.replaceChildren(
    h('div', { class: 'row', style: { marginBottom: '12px' } },
      h('button', { class: 'btn primary', onclick: () => userModal() }, '+ Add person'),
      h('span', { class: 'muted small' }, 'Admins see everything. Team members see only the businesses you tick. Clients see only the tabs you share and, inside them, only tasks marked “Visible to client”.')),
    h('div', { class: 'panel' }, h('table', { class: 't' },
      h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', {}, 'Access'), h('th', {}, '')),
      users.map((u) => h('tr', {},
        h('td', {}, h('div', {}, u.name), h('div', { class: 'muted small' }, u.email)),
        h('td', {}, { owner: 'Admin', member: 'Team', client: 'Client' }[u.role], u.pending ? h('div', {}, h('span', { class: 'chip soon' }, 'invite pending')) : null),
        h('td', { class: 'small' }, u.role === 'owner' ? 'Everything'
          : u.role === 'member' ? (u.business_ids.map((id) => businessById(id)?.name).filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'No businesses'))
            : (u.project_ids.map((id) => { const p = projectById(id); return p ? `${businessById(p.business_id)?.name} › ${p.name}${p.client_visible ? '' : ' (tab hidden)'}` : null; }).filter(Boolean).join(', ') || h('span', { class: 'muted' }, 'Nothing shared'))),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          h('button', { class: 'btn sm', onclick: () => userModal(u) }, 'Edit'),
          h('button', {
            class: 'btn sm',
            title: u.pending ? 'Get a new invite link' : 'Get a link that lets them set a new password',
            onclick: async () => {
              if (!u.pending && !confirm(`Create a new sign-in link for ${u.name}? They'll use it to choose a new password.`)) return;
              try { showInviteLink(u, (await api('POST', `/api/users/${u.id}/invite`, {})).invite_token); } catch (err) { fail(err); }
            },
          }, u.pending ? 'Invite link' : 'Reset link'),
          u.id !== b.me.id ? h('button', { class: 'btn sm danger', onclick: async () => { if (confirm(`Remove ${u.name}?`)) { await api('DELETE', `/api/users/${u.id}`).catch(fail); refreshAll(); } } }, 'Remove') : null))))));

  function userModal(u = null) {
    const f = {
      name: h('input', { type: 'text', value: u?.name || '' }),
      email: h('input', { type: 'email', value: u?.email || '' }),
      role: h('select', {}, [['client', 'Client — sees only what you share'], ['member', 'Team member — sees the businesses you pick'], ['owner', 'Admin — sees and controls everything']].map(([v, l]) => h('option', { value: v, selected: (u?.role || 'client') === v }, l))),
      password: h('input', { type: 'text', placeholder: u ? 'Leave blank to keep' : 'Leave blank to send an invite link' }),
    };
    const bizChecks = b.businesses.map((x) => h('label', {}, h('input', { type: 'checkbox', value: x.id, checked: u?.business_ids.includes(x.id) }), x.name));
    const projChecks = b.projects.filter((p) => !p.archived).map((p) => h('label', { title: p.client_visible ? '' : 'This tab is internal — enable client access on the tab too' },
      h('input', { type: 'checkbox', value: p.id, checked: u?.project_ids.includes(p.id) }), `${businessById(p.business_id)?.name} › ${p.name}`, p.client_visible ? '' : ' 🔒'));
    const memberBox = h('label', { class: 'field' }, h('span', {}, 'Businesses they work on'), h('div', { class: 'checks' }, bizChecks));
    const clientBox = h('label', { class: 'field' }, h('span', {}, 'Tabs they can open (🔒 = tab is internal; turn on client access in tab settings)'), h('div', { class: 'checks' }, projChecks));
    const sync = () => { memberBox.classList.toggle('hidden', f.role.value !== 'member'); clientBox.classList.toggle('hidden', f.role.value !== 'client'); };
    f.role.addEventListener('change', sync);
    sync();
    const checked = (arr) => arr.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => Number(i.value));
    modal(u ? `Edit ${u.name}` : 'Add person', h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Name'), f.name),
      h('label', { class: 'field' }, h('span', {}, 'Email'), f.email),
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'Role'), f.role), h('label', { class: 'field' }, h('span', {}, 'Password'), f.password)),
      memberBox, clientBox), [
      h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const body = { name: f.name.value, email: f.email.value, role: f.role.value, business_ids: checked(bizChecks), project_ids: checked(projChecks) };
          if (f.password.value) body.password = f.password.value;
          try {
            const r = u ? await api('PATCH', `/api/users/${u.id}`, body) : await api('POST', '/api/users', body);
            closeModal();
            await refreshAll();
            if (r.invite_token) showInviteLink({ id: r.id, name: body.name, email: body.email }, r.invite_token);
          } catch (err) { fail(err); }
        },
      }, 'Save')]);
  }
  draw();
}

async function settingsAutomation(area) {
  const [settings, tokens, log] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/tokens'), api('GET', '/api/inbound/log')]);
  const origin = settings.app_url || location.origin;
  const anyKey = state.boot.projects[0]?.key || 'KEY';
  const tokenHint = h('div');
  const projOpts = state.boot.projects.filter((p) => !p.archived);

  const set = (k) => (e) => api('PATCH', '/api/settings', { [k]: e.target.type === 'checkbox' ? e.target.checked : (e.target.type === 'number' ? Number(e.target.value) : (e.target.value === '' ? null : e.target.value)) })
    .then(() => toast('Saved')).catch(fail);

  const tryIn = h('textarea', { rows: 3, placeholder: `${anyKey}: Send logins for all platforms due:friday @pete\n${anyKey}-12 done` });
  const tryOut = h('div', { class: 'result' });
  const runTry = async (dryRun) => {
    try {
      const r = await api('POST', '/api/command', { text: tryIn.value, dryRun });
      tryOut.replaceChildren(
        h('div', { class: 'small muted' }, `Parser: ${r.parser === 'claude' ? 'Claude (AI)' : 'rules'}${dryRun ? ' · preview only' : ''}`),
        ...(dryRun ? [h('pre', {}, JSON.stringify(r.actions, null, 2))] : []),
        ...(r.results || []).map((x) => h('div', { class: 'okline' }, x.action === 'created' ? `✓ Created ${x.task}: ${x.title}` : `✓ ${x.task}: ${x.changes.join(', ')}`)),
        ...r.errors.map((e) => h('div', { class: 'errline' }, `✗ ${e}`)));
      if (!dryRun && r.ok) loadBoot().then(renderShell);
    } catch (err) { fail(err); }
  };

  area.append(
    h('div', { class: 'panel' }, h('h2', {}, '1. Create an automation token'),
      h('p', { class: 'muted' }, 'Email services and tools like Zapier, Make or iPhone Shortcuts use this secret token to post into your board. Treat it like a password.'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn primary',
          onclick: async () => {
            const name = prompt('Name this token (e.g. "Mailgun", "Zapier")', 'Email');
            if (!name) return;
            const { token } = await api('POST', '/api/tokens', { name });
            tokenHint.replaceChildren(h('div', { class: 'banner', style: { flexDirection: 'column', alignItems: 'flex-start' } },
              h('strong', {}, 'Copy this now — it won’t be shown again:'), h('code', { style: { userSelect: 'all' } }, token),
              h('div', {}, 'Email webhook URL:'), h('code', { style: { userSelect: 'all', wordBreak: 'break-all' } }, `${origin}/api/inbound/email?token=${token}`),
              h('div', {}, 'Message webhook URL:'), h('code', { style: { userSelect: 'all', wordBreak: 'break-all' } }, `${origin}/api/inbound/message?token=${token}`)));
          },
        }, '+ New token')),
      tokenHint,
      tokens.length ? h('table', { class: 't', style: { marginTop: '10px' } },
        h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Created'), h('th', {}, 'Last used'), h('th', {})),
        tokens.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'small' }, t.created_at), h('td', { class: 'small' }, t.last_used_at || 'never'),
          h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn sm danger', onclick: async () => { if (confirm('Revoke this token? Anything using it will stop working.')) { await api('DELETE', `/api/tokens/${t.id}`); area.replaceChildren(); settingsAutomation(area); } } }, 'Revoke'))))) : null),

    h('div', { class: 'panel' }, h('h2', {}, '2. Connect your email or messages'),
      h('p', {}, h('strong', {}, 'Email: '), 'point an inbound-email service (Mailgun Routes, SendGrid Inbound Parse, Postmark, Cloudflare Email Workers) at:'),
      h('pre', {}, `${origin}/api/inbound/email?token=YOUR_TOKEN`),
      h('p', { class: 'small muted' }, settings.inbound_email_address ? `Your board’s address: ${settings.inbound_email_address}. Notification emails use it as Reply-To, so replying to a notification adds a comment.` : 'Set INBOUND_EMAIL_ADDRESS on the server so notification emails can be replied to.'),
      h('p', {}, h('strong', {}, 'Gmail without a mail service: '), 'in Zapier/Make, trigger on “New email matching search” (e.g. label:taskboard) and send a webhook POST with subject, body and from to the email URL above.'),
      h('p', {}, h('strong', {}, 'Texts, Slack, Shortcuts, anything else: '), 'POST JSON to the message URL:'),
      h('pre', {}, `curl -X POST ${origin}/api/inbound/message \\\n  -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" \\\n  -d '{"text": "${anyKey}: Send logins for all platforms due:friday !high @pete"}'`),
      h('p', { class: 'small muted' }, 'Twilio SMS works too: set the messaging webhook to the message URL; the reply text confirms what changed.')),

    h('div', { class: 'panel' }, h('h2', {}, 'How to write messages'),
      h('table', { class: 't' },
        h('tr', {}, h('th', {}, 'You send'), h('th', {}, 'What happens')),
        [
          [`Subject: [${anyKey}] Portal training videos`, `New task in the ${anyKey} tab. Email body becomes the description.`],
          [`${anyKey}: Call vendor due:tomorrow 2pm !high @pete +client`, 'New task, due tomorrow 2pm, high priority, assigned to Pete, visible to the client'],
          [`[${anyKey}-12] done`, 'Marks task 12 complete'],
          [`${anyKey}-12 due: next friday`, 'Moves the deadline'],
          [`Re: [${anyKey}-12] … (reply with any text)`, 'Reply text is added as a comment'],
          [`${anyKey}-12 note: they pay net 60`, 'Internal note — never shown to the client'],
          [`Body lines: due: · priority: · status: · assign: · visible: client|internal · comment: · note:`, 'Set any field from the email body'],
          ['Several lines like the above in one text', 'Each line is applied separately'],
        ].map(([a, b2]) => h('tr', {}, h('td', {}, h('code', {}, a)), h('td', { class: 'small' }, b2))))),

    h('div', { class: 'panel' }, h('h2', {}, 'Try it'),
      tryIn,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn', onclick: () => runTry(true) }, 'Preview'),
        h('button', { class: 'btn primary', onclick: () => runTry(false) }, 'Run for real')),
      tryOut),

    h('div', { class: 'panel' }, h('h2', {}, 'Timezone'),
      h('p', { class: 'muted small' }, 'Used for deadlines sent by email or message (“due Friday” means 5pm here), reminders, the morning digest and monthly reports.'),
      h('select', { onchange: set('timezone'), style: { maxWidth: '360px' } },
        [...new Set([settings.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, ...(Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [])])]
          .filter(Boolean).map((tz) => h('option', { value: tz, selected: tz === settings.timezone }, tz.replace(/_/g, ' '))))),
    h('div', { class: 'panel' }, h('h2', {}, 'Automation settings'),
      h('label', { class: 'field' }, h('span', {}, 'Inbox tab — where messages without a [KEY] go'),
        h('select', { onchange: set('inbox_project_id') }, h('option', { value: '' }, 'None (reject them)'),
          projOpts.map((p) => h('option', { value: p.id, selected: Number(settings.inbox_project_id) === p.id }, `${businessById(p.business_id)?.name} › ${p.name}`)))),
      h('label', { class: 'field' }, h('span', {}, `AI interpretation with Claude ${state.boot.features.ai ? '' : '(set ANTHROPIC_API_KEY on the server to enable)'}`),
        h('select', { onchange: set('ai_mode'), disabled: !state.boot.features.ai },
          [['fallback', 'When the message doesn’t follow the format (recommended)'], ['always', 'For every message'], ['off', 'Off — rules only']]
            .map(([v, l]) => h('option', { value: v, selected: settings.ai_mode === v }, l)))),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, 'Send “due soon” reminders this many hours before'), h('input', { type: 'number', min: 1, max: 168, value: settings.reminder_hours, onchange: set('reminder_hours') })),
        h('label', { class: 'field' }, h('span', {}, 'Daily email digest hour (0-23)'), h('input', { type: 'number', min: 0, max: 23, value: settings.digest_hour, onchange: set('digest_hour') }))),
      h('label', { class: 'switch', style: { display: 'flex', marginBottom: '8px' } }, h('input', { type: 'checkbox', checked: settings.inbound_confirmations, onchange: set('inbound_confirmations') }), 'Email a confirmation back after each inbound email'),
      h('label', { class: 'switch', style: { display: 'flex' } }, h('input', { type: 'checkbox', checked: settings.allow_unknown_senders, onchange: set('allow_unknown_senders') }), 'Accept emails from addresses that aren’t TaskBoard users (acts as you)')),

    h('div', { class: 'panel' }, h('h2', {}, 'Recent inbound messages'),
      log.length ? h('table', { class: 't' },
        h('tr', {}, h('th', {}, 'When'), h('th', {}, 'From'), h('th', {}, 'Message'), h('th', {}, 'Result')),
        log.map((l) => h('tr', {},
          h('td', { class: 'small' }, l.created_at),
          h('td', { class: 'small' }, l.channel, h('br'), l.sender || ''),
          h('td', { class: 'small' }, l.subject ? h('strong', {}, l.subject) : null, h('div', { class: 'muted' }, (l.body || '').slice(0, 160))),
          h('td', { class: 'small', style: { whiteSpace: 'pre-line', color: l.ok ? 'var(--ok)' : 'var(--danger)' } }, l.result)))) : h('div', { class: 'muted' }, 'Nothing received yet.')),
  );
}

async function settingsImport(area) {
  const file = h('input', { type: 'file', accept: '.json,application/json' });
  const mode = h('select', {},
    h('option', { value: 'business' }, 'Each Trello list becomes a business (good when lists = clients/businesses)'),
    h('option', { value: 'project' }, 'One business for the board, each list becomes a tab'));
  const archived = h('input', { type: 'checkbox' });
  const out = h('div', { class: 'result' });
  area.append(h('div', { class: 'panel' },
    h('h2', {}, 'Import a Trello board'),
    h('ol', { class: 'muted' },
      h('li', {}, 'In Trello open the board → ⋯ Menu → Print, export and share → Export as JSON.'),
      h('li', {}, 'Save the file and choose it below.'),
      h('li', {}, 'Cards come in as internal tasks (hidden from clients). Completed cards go to Done; checklists, labels and comments are kept.')),
    h('label', { class: 'field' }, h('span', {}, 'Trello JSON export'), file),
    h('label', { class: 'field' }, h('span', {}, 'How to organise it'), mode),
    h('label', { class: 'switch', style: { marginBottom: '12px' } }, archived, 'Include archived lists and cards'),
    h('div', {}, h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!file.files[0]) return toast('Choose a file first', true);
        try {
          const board = JSON.parse(await file.files[0].text());
          const r = await api('POST', '/api/import/trello', { board, mode: mode.value, includeArchived: archived.checked });
          out.replaceChildren(h('div', { class: 'okline' }, `✓ Imported ${r.tasks} tasks into ${r.projects} tabs across ${r.businesses} businesses (${r.comments} comments).`));
          refreshAll();
        } catch (err) { fail(err); }
      },
    }, 'Import')),
    out));
}
