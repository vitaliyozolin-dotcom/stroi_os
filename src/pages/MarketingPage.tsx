import { useModuleRepository } from '../useModuleRepository';
import { createSalesRepository } from '../infrastructure/module-project';
import { leadSnapshot, marketingStages as stageOrder, marketingStageLabels as stageLabels, marketingSourceLabels as sourceLabels } from '../domain/marketing';
import { requestApi } from '../infrastructure/api-http';
import { createMarketingUseCases } from '../application';
import { runtimeIdGenerator, systemClock } from '../infrastructure/runtime';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  BadgeRussianRuble,
  CalendarClock,
  CheckCircle2,
  CircleUserRound,
  Filter,
  Globe2,
  Phone,
  Plus,
  Target,
  UsersRound,
} from 'lucide-react';
import { formatDateTime, money, shortMoney } from '../presentation/formatting';
import type { AppState, Lead, LeadSource, LeadStage, UserRole } from '../entities/index';
import { Field, MetricCard, Modal, SectionHeader, StatusBadge } from '../components/Ui';

const landLabels: Record<NonNullable<Lead['landStatus']>, string> = {
  unknown: 'Не уточнено',
  owned: 'Участок есть',
  searching: 'Подбирает участок',
  reserved: 'Участок забронирован',
};
const mortgageLabels: Record<NonNullable<Lead['mortgageStatus']>, string> = {
  unknown: 'Не уточнено',
  not_needed: 'Без ипотеки',
  needed: 'Нужна ипотека',
  approved: 'Ипотека одобрена',
};

const stageTone = (stage: LeadStage): 'neutral' | 'positive' | 'warning' | 'danger' | 'blue' => {
  if (stage === 'won') return 'positive';
  if (stage === 'lost') return 'danger';
  if (stage === 'estimate' || stage === 'negotiation') return 'blue';
  if (stage === 'new') return 'warning';
  return 'neutral';
};

