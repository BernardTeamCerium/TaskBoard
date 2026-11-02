// Notifications: in-app bell + optional email (SMTP) + optional chat/push webhook,
// plus a scheduler that sends deadline reminders and a daily digest.
import nodemailer from 'nodemailer';
import { getSetting, setSetting } from './db.js';

let transport = null;
let transportChecked = false;

function mailer() {
  if (!transportChecked) {
    transportChecked = true;
    if (process.env.SMTP_URL) transport = nodemailer.createTransport(process.env.SMTP_URL);
  }
  return transport;
}

export const emailConfigured = () => !!mailer();
const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');

export async function sendEmail({ to, subject, text, html }) {
  const t = mailer();
  if (!t) return false;
  await t.sendMail({
    from: process.env.MAIL_FROM || 'TaskBoard <taskboard@localhost>',
    // Replies go to the inbound address so "reply to add a comment" works.
    replyTo: process.env.INBOUND_EMAIL_ADDRESS || undefined,
    to, subject, text, html,
  });
  return true;
}

// Kinds forwarded to the team chat/push webhook (Slack, Discord, ntfy.sh, Teams...).
const WEBHOOK_KINDS = new Set(['due_soon', 'overdue', 'client_comment']);

async function postWebhook(text) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return;
  try {
    if (/ntfy\./.test(url)) {
      await fetch(url, { method: 'POST', body: text, headers: { Title: 'TaskBoard' } });
    } else {
      // "text" works for Slack & Teams-style incoming webhooks; "content" for Discord.
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
    }
  } catch (err) {
    console.error('[notify] webhook failed:', err.message);
  }
}

function deliver(db, notificationId) {
  const n = db.prepare(`SELECT n.*, u.email, u.name, u.email_notifications, u.role,
      t.title AS task_title, p.key AS project_key
    FROM notifications n JOIN users u ON u.id = n.user_id
    LEFT JOIN tasks t ON t.id = n.task_id LEFT JOIN projects p ON p.id = t.project_id
    WHERE n.id = ?`).get(notificationId);
  if (!n) return;
  if (n.email_notifications && emailConfigured()) {
    // Staff get the task reference in the subject so replying adds a comment via inbound email.
    const ref = n.task_id && n.role !== 'client' ? `[${n.project_key}-${n.task_id}] ` : '';
    const link = n.task_id ? `${appUrl()}/#task/${n.task_id}` : appUrl();
    sendEmail({
      to: n.email,
      subject: `${ref}${n.task_title || 'TaskBoard notification'}`,
      text: `${n.message}\n\nOpen: ${link}\n${ref ? '\nReply to this email to add a comment, or write "done" / "due: friday" on the first line.\n' : ''}`,
    }).then((sent) => sent && db.prepare('UPDATE notifications SET emailed = 1 WHERE id = ?').run(n.id))
      .catch((err) => console.error('[notify] email failed:', err.message));
  }
}

/** Create in-app notifications (and fan out to email/webhook). dedupeKey makes it idempotent per user. */
export function notify(db, userIds, { taskId = null, kind, message, dedupeKey = null }) {
  const created = [];
  for (const uid of new Set(userIds)) {
    if (!uid) continue;
    const key = dedupeKey ? `${dedupeKey}:u${uid}` : null;
    const r = db.prepare(`INSERT INTO notifications (user_id, task_id, kind, message, dedupe_key)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`).run(uid, taskId, kind, message, key);
    if (r.changes) {
      created.push(Number(r.lastInsertRowid));
      deliver(db, r.lastInsertRowid);
    }
  }
  if (created.length && WEBHOOK_KINDS.has(kind)) postWebhook(message);
  return created;
}

function staffForProject(db, projectId) {
  return db.prepare(`SELECT id FROM users WHERE role = 'owner'
    UNION SELECT bm.user_id FROM business_members bm JOIN projects p ON p.business_id = bm.business_id
      JOIN users u ON u.id = bm.user_id WHERE p.id = ? AND u.role = 'member'`).all(projectId).map((r) => r.id);
}

