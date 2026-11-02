// Campaign performance: campaigns belong to a business; results are logged per
// period (a week, a month, or any date range) and rolled up into cost per lead,
// cost per appointment, ROI and so on.
import { canManageBusiness, isStaff } from './permissions.js';
import { HttpError } from './tasks.js';
import { createBusinessWithProject } from './projects.js';

export const METRICS = ['spend', 'impressions', 'clicks', 'leads', 'appointments', 'sales', 'revenue'];
const STATUSES = ['active', 'paused', 'ended'];

/** The campaigns set up for this workspace, added with one click from the Campaigns page. */
export const STARTER_CAMPAIGNS = [
  { business: 'Spectaculeads', campaigns: [{ name: 'RetireFlow IUL Campaigns', channel: 'Lead gen' }] },
  { business: 'CardVaulters', campaigns: [{ name: 'Lead Gen Campaign', channel: 'Lead gen' }] },
  {
    business: 'Allied Elite Financial',
    campaigns: [
      { name: 'Annuity National Lead Campaign', channel: 'Lead gen' },
      { name: 'Annuity General Lead Campaign', channel: 'Lead gen' },
      { name: 'Allied Elite Financial Search Campaigns', channel: 'Search' },
    ],
  },
  { business: 'Pete Russo', campaigns: [{ name: 'Pete Russo Search Campaigns', channel: 'Search' }] },
];

// ---------- visibility ----------

/** Businesses whose campaigns the user may see. Clients: businesses with a tab shared with them. */
function businessIdsFor(db, user) {
  if (user.role === 'owner') return null; // all
  if (user.role === 'member') {
    return db.prepare('SELECT business_id AS id FROM business_members WHERE user_id = ?').all(user.id).map((r) => r.id);
  }
  return db.prepare(`SELECT DISTINCT p.business_id AS id FROM project_clients pc JOIN projects p ON p.id = pc.project_id
    WHERE pc.user_id = ? AND p.client_visible = 1 AND p.archived = 0`).all(user.id).map((r) => r.id);
}

