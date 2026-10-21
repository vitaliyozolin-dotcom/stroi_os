/** A successful commit stages an atomic local change. The existing sync workflow
 * owns durable writes, expected revisions, offline recovery and conflict resolution. */

export const moduleFingerprint = (state) => JSON.stringify(state);
export const moduleChange = (state, patch, action, summary, context, tone = 'neutral', recordActivity = true) => ({
  projectId: state.project.id, expected: moduleFingerprint(state), patch, action, summary,
  event: recordActivity ? { id: context.ids.next('activity'), timestamp: context.clock.now(), actor: context.identity.name, text: summary, tone } : undefined,
});
export const executeModule = (repository, command) => {
  const read = repository.read();
  if (!read.ok) return read;
  const result = command(read.snapshot);
  if (!result.ok || !result.change) return result;
  const committed = repository.commit(result.change);
  return committed.ok ? result : committed;
};
