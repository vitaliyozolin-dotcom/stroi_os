import { validateBaselineChanges } from '../projects/baseline.js';
import { validateStageControl } from '../projects/stage-control.js';

const MAX_STATE_BYTES = 6_000_000;

export const createTelegramProjectStore = ({ ensureSchema, readSnapshot, changes, mutationNoop }) => {
  const listSnapshots = async (db) => {
    await ensureSchema(db);
    const result = await db.prepare(`
      SELECT project_id, state_json, revision, updated_at
      FROM project_state
      WHERE substr(project_id, 1, 2) != '__'
      ORDER BY updated_at DESC
      LIMIT 100
    `).all();
    return (result?.results ?? []).flatMap((row) => {
      try {
        const state = JSON.parse(row.state_json);
        return state?.project?.id && state.project.status !== 'workspace'
          ? [{ projectId: row.project_id, state, revision: Number(row.revision), updatedAt: row.updated_at }]
          : [];
      } catch {
        return [];
      }
    });
  };

  const mutate = async (env, projectId, actor, role, action, summary, mutation) => {
    await ensureSchema(env.DB);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await readSnapshot(env.DB, projectId);
      if (!snapshot) throw new Error('project_not_found');
      const previous = snapshot.state;
      const next = JSON.parse(JSON.stringify(previous));
      const resultState = await mutation(next);
      if (resultState === mutationNoop) {
        return { previous, state: previous, revision: snapshot.revision, updatedAt: snapshot.updatedAt, changed: false };
      }
      const state = resultState ?? next;
      const now = new Date().toISOString();
      const stageError = validateStageControl(previous, state, { role, name: actor }, now);
      if (stageError) throw new Error(`invalid_stage_transition: ${stageError}`);
      const baselineError = validateBaselineChanges(previous, state, { role, name: actor }, now);
      if (baselineError) throw new Error(`invalid_baseline_transition: ${baselineError}`);
      const stateJson = JSON.stringify(state);
      const stateBytes = new TextEncoder().encode(stateJson).byteLength;
      if (stateBytes > MAX_STATE_BYTES) throw new Error('payload_too_large');
      const nextRevision = snapshot.revision + 1;
      const result = await env.DB.prepare(`
        UPDATE project_state
        SET state_json = ?, revision = ?, updated_at = ?, updated_by = ?, updated_role = ?
        WHERE project_id = ? AND revision = ?
      `).bind(stateJson, nextRevision, now, actor, role, projectId, snapshot.revision).run();
      if (changes(result) !== 1) continue;
      try {
        await env.DB.prepare(`
          INSERT INTO audit_log (
            id, project_id, revision, created_at, actor, role, action, summary, state_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(crypto.randomUUID(), projectId, nextRevision, now, actor, role, action, summary, stateBytes).run();
      } catch {
        // Основное состояние уже сохранено.
      }
      return { previous, state, revision: nextRevision, updatedAt: now, changed: true };
    }
    throw new Error('revision_conflict');
  };

  return { listSnapshots, mutate };
};
