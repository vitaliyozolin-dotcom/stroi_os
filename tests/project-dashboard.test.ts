import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectScheduleDashboard } from '../src/domain/project-dashboard.js';

test('contract variance is available without a baseline', () => {
  const state: any = { project: { targetDate: '2027-03-31' }, stages: [] };
  const forecast: any = { kind: 'estimated', end: '2027-05-20', rows: [] };
  assert.equal(projectScheduleDashboard(state, forecast, '2026-11-17').contractDelta, 50);
});
test('unknown observed completion date never invents exact contract variance', () => {
  const state: any = { project: { targetDate: '2027-03-31' }, stages: [{ id:'a',order:1,name:'Фундамент',status:'accepted',progress:100 }] };
  const forecast: any = { kind:'observed',end:'2027-05-20',rows:[{id:'a',start:'2027-05-20',end:'2027-05-20'}] };
  const view = projectScheduleDashboard(state, forecast, '2027-05-20');
  assert.equal(view.contractDelta,null);
  assert.equal(view.rows[0].end,null);
});
test('parallel work bars share the date axis rather than adding their durations', () => {
  const state: any = { project:{targetDate:'2027-01-20'},stages:[{id:'a',name:'A',order:1,status:'in_progress',progress:20},{id:'b',name:'B',order:2,status:'ready',progress:0}] };
  const forecast: any = {kind:'confirmed',end:'2027-01-20',rows:[{id:'a',start:'2027-01-01',end:'2027-01-20'},{id:'b',start:'2027-01-01',end:'2027-01-10'}]};
  const view=projectScheduleDashboard(state,forecast,'2027-01-05');
  assert.equal(view.rows[0].left,view.rows[1].left);
  assert.ok(view.rows[1].width < view.rows[0].width);
  assert.equal(view.contractDelta,0);
});
