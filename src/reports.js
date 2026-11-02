// Monthly accomplishments + next-month plan. Built from completed_at / due_at,
// scoped by the same visibility rules as everything else, so a client's copy
// only ever contains client-visible work.
import { taskScope, isStaff } from './permissions.js';
import { campaignSummary } from './campaigns.js';
import { sendEmail, emailConfigured } from './notify.js';
import { getSetting, setSetting } from './db.js';

const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export function monthRange(key) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const [y, mo] = m ? [Number(m[1]), Number(m[2]) - 1] : [now.getFullYear(), now.getMonth()];
  const start = new Date(y, mo, 1);
  const end = new Date(y, mo + 1, 1);
  const nextEnd = new Date(y, mo + 2, 1);
  const label = (d) => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { key: monthKey(start), start, end, nextEnd, label: label(start), nextLabel: label(end) };
}

const SELECT = `SELECT t.id, t.title, t.priority, t.due_at, t.completed_at, t.client_visible, t.created_at,
    p.key AS project_key, p.name AS project_name, b.id AS business_id, b.name AS business_name, b.color AS business_color,
    u.name AS assignee_name
  FROM tasks t JOIN projects p ON p.id = t.project_id JOIN businesses b ON b.id = p.business_id
  LEFT JOIN users u ON u.id = t.assignee_id`;

function groupByBusiness(tasks) {
  const map = new Map();
  for (const t of tasks) {
    if (!map.has(t.business_id)) map.set(t.business_id, { id: t.business_id, name: t.business_name, color: t.business_color, projects: new Map() });
    const b = map.get(t.business_id);
    if (!b.projects.has(t.project_key)) b.projects.set(t.project_key, { key: t.project_key, name: t.project_name, tasks: [] });
    b.projects.get(t.project_key).tasks.push(t);
  }
  return [...map.values()].map((b) => ({ ...b, count: [...b.projects.values()].reduce((n, p) => n + p.tasks.length, 0), projects: [...b.projects.values()] }))
    .sort((a, b) => b.count - a.count);
}

/**
 * @param {object} opts month 'YYYY-MM', clientView (only client-visible work), businessId
 */
