// Turns an email or chat message into board actions, without any AI.
//
// Create a task (subject or first line):
//   [WEB] Redesign homepage due:fri 5pm !high @sam +client
//   WEB: Call the hosting company
// Update a task (task numbers are shown on every card, e.g. WEB-12):
//   [WEB-12] done
//   WEB-12 due: next tuesday
//   Re: [WEB-12] Redesign homepage      <- reply body becomes a comment
// Body lines of the form "field: value" set fields; other text becomes the
// description (new task) or a comment (existing task).
//
// Several one-line commands can be sent in a single text message, one per line.

const FIELD_ALIASES = {
  due: 'due', deadline: 'due', 'due date': 'due', by: 'due', when: 'due',
  priority: 'priority', pri: 'priority', urgency: 'priority',
  status: 'status', column: 'status', stage: 'status', move: 'status', 'move to': 'status',
  assign: 'assignee', assignee: 'assignee', owner: 'assignee', 'assigned to': 'assignee', who: 'assignee',
  visible: 'visibility', visibility: 'visibility', client: 'visibility', share: 'visibility', shared: 'visibility',
  title: 'title', rename: 'title', name: 'title',
  comment: 'comment', reply: 'comment', update: 'comment',
  note: 'note', 'internal note': 'note', private: 'note',
  description: 'description', desc: 'description', details: 'description',
  project: 'project', board: 'project', tab: 'project',
};

const PRIORITY_WORDS = {
  low: 'low', minor: 'low',
  normal: 'normal', medium: 'normal', med: 'normal',
  high: 'high', important: 'high',
  urgent: 'urgent', critical: 'urgent', asap: 'urgent', blocker: 'urgent',
};

const STATUS_SHORTCUTS = [
  [/^(done|complete|completed|finished|closed|close|resolved|✅)$/i, { done: true }],
  [/^(start|started|starting|in progress|wip|working on it|doing)$/i, { name: 'in progress' }],
  [/^(reopen|reopened|todo|to do|backlog)$/i, { first: true }],
  [/^(waiting|blocked|on hold|waiting on client)$/i, { name: 'waiting' }],
];

export function parseVisibility(v) {
  const s = String(v).trim().toLowerCase();
  if (/^(client|clients|public|yes|y|true|on|visible|shared|share|show)$/.test(s)) return true;
  if (/^(internal|private|no|n|false|off|hidden|hide|team|staff)$/.test(s)) return false;
  return null;
}

export function parsePriority(v) {
  const s = String(v).trim().toLowerCase().replace(/^!+/, '');
  return PRIORITY_WORDS[s] || null;
}

/** "done" / "in progress" / "move to Review" -> status descriptor understood by applyActions */
export function parseStatus(v) {
  const s = String(v).trim().replace(/^(move\s+to|moved\s+to|status)\s*:?\s*/i, '').trim();
  if (!s) return null;
  for (const [re, desc] of STATUS_SHORTCUTS) if (re.test(s)) return { ...desc, raw: s };
  return { name: s.toLowerCase(), raw: s };
}

