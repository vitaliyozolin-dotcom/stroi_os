import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { seedState } from '../src/seed.ts';
import { createLeadProjectState, lifecycleDefinitions, migrateLifecycle, stepOwner, validateLifecycleChanges } from '../src/domain/project-lifecycle.js';
import { escrowFundingBlockers, monthExpired, qualificationBlockers, salesStages } from '../src/domain/sales-workflow.js';
import { maintainLeadFunnel, syncLeadCopies, validateSalesWrite } from '../sites/leads/funnel.js';
import { readSnapshot } from '../sites/projects/snapshot.js';
import { validateProjectFundingChanges } from '../src/domain/project-funding.js';

const now = '2026-11-25T09:00:00.000Z';
const owner = { role: 'management', name: 'Оператор' } as const;
const applicant = {
  id: 'inbox-1', createdAt: '2026-08-31T12:00:00.000Z', name: 'Клиент', phone: '000000',
  stage: 'qualified', stageEnteredAt: now, owner: 'Агент', projectManager: 'Руководитель',
  source: 'website', budget: 7000000, mortgageStatus: 'approved', landStatus: 'owned', region: 'Район', nextAction: 'Передать в расчёт',
  qualification: { technology: 'СИП', projectType: 'standard', financingSource: 'Банк и собственные средства',
    downPaymentMode: 'with', mortgageProgram: 'Семейная', projectModel: 'Вела', completionScope: 'Под ключ',
    plotAction: 'check', plotResult: 'verified', maternityCapital: 100 },
} as const;

