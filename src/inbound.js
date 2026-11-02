// Entry point for automation: emails, texts, Slack/Zapier/Make webhooks.
import { parseMessage } from './parser.js';
import { aiAvailable, interpretWithClaude } from './ai.js';
import { getSetting } from './db.js';
import { sendEmail, emailConfigured } from './notify.js';
import { createTask, updateTask, addComment, getTask, getProject, projectByKey, HttpError } from './tasks.js';
import { canSeeTask } from './permissions.js';

/** Extract a bare address from "Jane Doe <jane@x.com>". */
export function senderAddress(from) {
  if (!from) return null;
  const m = String(from).match(/<([^>]+)>/);
  return (m ? m[1] : String(from)).trim().toLowerCase() || null;
}

function applyAction(db, user, action, source) {
  const f = action.fields || {};
  if (action.type === 'create') {
    if (user.role === 'client') throw new HttpError(403, 'Clients can only add comments to tasks they can see');
    const project = action.projectKey ? projectByKey(db, action.projectKey) : null;
    if (!project) throw new HttpError(400, action.projectKey ? `No project with key "${action.projectKey}"` : 'No project specified — start the subject with [KEY], e.g. "[WEB] Fix the contact form"');
    const task = createTask(db, user, {
      project_id: project.id,
      title: action.title,
      description: f.description,
      due: f.due,
      priority: f.priority,
      status: f.status,
      assignee: f.assignee,
      client_visible: f.clientVisible,
    }, { source });
    if (f.comment) addComment(db, user, task.id, { body: f.comment }, { source });
    if (f.note) addComment(db, user, task.id, { body: f.note, internal: true }, { source });
    return { action: 'created', task: `${project.key}-${task.id}`, title: task.title, project: project.name };
  }

  const task = getTask(db, action.taskNumber);
  if (!task || !canSeeTask(db, user, task)) throw new HttpError(404, `Task ${action.projectKey ? `${action.projectKey}-` : '#'}${action.taskNumber} not found`);
  const project = getProject(db, task.project_id);
  if (action.projectKey && project.key.toUpperCase() !== action.projectKey.toUpperCase()) {
    throw new HttpError(400, `Task ${action.taskNumber} belongs to ${project.key}, not ${action.projectKey}`);
  }
  const label = `${project.key}-${task.id}`;
  const done = [];
  const edits = {};
  if (f.title) edits.title = f.title;
  if (f.description) edits.description = f.description;
  if (f.due !== undefined) edits.due = f.due;
  if (f.priority) edits.priority = f.priority;
  if (f.status) edits.status = f.status;
  if (f.assignee) edits.assignee = f.assignee;
  if (f.clientVisible !== undefined) edits.client_visible = f.clientVisible;

  if (Object.keys(edits).length) {
    if (user.role === 'client') throw new HttpError(403, 'Clients can only add comments');
    const { changed } = updateTask(db, user, task.id, edits, { source });
    done.push(...changed);
  }
  if (f.comment) { addComment(db, user, task.id, { body: f.comment }, { source }); done.push('added a comment'); }
  if (f.note) { addComment(db, user, task.id, { body: f.note, internal: true }, { source }); done.push('added an internal note'); }
  if (!done.length) throw new HttpError(400, `Nothing to change on ${label} (try "done", "due: friday" or add a comment)`);
  return { action: 'updated', task: label, title: getTask(db, task.id).title, changes: done };
}

/**
 * @param {object} opts
 * @param {'email'|'message'|'test'} opts.channel
 * @param {object} opts.tokenUser   user who owns the API token (or the logged-in user for tests)
 * @param {string} [opts.sender]    "From" address, if any
 */
export async function handleInbound(db, { channel, tokenUser, sender, subject = '', body = '', dryRun = false, forceAi = false }) {
  const result = { ok: false, parser: 'rules', results: [], errors: [] };

  // Who is acting? A known sender acts as themselves (clients stay restricted);
  // unknown senders are rejected unless explicitly allowed in Settings.
  let user = tokenUser;
  const addr = senderAddress(sender);
  if (addr) {
    const match = db.prepare('SELECT id, email, name, role FROM users WHERE email = ? COLLATE NOCASE').get(addr);
    if (match) user = match;
    else if (!getSetting(db, 'allow_unknown_senders', false)) {
      result.errors.push(`Sender ${addr} is not a TaskBoard user`);
      logInbound(db, channel, sender, subject, body, result);
      return result;
    }
  }

  let parsed = parseMessage({ subject, body });
  const aiMode = getSetting(db, 'ai_mode', 'fallback'); // off | fallback | always
  const wantAi = aiAvailable() && aiMode !== 'off' && user.role !== 'client'
    && (forceAi || aiMode === 'always' || !parsed.actions.length || parsed.untargeted);

  if (wantAi) {
    try {
      const ai = await interpretWithClaude(db, user, { subject, body });
      result.parser = 'claude';
      parsed = { actions: ai.actions, errors: ai.actions.length ? [] : [ai.clarification || 'Could not work out what to do'], untargeted: false };
    } catch (err) {
      console.error('[inbound] AI parse failed, using rules:', err.message);
      result.errors.push(`AI unavailable (${err.message}); used rule-based parser`);
    }
  }

  // Untargeted new tasks land in the Inbox project if one is configured.
  const inboxId = getSetting(db, 'inbox_project_id', null);
  const inbox = inboxId ? getProject(db, inboxId) : null;
  for (const a of parsed.actions) {
    if (a.type === 'create' && !a.projectKey && inbox) a.projectKey = inbox.key;
  }
  result.errors.push(...parsed.errors);

  if (dryRun) {
    result.ok = parsed.actions.length > 0;
    result.actions = parsed.actions;
    return result;
  }

  const source = channel === 'email' ? 'email' : channel === 'test' ? 'web' : 'message';
  for (const action of parsed.actions) {
    try {
      result.results.push(applyAction(db, user, action, source));
    } catch (err) {
      result.errors.push(err.message);
    }
  }
  result.ok = result.results.length > 0;
  result.actingAs = user.name;
  logInbound(db, channel, sender, subject, body, result);

  if (channel === 'email' && addr && emailConfigured() && getSetting(db, 'inbound_confirmations', true)) {
    sendEmail({ to: addr, subject: `Re: ${subject || 'your message'}`, text: summarize(result) })
      .catch((err) => console.error('[inbound] confirmation failed:', err.message));
  }
  return result;
}

export function summarize(result) {
  const lines = result.results.map((r) => r.action === 'created'
    ? `✓ Created ${r.task}: ${r.title} (${r.project})`
    : `✓ Updated ${r.task}: ${r.changes.join(', ')}`);
  for (const e of result.errors) lines.push(`✗ ${e}`);
  if (!lines.length) lines.push('Nothing was changed.');
  return lines.join('\n');
}

function logInbound(db, channel, sender, subject, body, result) {
  db.prepare('INSERT INTO inbound_log (channel, sender, subject, body, parser, result, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(channel, sender || null, subject || null, String(body || '').slice(0, 5000), result.parser, summarize(result), result.ok ? 1 : 0);
}