const PREFIX_RE = /^\s*((re|fw|fwd|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i;
export const stripReplyPrefixes = (s) => String(s || '').replace(PREFIX_RE, '').trim();

/** Remove quoted history and signatures from an email body. */
export function cleanBody(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*-- ?$/.test(line)) break; // signature delimiter
    if (/^\s*On .+wrote:\s*$/i.test(line)) break; // Gmail/Apple reply header
    if (/^\s*-{2,}\s*(Original|Forwarded) Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length) break; // Outlook reply header
    if (/^\s*Sent from my /i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Task reference: "[WEB-12]", "WEB-12", "#12", "task 12"
const TASK_REF_RE = /^\s*(?:\[\s*([a-z][a-z0-9]{0,9})-(\d+)\s*\]|([a-z][a-z0-9]{0,9})-(\d+)\b|#(\d+)\b|task\s+#?(\d+)\b)\s*[:\-–]?\s*/i;
// Project reference: "[WEB]" or "WEB:" (key must be 1-10 letters/digits starting with a letter)
const PROJECT_REF_RE = /^\s*(?:\[\s*([a-z][a-z0-9]{0,9})\s*\]|([a-z][a-z0-9]{0,9})\s*:(?!\/\/))\s*/i;

export function parseTarget(header) {
  const h = stripReplyPrefixes(header);
  let m = h.match(TASK_REF_RE);
  if (m) {
    return {
      kind: 'task',
      projectKey: (m[1] || m[3] || '').toUpperCase() || null,
      taskNumber: Number(m[2] || m[4] || m[5] || m[6]),
      rest: h.slice(m[0].length).trim(),
    };
  }
  m = h.match(PROJECT_REF_RE);
  if (m) {
    const key = (m[1] || m[2]).toUpperCase();
    // Don't treat "Hi:" / "Note:" etc. as project keys when written in normal case
    // with the colon form; bracket form is always accepted.
    if (m[1] || /^[A-Z0-9]+$/.test(m[2])) {
      return { kind: 'project', projectKey: key, rest: h.slice(m[0].length).trim() };
    }
  }
  return { kind: 'none', rest: h };
}

/** Pull inline tokens out of a one-line title: due:..., !high, @person, +client / +internal */
export function extractInlineTokens(text) {
  const fields = {};
  let s = ` ${text} `;

  const due = s.match(/\s(?:due|by|deadline):\s*(.+?)(?=\s[!@+]\S|\s(?:due|by|deadline|status|priority):|$)/i);
  if (due) {
    fields.due = due[1].trim();
    s = s.replace(due[0], ' ');
  }
  const status = s.match(/\sstatus:\s*(.+?)(?=\s[!@+]\S|\s(?:due|by|deadline|priority):|$)/i);
  if (status) {
    fields.status = status[1].trim();
    s = s.replace(status[0], ' ');
  }
  const pri = s.match(/\s(?:priority:\s*(\w+)|!(low|normal|medium|high|urgent|critical|asap)\b|(!{2,3})(?=\s))/i);
  if (pri) {
    fields.priority = pri[1] || pri[2] || (pri[3].length >= 3 ? 'urgent' : 'high');
    s = s.replace(pri[0], ' ');
  }
  const who = s.match(/\s@([\w.\-]+(?:@[\w.\-]+)?)/);
  if (who) {
    fields.assignee = who[1];
    s = s.replace(who[0], ' ');
  }
  const vis = s.match(/\s\+(client|clients|public|shared|internal|private)\b/i);
  if (vis) {
    fields.visibility = vis[1];
    s = s.replace(vis[0], ' ');
  }
  return { text: s.replace(/\s+/g, ' ').trim(), fields };
}

function parseBodyFields(body) {
  const fields = {};
  const free = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s*([a-z][a-z ]{0,14}?)\s*:\s*(.*)$/i);
    const key = m && FIELD_ALIASES[m[1].trim().toLowerCase()];
    if (key) {
      if (key === 'comment' || key === 'note' || key === 'description') {
        fields[key] = fields[key] ? `${fields[key]}\n${m[2]}` : m[2];
      } else {
        fields[key] = m[2].trim();
      }
    } else {
      free.push(line);
    }
  }
  return { fields, freeText: free.join('\n').trim() };
}

function normalizeFields(raw) {
  const f = {};
  const errors = [];
  if (raw.due != null && raw.due !== '') f.due = raw.due;
  if (raw.priority) {
    const p = parsePriority(raw.priority);
    if (p) f.priority = p;
    else errors.push(`Unknown priority "${raw.priority}"`);
  }
  if (raw.status) {
    const st = parseStatus(raw.status);
    if (st) f.status = st;
  }
  if (raw.assignee) f.assignee = raw.assignee.replace(/^@/, '').trim();
  if (raw.visibility != null && raw.visibility !== '') {
    const v = parseVisibility(raw.visibility);
    if (v === null) errors.push(`Unknown visibility "${raw.visibility}" (use client or internal)`);
    else f.clientVisible = v;
  }
  if (raw.title) f.title = raw.title.trim();
  if (raw.description) f.description = raw.description.trim();
  if (raw.comment) f.comment = raw.comment.trim();
  if (raw.note) f.note = raw.note.trim();
  if (raw.project) f.projectKey = raw.project.trim().toUpperCase();
  return { fields: f, errors };
}

function parseSingle(header, body) {
  const target = parseTarget(header);
  const { fields: bodyFields, freeText } = parseBodyFields(body);

  if (target.kind === 'task') {
    const raw = { ...bodyFields };
    const rest = target.rest;
    if (rest) {
      const shortcut = parseStatus(rest);
      const inline = extractInlineTokens(rest);
      if (shortcut && STATUS_SHORTCUTS.some(([re]) => re.test(shortcut.raw))) {
        raw.status ??= rest;
      } else if (/^(move|moved)\s+to\s+/i.test(rest)) {
        raw.status ??= rest;
      } else if (/^(comment|note|due|priority|status|assign|visible|title)\s*:/i.test(rest)) {
        const { fields } = parseBodyFields(rest);
        Object.assign(raw, fields, raw);
      } else if (Object.keys(inline.fields).length) {
        Object.assign(raw, inline.fields, raw);
      }
      // otherwise: the rest is just the task's title echoed in a reply subject - ignore
    }
    if (freeText) raw.comment = raw.comment ? `${raw.comment}\n\n${freeText}` : freeText;
    const { fields, errors } = normalizeFields(raw);
    return { action: { type: 'update', projectKey: target.projectKey, taskNumber: target.taskNumber, fields }, errors };
  }

  const inline = extractInlineTokens(target.rest);
  const raw = { ...inline.fields, ...bodyFields };
  if (freeText) raw.description = raw.description ? `${raw.description}\n\n${freeText}` : freeText;
  const { fields, errors } = normalizeFields(raw);
  const title = fields.title || inline.text;
  delete fields.title;
  const projectKey = target.kind === 'project' ? target.projectKey : fields.projectKey || null;
  delete fields.projectKey;
  if (!title) errors.push('No task title found');
  return {
    action: { type: 'create', projectKey, title, fields },
    errors,
    untargeted: !projectKey,
  };
}

/**
 * @param {{subject?: string, body?: string, text?: string}} msg
 * @returns {{ actions: object[], errors: string[], untargeted: boolean }}
 */
export function parseMessage(msg) {
  const subject = stripReplyPrefixes(msg.subject || '');
  const body = cleanBody(msg.body ?? msg.text ?? '');

  if (subject) {
    const r = parseSingle(subject, body);
    return { actions: r.errors.length && !r.action.title && r.action.type === 'create' ? [] : [r.action], errors: r.errors, untargeted: !!r.untargeted };
  }

  // No subject (SMS, chat, Slack): multi-line where every line is a command -> batch.
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { actions: [], errors: ['Empty message'], untargeted: true };
  const allTargeted = lines.length > 1 && lines.every((l) => parseTarget(l).kind !== 'none');
  if (allTargeted) {
    const actions = [];
    const errors = [];
    for (const l of lines) {
      const r = parseSingle(l, '');
      actions.push(r.action);
      errors.push(...r.errors.map((e) => `"${l}": ${e}`));
    }
    return { actions, errors, untargeted: false };
  }
  const [first, ...rest] = body.split('\n');
  const r = parseSingle(first, rest.join('\n').trim());
  return { actions: r.action.type === 'create' && !r.action.title ? [] : [r.action], errors: r.errors, untargeted: !!r.untargeted };
}