function workspace(id: string) {
  const state = structuredClone(seedState);
  state.project.id = id; state.stages = []; state.leads = [];
  return state;
}
function database() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE project_state (project_id TEXT PRIMARY KEY, state_json TEXT, revision INTEGER, updated_at TEXT, updated_by TEXT, updated_role TEXT);
    CREATE TABLE lead_inbox (id TEXT PRIMARY KEY, status TEXT, created_at TEXT);
    CREATE TABLE lead_status_clock (lead_id TEXT PRIMARY KEY, entered_at TEXT);
    CREATE TABLE audit_log (id TEXT PRIMARY KEY, project_id TEXT, revision INTEGER, created_at TEXT, actor TEXT, role TEXT, action TEXT, summary TEXT, state_bytes INTEGER);`);
  const statement = (query: string, args: any[] = []) => ({
    bind: (...values: any[]) => statement(query, values),
    all: async () => ({ results: sql.prepare(query).all(...args) }),
    first: async () => sql.prepare(query).get(...args),
    run: async () => ({ changes: sql.prepare(query).run(...args).changes }),
  });
  const db = { prepare: statement, batch: async (list: ReturnType<typeof statement>[]) => Promise.all(list.map(entry => entry.run())) };
  const put = (state: ReturnType<typeof workspace>) => sql.prepare('INSERT INTO project_state VALUES (?, ?, 1, NULL, NULL, NULL)').run(state.project.id, JSON.stringify(state));
  return { db, sql, put };
}

test('the same local clock time a calendar month later is still 0.5, including short months and Moscow midnight', () => {
  assert.equal(monthExpired('2026-01-30T22:00:00Z', '2026-02-27T22:00:00Z'), false);
  assert.equal(monthExpired('2026-01-30T22:00:00Z', '2026-02-27T22:00:00.001Z'), true);
  assert.equal(monthExpired('2024-01-31T08:00:00Z', '2024-02-29T08:00:00Z'), false);
  assert.equal(monthExpired('2026-10-25T09:00:00Z', now), false);
  assert.deepEqual(salesStages.map(row => row.code), ['0.1','0.2','0.5','0.6','0.7','0.8','0.9','0.95','1.0']);
  assert.equal(lifecycleDefinitions.find(row => row.number === '1.1')?.title, 'Согласован план производства работ и определены даты финансирования');
});

test('one scheduled run catches website and project leads offline, respects recent re-entry and does not duplicate history', async () => {
  const { db, sql, put } = database();
  const old = { ...applicant, stage: 'new' as const, stageEnteredAt: undefined };
  const recent = { ...old, id: 'reopened', stageEnteredAt: '2026-11-23T12:00:00Z' };
  for (const id of ['one','two']) {
    const state = workspace(id); state.leads = [old, recent]; put(state);
  }
  for (const id of [old.id,'unimported']) sql.prepare('INSERT INTO lead_inbox VALUES (?, ?, ?)').run(id,'new',old.createdAt);
  await maintainLeadFunnel(db, now);
  for (const id of ['one','two']) {
    const snap = await readSnapshot(db,id);
    assert.equal(snap.state.leads[0].stage,'deferred'); assert.equal(snap.state.leads[1].stage,'new');
    assert.equal(snap.revision,2);
  }
  assert.deepEqual(sql.prepare('SELECT status FROM lead_inbox').all().map(row => row.status), ['deferred','deferred']);
  await maintainLeadFunnel(db, now);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM audit_log').get()!.n,2);
  const snapshot = await readSnapshot(db,'one'), next = structuredClone(snapshot.state);
  next.leads[0].stage = 'new';
  assert.equal(await validateSalesWrite(snapshot.state,next,db,readSnapshot,now),'');
  await syncLeadCopies(db,snapshot.state,next,owner.name,now);
  assert.equal((await readSnapshot(db,'two')).state.leads[0].stage,'new');
  assert.equal(sql.prepare('SELECT status FROM lead_inbox WHERE id=?').get(old.id)!.status,'new');
  const afterEdit = structuredClone(next); afterEdit.leads[0].notes = 'Новый комментарий';
  await validateSalesWrite(next,afterEdit,db,readSnapshot,'2026-12-03T10:00:00Z');
  assert.equal(afterEdit.leads[0].stageEnteredAt,now);
});

test('handoff retains two distinct people, individual assignment and historical route facts', () => {
  assert.deepEqual(qualificationBlockers(applicant),[]);
  assert.ok(qualificationBlockers({ ...applicant, qualification: {} }).length);
  const target = createLeadProjectState(workspace('source'),applicant,{ id:'target',code:'H-003' },owner.name,now);
  assert.equal(target.project.leadOwner,'Агент'); assert.equal(target.project.projectManager,'Руководитель');
  assert.equal(stepOwner(target,'brief'),'Агент'); assert.equal(stepOwner(target,'ppr'),'Руководитель');
  target.project.lifecycle!.items.find(row=>row.key==='ppr')!.owner='Планировщик';
  assert.equal(stepOwner(target,'ppr'),'Планировщик');
  const old = { ...target.project.lifecycle!, version:1 as const, items:[{ key:'funding', status:'done' as const, owner:'Финансист', required:true, basis:'Согласовано', documentIds:['original'] }] };
  const migrated = migrateLifecycle(old)!;
  assert.equal(migrated.version,2); assert.deepEqual(migrated.previousItems,old.items);
  assert.equal(migrated.items.find(row=>row.key==='estimate')?.status,'pending');
  assert.deepEqual(migrateLifecycle(migrated),migrated);
});

test('saved project milestones update the source lead; bank funds alone do not complete escrow with maternity capital', async () => {
  const { db, put } = database();
  let target = createLeadProjectState(workspace('source'),applicant,{id:'target',code:'H-003'},owner.name,now);
  const source = workspace('source'); source.leads = [structuredClone(target.leads[0])]; put(source);
  const stages = [['estimate','estimate'],['commercial','negotiation'],['contract','won']] as const;
  for (const [key,stage] of stages) {
    const next = structuredClone(target);
    next.project.lifecycle!.primaryFunding='Кредит'; next.project.lifecycle!.reserveFunding='Средства партнёра';
    next.documents = [{id:'contract',name:'Договор',category:'contract',status:'signed',fileKey:'target/agreement',type:'PDF',updatedAt:now,clientVisible:false}];
    next.project.lifecycle!.items.find(item=>item.key===key)!.status='done';
    assert.equal(validateLifecycleChanges(target,next,owner,now),'');
    assert.equal(await validateSalesWrite(target,next,db,readSnapshot,now),'');
    await syncLeadCopies(db,target,next,owner.name,now);
    assert.equal((await readSnapshot(db,'source')).state.leads[0].stage,stage);
    target = next;
  }
  const next = structuredClone(target);
  next.project.lifecycle!.usesEscrow='yes';
  next.project.lifecycle!.items.find(item=>item.key==='escrow')!.status='done';
  next.project.funding={ route:'escrow', bank:'Банк', escrowAccountReference:'номер', changeReason:'Выписка',
    escrow:{planned:{ amountCents:100000,bankAmountCents:80000,maternityAmountCents:10000,date:'2026-11-24',source:'Договор' },
      deposited:{amountCents:100000,bankAmountCents:80000,date:'2026-11-25',source:'Выписка'} }};
  assert.match(escrowFundingBlockers(next).join(' '),/маткапитала/);
  assert.notEqual(await validateSalesWrite(target,structuredClone(next),db,readSnapshot,now),'');
  next.project.funding.escrow!.deposited!.maternityAmountCents=10000;
  assert.deepEqual(escrowFundingBlockers(next),[]);
  assert.equal(validateProjectFundingChanges(target,structuredClone(next),owner,now),'');
  assert.equal(validateLifecycleChanges(target,next,owner,now),'');
  assert.equal(await validateSalesWrite(target,next,db,readSnapshot,now),'');
  await syncLeadCopies(db,target,next,owner.name,now);
  assert.equal((await readSnapshot(db,'source')).state.leads[0].stage,'escrow_funded');
  const planning=structuredClone(next);
  planning.project.lifecycle!.items.find(item=>item.key==='ppr')!.status='done';
  assert.equal(validateLifecycleChanges(next,planning,owner,now),'');
  assert.equal(await validateSalesWrite(next,planning,db,readSnapshot,now),'');
  assert.equal(planning.leads[0].stage,'escrow_funded');
});
