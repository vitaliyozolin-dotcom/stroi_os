import test from 'node:test';
import assert from 'node:assert/strict';
import { seedState } from '../src/seed.ts';
import { createLifecycle, createLeadProjectState, leadProjectIdentity, leadHandoffBlockers, constructionLaunchBlockers, validateLifecycleChanges, lifecycleGroupProgress, lifecycleItemBlockers } from '../src/domain/project-lifecycle.js';
import { createLeadPreparationHandler } from '../sites/leads/preparation.js';
import { stateForRole } from '../sites/access-control.js';
import type { Lead } from '../src/entities/index';
const now = '2026-11-17T19:00:00.000Z';
const owner = { role: 'management' as const, name: 'Owner' };
const lead: Lead = { id: 'lead-1', name: 'Client', phone: '+79990000000', createdAt: now, source: 'manual', stage: 'negotiation', owner: 'Manager', nextAction: 'Prepare', region: 'Рощино', budget: 7000000, landStatus: 'owned', mortgageStatus: 'approved', qualification: { approvedLoan: 5600000, downPayment: 1400000, bank: 'Bank', address: 'Рощино, участок 7' } };
const fixture = () => { const s = structuredClone(seedState); s.project.id = 'source'; s.project.code = 'H-002'; s.leads = [structuredClone(lead)]; return s; };

test('lead conversion keeps client money out of internal budget, transfers qualification and creates stage0', async () => {
  const source = fixture(); const identity = await leadProjectIdentity(lead.id);
  const target = createLeadProjectState(source, lead, identity, owner.name, now);
  assert.equal(target.project.name, 'Рощино');
  assert.equal(target.project.contractValue, 0); assert.equal(target.project.targetCost, 0);
  assert.ok(target.project.unknownFields?.includes('targetCost'));
  assert.deepEqual(target.budgetLines, []); assert.deepEqual(target.financeEntries, []);
  assert.equal(target.project.lifecycle?.phase, 'preparation');
  assert.equal(target.leads[0].qualification?.approvedLoan, 5600000);
  assert.deepEqual(await leadProjectIdentity(lead.id), identity);
  assert.equal(validateLifecycleChanges(null, target, owner, now), '');
  assert.ok(constructionLaunchBlockers(target).length > 0);
});

test('qualification requires only critical handoff data and allows searching for a plot', () => {
  assert.deepEqual(leadHandoffBlockers({ ...lead, landStatus: 'searching', qualification: {} }), []);
  assert.ok(leadHandoffBlockers({ ...lead, budget: undefined }).some(message => /бюджет/.test(message)));
  assert.ok(leadHandoffBlockers({ ...lead, mortgageStatus: 'unknown' }).length);
});

test('stage0 cannot be removed, bypassed by legacy flag, or made complete by contract price', () => {
  const before = fixture(); before.project.lifecycle = createLifecycle(now);
  let next = structuredClone(before); delete next.project.lifecycle;
  assert.match(validateLifecycleChanges(before, next, owner, now), /удалить/);
  next = structuredClone(before); next.project.lifecycle!.legacyReview = true;
  assert.match(validateLifecycleChanges(before, next, owner, now), /неизменяемы/);
  next = structuredClone(before); next.project.contractValue = 9500000;
  next.project.lifecycle!.items.find(item => item.key === 'estimate')!.status = 'done';
  assert.match(validateLifecycleChanges(before, next, owner, now), /себестоимости/);
  next = structuredClone(before); next.project.lifecycle!.items.find(item => item.key === 'contract')!.required = false;
  assert.match(validateLifecycleChanges(before, next, owner, now), /отключить/);
});

test('unchanged lifecycle still blocks raw stage start, and legacy projects retain operation', () => {
  const before = fixture(); before.project.lifecycle = createLifecycle(now);
  before.stages[0].status = 'ready'; delete before.stages[0].actualStart;
  const next = structuredClone(before); next.stages[0].status = 'in_progress'; next.stages[0].actualStart = '2026-11-17';
  assert.match(validateLifecycleChanges(before, next, owner, now), /Не завершён этап 0/);
  delete before.project.lifecycle; delete next.project.lifecycle;
  assert.equal(validateLifecycleChanges(before, next, owner, now), '');
});

