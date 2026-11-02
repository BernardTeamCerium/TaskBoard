// Task operations shared by the web UI routes and the email/message automation,
// so both paths get identical validation, activity logging and notifications.
import { parseDue } from './dates.js';
import { notify } from './notify.js';
import { isStaff, canEditProject, canSeeTask } from './permissions.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const nowIso = () => new Date().toISOString();

export const getTask = (db, id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
export const getProject = (db, id) => db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id));
export const projectByKey = (db, key) => db.prepare('SELECT * FROM projects WHERE key = ? COLLATE NOCASE').get(String(key));
export const projectColumns = (db, projectId) =>
  db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position, id').all(projectId);

export function taskLabel(db, task) {
  const p = getProject(db, task.project_id);
  return `${p.key}-${task.id}`;
}

function logActivity(db, taskId, userId, action, detail = '', source = 'web') {
  db.prepare('INSERT INTO activity (task_id, user_id, action, detail, source) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, userId ?? null, action, detail, source);
}

/** Resolve a status descriptor ({done}|{first}|{name}) or column id to a column of the project. */
export function resolveColumn(db, projectId, status) {
  const cols = projectColumns(db, projectId);
  if (!cols.length) throw new HttpError(400, 'Project has no columns');
  if (status == null) return cols[0];
  if (typeof status === 'number' || /^\d+$/.test(String(status))) {
    const c = cols.find((x) => x.id === Number(status));
    if (!c) throw new HttpError(400, 'Column does not belong to this project');
    return c;
  }
  if (status.done) return cols.find((c) => c.is_done) || cols[cols.length - 1];
  if (status.first) return cols[0];
  const want = String(status.name || '').toLowerCase();
  return cols.find((c) => c.name.toLowerCase() === want)
    || cols.find((c) => c.name.toLowerCase().startsWith(want))
    || cols.find((c) => c.name.toLowerCase().includes(want))
    || (() => { throw new HttpError(400, `No column matching "${status.raw || status.name}". Columns: ${cols.map((c) => c.name).join(', ')}`); })();
}

/** Find a staff user by email, full name, first name or email prefix. */
export function resolveAssignee(db, ref) {
  if (ref == null || ref === '') return null;
  const s = String(ref).trim().toLowerCase();
  if (/^(none|nobody|unassign|unassigned)$/.test(s)) return { id: null };
  const staff = db.prepare("SELECT id, name, email FROM users WHERE role IN ('owner','member')").all();
  const tests = [
    (u) => u.email.toLowerCase() === s,
    (u) => u.name.toLowerCase() === s,
    (u) => u.email.toLowerCase().split('@')[0] === s,
    (u) => u.name.toLowerCase().split(/\s+/)[0] === s,
    (u) => u.name.toLowerCase().replace(/\s+/g, '') === s.replace(/[\s.]+/g, ''),
  ];
  for (const t of tests) {
    const hits = staff.filter(t);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new HttpError(400, `"${ref}" matches several people: ${hits.map((h) => h.name).join(', ')}`);
  }
  throw new HttpError(400, `Nobody on the team matches "${ref}"`);
}

function normalizeDue(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const r = parseDue(value);
  if (!r) throw new HttpError(400, `Couldn't understand the due date "${value}"`);
  return r.clear ? null : r.date.toISOString();
}

function recipientsForTask(db, task, { includeOwners = false } = {}) {
  const ids = new Set();
  if (task.assignee_id) ids.add(task.assignee_id);
  if (task.created_by) {
    const creator = db.prepare('SELECT role FROM users WHERE id = ?').get(task.created_by);
    if (creator && creator.role !== 'client') ids.add(task.created_by);
  }
  if (includeOwners || !ids.size) {
    for (const u of db.prepare("SELECT id FROM users WHERE role = 'owner'").all()) ids.add(u.id);
  }
  return [...ids];
}

function clientsOfProject(db, projectId) {
  return db.prepare(`SELECT u.id FROM project_clients pc JOIN users u ON u.id = pc.user_id
    JOIN projects p ON p.id = pc.project_id WHERE pc.project_id = ? AND p.client_visible = 1`).all(projectId).map((r) => r.id);
}

export function createTask(db, user, input, { source = 'web' } = {}) {
  const project = getProject(db, input.project_id);
  if (!project) throw new HttpError(404, 'Project not found');
  if (!canEditProject(db, user, project.id)) throw new HttpError(403, 'You cannot add tasks to this project');
  const title = String(input.title || '').trim();
  if (!title) throw new HttpError(400, 'Title is required');
  const column = resolveColumn(db, project.id, input.column_id ?? input.status ?? null);
  const priority = input.priority || 'normal';
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'Invalid priority');
  const assignee = input.assignee_id !== undefined ? (input.assignee_id ? { id: Number(input.assignee_id) } : null) : resolveAssignee(db, input.assignee);
  const due = normalizeDue(input.due_at ?? input.due) ?? null;
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE column_id = ?').get(column.id).p;

  const r = db.prepare(`INSERT INTO tasks (project_id, column_id, title, description, priority, due_at, assignee_id,
      client_visible, position, source, created_by, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    project.id, column.id, title, String(input.description || ''), priority, due, assignee?.id ?? null,
    input.client_visible ? 1 : 0, pos, source, user.id, column.is_done ? nowIso() : null,
  );
  const task = getTask(db, r.lastInsertRowid);
  logActivity(db, task.id, user.id, 'created', `in ${column.name}`, source);
  if (task.assignee_id && task.assignee_id !== user.id) {
    notify(db, [task.assignee_id], { taskId: task.id, kind: 'assigned', message: `${user.name} assigned you ${project.key}-${task.id}: ${task.title}` });
  }
  return task;
}

export function updateTask(db, user, taskId, input, { source = 'web' } = {}) {
  const task = getTask(db, taskId);
  if (!task || !canSeeTask(db, user, task)) throw new HttpError(404, 'Task not found');
  if (!canEditProject(db, user, task.project_id)) throw new HttpError(403, 'You cannot edit this task');
  const project = getProject(db, task.project_id);
  const changes = {};
  const notes = [];

  if (input.title !== undefined) {
    const t = String(input.title).trim();
    if (!t) throw new HttpError(400, 'Title cannot be empty');
    if (t !== task.title) { changes.title = t; notes.push(`renamed to "${t}"`); }
  }
  if (input.description !== undefined && input.description !== task.description) {
    changes.description = String(input.description);
    notes.push('updated the description');
  }
  if (input.priority !== undefined && input.priority !== task.priority) {
    if (!PRIORITIES.includes(input.priority)) throw new HttpError(400, 'Invalid priority');
    changes.priority = input.priority;
    notes.push(`priority → ${input.priority}`);
  }
  const dueInput = input.due_at !== undefined ? input.due_at : input.due;
  if (dueInput !== undefined) {
    const due = normalizeDue(dueInput);
    if (due !== task.due_at) { changes.due_at = due; notes.push(due ? `due → ${due}` : 'removed the deadline'); }
  }
  let newAssignee;
  if (input.assignee_id !== undefined) newAssignee = input.assignee_id ? Number(input.assignee_id) : null;
  else if (input.assignee !== undefined) newAssignee = resolveAssignee(db, input.assignee)?.id ?? null;
  if (newAssignee !== undefined && newAssignee !== task.assignee_id) {
    changes.assignee_id = newAssignee;
    const name = newAssignee ? db.prepare('SELECT name FROM users WHERE id = ?').get(newAssignee)?.name : 'nobody';
    notes.push(`assigned to ${name}`);
  }
  if (input.client_visible !== undefined) {
    const v = input.client_visible ? 1 : 0;
    if (v !== task.client_visible) { changes.client_visible = v; notes.push(v ? 'shared with client' : 'hidden from client'); }
  }
  let movedToDone = false;
  const statusInput = input.column_id ?? input.status;
  if (statusInput !== undefined && statusInput !== null) {
    const col = resolveColumn(db, task.project_id, statusInput);
    if (col.id !== task.column_id) {
      changes.column_id = col.id;
      changes.position = input.position ?? db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE column_id = ?').get(col.id).p;
      changes.completed_at = col.is_done ? nowIso() : null;
      movedToDone = !!col.is_done && !task.completed_at;
      notes.push(`moved to ${col.name}`);
    } else if (input.position !== undefined) {
      changes.position = Number(input.position);
    }
  } else if (input.position !== undefined) {
    changes.position = Number(input.position);
  }

  if (Object.keys(changes).length) {
    changes.updated_at = nowIso();
    const cols = Object.keys(changes);
    db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => changes[c]), task.id);
  }
  if (notes.length) logActivity(db, task.id, user.id, 'updated', notes.join('; '), source);

  const updated = getTask(db, task.id);
  const label = `${project.key}-${task.id}`;
  if (changes.assignee_id && changes.assignee_id !== user.id) {
    notify(db, [changes.assignee_id], { taskId: task.id, kind: 'assigned', message: `${user.name} assigned you ${label}: ${updated.title}` });
  }
  if (movedToDone) {
    const ids = recipientsForTask(db, updated).filter((id) => id !== user.id);
    notify(db, ids, { taskId: task.id, kind: 'completed', message: `${user.name} completed ${label}: ${updated.title}` });
    if (updated.client_visible) {
      notify(db, clientsOfProject(db, task.project_id), { taskId: task.id, kind: 'completed', message: `Completed: ${updated.title}` });
    }
  } else if (changes.due_at && updated.assignee_id && updated.assignee_id !== user.id) {
    notify(db, [updated.assignee_id], { taskId: task.id, kind: 'due_changed', message: `${label} is now due ${new Date(changes.due_at).toLocaleString()}` });
  }
  return { task: updated, changed: notes };
}

export function addComment(db, user, taskId, { body, internal = false }, { source = 'web' } = {}) {
  const task = getTask(db, taskId);
  if (!task || !canSeeTask(db, user, task)) throw new HttpError(404, 'Task not found');
  const text = String(body || '').trim();
  if (!text) throw new HttpError(400, 'Comment is empty');
  const isInternal = isStaff(user) && internal ? 1 : 0; // clients can never post internal notes
  const r = db.prepare('INSERT INTO comments (task_id, user_id, body, internal, source) VALUES (?, ?, ?, ?, ?)')
    .run(task.id, user.id, text, isInternal, source);
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(nowIso(), task.id);
  const label = taskLabel(db, task);
  const fromClient = user.role === 'client';
  const ids = recipientsForTask(db, task, { includeOwners: fromClient }).filter((id) => id !== user.id);
  notify(db, ids, {
    taskId: task.id,
    kind: fromClient ? 'client_comment' : 'comment',
    message: `${user.name}${fromClient ? ' (client)' : ''} commented on ${label}: ${text.slice(0, 140)}`,
  });
  if (!isInternal && !fromClient && task.client_visible) {
    notify(db, clientsOfProject(db, task.project_id).filter((id) => id !== user.id), {
      taskId: task.id, kind: 'comment', message: `${user.name} commented on "${task.title}": ${text.slice(0, 140)}`,
    });
  }
  return db.prepare('SELECT * FROM comments WHERE id = ?').get(r.lastInsertRowid);
}

export function deleteTask(db, user, taskId) {
  const task = getTask(db, taskId);
  if (!task || !canSeeTask(db, user, task)) throw new HttpError(404, 'Task not found');
  if (!canEditProject(db, user, task.project_id)) throw new HttpError(403, 'You cannot delete this task');
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
}
