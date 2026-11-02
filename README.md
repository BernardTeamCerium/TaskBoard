# TaskBoard

A project board for running several businesses at once. It replaces a Trello setup with:

- **A board per business, with tabs per project.** Each business (Allied Elite Financial, Spectaculeads, One Stop Web…) gets its own page. Each page has one or more tabs (e.g. *SEO & Citations*, *Content*, *Internal*), and each tab has Board, List and Calendar views.
- **Deadlines that actually notify you.** Every task can have a due date and time. Overdue and soon-due work shows in red, orange and yellow. A **Deadlines** dashboard covers every business at once. Reminders go to the in-app bell, to email, and optionally to Slack, Discord, Teams or phone push (ntfy), and a morning digest email is sent at a set hour.
- **Client logins that only show what you choose.**
  - A **tab** can be internal (clients never see it) or client-visible.
  - A **task** is internal by default. Flip *Visible to client* to share it.
  - **Comments** can be marked *internal note*. Clients never see those.
  - Owners and team members get a **Client view** toggle that shows exactly what the client sees.
- **Updates from email and messages.** Forward an email, reply to a notification, send a text or post from Zapier/Make/Slack. TaskBoard creates tasks, moves them, changes deadlines and adds comments. If you add an Anthropic API key, Claude also interprets free-form messages that don't follow the format.
- **Monthly reports.** Every completed task is kept with the date it was finished. The **Monthly reports** page shows, for any month:
  - what was accomplished, grouped by business and tab, with who did it and whether it was on time;
  - totals per team member;
  - what's planned for next month (tasks due then);
  - anything carried over that's still open and overdue.
  It prints to PDF or downloads as text. A **Client version** switch strips out internal work and names so you can send it to a client, and with an Anthropic API key Claude can write a short written summary. On the 1st of each month a snapshot of last month is saved and emailed to the team.
- **Trello import.** Brings across lists, cards, due dates, checklists, labels and comments.

## Quick start

Requires Node.js 22.13 or newer. There's nothing native to compile, because it uses Node's built-in SQLite.

```bash
npm install
npm start            # http://localhost:3000 — first visit asks you to create the admin account
```

Run the tests with `npm test`.

## Who sees what

| Role | Sees | Can do |
|---|---|---|
| **Admin** | Everything | Everything, including people, tokens, settings and import |
| **Team member** | Businesses they're added to (all tabs, all tasks, internal notes) | Create, edit and move tasks, comment |
| **Client** | Only tabs that are **shared with them** *and* marked client-visible, and within those only tasks marked **Visible to client** | Read, and post comments (never internal) |

All of these rules are enforced on the server (`src/permissions.js`), not just hidden in the UI.

### Adding people

1. *Settings › People & access → Add person.*
2. Enter their name and email and choose **Team member** or **Client**:
   - for a team member, tick the businesses they work on;
   - for a client, tick the tabs they may open (the tab must also have *Clients can open this tab* switched on).
3. Leave the password blank. TaskBoard shows a **sign-in link** to copy and send them (or email it for you if email is set up). The link works once, for 7 days, and lets them choose their own password. Until they use it, the person shows as *invite pending* and can't sign in.
4. Forgotten password? Click **Reset link** next to their name and send them the new link.

No passwords are stored in the code or shown to you.

## Updating the board from email and messages

Every tab has a short **key** (e.g. `AEF`), and every task has a number shown on its card (e.g. `AEF-12`).

| Send | Result |
|---|---|
| Subject `[AEF] Portal training videos` | New task in the AEF tab. The email body becomes the description |
| `AEF: Call vendor due:tomorrow 2pm !high @pete +client` | New task: due tomorrow at 2pm, high priority, assigned to Pete, visible to the client |
| `[AEF-12] done` / `AEF-12 in progress` / `AEF-12 move to waiting` | Moves the task |
| `AEF-12 due: next friday` | Changes the deadline |
| Reply to a notification email (`Re: [AEF-12] …`) | Your reply is added as a comment. Quoted history and signatures are stripped |
| `AEF-12 note: they pay net 60` | Adds an internal note |
| Body lines `due:` `priority:` `status:` `assign:` `visible: client/internal` `comment:` `note:` | Sets that field |
| Several command lines in one text | Each line is applied |

