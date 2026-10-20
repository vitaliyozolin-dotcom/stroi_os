// Characterization harness around the production scoped workflows and adapters.
// Existing assertions can inspect the staged full project without shipping legacy facades.
import type { AppState, UserRole } from '../../src/entities/index.ts';
import type { StateChange } from '../../src/domain/change.ts';
import type { StateChangeSink } from '../../src/application/state-change.ts';
import type { Clock, IdGenerator } from '../../src/application/ports.ts';
import type { ModuleResult } from '../../src/application/module-repository.ts';
import * as supply from '../../src/application/procurement.ts';
import * as contacts from '../../src/application/counterparties.ts';
import * as sales from '../../src/application/marketing.ts';
import * as decisions from '../../src/application/client-decisions.ts';
import * as settings from '../../src/application/settings.ts';
import * as planning from '../../src/application/schedule-planning.ts';
import * as edits from '../../src/application/schedule-edits.ts';
import * as control from '../../src/application/stage-control.ts';
import * as documents from '../../src/application/project-documents.ts';
import * as reports from '../../src/application/field-reports.ts';
import * as adapters from '../../src/infrastructure/module-project.ts';

type Projected<R> = R extends { ok: true } ? Omit<R, 'change'> & { change: StateChange | null } : R;
const expose = <C extends Record<string, (...args: never[]) => ModuleResult<unknown>>>(state: AppState, sink: StateChangeSink, build: (read: () => AppState, sink: StateChangeSink) => C) => {
 let current = state, staged: StateChange | null = null;
 const commands = build(() => current, (next, metadata) => { staged = { state: next, action: metadata!.action, summary: metadata!.summary }; current = next; sink(next, metadata); });
 return Object.fromEntries(Object.entries(commands).map(([key, command]) => [key, (...args: never[]) => { staged = null; const result = command(...args); return result.ok ? { ...result, change: staged } : result; }])) as { [K in keyof C]: (...args: Parameters<C[K]>) => Projected<ReturnType<C[K]>> };
};
const noop: StateChangeSink = () => {};
type Identity = { name: string; role: UserRole; id?: string };
export const createProcurementUseCases = (state: AppState, identity: Identity, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => supply.createProcurementUseCases(adapters.createSupplyRepository(read, stage), identity, clock, ids));
export const createProjectRequirement = (state: AppState, input: supply.CreateRequirementInput, identity: Identity, clock: Clock, ids: IdGenerator) => createProcurementUseCases(state, identity, clock, ids).createRequirement(input);
export const changeProjectProcurement = (state: AppState, input: Parameters<typeof supply.changeProjectProcurement>[1], identity: Identity, clock: Clock, ids: IdGenerator) => createProcurementUseCases(state, identity, clock, ids).change(input);
export const createCounterpartyUseCases = (state: AppState, actor: string, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => contacts.createCounterpartyUseCases(adapters.createContactsRepository(read, stage), actor, clock, ids));
export const saveProjectCounterparty = (state: AppState, input: contacts.SaveCounterpartyInput, actor: string, clock: Clock, ids: IdGenerator) => createCounterpartyUseCases(state, actor, clock, ids).saveProfile(input);
export const addProjectCounterpartyDocument = (state: AppState, input: contacts.AddCounterpartyDocumentInput, actor: string, clock: Clock, ids: IdGenerator) => createCounterpartyUseCases(state, actor, clock, ids).addDocument(input);
export const createMarketingUseCases = (state: AppState, identity: Identity, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => sales.createMarketingUseCases(adapters.createSalesRepository(read, stage), identity, clock, ids));
export const changeProjectMarketing = (state: AppState, input: sales.MarketingCommand, identity: Identity, clock: Clock, ids: IdGenerator) => createMarketingUseCases(state, identity, clock, ids).execute(input);
export const createClientDecisionUseCases = (state: AppState, identity: Identity, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => decisions.createClientDecisionUseCases(adapters.createDecisionsRepository(read, stage), identity, clock, ids));
export const confirmProjectClientDecision = (state: AppState, input: decisions.ConfirmClientDecisionInput, identity: Identity, clock: Clock, ids: IdGenerator) => createClientDecisionUseCases(state, identity, clock, ids).confirm(input);
export const createSettingsUseCases = (state: AppState, identity: Identity & { canManageAccess: boolean }, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => settings.createSettingsUseCases(adapters.createSettingsRepository(read, stage), identity, clock, ids));
export const changeProjectSettings = (state: AppState, input: Parameters<typeof settings.changeProjectSettings>[1], identity: Identity & { canManageAccess: boolean }, clock: Clock, ids: IdGenerator) => createSettingsUseCases(state, identity, clock, ids).execute(input);
export const createSchedulePlanningUseCases = (state: AppState, identity: Identity, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => planning.createSchedulePlanningUseCases(adapters.createConstructionRepository(read, stage), identity, clock, ids));
export const editProjectStagePlan = (state: AppState, input: planning.EditStagePlanInput, identity: Identity, clock: Clock, ids: IdGenerator) => createSchedulePlanningUseCases(state, identity, clock, ids).editPlan(input);
export const createScheduleEditUseCases = (state: AppState, identity: Identity, clock: Clock, ids: IdGenerator, sink = noop) => expose(state, sink, (read, stage) => edits.createScheduleEditUseCases(adapters.createConstructionRepository(read, stage), identity, clock, ids));
export const editProjectSchedule = (state: AppState, input: edits.ScheduleEditInput, identity: Identity, clock: Clock, ids: IdGenerator) => createScheduleEditUseCases(state, identity, clock, ids).execute(input);
export const applyStageControl = (state: AppState, ...args: Parameters<typeof control.applyStageControl> extends [unknown, ...infer R] ? R : never) => {
 const result = control.applyStageControl(adapters.constructionSnapshot(state), ...args);
 return { ...structuredClone(state), stages: result.snapshot.stages, tasks: result.snapshot.tasks, activity: [result.event, ...structuredClone(state.activity)] };
};
export const commitStageControl = (state: AppState, stageId: string, action: control.StageAction, input: Parameters<typeof control.applyStageControl>[3], actor: string, role: UserRole, userId: string | undefined, expected: string, clock: Clock, ids: IdGenerator, sink: StateChangeSink) => {
 const commands = expose(state, sink, (read, stage) => control.createStageControlUseCases(adapters.createConstructionRepository(read, stage), { name: actor, role, id: userId }, clock, ids));
 const result = commands.control({ stageId, action, input, expected });
 if (!result.ok || !result.change) throw new Error(result.ok ? 'no_change' : result.error);
 return result.change.state;
};
const upload = async <R extends ModuleResult<unknown>>(read: () => AppState, sink: StateChangeSink, command: (repository: ReturnType<typeof adapters.createDocumentsRepository>) => Promise<R>) => {
 let staged: StateChange | null = null;
 const repository = adapters.createDocumentsRepository(read, (state, metadata) => { staged = { state, action: metadata!.action, summary: metadata!.summary }; sink(state, metadata); });
 const result = await command(repository);
 return (result.ok ? { ...result, change: staged } : result) as Projected<R>;
};
export const uploadProjectDocument = (read: () => AppState, input: Parameters<typeof documents.uploadProjectDocument>[1], identity: Identity, clock: Clock, ids: IdGenerator, uploader: documents.DocumentUploadPort, sink: StateChangeSink, signal: AbortSignal) => upload(read, sink, repository => documents.uploadProjectDocument(repository, input, identity, clock, ids, uploader, signal));
export const uploadFieldReport = (read: () => AppState, input: Parameters<typeof reports.uploadFieldReport>[1], identity: Identity, clock: Clock, ids: IdGenerator, uploader: documents.DocumentUploadPort, sink: StateChangeSink, signal: AbortSignal) => upload(read, sink, repository => reports.uploadFieldReport(repository, input, identity, clock, ids, uploader, signal));