test('escrow applicability changes counts, unknown state remains a blocker, client cannot read details', () => {
  const state = fixture(); state.project.lifecycle = createLifecycle(now);
  const unknown = lifecycleGroupProgress(state).total;
  state.project.lifecycle.usesEscrow = 'no';
  assert.equal(lifecycleGroupProgress(state).total, unknown - 1);
  assert.equal(stateForRole(state, {role:'client',id:'client'}).project.lifecycle, undefined);
  assert.equal(stateForRole(state, {role:'foreman',id:'foreman'}).project.lifecycle, undefined);
});

test('project cannot close from preparation, and non-management cannot modify checklist', () => {
  const before = fixture(); before.project.lifecycle = createLifecycle(now);
  let next = structuredClone(before); next.project.lifecycle!.phase = 'closed';
  assert.match(validateLifecycleChanges(before, next, owner, now), /последовательности/);
  next = structuredClone(before); next.project.lifecycle!.usesEscrow = 'no';
  assert.match(validateLifecycleChanges(before, next, { role:'foreman',name:'Foreman' }, now), /управление/);
});

function storeFixture() {
  const snapshots = new Map<string, any>([['source', { state: fixture(), revision: 1 }]]);
  const audits: any[] = [];
  const db: any = {
    prepare(sql: string) { return { sql, values: [] as any[], bind(...values: any[]) { this.values = values; return this; }, async all() { return {results:[...snapshots.values()].map(row=>({state_json:JSON.stringify(row.state)}))}; } }; },
    async batch(statements: any[]) { return statements.map(statement => {
      if (/INTO project_state/.test(statement.sql)) { const [id, text] = statement.values; if(snapshots.has(id)) return {changes:0}; snapshots.set(id,{state:JSON.parse(text),revision:1}); return {changes:1}; }
      if (/UPDATE project_state/.test(statement.sql)) { const [text, revision, , , , id, expected] = statement.values; if (snapshots.get(id)?.revision !== expected) return { changes: 0 }; snapshots.set(id,{state:JSON.parse(text),revision}); return {changes:1}; }
      audits.push(statement.values); return {changes:1};
    }); },
    async financialTransaction(work: any) { return work(db); },
  };
  const handler = createLeadPreparationHandler({ ensureSchema: async()=>{}, readSnapshot: async (_db: any,id:string)=>snapshots.get(id) ?? null });
  const request = (email='owner@test.invalid', expectedLead=JSON.stringify(lead)) => new Request('https://app.test/api/leads/prepare',{method:'POST',headers:{'Content-Type':'application/json','oai-authenticated-user-email':email},body:JSON.stringify({sourceProjectId:'source',leadId:lead.id,expectedLead})});
  return {snapshots,audits,handler,request,env:{DB:db,OWNER_EMAIL:'owner@test.invalid',OWNER_NAME:'Owner'}};
}

test('handoff API creates exactly one target and audit, reuses numeric codes and survives a repeated request', async () => {
  const f = storeFixture();
  const first = await f.handler(f.request(),f.env); assert.equal(first.status,201); const body = await first.json();
  assert.equal(body.project.code,'H-003'); assert.equal(f.snapshots.size,2); assert.equal(f.audits.length,2);
  const second = await f.handler(f.request(),f.env); assert.equal(second.status,200); const again=await second.json();
  assert.equal(again.project.id,body.project.id); assert.equal(again.created,false); assert.equal(f.snapshots.size,2); assert.equal(f.audits.length,2);
  assert.equal(f.snapshots.get('source').state.leads[0].stage,'preparation');
});

test('handoff API rejects unauthorized caller and stale source without creating project', async () => {
  const f = storeFixture();
  assert.equal((await f.handler(f.request('other@test.invalid'),f.env)).status,403);
  assert.equal((await f.handler(f.request('owner@test.invalid','stale'),f.env)).status,409);
  assert.equal(f.snapshots.size,1); assert.equal(f.audits.length,0);
});