Dates understood: `today`, `tomorrow 9am`, `fri`, `next monday`, `eow`, `in 3 days`, `nov 20`, `11/20`, `2026-11-20 14:00`, `none`.

Messages without a `[KEY]` go to the **Inbox tab** you choose in *Settings › Email & automation*. If an Anthropic API key is set, Claude reads the message first and files it.

### Connecting it

1. In *Settings › Email & automation*, create a **token**.
2. Point a source at one of the two webhooks:
   - **Email**: `POST /api/inbound/email?token=…` accepts Mailgun Routes, SendGrid Inbound Parse, Postmark, Cloudflare Email Workers or plain JSON (`subject`, `body`, `from`).
   - **Messages**: `POST /api/inbound/message` with `Authorization: Bearer …` and `{"text": "..."}`. This works for Zapier, Make, iPhone Shortcuts and Slack workflows. It also works for Twilio SMS, which gets the confirmation back as the text reply.
3. Gmail with no mail service: create a Zap or Make scenario. Trigger on *New email matching search* (for example `label:taskboard`), then use *Webhooks → POST* to the email URL with subject, body and from.

Security:
- Emails from addresses that don't belong to a TaskBoard user are rejected unless you allow it in Settings.
- Clients who email in can only add comments.
- Every inbound message is logged in Settings.

### AI interpretation (optional)

Set `ANTHROPIC_API_KEY`. Claude then turns messages like *"Pete finished the AEF citations, and can Christine get the TEAG portal videos done by next Friday?"* into the right updates. By default it only runs when the rule-based parser can't place a message. You can switch it to *always* or *off* in Settings.

## Notifications

| Event | Who is notified |
|---|---|
| Assigned to a task | Assignee |
| Due within N hours (default 24) and overdue | Assignee, or all owners and that business's team if unassigned. Each one is sent once per deadline |
| Comment | Assignee and creator. Client comments also notify all owners |
| Task completed | Assignee and creator. Clients are notified if it was a visible task |
| Morning digest | Each team member gets overdue, due today and next 7 days |

Channels: in-app bell (always), email (`SMTP_URL`), and chat or phone push (`NOTIFY_WEBHOOK_URL`, for due-soon, overdue and client comments).

## Moving off Trello

1. In Trello, open the board and choose *Menu → Print, export and share → Export as JSON*.
2. In TaskBoard, open *Settings › Import from Trello* and choose the file.
3. Pick a layout:
   - **Each list becomes a business.** Use this when each list is a client or business, as on the current board.
   - **One business, each list becomes a tab.**

Everything imports as **internal**, so nothing is exposed to a client until you share it.

## Monthly reports

Open **Monthly reports** in the sidebar and pick a month.

| Section | What's in it |
|---|---|
| Accomplished | Tasks finished that month, by business and tab, with who and on time / late |
| By team member | How many tasks each person finished |
| Planned for next month | Open tasks due next month |
| Carried over | Open tasks already past due at month end |

- **Client version** shows only client-visible work with no names. Clients who log in and open Reports always get this version.
- **Print / PDF** gives a clean printable page; **Text** downloads a plain-text copy for email.
- On the 1st of each month (at the digest hour) a snapshot of last month is saved under *Saved reports* and emailed to owners and team members. Snapshots keep the record even if tasks are later edited or deleted.
- Done columns on boards only show the last 30 days, so boards stay tidy; older completed work is still in Reports.

## Campaign performance

**Campaigns** in the sidebar tracks how each company's marketing is doing.

- The first time, click **Add our campaigns** to create:

  | Company | Campaign | Channel |
  |---|---|---|
  | Spectaculeads | RetireFlow IUL Campaigns | Lead gen |
  | CardVaulters | Lead Gen Campaign | Lead gen |
  | Allied Elite Financial | Annuity National Lead Campaign | Lead gen |
  | Allied Elite Financial | Annuity General Lead Campaign | Lead gen |
  | Allied Elite Financial | Allied Elite Financial Search Campaigns | Search |
  | Pete Russo | Pete Russo Search Campaigns | Search |

  Missing companies are created too. Add, rename, pause or move campaigns any time.
