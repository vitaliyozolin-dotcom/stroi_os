export const readSnapshot = async (db, projectId) => {
  const row = await db.prepare(`
    SELECT project_id, state_json, revision, updated_at, updated_by, updated_role
    FROM project_state
    WHERE project_id = ?
  `).bind(projectId).first();
  if (!row) return null;

  return {
    projectId: row.project_id,
    state: JSON.parse(row.state_json),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    updatedRole: row.updated_role,
  };
};