test('raw inserted stage, historical completion, acceptance and order completion cannot bypass stage0', () => {
  const before = fixture(); before.project.lifecycle = createLifecycle(now); before.stages = [];
  for (const status of ['in_progress','awaiting_inspection','accepted','rework'] as const) {
    const next = structuredClone(before); next.stages = [{ ...seedState.stages[0], id: 'new-stage', status }];
    assert.match(validateLifecycleChanges(before, next, owner, now), /Не завершён этап 0/);
  }
  const next = structuredClone(before); next.project.status = 'completed';
  assert.match(validateLifecycleChanges(before, next, owner, now), /Закрытие заказа/);
});
test('handoff rejects source collision and preserves canonical object references without duplicating files', async () => {
  const f = storeFixture(); const target = await leadProjectIdentity(lead.id);
  const foreign = createLeadProjectState({ ...fixture(), project: {...fixture().project,id:'other-source'} },lead,target,owner.name,now);
  f.snapshots.set(target.id,{state:foreign,revision:1});
  assert.equal((await f.handler(f.request(),f.env)).status,409);
  const state = createLeadProjectState(fixture(),lead,target,owner.name,now);
  assert.ok(state.orderRelations); assert.deepEqual(state.documents,[]);
});

test('complete preparation can launch construction and treats bank escrow separately from contractor cash', () => {
  const before = fixture(); before.project.lifecycle = createLifecycle(now);
  const next = structuredClone(before); const route = next.project.lifecycle!; route.usesEscrow = 'no'; route.scope = 'turnkey'; next.project.address = 'Рощино, участок 7';
  next.budgetMeta.estimateKind = 'internal_cost';
  next.documents = [{id:'estimate',name:'Смета',category:'specification',fileKey:'source/estimate',type:'PDF',status:'current',updatedAt:now,clientVisible:false},{id:'contract',name:'Договор',category:'contract',fileKey:'source/contract',type:'PDF',status:'signed',updatedAt:now,clientVisible:false}];
  next.stages = [{...next.stages[0],status:'ready',planStart:'2026-11-20',planEnd:'2026-12-20',actualStart:undefined,completedOn:undefined}];
  next.financeEntries = [{...seedState.financeEntries[0],id:'need',kind:'expense',stageId:next.stages[0].id,amount:100000,date:'2026-11-19',dueDate:'2026-11-19'}];
  next.project.funding = {route:'direct',changeReason:'Проверено',contractor:{kind:'own',confirmed:true,amountCents:10000000,date:'2026-11-19',source:'Выписка',documentId:'estimate'}};
  for(const item of route.items.filter(item=>!['customer_acceptance','handover_docs','registration','bank_release','settlement','escrow'].includes(item.key))) { item.status='done';item.basis='Результат подтверждён';item.documentIds=[item.key==='contract'?'contract':'estimate']; }
  assert.deepEqual(constructionLaunchBlockers(next),[]);
  route.phase = 'construction';
  assert.equal(validateLifecycleChanges(before,next,owner,now),'');
  next.project.funding.route='escrow';
  assert.ok(constructionLaunchBlockers(next).includes('Схема финансирования требует эскроу'));
});
test('contract demands signed contract category and PPR demands dated outgoing needs', () => {
  const state = fixture(); state.project.lifecycle = createLifecycle(now);
  const item=state.project.lifecycle.items.find(item=>item.key==='contract')!; item.basis='Подписано';item.documentIds=['invoice'];
  state.documents=[{id:'invoice',name:'Счёт',category:'invoice',fileKey:'source/invoice',type:'PDF',status:'signed',updatedAt:now,clientVisible:false}];
  assert.ok(lifecycleItemBlockers(state,'contract').some(message=>message.includes('подписанный договор')));
  state.financeEntries=[]; state.treasury={...state.treasury!,cashPlans:[{id:'income',name:'Доход',kind:'income',category:'other',amountCents:100000,date:'2026-12-01',certainty:'expected',source:'Клиент'}]};
  assert.ok(lifecycleItemBlockers(state,'ppr').some(message=>message.includes('расходный план')));
});
