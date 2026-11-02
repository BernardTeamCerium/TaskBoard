import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, tx, getSetting, setSetting } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, userFromSession, userFromApiToken,
  parseCookies, SESSION_COOKIE, randomToken, sha256, loginThrottled, recordLoginFailure, clearLoginFailures,
} from './auth.js';
import {
  isStaff, visibleProjects, visibleBusinesses, canSeeProject, canEditProject, canManageBusiness,
  taskScope, canSeeTask, presentTask,
} from './permissions.js';
import { createTask, updateTask, addComment, deleteTask, getTask, getProject, projectColumns, HttpError } from './tasks.js';
import { handleInbound, summarize } from './inbound.js';
import { startScheduler, emailConfigured, runReminders } from './notify.js';
import { aiAvailable } from './ai.js';
import { importTrello } from './trello.js';
import { buildMonthlyReport, reportText, saveReport, runMonthlyReport } from './reports.js';
import { aiAvailable as aiOn, summarizeReport } from './ai.js';
import { createProject, createBusinessWithProject } from './projects.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.TRUST_PROXY === '1');
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: false, limit: '5mb' }));
  // On Netlify the API is reached through /.netlify/functions/api/*; normalise to /api/*.
  app.use((req, _res, next) => { req.url = req.url.replace(/^\/\.netlify\/functions\/api(?=\/|$)/, '/api'); next(); });
  app.use(express.static(path.join(here, '..', 'public'), { index: 'index.html' }));

  // ---------- auth helpers ----------
  app.use((req, _res, next) => {
    req.sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    req.user = userFromSession(db, req.sessionToken);
    next();
  });
  const requireUser = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Please sign in')));
  const requireStaff = (req, _res, next) => (isStaff(req.user) ? next() : next(new HttpError(403, 'Not allowed')));
  const requireOwner = (req, _res, next) => (req.user?.role === 'owner' ? next() : next(new HttpError(403, 'Owner only')));
  // Basic CSRF defence for cookie-authenticated writes: browsers can't send JSON cross-site without CORS.
  app.use('/api', (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path.startsWith('/inbound/')) return next();
    if (!req.is('application/json')) return next(new HttpError(415, 'Expected JSON'));
    next();
  });

  const setCookie = (res, token, maxAge) => {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'lax', maxAge, path: '/',
      secure: process.env.APP_URL?.startsWith('https://') ?? false,
    });
  };

  // ---------- setup & login ----------
  app.get('/api/setup', (_req, res) => {
    res.json({ needsSetup: !db.prepare('SELECT 1 FROM users LIMIT 1').get(), demo: process.env.DEMO_MODE === '1' });
  });

  app.post('/api/setup', (req, res) => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(400, 'Already set up');
    const { name, email, password, business } = req.body;
    if (!name || !email || !password || password.length < 8) throw new HttpError(400, 'Name, email and a password of 8+ characters are required');
    const user = tx(db, () => {
      const r = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'owner')").run(name, email, hashPassword(password));
      if (business) createBusinessWithProject(db, business);
      return { id: Number(r.lastInsertRowid) };
    });
    const s = createSession(db, user.id);
    setCookie(res, s.token, s.maxAge);
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const email = String(req.body.email || '').trim();
    const key = `${email.toLowerCase()}|${req.ip}`;
    if (loginThrottled(key)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);
    if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) {
      recordLoginFailure(key);
      throw new HttpError(401, 'Wrong email or password');
    }
    clearLoginFailures(key);
    const s = createSession(db, u.id);
    setCookie(res, s.token, s.maxAge);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    destroySession(db, req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', requireUser, (req, res) => res.json(req.user));

  app.patch('/api/me', requireUser, (req, res) => {
    const { name, email_notifications, current_password, new_password } = req.body;
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(name), req.user.id);
    if (email_notifications !== undefined) db.prepare('UPDATE users SET email_notifications = ? WHERE id = ?').run(email_notifications ? 1 : 0, req.user.id);
    if (new_password) {
      const u = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
      if (!verifyPassword(String(current_password || ''), u.password_hash)) throw new HttpError(400, 'Current password is wrong');
      if (String(new_password).length < 8) throw new HttpError(400, 'Password must be 8+ characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(new_password), req.user.id);
    }
    res.json({ ok: true });
  });

  // ---------- bootstrap: everything the UI needs for navigation ----------
  app.get('/api/bootstrap', requireUser, (req, res) => {
    const user = req.user;
    const projects = visibleProjects(db, user, { includeArchived: isStaff(user) }).map((p) => ({
      ...p,
      columns: projectColumns(db, p.id),
      ...(user.role === 'client' ? {} : { client_ids: db.prepare('SELECT user_id FROM project_clients WHERE project_id = ?').all(p.id).map((r) => r.user_id) }),
    }));
    const people = isStaff(user)
      ? db.prepare('SELECT id, name, email, role FROM users ORDER BY role, name').all()
      : db.prepare('SELECT id, name, role FROM users WHERE id = ?').all(user.id);
    const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(user.id).n;
    res.json({
      me: user,
      businesses: visibleBusinesses(db, user),
      projects,
      people,
      unread,
      features: { email: emailConfigured(), ai: aiAvailable(), demo: process.env.DEMO_MODE === '1' },
    });
  });

  // ---------- businesses ----------
  app.post('/api/businesses', requireOwner, (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw new HttpError(400, 'Name is required');
    const b = tx(db, () => createBusinessWithProject(db, name, req.body.color));
    res.json(b);
  });

  app.patch('/api/businesses/:id', requireStaff, (req, res) => {
    if (!canManageBusiness(db, req.user, req.params.id)) throw new HttpError(403, 'Not allowed');
    const { name, color, position } = req.body;
    if (name) db.prepare('UPDATE businesses SET name = ? WHERE id = ?').run(name, req.params.id);
    if (color) db.prepare('UPDATE businesses SET color = ? WHERE id = ?').run(color, req.params.id);
    if (position !== undefined) db.prepare('UPDATE businesses SET position = ? WHERE id = ?').run(position, req.params.id);
    res.json(db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id));
  });

  app.delete('/api/businesses/:id', requireOwner, (req, res) => {
    db.prepare('DELETE FROM businesses WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------- projects (tabs) ----------
  app.post('/api/projects', requireStaff, (req, res) => {
    const { business_id, name, key, client_visible, description } = req.body;
    if (!canManageBusiness(db, req.user, business_id)) throw new HttpError(403, 'Not allowed');
    if (!name) throw new HttpError(400, 'Name is required');
    const p = tx(db, () => createProject(db, business_id, name, key, { client_visible, description }));
    res.json(p);
  });

  app.patch('/api/projects/:id', requireStaff, (req, res) => {
    const p = getProject(db, req.params.id);
    if (!p || !canEditProject(db, req.user, p.id)) throw new HttpError(404, 'Project not found');
    const allowed = ['name', 'description', 'client_visible', 'archived', 'position', 'business_id', 'key'];
    for (const k of allowed) {
      if (req.body[k] === undefined) continue;
      let v = req.body[k];
      if (k === 'key') {
        v = String(v).toUpperCase();
        if (!/^[A-Z][A-Z0-9]{0,9}$/.test(v)) throw new HttpError(400, 'Key must be 1-10 letters/digits starting with a letter');
        const clash = db.prepare('SELECT id FROM projects WHERE key = ? AND id != ?').get(v, p.id);
        if (clash) throw new HttpError(400, `Key ${v} is already used`);
      }
      if (k === 'business_id' && !canManageBusiness(db, req.user, v)) throw new HttpError(403, 'Not allowed');
      if (typeof v === 'boolean') v = v ? 1 : 0;
      db.prepare(`UPDATE projects SET ${k} = ? WHERE id = ?`).run(v, p.id);
    }
    res.json(getProject(db, p.id));
  });

  app.delete('/api/projects/:id', requireOwner, (req, res) => {
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Which client accounts can open this tab.
  app.put('/api/projects/:id/clients', requireStaff, (req, res) => {
    const p = getProject(db, req.params.id);
    if (!p || !canEditProject(db, req.user, p.id)) throw new HttpError(404, 'Project not found');
    const ids = (req.body.user_ids || []).map(Number);
    tx(db, () => {
      db.prepare('DELETE FROM project_clients WHERE project_id = ?').run(p.id);
      const ins = db.prepare("INSERT INTO project_clients (project_id, user_id) SELECT ?, id FROM users WHERE id = ? AND role = 'client'");
      for (const id of ids) ins.run(p.id, id);
    });
    res.json({ ok: true });
  });

  // ---------- columns ----------
  app.post('/api/projects/:id/columns', requireStaff, (req, res) => {
    if (!canEditProject(db, req.user, req.params.id)) throw new HttpError(404, 'Project not found');
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM columns WHERE project_id = ?').get(req.params.id).p;
    const r = db.prepare('INSERT INTO columns (project_id, name, position, is_done) VALUES (?, ?, ?, ?)')
      .run(req.params.id, String(req.body.name || 'New column'), pos, req.body.is_done ? 1 : 0);
    res.json(db.prepare('SELECT * FROM columns WHERE id = ?').get(r.lastInsertRowid));
  });

  app.patch('/api/columns/:id', requireStaff, (req, res) => {
    const c = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
    if (!c || !canEditProject(db, req.user, c.project_id)) throw new HttpError(404, 'Column not found');
    if (req.body.name) db.prepare('UPDATE columns SET name = ? WHERE id = ?').run(req.body.name, c.id);
    if (req.body.position !== undefined) db.prepare('UPDATE columns SET position = ? WHERE id = ?').run(req.body.position, c.id);
    if (req.body.is_done !== undefined) db.prepare('UPDATE columns SET is_done = ? WHERE id = ?').run(req.body.is_done ? 1 : 0, c.id);
    res.json(db.prepare('SELECT * FROM columns WHERE id = ?').get(c.id));
  });

  app.delete('/api/columns/:id', requireStaff, (req, res) => {
    const c = db.prepare('SELECT * FROM columns WHERE id = ?').get(req.params.id);
    if (!c || !canEditProject(db, req.user, c.project_id)) throw new HttpError(404, 'Column not found');
    const other = db.prepare('SELECT id FROM columns WHERE project_id = ? AND id != ? ORDER BY position LIMIT 1').get(c.project_id, c.id);
    if (!other) throw new HttpError(400, 'A project needs at least one column');
    tx(db, () => {
      db.prepare('UPDATE tasks SET column_id = ? WHERE column_id = ?').run(other.id, c.id);
      db.prepare('DELETE FROM columns WHERE id = ?').run(c.id);
    });
    res.json({ ok: true });
  });

  // ---------- tasks ----------
  const TASK_SELECT = `SELECT t.*, p.key AS project_key, p.name AS project_name, p.business_id,
      c.name AS column_name, c.is_done, u.name AS assignee_name,
      (SELECT COUNT(*) FROM comments cm WHERE cm.task_id = t.id %COMMENT_FILTER%) AS comment_count
    FROM tasks t JOIN projects p ON p.id = t.project_id JOIN columns c ON c.id = t.column_id
    LEFT JOIN users u ON u.id = t.assignee_id`;
  const taskSelect = (user) => TASK_SELECT.replace('%COMMENT_FILTER%', isStaff(user) ? '' : 'AND cm.internal = 0');

  app.get('/api/tasks', requireUser, (req, res) => {
    const [scope, params] = taskScope(db, req.user);
    const where = [scope];
    const q = req.query;
    if (q.project_id) { where.push('t.project_id = ?'); params.push(Number(q.project_id)); }
    if (q.business_id) { where.push('p.business_id = ?'); params.push(Number(q.business_id)); }
    if (q.assignee === 'me') { where.push('t.assignee_id = ?'); params.push(req.user.id); }
    if (q.open === '1') where.push('t.completed_at IS NULL');
    if (q.has_due === '1') where.push('t.due_at IS NOT NULL');
    if (q.due_before) { where.push('t.due_at <= ?'); params.push(String(q.due_before)); }
    if (q.client_view === '1') where.push('t.client_visible = 1 AND p.client_visible = 1');
    if (q.q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    if (!q.project_id) where.push('p.archived = 0');
    const order = q.sort === 'due' ? 'ORDER BY t.due_at IS NULL, t.due_at, t.id' : 'ORDER BY c.position, t.position, t.id';
    const rows = db.prepare(`${taskSelect(req.user)} WHERE ${where.join(' AND ')} ${order} LIMIT 2000`).all(...params);
    res.json(rows.map((t) => presentTask(req.user, t)));
  });

  app.get('/api/tasks/:id', requireUser, (req, res) => {
    const task = getTask(db, req.params.id);
    if (!canSeeTask(db, req.user, task)) throw new HttpError(404, 'Task not found');
    const full = db.prepare(`${taskSelect(req.user)} WHERE t.id = ?`).get(task.id);
    const comments = db.prepare(`SELECT cm.*, u.name AS user_name, u.role AS user_role FROM comments cm
      LEFT JOIN users u ON u.id = cm.user_id WHERE cm.task_id = ? ${isStaff(req.user) ? '' : 'AND cm.internal = 0'}
      ORDER BY cm.created_at, cm.id`).all(task.id);
    const activity = isStaff(req.user)
      ? db.prepare(`SELECT a.*, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.task_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 50`).all(task.id)
      : [];
    res.json({ ...presentTask(req.user, full), comments, activity });
  });

  app.post('/api/tasks', requireStaff, (req, res) => {
    res.json(createTask(db, req.user, req.body));
  });

  app.patch('/api/tasks/:id', requireStaff, (req, res) => {
    res.json(updateTask(db, req.user, req.params.id, req.body).task);
  });

  app.delete('/api/tasks/:id', requireStaff, (req, res) => {
    deleteTask(db, req.user, req.params.id);
    res.json({ ok: true });
  });

  app.post('/api/tasks/:id/comments', requireUser, (req, res) => {
    res.json(addComment(db, req.user, req.params.id, { body: req.body.body, internal: !!req.body.internal }));
  });

  // ---------- monthly reports ----------
  app.get('/api/reports/monthly', requireUser, (req, res) => {
    res.json(buildMonthlyReport(db, req.user, {
      month: req.query.month, clientView: req.query.client_view === '1', businessId: req.query.business_id || null,
    }));
  });

  app.get('/api/reports/monthly.txt', requireUser, (req, res) => {
    const rep = buildMonthlyReport(db, req.user, { month: req.query.month, clientView: req.query.client_view === '1', businessId: req.query.business_id || null });
    res.type('text/plain').attachment(`taskboard-report-${rep.month}.txt`).send(reportText(rep));
  });

  app.get('/api/reports/saved', requireOwner, (_req, res) => {
    res.json(db.prepare('SELECT id, month, scope, client_view, created_at FROM reports ORDER BY month DESC, id DESC').all());
  });

  app.get('/api/reports/saved/:id', requireOwner, (req, res) => {
    const row = db.prepare('SELECT data FROM reports WHERE id = ?').get(req.params.id);
    if (!row) throw new HttpError(404, 'Report not found');
    res.json(JSON.parse(row.data));
  });

  app.post('/api/reports/save', requireOwner, (req, res) => {
    const rep = buildMonthlyReport(db, req.user, { month: req.body.month, clientView: !!req.body.client_view });
    saveReport(db, rep, { clientView: !!req.body.client_view });
    res.json({ ok: true });
  });

  app.post('/api/reports/summary', requireStaff, async (req, res) => {
    if (!aiOn()) throw new HttpError(400, 'Set ANTHROPIC_API_KEY on the server to enable AI summaries');
    const rep = buildMonthlyReport(db, req.user, { month: req.body.month, clientView: !!req.body.client_view, businessId: req.body.business_id || null });
    res.json({ summary: await summarizeReport(reportText(rep), { clientView: rep.clientView }) });
  });

  // ---------- notifications ----------
  app.get('/api/notifications', requireUser, (req, res) => {
    res.json(db.prepare(`SELECT n.id, n.task_id, n.kind, n.message, n.read, n.created_at FROM notifications n
      WHERE n.user_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 100`).all(req.user.id));
  });

  app.post('/api/notifications/read', requireUser, (req, res) => {
    if (req.body.all) db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    else for (const id of req.body.ids || []) db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(id, req.user.id);
    res.json({ ok: true });
  });

  // ---------- users & access (owner) ----------
  app.get('/api/users', requireOwner, (_req, res) => {
    const users = db.prepare('SELECT id, name, email, role, email_notifications, created_at FROM users ORDER BY role, name').all();
    for (const u of users) {
      u.business_ids = db.prepare('SELECT business_id FROM business_members WHERE user_id = ?').all(u.id).map((r) => r.business_id);
      u.project_ids = db.prepare('SELECT project_id FROM project_clients WHERE user_id = ?').all(u.id).map((r) => r.project_id);
    }
    res.json(users);
  });

  app.post('/api/users', requireOwner, (req, res) => {
    const { name, email, password, role } = req.body;
    if (!name || !email || !['owner', 'member', 'client'].includes(role)) throw new HttpError(400, 'Name, email and role are required');
    const pw = password || randomToken(9);
    if (pw.length < 8) throw new HttpError(400, 'Password must be 8+ characters');
    if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(email)) throw new HttpError(400, 'That email already has an account');
    const r = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, email, hashPassword(pw), role);
    const id = Number(r.lastInsertRowid);
    setAccess(db, id, req.body);
    res.json({ id, password: password ? undefined : pw });
  });

  app.patch('/api/users/:id', requireOwner, (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw new HttpError(404, 'User not found');
    const { name, email, role, password } = req.body;
    if (role && role !== u.role && u.role === 'owner' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get().n === 1) {
      throw new HttpError(400, 'You need at least one owner');
    }
    if (name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
    if (email) db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, u.id);
    if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
    if (password) {
      if (password.length < 8) throw new HttpError(400, 'Password must be 8+ characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), u.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    }
    setAccess(db, u.id, req.body);
    res.json({ ok: true });
  });

  app.delete('/api/users/:id', requireOwner, (req, res) => {
    if (Number(req.params.id) === req.user.id) throw new HttpError(400, "You can't delete yourself");
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------- API tokens for automation (owner) ----------
  app.get('/api/tokens', requireOwner, (_req, res) => {
    res.json(db.prepare(`SELECT t.id, t.name, t.created_at, t.last_used_at, u.name AS user_name FROM api_tokens t
      JOIN users u ON u.id = t.user_id ORDER BY t.id DESC`).all());
  });

  app.post('/api/tokens', requireOwner, (req, res) => {
    const token = `tb_${randomToken(24)}`;
    db.prepare('INSERT INTO api_tokens (name, token_hash, user_id) VALUES (?, ?, ?)').run(String(req.body.name || 'Automation'), sha256(token), req.user.id);
    res.json({ token }); // shown once
  });

  app.delete('/api/tokens/:id', requireOwner, (req, res) => {
    db.prepare('DELETE FROM api_tokens WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // ---------- settings (owner) ----------
  const SETTING_KEYS = ['inbox_project_id', 'ai_mode', 'allow_unknown_senders', 'inbound_confirmations', 'reminder_hours', 'digest_hour'];
  app.get('/api/settings', requireOwner, (_req, res) => {
    res.json({
      inbox_project_id: getSetting(db, 'inbox_project_id', null),
      ai_mode: getSetting(db, 'ai_mode', 'fallback'),
      allow_unknown_senders: getSetting(db, 'allow_unknown_senders', false),
      inbound_confirmations: getSetting(db, 'inbound_confirmations', true),
      reminder_hours: getSetting(db, 'reminder_hours', 24),
      digest_hour: getSetting(db, 'digest_hour', 8),
      inbound_email_address: process.env.INBOUND_EMAIL_ADDRESS || null,
      app_url: process.env.APP_URL || null,
    });
  });

  app.patch('/api/settings', requireOwner, (req, res) => {
    for (const k of SETTING_KEYS) if (req.body[k] !== undefined) setSetting(db, k, req.body[k]);
    res.json({ ok: true });
  });

  app.get('/api/inbound/log', requireOwner, (_req, res) => {
    res.json(db.prepare('SELECT * FROM inbound_log ORDER BY id DESC LIMIT 100').all());
  });

  // Try a command from the UI as the logged-in user.
  app.post('/api/command', requireUser, async (req, res) => {
    res.json(await handleInbound(db, {
      channel: 'test', tokenUser: req.user, subject: req.body.subject, body: req.body.body ?? req.body.text,
      dryRun: !!req.body.dryRun, forceAi: !!req.body.ai,
    }));
  });

  // ---------- Trello import (owner) ----------
  app.post('/api/import/trello', requireOwner, (req, res) => {
    res.json(importTrello(db, req.user, req.body.board, { mode: req.body.mode, includeArchived: !!req.body.includeArchived }));
  });

  // ---------- inbound automation (API token) ----------
  const tokenAuth = (req, _res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    req.tokenUser = userFromApiToken(db, token);
    if (!req.tokenUser) return next(new HttpError(401, 'Invalid or missing API token'));
    if (req.tokenUser.role !== 'owner') return next(new HttpError(403, 'Token owner is no longer an owner'));
    next();
  };
  const form = multer({ limits: { fieldSize: 2 * 1024 * 1024, files: 0 } }).none();

  // Generic: JSON {text} or {subject, body, from}. Works with Zapier, Make, Shortcuts, Slack, Twilio (Body/From).
  app.post('/api/inbound/message', tokenAuth, form, async (req, res) => {
    const b = req.body || {};
    const result = await handleInbound(db, {
      channel: 'message', tokenUser: req.tokenUser,
      sender: b.from || b.sender || b.email || null,
      subject: b.subject || '',
      body: b.text ?? b.body ?? b.Body ?? b.message ?? '',
      dryRun: req.query.dry_run === '1',
    });
    if (b.Body !== undefined && b.From !== undefined) {
      // Twilio SMS webhook: reply with TwiML (sender phone numbers aren't users, so From isn't used for identity).
      res.type('text/xml').send(`<Response><Message>${escapeXml(summarize(result))}</Message></Response>`);
      return;
    }
    res.json(result);
  });

  // Inbound email webhooks: Mailgun, SendGrid Inbound Parse, Postmark, Cloudflare Email Workers, or plain JSON.
  app.post('/api/inbound/email', tokenAuth, form, async (req, res) => {
    const b = req.body || {};
    const subject = b.subject || b.Subject || '';
    const body = b['stripped-text'] || b['body-plain'] || b.TextBody || b.text || b.body || stripHtml(b['body-html'] || b.HtmlBody || b.html || '');
    const sender = b.sender || b.from || b.From || b.FromFull?.Email || null;
    res.json(await handleInbound(db, { channel: 'email', tokenUser: req.tokenUser, sender, subject, body }));
  });

  // Manual trigger for reminders (useful with an external cron).
  app.post('/api/inbound/run-reminders', tokenAuth, (_req, res) => res.json({ sent: runReminders(db) }));

  // ---------- errors ----------
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(err.message) ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  return app;
}

// ---------- helpers ----------
function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function stripHtml(html) {
  return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function setAccess(db, userId, { business_ids, project_ids }) {
  if (Array.isArray(business_ids)) {
    db.prepare('DELETE FROM business_members WHERE user_id = ?').run(userId);
    for (const b of business_ids) db.prepare('INSERT OR IGNORE INTO business_members (business_id, user_id) VALUES (?, ?)').run(b, userId);
  }
  if (Array.isArray(project_ids)) {
    db.prepare('DELETE FROM project_clients WHERE user_id = ?').run(userId);
    for (const p of project_ids) db.prepare('INSERT OR IGNORE INTO project_clients (project_id, user_id) VALUES (?, ?)').run(p, userId);
  }
}

// ---------- main ----------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDb();
  const app = createApp(db);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`TaskBoard running on http://localhost:${port}`);
    console.log(`  email notifications: ${emailConfigured() ? 'on' : 'off (set SMTP_URL)'}`);
    console.log(`  AI message parsing:  ${aiAvailable() ? 'on' : 'off (set ANTHROPIC_API_KEY)'}`);
  });
  startScheduler(db, { extraJobs: [runMonthlyReport] });
}