- **Add results** for a week, a month or any dates: ad spend, leads, appointments, sales/policies, revenue, clicks, impressions (leave out what you don't track). Entering the same campaign and period again replaces the numbers.
- TaskBoard works out **cost per lead, cost per appointment, cost per sale, return on spend**, and shows the change against the previous period (the previous month when you're looking at a whole month).
- Set a **target cost per lead** on a campaign to flag when it's running above target.
- Click a campaign for its history: leads and cost per lead per period, and every entry.
- **Import CSV** accepts your own sheet or Google Ads / Facebook exports (Cost, Amount spent, Results, Conversions, Day, Week, Month…). **⬇ CSV** and **Print / PDF** export the view.
- Campaigns are internal by default. Tick *Clients of this business can see this campaign's results* to include it in that client's view. The **Client version** switch previews it.
- The monthly report includes a campaign performance section.

To fill it automatically (for example a Zapier/Make step after a Google Ads or Facebook report, or a Google Sheet row), POST to `/api/inbound/campaign-results` with an automation token:

```bash
curl -X POST https://YOUR-SITE/api/inbound/campaign-results \
  -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"campaign": "RetireFlow IUL Campaigns", "period_start": "2026-11-03", "period_end": "2026-11-09", "spend": 450, "leads": 18, "appointments": 5}'
```

It also accepts `{"rows": [...]}` or `{"csv": "..."}` for several at once.

## Running on Netlify

`netlify.toml` sets everything up:

- `public/` is the website.
- `netlify/functions/api.mjs` serves every `/api/*` request. It runs the same server code, bundled by `npm run build:netlify` during Netlify's build.
- The database is stored in **Netlify Blobs** (store `taskboard`). Each save is conditional, so two requests at the same moment can't overwrite each other, and a dated backup copy is kept each day under `backups/`.
- `netlify/functions/scheduled.mjs` runs every 15 minutes for deadline reminders, the morning digest and the monthly report.

### First-time setup

1. In Netlify: **Add new site → Import an existing project → GitHub**, pick this repository and branch. The build settings come from `netlify.toml`, so leave them as they are.
2. Before the first deploy (or right after), add these under **Site configuration → Environment variables**:
   - `ADMIN_EMAIL` — your email. Only this address can create the admin account on the first-run screen, so nobody else can claim it.
   - Optional: `SMTP_URL` and `MAIL_FROM` for email notifications and invite emails, `NOTIFY_WEBHOOK_URL`, `ANTHROPIC_API_KEY` (see `.env.example`).
3. Deploy, open the site, and create your admin account. Your browser's timezone is saved as the workspace timezone (change it under *Settings › Email & automation*).
4. Add your team and clients under *Settings › People & access* (see above).

If a site is already connected, open **Deploys → Trigger deploy → Clear cache and deploy site** after pulling changes. If something doesn't load, check **Logs → Functions → api**.

## Deploying elsewhere

Outside Netlify, the app is a single Node process with one SQLite file. Any host that keeps a persistent disk works, for example Render, Railway or Fly.io (with a volume), a $5 VPS, or Docker:

```bash
docker build -t taskboard .
docker run -d -p 3000:3000 -v taskboard-data:/data --env-file .env taskboard
```

Copy `.env.example` to `.env` and fill in what you need. Back up the file at `DB_PATH`.

## Code map

```
src/server.js       HTTP API + static files
src/permissions.js  visibility rules (owner / team / client)
src/tasks.js        create/update/comment logic shared by UI and automation
src/parser.js       email/text command parser
src/dates.js        natural-language deadlines
src/ai.js           optional Claude interpretation
src/inbound.js      inbound email/message handling
src/notify.js       in-app/email/webhook notifications, reminders, digest
src/trello.js       Trello JSON import
src/reports.js      monthly reports
src/campaigns.js    campaign performance: results, roll-ups, CSV import
src/db-core.js      database schema and helpers (src/db.js picks the driver)
public/             front end (no build step)
netlify/            Netlify Functions, Blobs-backed runtime and its build script
```