/** Send "due soon" and "overdue" reminders. Safe to call repeatedly. */
export function runReminders(db, now = new Date()) {
  const soonHours = Number(getSetting(db, 'reminder_hours', 24));
  const horizon = new Date(now.getTime() + soonHours * 3600e3).toISOString();
  const rows = db.prepare(`SELECT t.*, p.key FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.due_at <= ? AND p.archived = 0`).all(horizon);
  let sent = 0;
  for (const t of rows) {
    const overdue = t.due_at <= now.toISOString();
    const who = t.assignee_id ? [t.assignee_id] : staffForProject(db, t.project_id);
    const when = new Date(t.due_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const kind = overdue ? 'overdue' : 'due_soon';
    sent += notify(db, who, {
      taskId: t.id,
      kind,
      message: overdue ? `OVERDUE: ${t.key}-${t.id} ${t.title} (was due ${when})` : `Due soon: ${t.key}-${t.id} ${t.title} — ${when}`,
      dedupeKey: `${kind}:${t.id}:${t.due_at}`,
    }).length;
  }
  return sent;
}

/** One email per staff member each morning listing overdue / today / this week. */
export async function runDailyDigest(db, now = new Date()) {
  const hour = Number(process.env.DIGEST_HOUR ?? getSetting(db, 'digest_hour', 8));
  const today = now.toLocaleDateString('en-CA'); // YYYY-MM-DD
  if (now.getHours() < hour || getSetting(db, 'last_digest') === today || !emailConfigured()) return 0;
  setSetting(db, 'last_digest', today);

  const weekAhead = new Date(now.getTime() + 7 * 864e5).toISOString();
  const users = db.prepare("SELECT * FROM users WHERE role IN ('owner','member') AND email_notifications = 1").all();
  let count = 0;
  for (const u of users) {
    const scope = u.role === 'owner' ? '' : 'AND (t.assignee_id = @uid OR p.business_id IN (SELECT business_id FROM business_members WHERE user_id = @uid))';
    const tasks = db.prepare(`SELECT t.*, p.key, b.name AS business FROM tasks t JOIN projects p ON p.id = t.project_id
      JOIN businesses b ON b.id = p.business_id
      WHERE t.completed_at IS NULL AND t.due_at IS NOT NULL AND t.due_at <= @week AND p.archived = 0 ${scope}
      ORDER BY t.due_at`).all({ uid: u.id, week: weekAhead });
    if (!tasks.length) continue;
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
    const group = (pred) => tasks.filter(pred).map((t) =>
      `  • ${t.key}-${t.id} ${t.title} — ${t.business}, ${new Date(t.due_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${t.assignee_id === u.id ? ' (yours)' : ''}`).join('\n');
    const overdue = group((t) => t.due_at < now.toISOString());
    const dueToday = group((t) => t.due_at >= now.toISOString() && t.due_at <= endOfToday.toISOString());
    const week = group((t) => t.due_at > endOfToday.toISOString());
    const text = [
      `Good morning ${u.name.split(' ')[0]},`, '',
      overdue && `OVERDUE\n${overdue}\n`,
      dueToday && `DUE TODAY\n${dueToday}\n`,
      week && `NEXT 7 DAYS\n${week}\n`,
      `Open the board: ${appUrl()}`,
    ].filter(Boolean).join('\n');
    try {
      await sendEmail({ to: u.email, subject: `TaskBoard: ${tasks.length} upcoming deadline${tasks.length === 1 ? '' : 's'}`, text });
      count++;
    } catch (err) {
      console.error('[notify] digest failed:', err.message);
    }
  }
  return count;
}

export function startScheduler(db, { intervalMs = 5 * 60e3, extraJobs = [] } = {}) {
  const tick = () => {
    try { runReminders(db); } catch (err) { console.error('[scheduler] reminders:', err); }
    runDailyDigest(db).catch((err) => console.error('[scheduler] digest:', err));
    for (const job of extraJobs) Promise.resolve().then(() => job(db)).catch((err) => console.error('[scheduler]', err));
  };
  setTimeout(tick, 5000);
  return setInterval(tick, intervalMs);
}
