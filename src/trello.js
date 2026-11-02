// Import a Trello board export (Board menu → More → Print, export and share → Export as JSON).
//
// mode "business" (default): each Trello list becomes its own business with a
//   "Tasks" tab — matches boards where every list is a client/business.
// mode "project": one business named after the board, each list becomes a tab.
//
// Everything is imported as INTERNAL (hidden from clients); share tasks/tabs afterwards.
import { tx, DEFAULT_COLUMNS } from './db.js';
import { HttpError } from './tasks.js';
import { createProject } from './projects.js';

export function importTrello(db, user, board, { mode = 'business', includeArchived = false } = {}) {
  if (!board || !Array.isArray(board.lists) || !Array.isArray(board.cards)) {
    throw new HttpError(400, 'That does not look like a Trello board JSON export');
  }
  const lists = board.lists.filter((l) => includeArchived || !l.closed).sort((a, b) => a.pos - b.pos);
  const checklistsByCard = {};
  for (const cl of board.checklists || []) (checklistsByCard[cl.idCard] ||= []).push(cl);
  const commentsByCard = {};
  for (const a of board.actions || []) {
    if (a.type === 'commentCard' && a.data?.card?.id) (commentsByCard[a.data.card.id] ||= []).push(a);
  }

  const palette = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#2563eb'];
  const newBusiness = (name) => {
    const n = db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n;
    const r = db.prepare('INSERT INTO businesses (name, color, position) VALUES (?, ?, ?)').run(name, palette[n % palette.length], n);
    return Number(r.lastInsertRowid);
  };

  return tx(db, () => {
    const summary = { businesses: 0, projects: 0, tasks: 0, comments: 0 };
    const boardBusinessId = mode === 'project' ? (summary.businesses++, newBusiness(board.name || 'Imported board')) : null;

    for (const list of lists) {
      let businessId = boardBusinessId;
      if (mode !== 'project') { businessId = newBusiness(list.name); summary.businesses++; }
      const project = createProject(db, businessId, mode === 'project' ? list.name : 'Tasks', null, { columns: DEFAULT_COLUMNS });
      summary.projects++;
      const cols = db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position').all(project.id);
      const todo = cols[0];
      const done = cols.find((c) => c.is_done);

      const cards = board.cards.filter((c) => c.idList === list.id && (includeArchived || !c.closed)).sort((a, b) => a.pos - b.pos);
      cards.forEach((card, i) => {
        let desc = card.desc || '';
        const labels = (card.labels || []).map((l) => l.name || l.color).filter(Boolean);
        if (labels.length) desc = `Labels: ${labels.join(', ')}\n\n${desc}`.trim();
        for (const cl of checklistsByCard[card.id] || []) {
          desc += `\n\n**${cl.name}**\n${(cl.checkItems || []).sort((a, b) => a.pos - b.pos)
            .map((it) => `- [${it.state === 'complete' ? 'x' : ' '}] ${it.name}`).join('\n')}`;
        }
        const isDone = !!card.dueComplete;
        const col = isDone ? done : todo;
        const r = db.prepare(`INSERT INTO tasks (project_id, column_id, title, description, due_at, position, source, created_by, completed_at, client_visible)
          VALUES (?, ?, ?, ?, ?, ?, 'trello', ?, ?, 0)`).run(
          project.id, col.id, card.name || '(untitled)', desc.trim(), card.due || null, i + 1, user.id,
          isDone ? (card.dateLastActivity || new Date().toISOString()) : null,
        );
        summary.tasks++;
        for (const a of (commentsByCard[card.id] || []).reverse()) {
          const who = a.memberCreator?.fullName ? `${a.memberCreator.fullName} (Trello): ` : '';
          db.prepare("INSERT INTO comments (task_id, user_id, body, internal, source, created_at) VALUES (?, ?, ?, 1, 'trello', ?)")
            .run(r.lastInsertRowid, user.id, `${who}${a.data.text}`, a.date || new Date().toISOString());
          summary.comments++;
        }
      });
    }
    return summary;
  });
}
