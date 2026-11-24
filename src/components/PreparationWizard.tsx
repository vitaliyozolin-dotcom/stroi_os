import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Check, ChevronDown, FileCheck2, ListChecks, Plus } from 'lucide-react';
import type { AppState, LifecycleItem, ProjectLifecycle, UserRole } from '../entities/index';
import { constructionLaunchBlockers, createLifecycle, lifecycleDefinitions, lifecycleGroupProgress, lifecycleItemBlockers, lifecyclePhaseLabels, validateLifecycleChanges } from '../domain/project-lifecycle.js';
import { Field } from './Ui';
import { workspacePath } from '../presentation/navigation';
import './preparation-wizard.css';

export function PreparationWizard({ state, actor, role, onChange, defaultExpanded = false, initialStep = 'brief' }: { state: AppState; actor: string; role: UserRole; onChange: (next: AppState) => void; defaultExpanded?: boolean; initialStep?: string }) {
  const lifecycle = state.project.lifecycle;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [selected, setSelected] = useState(initialStep);
  const [error, setError] = useState('');
  const current = lifecycle?.items.find(item => item.key === selected);
  const [draft, setDraft] = useState<LifecycleItem | null>(current ?? null);
  useEffect(() => { setDraft(current ? structuredClone(current) : null); setError(''); }, [current, selected]);
  useEffect(() => { if (lifecycle && ['handover', 'closed', 'warranty'].includes(lifecycle.phase) && !lifecycleDefinitions.some(def => def.key === selected && def.group === 'handover')) setSelected('customer_acceptance'); }, [lifecycle?.phase, selected]);
  if (role !== 'management') return null;
  const commit = (nextLifecycle: ProjectLifecycle) => {
    const next = { ...state, project: { ...state.project, lifecycle: structuredClone(nextLifecycle) } };
    const message = validateLifecycleChanges(state, next, { name: actor, role });
    if (message) { setError(message); return false; }
    onChange(next); setError(''); return true;
  };
  if (!lifecycle) return <section className="panel preparation-start"><div><span className="eyebrow">Путь объекта</span><h2>Подготовка, стройка, сдача</h2><p>Добавьте маршрут, чтобы видеть обязательные результаты и следующий шаг.</p></div><button className="button button--secondary" type="button" onClick={() => {
    const legacyReview = state.stages.some(stage => ['in_progress', 'accepted', 'awaiting_inspection', 'rework'].includes(stage.status));
    commit(createLifecycle(new Date().toISOString(), { legacyReview })); setExpanded(true);
  }}><Plus size={16} /> Добавить маршрут</button>{error && <p role="alert">{error}</p>}</section>;
  const group = ['handover', 'closed', 'warranty'].includes(lifecycle.phase) ? 'handover' : 'preparation';
  const progress = lifecycleGroupProgress(state, group);
  const definitions = lifecycleDefinitions.filter(def => def.group === group && !(def.escrow && lifecycle.usesEscrow === 'no'));
  const nextKey = progress.pending[0];
  const activeDef = definitions.find(def => def.key === selected) ?? definitions.find(def => def.key === nextKey) ?? definitions[0];
  const launchBlockers = constructionLaunchBlockers(state);
  const beginEdit = (key: string) => { setSelected(key); setDraft(structuredClone(lifecycle.items.find(item => item.key === key)!)); setExpanded(true); };
  const phaseNext: Partial<Record<ProjectLifecycle['phase'], ProjectLifecycle['phase']>> = { preparation: 'construction', construction: 'handover', handover: 'closed', closed: 'warranty' };
  const phaseButton = { preparation: 'Допустить к строительству', construction: 'Перейти к сдаче', handover: 'Закрыть проект', closed: 'Гарантийное сопровождение', warranty: '' };
  return <section className="panel preparation-wizard">
    <header className="preparation-header"><div><span className="eyebrow">{state.project.code} · Путь проекта</span><h2>{lifecyclePhaseLabels[lifecycle.phase]}</h2><p>{nextKey ? `Следующий результат: ${lifecycleDefinitions.find(def => def.key === nextKey)?.title}` : 'Обязательные результаты этой части маршрута подтверждены.'}</p></div><div className="preparation-count"><strong>{progress.completed}<span> / {progress.total}</span></strong><small>подтверждено</small></div></header>
    {!!lifecycle.sourceDocumentIds?.length && lifecycle.sourceProjectId && <p className="preparation-note"><Link to={workspacePath(lifecycle.sourceProjectId, 'project')}>Открыть исходные документы обращения ({lifecycle.sourceDocumentIds.length})</Link> · оригиналы сохранены в исходном заказе</p>}
    <div className="preparation-track" aria-label={`${progress.completed} из ${progress.total} результатов подтверждено`}><span style={{ width: `${progress.total ? progress.completed / progress.total * 100 : 0}%` }} /></div>
    {lifecycle.legacyReview && <p className="preparation-note">Сверка действующего объекта: новые пункты подготовки не останавливают уже начатые работы.</p>}
    <div className="preparation-actions"><button type="button" className="button button--primary" onClick={() => beginEdit(nextKey ?? definitions[0].key)}><ListChecks size={17} /> {nextKey ? 'Следующий шаг' : 'Проверить результаты'}</button><button type="button" className="text-button" onClick={() => setExpanded(value => !value)}><ChevronDown size={16} /> {expanded ? 'Свернуть' : 'Все подэтапы'}</button>{phaseNext[lifecycle.phase] && <button type="button" className="button button--secondary" onClick={() => commit({ ...lifecycle, phase: phaseNext[lifecycle.phase]! })}>{phaseButton[lifecycle.phase]} <ArrowRight size={16} /></button>}</div>
    {error && <p className="form-warning" role="alert">{error}</p>}
    {expanded && <div className="preparation-body">
      <div className="preparation-settings form-grid"><Field label="Комплектация"><select value={lifecycle.scope} onChange={e => commit({ ...lifecycle, scope: e.target.value as ProjectLifecycle['scope'] })}><option value="unknown">Не уточнена</option><option value="warm_shell">Тёплый контур</option><option value="engineering">С инженерией</option><option value="turnkey">Под ключ</option><option value="custom">Индивидуальная</option></select></Field><Field label="Используем эскроу?"><select value={lifecycle.usesEscrow} onChange={e => commit({ ...lifecycle, usesEscrow: e.target.value as ProjectLifecycle['usesEscrow'] })}><option value="unknown">Нужно уточнить</option><option value="yes">Да</option><option value="no">Нет</option></select></Field></div>
      <nav className="preparation-steps" aria-label="Подэтапы проекта">{definitions.map(def => { const item = lifecycle.items.find(row => row.key === def.key)!; return <button type="button" key={def.key} className={selected === def.key ? 'active' : ''} onClick={() => beginEdit(def.key)}><span>{item.status === 'done' ? <Check size={15} /> : def.number}</span><strong>{def.title}</strong><small>{item.status === 'done' ? 'Подтверждено' : item.status === 'not_applicable' ? 'Не применяется' : item.owner || def.role}</small></button>; })}</nav>
      {draft && activeDef?.key === draft.key && <div className="preparation-question"><span className="eyebrow">Подэтап {activeDef.number}</span><h3>{activeDef.question}</h3><div className="form-grid"><Field label="Ответственный"><select value={draft.owner ?? ''} onChange={e => setDraft({ ...draft, owner: e.target.value })}><option value="">Назначить</option>{state.settings.users.filter(user => user.status === 'active' && user.role !== 'client').map(user => <option key={user.id} value={user.name}>{user.name}</option>)}</select></Field><Field label="Обязательность"><select value={draft.required ? 'required' : 'optional'} disabled={activeDef.locked} onChange={e => setDraft({ ...draft, required: e.target.value === 'required' })}><option value="required">Обязательный результат</option><option value="optional">Дополнительный результат</option></select></Field></div>
        <div className="form-grid"><Field label="Начало подэтапа"><input type="date" value={draft.planStart ?? ''} onChange={e => setDraft({ ...draft, planStart: e.target.value })} /></Field><Field label="Срок подэтапа"><input type="date" value={draft.planEnd ?? ''} onChange={e => setDraft({ ...draft, planEnd: e.target.value })} /></Field></div>
        <Field label="Основание / что подтверждено"><textarea rows={2} value={draft.basis} placeholder="Результат, источник и существенные условия" onChange={e => setDraft({ ...draft, basis: e.target.value })} /></Field>
        <Field label={activeDef.documents ? 'Подтверждающие документы' : 'Документы, если нужны'}><div className="preparation-documents">{state.documents.filter(doc => doc.fileKey).map(doc => <label key={doc.id}><input type="checkbox" checked={draft.documentIds.includes(doc.id)} onChange={e => setDraft({ ...draft, documentIds: e.target.checked ? [...draft.documentIds, doc.id] : draft.documentIds.filter(id => id !== doc.id) })} />{doc.name}</label>)}{!state.documents.some(doc => doc.fileKey) && <span>Оригиналы пока не приложены. Добавьте их в документах проекта.</span>}</div></Field>
        <details><summary>Условия подтверждения</summary><ul>{lifecycleItemBlockers({ ...state, project: { ...state.project, lifecycle: { ...lifecycle, items: lifecycle.items.map(item => item.key === draft.key ? draft : item) } } }, draft.key).map((message, index) => <li key={index}>{message}</li>)}</ul><Link to={workspacePath(state.project.id, draft.key === 'ppr' ? 'schedule' : draft.key === 'estimate' || draft.key === 'funding' ? 'finance' : 'project')}>Открыть связанные сведения</Link></details>
        <p><strong>Подтверждаешь выполнение: {activeDef.title.toLocaleLowerCase('ru')}?</strong></p>
        <div className="preparation-actions"><button type="button" className="button button--primary" onClick={() => commit({ ...lifecycle, items: lifecycle.items.map(item => item.key === draft.key ? { ...draft, status: 'done' } : item) })}><FileCheck2 size={16} /> Подтверждаю</button><button type="button" className="button button--secondary" onClick={() => commit({ ...lifecycle, items: lifecycle.items.map(item => item.key === draft.key ? { ...draft, status: 'pending' } : item) })}>Ещё не выполнено · сохранить</button>{!activeDef.locked && <button type="button" className="text-button" onClick={() => commit({ ...lifecycle, items: lifecycle.items.map(item => item.key === draft.key ? { ...draft, status: 'not_applicable' } : item) })}>Не применяется</button>}</div>
      </div>}
      {lifecycle.phase === 'preparation' && launchBlockers.length > 0 && <p className="preparation-note">До запуска: {launchBlockers.join(' · ')}</p>}
    </div>}
  </section>;
}
