import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDisplayName, constructionLocation, withProjectLocationName } from '../src/domain/project-naming.js';
import { renameProjectFromLocation } from '../src/application/project-naming.ts';
import { createDraftOrderState, seedState } from '../src/seed.ts';
import { createLeadProjectState } from '../src/domain/project-lifecycle.js';
const address = 'Ленинградская область, Выборгский район, Рощинское городское поселение, посёлок Цвелодубово, проезд Светлый, земельный участок 7';
const project = { ...seedState.project, id: 'house-existing', code: 'H-002', name: 'Ипотечник1', address, status: 'active' as const };

test('project name comes from settlement while full postal address stays untouched', () => {
 assert.equal(projectDisplayName(project), 'Цвелодубово');
 assert.equal(projectDisplayName({...project,address:'Ленинградская область, д. Келози, участок 9'}), 'Келози');
 assert.equal(projectDisplayName({...project,address:'Рощино, ул. Лесная, участок 10'}), 'Рощино');
 assert.equal(projectDisplayName({...project,address:'Ленинградская область Выборгский район поселок Цвелодубово проезд Светлый участок 7'}),'Цвелодубово');
 assert.equal(projectDisplayName({...project,address:''}), 'Место уточняется');
 assert.equal(projectDisplayName({...project,status:'workspace',name:'ИКИОМА ОС',address:''}),'ИКИОМА ОС');
 assert.equal(constructionLocation(address).detail,'проезд Светлый, земельный участок 7');
 assert.equal(project.address,address);
});
test('same-place projects use street/plot only on collision and code only for identical locations', () => {
 const other={...project,id:'house-other',code:'H-003',address:address.replace('участок 7','участок 8')};
 assert.equal(projectDisplayName(project,[project]),'Цвелодубово');
 assert.equal(projectDisplayName(project,[project,other]),'Цвелодубово · проезд Светлый, земельный участок 7');
 assert.equal(projectDisplayName(project,[{...other,address}]),'Цвелодубово · проезд Светлый, земельный участок 7 · H-002');
});
test('explicit rename preserves ID, code, previous alias and all project history; repeat is no-op', () => {
 const state=structuredClone(seedState);state.project=project;
 state.activity=[{id:'old',timestamp:'2026-11-17',actor:'Owner',text:'Старое событие Ипотечник1',tone:'neutral'}];
 const result=renameProjectFromLocation(state,{name:'Owner',role:'management'},'2026-11-18T12:00:00Z');
 assert.ok(result.ok);if(!result.ok)return;
 assert.equal(result.state.project.name,'Цвелодубово');assert.equal(result.state.project.id,project.id);assert.equal(result.state.project.code,'H-002');
 assert.deepEqual(result.state.project.nameAliases,['Ипотечник1']);assert.equal(result.state.project.address,address);
 assert.deepEqual(result.state.activity.slice(1),state.activity);assert.deepEqual(result.state.documents,state.documents);
 assert.equal(state.project.name,'Ипотечник1');
 assert.equal(withProjectLocationName(result.state.project),result.state.project);
 assert.equal(renameProjectFromLocation(state,{name:'Foreman',role:'foreman'},'2026-11-18').ok,false);
});
test('manual draft and CRM creation share naming without copying source identity', () => {
 const draft=createDraftOrderState(seedState,{code:'H-008',name:'Чужое рабочее название',address,actor:'Owner'});
 assert.equal(draft.project.name,'Цвелодубово');assert.deepEqual(draft.project.nameAliases,['Чужое рабочее название']);
 assert.equal(draft.project.code,'H-008');assert.notEqual(draft.project.id,seedState.project.id);
 const lead={id:'lead1',name:'Клиент',phone:'+700000',createdAt:'2026-11-18',source:'manual' as const,stage:'negotiation' as const,nextAction:'Передать',owner:'Owner',qualification:{address}};
 const created=createLeadProjectState(seedState,lead,{id:'lead-stable',code:'H-009'},'Owner','2026-11-18');
 assert.equal(created.project.name,'Цвелодубово');assert.equal(created.project.id,'lead-stable');assert.equal(created.project.code,'H-009');
 assert.equal(created.project.address,address);
});