export function buildMonthlyReport(db, user, { month, clientView = false, businessId = null } = {}) {
  const r = monthRange(month);
  const [scope, scopeParams] = taskScope(db, user);
  const where = [scope];
  const params = [...scopeParams];
  if (clientView || !isStaff(user)) where.push('t.client_visible = 1 AND p.client_visible = 1');
  if (businessId) { where.push('b.id = ?'); params.push(Number(businessId)); }
  const base = where.join(' AND ');
  const s = r.start.toISOString();
  const e = r.end.toISOString();
  const ne = r.nextEnd.toISOString();

  const completed = db.prepare(`${SELECT} WHERE ${base} AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at`).all(...params, s, e);
  const planned = db.prepare(`${SELECT} WHERE ${base} AND t.completed_at IS NULL AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at`).all(...params, e, ne);
  const carried = db.prepare(`${SELECT} WHERE ${base} AND t.completed_at IS NULL AND t.due_at < ? ORDER BY t.due_at`).all(...params, e);
  const created = db.prepare(`SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id JOIN businesses b ON b.id = p.business_id
    WHERE ${base} AND t.created_at >= ? AND t.created_at < ?`).get(...params, s.replace('T', ' ').slice(0, 19), e.replace('T', ' ').slice(0, 19)).n;

  const withDue = completed.filter((t) => t.due_at);
  const onTime = withDue.filter((t) => t.completed_at <= t.due_at).length;
  const people = new Map();
  for (const t of completed) {
    const k = t.assignee_name || 'Unassigned';
    people.set(k, (people.get(k) || 0) + 1);
  }

  return {
    month: r.key,
    label: r.label,
    nextLabel: r.nextLabel,
    clientView: !!(clientView || !isStaff(user)),
    generatedAt: new Date().toISOString(),
    stats: {
      completed: completed.length,
      created,
      onTime,
      late: withDue.length - onTime,
      planned: planned.length,
      carriedOver: carried.length,
    },
    byPerson: [...people.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    completed: groupByBusiness(completed),
    planned: groupByBusiness(planned),
    carriedOver: carried,
    campaigns: campaignSummary(db, user, {
      from: monthKey(r.start) + '-01',
      to: new Date(r.start.getFullYear(), r.start.getMonth() + 1, 0).toLocaleDateString('en-CA'),
      businessId,
      clientView: !!(clientView || !isStaff(user)),
    }),
  };
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function reportText(rep) {
  const lines = [
    `${rep.clientView ? 'Monthly update' : 'Team report'} — ${rep.label}`,
    '',
    `Completed: ${rep.stats.completed}   On time: ${rep.stats.onTime}   Late: ${rep.stats.late}   Planned for ${rep.nextLabel}: ${rep.stats.planned}   Carried over: ${rep.stats.carriedOver}`,
    '',
    `ACCOMPLISHED IN ${rep.label.toUpperCase()}`,
  ];
  if (!rep.completed.length) lines.push('  (nothing completed)');
  for (const b of rep.completed) {
    lines.push(`\n${b.name} (${b.count})`);
    for (const p of b.projects) for (const t of p.tasks) {
      lines.push(`  ✓ ${t.title}${t.assignee_name && !rep.clientView ? ` — ${t.assignee_name}` : ''} (${fmtDate(t.completed_at)})`);
    }
  }
  if (!rep.clientView && rep.byPerson.length) {
    lines.push('', 'BY TEAM MEMBER', ...rep.byPerson.map((p) => `  ${p.name}: ${p.count}`));
  }
  lines.push('', `PLANNED FOR ${rep.nextLabel.toUpperCase()}`);
  if (!rep.planned.length) lines.push('  (nothing scheduled yet)');
  for (const b of rep.planned) {
    lines.push(`\n${b.name}`);
    for (const p of b.projects) for (const t of p.tasks) {
      lines.push(`  • ${t.title} — due ${fmtDate(t.due_at)}${t.assignee_name && !rep.clientView ? `, ${t.assignee_name}` : ''}`);
    }
  }
  const camp = rep.campaigns;
  if (camp && camp.businesses.length) {
    const money = (v) => (v == null ? '—' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: v % 1 ? 2 : 0 })}`);
    const n = (v) => (v == null ? '—' : v.toLocaleString('en-US'));
    lines.push('', 'CAMPAIGN PERFORMANCE');
    for (const b of camp.businesses) {
      lines.push(`\n${b.name}`);
      for (const c of b.campaigns) {
        const t = c.totals;
        lines.push(`  ${c.name}: spend ${money(t.spend)} · leads ${n(t.leads)} · cost/lead ${money(t.cpl)} · appts ${n(t.appointments)} · sales ${n(t.sales)}${t.roi != null ? ` · ROI ${Math.round(t.roi * 100)}%` : ''}`);
      }
    }
  }
  if (rep.carriedOver.length) {
    lines.push('', 'CARRIED OVER (still open, past due)');
    for (const t of rep.carriedOver) lines.push(`  ! ${t.title} — ${t.business_name}, was due ${fmtDate(t.due_at)}`);
  }
  return lines.join('\n');
}

/** Save a snapshot so past months stay on record even if tasks are later edited or deleted. */
export function saveReport(db, rep, { scope = 'all', clientView = false } = {}) {
  db.prepare(`INSERT INTO reports (month, scope, client_view, data) VALUES (?, ?, ?, ?)
    ON CONFLICT(month, scope, client_view) DO UPDATE SET data = excluded.data, created_at = datetime('now')`)
    .run(rep.month, scope, clientView ? 1 : 0, JSON.stringify(rep));
}

/** On the 1st of each month (after the digest hour), snapshot and email last month's report. */
export async function runMonthlyReport(db, now = new Date()) {
  const hour = Number(process.env.DIGEST_HOUR ?? getSetting(db, 'digest_hour', 8));
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const key = monthKey(last);
  if (now.getHours() < hour || getSetting(db, 'last_monthly_report') === key) return 0;
  setSetting(db, 'last_monthly_report', key);

  const owner = db.prepare("SELECT * FROM users WHERE role = 'owner' ORDER BY id LIMIT 1").get();
  if (!owner) return 0;
  saveReport(db, buildMonthlyReport(db, owner, { month: key }));
  if (!emailConfigured()) return 0;

  const appUrl = (process.env.APP_URL || process.env.URL || '').replace(/\/$/, '');
  let sent = 0;
  for (const u of db.prepare("SELECT * FROM users WHERE role IN ('owner','member') AND email_notifications = 1").all()) {
    const rep = buildMonthlyReport(db, u, { month: key });
    try {
      await sendEmail({
        to: u.email,
        subject: `TaskBoard report: ${rep.label} — ${rep.stats.completed} completed, ${rep.stats.planned} planned`,
        text: `${reportText(rep)}\n\n${appUrl ? `Full report: ${appUrl}/#/reports/${key}` : ''}`,
      });
      sent++;
    } catch (err) {
      console.error('[reports] email failed:', err.message);
    }
  }
  return sent;
}