function campaignScope(db, user, alias = 'c') {
  const ids = businessIdsFor(db, user);
  const where = [];
  const params = [];
  if (ids) {
    if (!ids.length) return ['0', []];
    where.push(`${alias}.business_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (!isStaff(user)) where.push(`${alias}.client_visible = 1`);
  return [where.length ? where.join(' AND ') : '1', params];
}

export function getCampaign(db, user, id) {
  const [scope, params] = campaignScope(db, user);
  const c = db.prepare(`SELECT c.*, b.name AS business_name, b.color AS business_color FROM campaigns c
    JOIN businesses b ON b.id = c.business_id WHERE c.id = ? AND ${scope}`).get(Number(id), ...params);
  if (!c) throw new HttpError(404, 'Campaign not found');
  return c;
}

function requireManage(db, user, businessId) {
  if (!isStaff(user) || !canManageBusiness(db, user, businessId)) throw new HttpError(403, 'You cannot change campaigns for this business');
}

// ---------- campaigns ----------

function cleanCampaign(input, partial = false) {
  const out = {};
  if (input.name !== undefined || !partial) {
    const name = String(input.name || '').trim();
    if (!name) throw new HttpError(400, 'Campaign name is required');
    out.name = name;
  }
  if (input.channel !== undefined) out.channel = String(input.channel || '').trim();
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new HttpError(400, 'Status must be active, paused or ended');
    out.status = input.status;
  }
  for (const k of ['target_cpl', 'monthly_budget']) {
    if (input[k] !== undefined) out[k] = input[k] === '' || input[k] === null ? null : num(input[k], k);
  }
  if (input.notes !== undefined) out.notes = String(input.notes || '');
  if (input.client_visible !== undefined) out.client_visible = input.client_visible ? 1 : 0;
  return out;
}

export function createCampaign(db, user, input) {
  const businessId = Number(input.business_id);
  if (!db.prepare('SELECT 1 FROM businesses WHERE id = ?').get(businessId)) throw new HttpError(400, 'Choose a business');
  requireManage(db, user, businessId);
  const c = cleanCampaign(input);
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM campaigns WHERE business_id = ?').get(businessId).p;
  const r = db.prepare(`INSERT INTO campaigns (business_id, name, channel, status, target_cpl, monthly_budget, notes, client_visible, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(businessId, c.name, c.channel || '', c.status || 'active', c.target_cpl ?? null,
    c.monthly_budget ?? null, c.notes || '', c.client_visible || 0, pos);
  return getCampaign(db, user, r.lastInsertRowid);
}

export function updateCampaign(db, user, id, input) {
  const existing = getCampaign(db, user, id);
  requireManage(db, user, existing.business_id);
  const c = cleanCampaign(input, true);
  if (input.business_id !== undefined && Number(input.business_id) !== existing.business_id) {
    requireManage(db, user, Number(input.business_id));
    c.business_id = Number(input.business_id);
  }
  const cols = Object.keys(c);
  if (cols.length) db.prepare(`UPDATE campaigns SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((k) => c[k]), existing.id);
  return getCampaign(db, user, existing.id);
}

export function deleteCampaign(db, user, id) {
  const existing = getCampaign(db, user, id);
  requireManage(db, user, existing.business_id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(existing.id);
}

/** Create the workspace's standard campaigns (and their businesses) if missing. */
export function addStarterCampaigns(db, user) {
  if (user.role !== 'owner') throw new HttpError(403, 'Admin only');
  let businesses = 0;
  let campaigns = 0;
  for (const group of STARTER_CAMPAIGNS) {
    let biz = db.prepare('SELECT * FROM businesses WHERE name = ? COLLATE NOCASE').get(group.business);
    if (!biz) { biz = createBusinessWithProject(db, group.business); businesses++; }
    for (const c of group.campaigns) {
      if (db.prepare('SELECT 1 FROM campaigns WHERE business_id = ? AND name = ? COLLATE NOCASE').get(biz.id, c.name)) continue;
      createCampaign(db, user, { business_id: biz.id, ...c });
      campaigns++;
    }
  }
  return { businesses, campaigns };
}

// ---------- results ----------

function num(v, field) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${field} must be a number of 0 or more`);
  return n;
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Accepts YYYY-MM-DD, MM/DD/YYYY or M/D/YY; returns YYYY-MM-DD or null. */
export function toIsoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (isDate(s)) return s;
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (us) {
    const y = us[3].length === 2 ? `20${us[3]}` : us[3];
    const out = `${y}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
    return isDate(out) ? out : null;
  }
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})T/);
  return iso && isDate(iso[1]) ? iso[1] : null;
}

function cleanResult(input) {
  const start = toIsoDate(input.period_start);
  const end = toIsoDate(input.period_end) || start;
  if (!start) throw new HttpError(400, 'A start date (YYYY-MM-DD) is required');
  if (end < start) throw new HttpError(400, 'The end date is before the start date');
  const out = { period_start: start, period_end: end, notes: String(input.notes || '') };
  for (const m of METRICS) out[m] = num(input[m], m);
  if (['impressions', 'clicks', 'leads', 'appointments', 'sales'].some((m) => out[m] !== null && !Number.isInteger(out[m]))) {
    throw new HttpError(400, 'Impressions, clicks, leads, appointments and sales must be whole numbers');
  }
  if (METRICS.every((m) => out[m] === null)) throw new HttpError(400, 'Enter at least one number');
  return out;
}

/** Add results for a period, or replace them if that exact period was already entered. */
export function saveResult(db, user, campaignId, input, { source = 'web' } = {}) {
  const c = getCampaign(db, user, campaignId);
  requireManage(db, user, c.business_id);
  const r = cleanResult(input);
  db.prepare(`INSERT INTO campaign_results (campaign_id, period_start, period_end, ${METRICS.join(', ')}, notes, source, created_by)
    VALUES (?, ?, ?, ${METRICS.map(() => '?').join(', ')}, ?, ?, ?)
    ON CONFLICT(campaign_id, period_start, period_end) DO UPDATE SET
      ${METRICS.map((m) => `${m} = excluded.${m}`).join(', ')}, notes = excluded.notes, source = excluded.source`)
    .run(c.id, r.period_start, r.period_end, ...METRICS.map((m) => r[m]), r.notes, source, user.id);
  return db.prepare('SELECT * FROM campaign_results WHERE campaign_id = ? AND period_start = ? AND period_end = ?').get(c.id, r.period_start, r.period_end);
}

function resultWithCampaign(db, user, resultId) {
  const row = db.prepare('SELECT * FROM campaign_results WHERE id = ?').get(Number(resultId));
  if (!row) throw new HttpError(404, 'Result not found');
  const c = getCampaign(db, user, row.campaign_id);
  requireManage(db, user, c.business_id);
  return row;
}

export function updateResult(db, user, resultId, input) {
  const row = resultWithCampaign(db, user, resultId);
  const r = cleanResult({ ...row, ...input });
  const clash = db.prepare('SELECT id FROM campaign_results WHERE campaign_id = ? AND period_start = ? AND period_end = ? AND id != ?')
    .get(row.campaign_id, r.period_start, r.period_end, row.id);
  if (clash) throw new HttpError(400, 'There are already results for that exact period');
  db.prepare(`UPDATE campaign_results SET period_start = ?, period_end = ?, ${METRICS.map((m) => `${m} = ?`).join(', ')}, notes = ? WHERE id = ?`)
    .run(r.period_start, r.period_end, ...METRICS.map((m) => r[m]), r.notes, row.id);
  return db.prepare('SELECT * FROM campaign_results WHERE id = ?').get(row.id);
}

export function deleteResult(db, user, resultId) {
  const row = resultWithCampaign(db, user, resultId);
  db.prepare('DELETE FROM campaign_results WHERE id = ?').run(row.id);
}

// ---------- roll-ups ----------

/** Sum raw metrics and derive the ratios. Ratios are null when they can't be computed. */
export function derive(t) {
  const div = (a, b) => (a != null && b ? a / b : null);
  return {
    ...t,
    ctr: div(t.clicks, t.impressions),
    cpc: div(t.spend, t.clicks),
    cpl: div(t.spend, t.leads),
    cost_per_appointment: div(t.spend, t.appointments),
    cost_per_sale: div(t.spend, t.sales),
    lead_to_appointment: div(t.appointments, t.leads),
    appointment_to_sale: div(t.sales, t.appointments),
    roas: div(t.revenue, t.spend),
    roi: t.revenue != null && t.spend ? (t.revenue - t.spend) / t.spend : null,
  };
}

function emptyTotals() {
  return Object.fromEntries(METRICS.map((m) => [m, null]));
}

function addInto(totals, row) {
  for (const m of METRICS) if (row[m] != null) totals[m] = (totals[m] ?? 0) + row[m];
  return totals;
}

/** The period to compare against: the previous calendar month for a whole month, otherwise the same number of days just before. */
export function previousRange(from, to) {
  const d = (s) => new Date(`${s}T00:00:00Z`);
  const f = d(from);
  const t = d(to);
  const monthEnd = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 0));
  if (f.getUTCDate() === 1 && t.getTime() === monthEnd.getTime()) {
    const pFrom = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - 1, 1));
    const pTo = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0));
    return { from: pFrom.toISOString().slice(0, 10), to: pTo.toISOString().slice(0, 10) };
  }
  const days = Math.round((d(to) - d(from)) / 864e5) + 1;
  const prevTo = new Date(d(from).getTime() - 864e5);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 864e5);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { from: iso(prevFrom), to: iso(prevTo) };
}

/**
 * Performance for every visible campaign between from and to (inclusive, YYYY-MM-DD).
 * A result counts toward the range its period starts in.
 */
export function campaignSummary(db, user, { from, to, businessId = null, clientView = false } = {}) {
  from = toIsoDate(from);
  to = toIsoDate(to);
  if (!from || !to) throw new HttpError(400, 'Choose a date range');
  if (to < from) throw new HttpError(400, 'The end date is before the start date');
  const prev = previousRange(from, to);
  const [scope, params] = campaignScope(db, user);
  const where = [scope];
  if (businessId) { where.push('c.business_id = ?'); params.push(Number(businessId)); }
  if (clientView) where.push('c.client_visible = 1');
  const campaigns = db.prepare(`SELECT c.*, b.name AS business_name, b.color AS business_color, b.position AS business_position
    FROM campaigns c JOIN businesses b ON b.id = c.business_id WHERE ${where.join(' AND ')}
    ORDER BY b.position, b.id, c.position, c.id`).all(...params);

  const sumFor = (campaignId, a, b) => {
    const rows = db.prepare(`SELECT * FROM campaign_results WHERE campaign_id = ? AND period_start >= ? AND period_start <= ?`).all(campaignId, a, b);
    return { totals: rows.reduce(addInto, emptyTotals()), entries: rows.length };
  };

  const businesses = new Map();
  const overall = emptyTotals();
  const overallPrev = emptyTotals();
  for (const c of campaigns) {
    const cur = sumFor(c.id, from, to);
    const before = sumFor(c.id, prev.from, prev.to);
    if (!businesses.has(c.business_id)) {
      businesses.set(c.business_id, { id: c.business_id, name: c.business_name, color: c.business_color, campaigns: [], totals: emptyTotals(), previous: emptyTotals() });
    }
    const b = businesses.get(c.business_id);
    const { business_position, ...campaign } = c;
    b.campaigns.push({ ...campaign, entries: cur.entries, totals: derive(cur.totals), previous: derive(before.totals) });
    addInto(b.totals, cur.totals);
    addInto(b.previous, before.totals);
    addInto(overall, cur.totals);
    addInto(overallPrev, before.totals);
  }
  return {
    from, to, previous: prev,
    totals: derive(overall),
    previousTotals: derive(overallPrev),
    businesses: [...businesses.values()].map((b) => ({ ...b, totals: derive(b.totals), previous: derive(b.previous) })),
  };
}

export function campaignDetail(db, user, id) {
  const c = getCampaign(db, user, id);
  const results = db.prepare('SELECT * FROM campaign_results WHERE campaign_id = ? ORDER BY period_start DESC, period_end DESC').all(c.id);
  return { ...c, results: results.map((r) => ({ ...r, ...derive(r) })), canEdit: isStaff(user) && canManageBusiness(db, user, c.business_id) };
}

// ---------- CSV ----------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const HEADER_ALIASES = {
  campaign: ['campaign', 'campaign name', 'name'],
  business: ['business', 'company', 'client', 'account'],
  period_start: ['period_start', 'start', 'start date', 'from', 'date', 'week', 'week of', 'month', 'day', 'reporting starts'],
  period_end: ['period_end', 'end', 'end date', 'to', 'reporting ends'],
  spend: ['spend', 'cost', 'amount spent', 'amount spent (usd)', 'ad spend', 'budget spent'],
  impressions: ['impressions', 'impr.', 'impr'],
  clicks: ['clicks', 'link clicks'],
  leads: ['leads', 'results', 'conversions', 'leads generated'],
  appointments: ['appointments', 'appts', 'appointments set', 'booked', 'calls booked'],
  sales: ['sales', 'policies', 'closed', 'deals', 'policies sold'],
  revenue: ['revenue', 'premium', 'commission', 'conv. value', 'conversion value'],
  notes: ['notes', 'note', 'comments'],
};

/** Rows of objects (from CSV or JSON) -> saved results. Campaigns are matched by name. */
export function importResults(db, user, rows, { source = 'import' } = {}) {
  const [scope, params] = campaignScope(db, user);
  const campaigns = db.prepare(`SELECT c.id, c.name, b.name AS business FROM campaigns c JOIN businesses b ON b.id = c.business_id WHERE ${scope}`).all(...params);
  let imported = 0;
  const errors = [];
  rows.forEach((raw, i) => {
    const line = i + 2;
    try {
      const find = (k) => {
        for (const alias of HEADER_ALIASES[k]) {
          const key = Object.keys(raw).find((h) => h.trim().toLowerCase() === alias);
          if (key !== undefined && raw[key] !== '' && raw[key] != null) return raw[key];
        }
        return undefined;
      };
      const name = String(find('campaign') || '').trim();
      const biz = String(find('business') || '').trim().toLowerCase();
      const matches = campaigns.filter((c) => c.name.toLowerCase() === name.toLowerCase() && (!biz || c.business.toLowerCase() === biz));
      if (!name) throw new Error('missing campaign name');
      if (!matches.length) throw new Error(`no campaign called "${name}"`);
      if (matches.length > 1) throw new Error(`"${name}" exists in several businesses — add a business column`);
      const rawStart = String(find('period_start') ?? '').trim();
      let start = rawStart;
      let end = find('period_end');
      if (/^\d{4}-\d{2}$/.test(rawStart)) { // a whole month, e.g. 2026-10
        const [y, m] = rawStart.split('-').map(Number);
        start = `${rawStart}-01`;
        end ||= new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      }
      const input = { period_start: start, period_end: end, notes: find('notes') };
      for (const m of METRICS) input[m] = find(m);
      saveResult(db, user, matches[0].id, input, { source });
      imported++;
    } catch (err) {
      errors.push(`Row ${line}: ${err.message}`);
    }
  });
  return { imported, errors };
}

export function csvToObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function summaryCsv(summary) {
  const cols = ['business', 'campaign', 'channel', 'status', ...METRICS, 'cpl', 'cost_per_appointment', 'cost_per_sale', 'roi'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const lines = [cols.join(',')];
  for (const b of summary.businesses) {
    for (const c of b.campaigns) {
      lines.push([b.name, c.name, c.channel, c.status, ...METRICS.map((m) => c.totals[m]), c.totals.cpl, c.totals.cost_per_appointment, c.totals.cost_per_sale, c.totals.roi]
        .map(round).map(esc).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}
