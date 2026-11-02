// Central place for "who can see what". Every route goes through these helpers
// so the client-visibility rules can't be bypassed by a forgotten WHERE clause.

export const isStaff = (user) => user && (user.role === 'owner' || user.role === 'member');

/** Projects (tabs) the user may open. */
export function visibleProjects(db, user, { includeArchived = false } = {}) {
  const archived = includeArchived ? '' : 'AND p.archived = 0';
  if (user.role === 'owner') {
    return db.prepare(`SELECT p.* FROM projects p WHERE 1=1 ${archived} ORDER BY p.business_id, p.position, p.id`).all();
  }
  if (user.role === 'member') {
    return db.prepare(`
      SELECT p.* FROM projects p
      JOIN business_members bm ON bm.business_id = p.business_id AND bm.user_id = ?
      WHERE 1=1 ${archived} ORDER BY p.business_id, p.position, p.id`).all(user.id);
  }
  // client: only tabs explicitly shared with them AND marked client-visible
  return db.prepare(`
    SELECT p.* FROM projects p
    JOIN project_clients pc ON pc.project_id = p.id AND pc.user_id = ?
    WHERE p.client_visible = 1 AND p.archived = 0
    ORDER BY p.business_id, p.position, p.id`).all(user.id);
}

export function visibleBusinesses(db, user) {
  if (user.role === 'owner') return db.prepare('SELECT * FROM businesses ORDER BY position, id').all();
  const ids = [...new Set(visibleProjects(db, user).map((p) => p.business_id))];
  if (user.role === 'member') {
    for (const r of db.prepare('SELECT business_id FROM business_members WHERE user_id = ?').all(user.id)) {
      if (!ids.includes(r.business_id)) ids.push(r.business_id);
    }
  }
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM businesses WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY position, id`).all(...ids);
}

export function canSeeProject(db, user, projectId) {
  return visibleProjects(db, user, { includeArchived: isStaff(user) }).some((p) => p.id === Number(projectId));
}

export function canEditProject(db, user, projectId) {
  return isStaff(user) && canSeeProject(db, user, projectId);
}

export function canManageBusiness(db, user, businessId) {
  if (user.role === 'owner') return true;
  if (user.role !== 'member') return false;
  return !!db.prepare('SELECT 1 FROM business_members WHERE business_id = ? AND user_id = ?').get(businessId, user.id);
}

/** SQL fragment restricting tasks for a user. Returns [sql, params]. Alias `t` = tasks. */
export function taskScope(db, user) {
  const ids = visibleProjects(db, user, { includeArchived: isStaff(user) }).map((p) => p.id);
  if (!ids.length) return ['0', []];
  const inList = `t.project_id IN (${ids.map(() => '?').join(',')})`;
  if (isStaff(user)) return [inList, ids];
  return [`${inList} AND t.client_visible = 1`, ids];
}

export function canSeeTask(db, user, task) {
  if (!task) return false;
  if (!canSeeProject(db, user, task.project_id)) return false;
  return isStaff(user) || task.client_visible === 1;
}

/** Strip fields clients should never receive. */
export function presentTask(user, task) {
  if (isStaff(user)) return task;
  const { created_by, source, position, ...rest } = task;
  return rest;
}