export function MarketingPage({ state, actor, role, focusId, onChange }: { state: AppState; actor: string; role: UserRole; focusId?: string | null; onChange: (next: AppState) => void }) {
  const marketing = createMarketingUseCases(useModuleRepository(createSalesRepository, state, onChange), { name: actor, role }, systemClock, runtimeIdGenerator);
  const latest = useRef(marketing); latest.current = marketing;
  const [commandError, setCommandError] = useState('');
  const [importError, setImportError] = useState('');
  const [importAttempt, setImportAttempt] = useState(0);
  const [draftProjectId, setDraftProjectId] = useState(state.project.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [stageFilter, setStageFilter] = useState<LeadStage | 'all'>('all');
  const [form, setForm] = useState({ name: '', phone: '', email: '', source: 'manual' as LeadSource, budget: '', houseArea: '', region: '', landStatus: 'unknown' as NonNullable<Lead['landStatus']>, mortgageStatus: 'unknown' as NonNullable<Lead['mortgageStatus']>, nextAction: 'Позвонить и квалифицировать заявку', nextActionAt: '', owner: actor, notes: '' });

  useEffect(() => {
    const controller = new AbortController();
    const projectId = state.project.id;
    setImportError('');
    void requestApi('/api/leads?projectId=ikioma-sales', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Заявки сайта временно недоступны.');
      const body: unknown = await response.json();
      if (controller.signal.aborted) return;
      const result = latest.current.execute({ action: 'import', projectId, response: body });
      if (!result.ok) setImportError(result.error);
    }).catch(() => { if (!controller.signal.aborted) setImportError('Не удалось загрузить заявки сайта. Повторите попытку.'); });
    return () => controller.abort();
  }, [state.project.id, importAttempt]);

  useEffect(() => {
    if (focusId && state.leads.some((lead) => lead.id === focusId)) setSelectedId(focusId);
  }, [focusId, state.leads]);

  const visible = useMemo(() => state.leads
    .filter((lead) => stageFilter === 'all' || lead.stage === stageFilter)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [stageFilter, state.leads]);
  const active = state.leads.filter((lead) => !['won', 'lost'].includes(lead.stage));
  const won = state.leads.filter((lead) => lead.stage === 'won');
  const pipeline = active.reduce((sum, lead) => sum + (lead.budget ?? 0), 0);
  const conversion = state.leads.length ? Math.round(won.length / state.leads.length * 100) : 0;
  const selected = state.leads.find((lead) => lead.id === selectedId) ?? null;

  const addLead = (event: FormEvent) => {
    event.preventDefault();
    const result = marketing.execute({ action: 'create', projectId: draftProjectId, draft: { ...form, budget: form.budget.trim() ? Number(form.budget) : undefined, houseArea: form.houseArea.trim() ? Number(form.houseArea) : undefined } });
    if (!result.ok) { setCommandError(result.error); return; }
    setCommandError('');
    setShowForm(false);
    setForm({ ...form, name: '', phone: '', email: '', budget: '', houseArea: '', region: '', notes: '' });
  };

  const updateLead = (leadId: string, patch: Pick<Lead, 'landStatus' | 'mortgageStatus'> & { stage?: LeadStage }) => {
    const result = marketing.execute(patch.stage ? { action: 'stage', leadId, stage: patch.stage, expected: leadSnapshot(state, leadId) } : { action: 'qualify', leadId, patch, expected: leadSnapshot(state, leadId) });
    setCommandError(result.ok ? '' : result.error);
  };
  const advanceLead = (lead: Lead) => {
    const result = marketing.execute({ action: 'stage', leadId: lead.id, expected: leadSnapshot(state, lead.id) });
    setCommandError(result.ok ? '' : result.error);
  };

  return (
    <div className="page-stack">
      {importError && <p role="alert">{importError} <button type="button" onClick={() => setImportAttempt(value => value + 1)}>Повторить загрузку заявок</button></p>}
      {commandError && !showForm && !selected && <p role="alert">{commandError}</p>}
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Продажи и спрос</span>
          <h1>Маркетинг и воронка</h1>
          <p>От первого обращения до договора и запуска дома. Источник, следующий шаг и потенциальная выручка видны в одном месте.</p>
        </div>
        <button type="button" className="button button--primary" onClick={() => { setDraftProjectId(state.project.id); setCommandError(''); setShowForm(true); }}><Plus size={18} /> Добавить заявку</button>
      </section>

      <section className="metric-grid">
        <MetricCard label="Новые заявки" value={`${state.leads.filter((lead) => lead.stage === 'new').length}`} detail={<span>требуют первичного контакта</span>} icon={UsersRound} onClick={() => setStageFilter('new')} />
        <MetricCard label="Активная воронка" value={shortMoney(pipeline)} detail={<span>{active.length} потенциальных проектов</span>} icon={BadgeRussianRuble} onClick={() => setStageFilter('all')} />
        <MetricCard label="Договоры" value={`${won.length}`} detail={<span>{shortMoney(won.reduce((sum, lead) => sum + (lead.budget ?? 0), 0))} подтверждено</span>} icon={CheckCircle2} tone="positive" onClick={() => setStageFilter('won')} />
        <MetricCard label="Конверсия в договор" value={`${conversion}%`} detail={<span>по всем заведённым обращениям</span>} icon={Target} tone="dark" onClick={() => setStageFilter('won')} />
      </section>

      <section className="panel marketing-funnel-panel">
        <SectionHeader eyebrow="Сквозной путь" title="Воронка заявок" action={<button type="button" className="text-button" onClick={() => setStageFilter('all')}><Filter size={15} /> Сбросить фильтр</button>} />
        <div className="marketing-funnel">
          {stageOrder.filter((stage) => stage !== 'lost').map((stage, index) => {
            const leads = state.leads.filter((lead) => lead.stage === stage);
            return (
              <button type="button" className={stageFilter === stage ? 'marketing-funnel__step marketing-funnel__step--active' : 'marketing-funnel__step'} key={stage} onClick={() => setStageFilter(stage)}>
                <span>{index + 1}</span><div><strong>{stageLabels[stage]}</strong><small>{leads.length} · {shortMoney(leads.reduce((sum, lead) => sum + (lead.budget ?? 0), 0))}</small></div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel leads-panel">
        <SectionHeader eyebrow="CRM" title={stageFilter === 'all' ? 'Все обращения' : stageLabels[stageFilter]} action={<span className="count-badge">{visible.length}</span>} />
        <div className="lead-list">
          {visible.map((lead) => (
            <button type="button" className="lead-row" key={lead.id} onClick={() => setSelectedId(lead.id)}>
              <span className="lead-row__avatar"><CircleUserRound size={20} /></span>
              <div className="lead-row__main"><strong>{lead.name}</strong><small>{lead.phone} · {sourceLabels[lead.source]}{lead.region ? ` · ${lead.region}` : ''}</small><small>Поступила: {formatDateTime(lead.createdAt)}</small></div>
              <span><StatusBadge label={stageLabels[lead.stage]} tone={stageTone(lead.stage)} /></span>
              <div className="lead-row__next"><small>Следующее действие</small><strong>{lead.nextAction}</strong>{lead.nextActionAt && <span><CalendarClock size={13} /> {formatDateTime(lead.nextActionAt)}</span>}</div>
              <strong className="lead-row__budget">{lead.budget ? money(lead.budget) : 'Бюджет не указан'}</strong>
              <ArrowRight size={18} />
            </button>
          ))}
          {!visible.length && <div className="table-empty">На этом этапе заявок пока нет.</div>}
        </div>
      </section>

      {showForm && (
        <Modal title="Новая заявка" subtitle="Заявка сразу попадёт в общую воронку и будет сохранена в облаке." onClose={() => setShowForm(false)}>
          <form className="modal-form" onSubmit={addLead}>{commandError && <p role="alert" className="form-warning">{commandError}</p>}
            <div className="form-grid"><Field label="Имя клиента"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field><Field label="Телефон"><input required value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="+7 999 000-00-00" /></Field></div>
            <div className="form-grid"><Field label="Email"><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field><Field label="Источник"><select value={form.source} onChange={(event) => setForm({ ...form, source: event.target.value as LeadSource })}>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field></div>
            <div className="form-grid form-grid--three"><Field label="Бюджет, ₽"><input type="number" min="0" value={form.budget} onChange={(event) => setForm({ ...form, budget: event.target.value })} /></Field><Field label="Площадь, м²"><input type="number" min="0" value={form.houseArea} onChange={(event) => setForm({ ...form, houseArea: event.target.value })} /></Field><Field label="Район"><input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} /></Field></div>
            <div className="form-grid"><Field label="Земельный участок"><select value={form.landStatus} onChange={(event) => setForm({ ...form, landStatus: event.target.value as NonNullable<Lead['landStatus']> })}>{Object.entries(landLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field><Field label="Финансирование"><select value={form.mortgageStatus} onChange={(event) => setForm({ ...form, mortgageStatus: event.target.value as NonNullable<Lead['mortgageStatus']> })}>{Object.entries(mortgageLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></Field></div>
            <div className="form-grid"><Field label="Следующее действие"><input value={form.nextAction} onChange={(event) => setForm({ ...form, nextAction: event.target.value })} /></Field><Field label="Когда"><input type="datetime-local" value={form.nextActionAt} onChange={(event) => setForm({ ...form, nextActionAt: event.target.value })} /></Field></div>
            <Field label="Ответственный"><select value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })}>{state.settings.users.filter((user) => user.status === 'active' && user.role === 'management').map((user) => <option value={user.name} key={user.id}>{user.name}</option>)}</select></Field>
            <Field label="Комментарий"><textarea rows={3} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} /></Field>
            <div className="modal__actions"><button type="button" className="button button--ghost" onClick={() => setShowForm(false)}>Отмена</button><button type="submit" className="button button--primary"><Plus size={17} /> Создать заявку</button></div>
          </form>
        </Modal>
      )}

      {selected && (
        <Modal wide title={selected.name} subtitle={`${sourceLabels[selected.source]} · создана ${formatDateTime(selected.createdAt)}`} onClose={() => setSelectedId(null)}>
          {commandError && <p role="alert" className="form-warning">{commandError}</p>}<div className="entity-detail-grid">
            <section className="entity-detail-card"><small>Контакт</small><strong><Phone size={16} /> {selected.phone}</strong><span>{selected.email ?? 'Email не указан'}</span></section>
            <section className="entity-detail-card"><small>Параметры дома</small><strong>{selected.houseArea ? `${selected.houseArea} м²` : 'Площадь не указана'}</strong><span>{selected.region ?? 'Район не указан'}</span></section>
            <section className="entity-detail-card"><small>Потенциал</small><strong>{selected.budget ? money(selected.budget) : 'Не оценён'}</strong><span>Ответственный: {selected.owner}</span></section>
            <section className="entity-detail-card entity-detail-card--editable"><small>Земельный участок</small><select aria-label="Статус земельного участка" value={selected.landStatus ?? 'unknown'} onChange={(event) => updateLead(selected.id, { landStatus: event.target.value as NonNullable<Lead['landStatus']> })}>{Object.entries(landLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span>Можно уточнить прямо в карточке</span></section>
            <section className="entity-detail-card entity-detail-card--editable"><small>Ипотека</small><select aria-label="Статус ипотеки" value={selected.mortgageStatus ?? 'unknown'} onChange={(event) => updateLead(selected.id, { mortgageStatus: event.target.value as NonNullable<Lead['mortgageStatus']> })}>{Object.entries(mortgageLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span>Нужна ли помощь с одобрением</span></section>
          </div>
          <div className="entity-detail-section"><span className="eyebrow">Текущий этап</span><div className="stage-choice">{stageOrder.map((stage) => <button type="button" key={stage} className={selected.stage === stage ? 'active' : ''} onClick={() => updateLead(selected.id, { stage })}>{stageLabels[stage]}</button>)}</div></div>
          <div className="entity-detail-section"><span className="eyebrow">Следующий шаг</span><h3>{selected.nextAction}</h3><p>{selected.nextActionAt ? formatDateTime(selected.nextActionAt) : 'Срок не задан'} · {selected.notes ?? 'Комментариев пока нет'}</p></div>
          <div className="modal__actions"><button type="button" className="button button--secondary" onClick={() => window.location.href = `tel:${selected.phone.replace(/\s/g, '')}`}><Phone size={17} /> Позвонить</button>{!['won', 'lost'].includes(selected.stage) && <button type="button" className="button button--primary" onClick={() => advanceLead(selected)}>Следующий этап <ArrowRight size={17} /></button>}</div>
        </Modal>
      )}
    </div>
  );
}
