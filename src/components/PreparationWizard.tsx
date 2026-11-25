import { Link } from 'react-router';
import { workspacePath } from '../presentation/navigation';
import { PersonField } from './ProjectAssignments';
import { escrowFundingBlockers } from '../domain/sales-workflow.js';
import { useState } from 'react';
import { ArrowRight, Check, ChevronDown, Plus } from 'lucide-react';
import type { AppState, LifecycleItem, ProjectLifecycle, UserRole } from '../entities/index';
import { constructionLaunchBlockers, createLifecycle, lifecycleDefinitions, lifecycleItemBlockers, stepOwner, lifecycleGroupProgress, lifecyclePhaseLabels, validateLifecycleChanges } from '../domain/project-lifecycle.js';
import './preparation-wizard.css';

const phaseNext = { preparation: 'construction', construction: 'handover', handover: 'closed', closed: 'warranty' } as const;
const phaseButton = { preparation: 'Допустить к строительству', construction: 'Перейти к сдаче', handover: 'Закрыть проект', closed: 'Гарантийное сопровождение' } as const;

export function PreparationWizard({ state, actor, role, onChange, defaultExpanded = false, initialStep, embedded = false }: { state: AppState; actor: string; role: UserRole; onChange: (next: AppState) => void; defaultExpanded?: boolean; initialStep?: string; embedded?: boolean }) {
  const lifecycle = state.project.lifecycle;
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [assignee, setAssignee] = useState('');
  const [primary, setPrimary] = useState('');
  const [reserve, setReserve] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState('');
  if (role !== 'management') return null;

  const commit = (nextLifecycle: ProjectLifecycle) => {
    const next = { ...state, project: { ...state.project, lifecycle: structuredClone(nextLifecycle) } };
    const message = validateLifecycleChanges(state, next, { name: actor, role });
    setError(message);
    if (message) return false;
    onChange(next);
    return true;
  };
  if (!lifecycle) return <section className="panel preparation-start">
    <h2>Маршрут проекта</h2>
    <button className="button button--secondary" type="button" onClick={() => {
      const legacyReview = state.stages.some(stage => ['in_progress', 'accepted', 'awaiting_inspection', 'rework'].includes(stage.status));
      if (commit(createLifecycle(new Date().toISOString(), { legacyReview }))) setExpanded(true);
    }}><Plus size={16} /> Добавить маршрут</button>
    {error && <p role="alert">{error}</p>}
  </section>;

  const { phase } = lifecycle;
  const group = ['handover', 'closed', 'warranty'].includes(phase) ? 'handover' : 'preparation';
  const progress = lifecycleGroupProgress(state, group);
  const definitions = lifecycleDefinitions.filter(def => def.group === group && !(def.escrow && lifecycle.usesEscrow === 'no'));
  const nextPhase = phase === 'warranty' ? undefined : phaseNext[phase];
  const canAdvance = phase === 'preparation' ? constructionLaunchBlockers(state).length === 0
    : phase === 'construction' ? state.stages.length > 0 && state.stages.every(stage => stage.status === 'accepted')
    : phase === 'handover' ? progress.pending.length === 0 : true;
  const canReopen = phase === 'preparation' || phase === 'handover';
  const people = state.settings.users.filter(user => user.status === 'active' && user.role !== 'client').map(user => user.name);
  const open = (item: LifecycleItem) => {
    setError(''); setOpenStep(item.key);
    setAssignee(item.owner || ''); setComment(item.basis);
    setPrimary(lifecycle.primaryFunding || ''); setReserve(lifecycle.reserveFunding || '');
  };
  const mark = (item: LifecycleItem, status = item.status) => {
    const editing = openStep === item.key;
    const nextItem = { ...item, status, ...(editing ? { basis: comment.trim(), owner: assignee.trim() } : {}) };
    const usesEscrow = item.key === 'escrow' && status === 'done' && lifecycle.usesEscrow === 'unknown' ? 'yes' : lifecycle.usesEscrow;
    if (!editing && status === 'done' && (item.key === 'estimate' && (!lifecycle.primaryFunding || !lifecycle.reserveFunding) || item.key === 'escrow' && escrowFundingBlockers(state).length || item.key === 'contract' && lifecycle.sourceLeadId && lifecycleItemBlockers(state, 'contract').length)) {
      open(item); return;
    }
    if (commit({ ...lifecycle, usesEscrow, ...(editing && item.key === 'estimate' ? { primaryFunding: primary.trim(), reserveFunding: reserve.trim() } : {}), items: lifecycle.items.map(row => row.key === item.key ? nextItem : row) })) setOpenStep(null);
  };

  return <section className={embedded ? 'preparation-wizard preparation-wizard--embedded' : 'panel preparation-wizard'}>
    <header className="preparation-header">
      {!embedded && <h2>{lifecyclePhaseLabels[phase]}</h2>}
      <span>{progress.completed} из {progress.total} выполнено</span>
      {!embedded && <button type="button" className="text-button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded}>Подэтапы <ChevronDown size={16} /></button>}
    </header>
    {error && <p className="form-warning" role="alert">{error}</p>}
    {expanded && <ul className="preparation-steps" aria-label="Подэтапы проекта">
      {definitions.map(def => {
        const item = lifecycle.items.find(row => row.key === def.key);
        if (!item) return null;
        const done = item.status === 'done';
        const editing = openStep === item.key;
        const notApplicable = item.status === 'not_applicable';
        return <li key={item.key} className="preparation-step" data-current={initialStep === item.key && !done}>
          <div className="preparation-step__row">
            <button type="button" className="preparation-step__title" aria-expanded={editing} onClick={() => editing ? setOpenStep(null) : open(item)}>
              <span>{def.number}</span><span className="preparation-step__caption"><strong>{done && def.key !== 'ppr' ? def.result : def.title}</strong><small>{stepOwner(state, item.key) || 'Ответственный не назначен'}</small></span><ChevronDown size={14} aria-hidden="true" />
            </button>
            {done ? <span className="preparation-step__done"><Check size={16} /> Выполнено</span>
              : notApplicable ? <span className="preparation-step__done">Не применяется</span>
              : <button type="button" className="button button--secondary" aria-label={`Готово: ${def.title}`} onClick={() => mark(item, 'done')}>Готово</button>}
          </div>
          {editing && <div className="preparation-step__details modal-form">
            <p>{done && def.key !== 'ppr' ? def.title : def.result}</p>
            <PersonField label="Ответственный за подэтап" value={assignee} people={people} onChange={setAssignee} />
            {item.key === 'estimate' && <div className="form-grid">
              <label className="field">Основные источники финансирования<input maxLength={1000} value={primary} onChange={event => setPrimary(event.target.value)} /></label>
              <label className="field">Резервные источники финансирования<input maxLength={1000} value={reserve} onChange={event => setReserve(event.target.value)} /></label>
            </div>}
            {item.key === 'contract' && lifecycle.sourceLeadId && <Link className="text-button" to={workspacePath(state.project.id, 'project') + '#project-documents'}>Документы и подписанный договор</Link>}
            {item.key === 'ppr' && <div className="stage-quick__actions"><Link className="text-button" to={workspacePath(state.project.id, 'schedule')}>Открыть ППР</Link><Link className="text-button" to={workspacePath(state.project.id, 'finance')}>Открыть график финансирования</Link></div>}
            {item.key === 'escrow' && <div>{escrowFundingBlockers(state).map(text => <p key={text}>{text}</p>)}<Link className="text-button" to={workspacePath(state.project.id, 'finance')}>Открыть подтверждения финансирования</Link></div>}
            <label className="field">Комментарий (необязательно)<input maxLength={3000} value={comment} onChange={event => setComment(event.target.value)} /></label>
            <button type="button" className="text-button" onClick={() => mark(item)}>Сохранить изменения</button>
            {(done || notApplicable) && canReopen && <button className="text-button" type="button" onClick={() => mark(item, 'pending')}>Вернуть в работу</button>}
          </div>}
        </li>;
      })}
    </ul>}
    {expanded && state.project.funding?.route !== 'escrow' && phase === 'preparation' && <details className="preparation-settings">
      <summary>Настройки этапа</summary>
      <label>Используем эскроу? <select value={lifecycle.usesEscrow} onChange={event => commit({ ...lifecycle, usesEscrow: event.target.value as ProjectLifecycle['usesEscrow'] })}><option value="unknown">Нужно уточнить</option><option value="yes">Да</option><option value="no">Нет</option></select></label>
    </details>}
    {nextPhase && canAdvance && <button type="button" className="button button--primary" onClick={() => commit({ ...lifecycle, phase: nextPhase })}>{phaseButton[phase as keyof typeof phaseButton]} <ArrowRight size={16} /></button>}
  </section>;
}
