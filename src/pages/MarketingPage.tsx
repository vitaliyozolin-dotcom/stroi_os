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
import { formatDateTime, money, shortMoney, uid } from '../domain';
import type { AppState, Lead, LeadSource, LeadStage } from '../entities/index';
import { Field, MetricCard, Modal, SectionHeader, StatusBadge } from '../components/Ui';

const stageOrder: LeadStage[] = ['new', 'qualified', 'site_visit', 'estimate', 'negotiation', 'won', 'lost'];
const stageLabels: Record<LeadStage, string> = {
  new: 'Новая',
  qualified: 'Квалификация',
  site_visit: 'Выезд',
  estimate: 'Смета',
  negotiation: 'Переговоры',
  won: 'Договор',
  lost: 'Отказ',
};
const sourceLabels: Record<LeadSource, string> = {
  website: 'Сайт',
  avito: 'Авито',
  domclick: 'Домклик',
  referral: 'Рекомендация',
  telegram: 'Telegram',
  manual: 'Вручную',
};
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

export function MarketingPage({ state, actor, focusId, onChange }: { state: AppState; actor: string; focusId?: string | null; onChange: (next: AppState) => void }) {
  const importedProjects = useRef(new Set<string>());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [stageFilter, setStageFilter] = useState<LeadStage | 'all'>('all');
  const [form, setForm] = useState({ name: '', phone: '', email: '', source: 'manual' as LeadSource, budget: '', houseArea: '', region: '', landStatus: 'unknown' as NonNullable<Lead['landStatus']>, mortgageStatus: 'unknown' as NonNullable<Lead['mortgageStatus']>, nextAction: 'Позвонить и квалифицировать заявку', nextActionAt: '', owner: actor, notes: '' });

  useEffect(() => {
    if (importedProjects.current.has(state.project.id)) return;
    importedProjects.current.add(state.project.id);
    void fetch('/api/leads?projectId=ikioma-sales', { cache: 'no-store' }).then((response) => response.json()).then((body: { leads?: Array<{ id: string; created_at: string; name: string; phone: string; email?: string; source?: string; message?: string }> }) => {
      const incoming = (body.leads ?? []).filter((item) => !state.leads.some((lead) => lead.id === item.id)).map((item): Lead => ({ id: item.id, createdAt: item.created_at, name: item.name, phone: item.phone, email: item.email || undefined, source: (Object.hasOwn(sourceLabels, item.source ?? '') ? item.source : 'website') as LeadSource, stage: 'new', nextAction: 'Позвонить и квалифицировать заявку', owner: actor, notes: item.message || undefined }));
      if (!incoming.length) return;
      onChange({ ...state, leads: [...incoming, ...state.leads], activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor: 'ИКИОМА ОС', text: `Из формы сайта получено заявок: ${incoming.length}`, tone: 'neutral' }, ...state.activity] });
    }).catch(() => undefined);
  }, [state.project.id]);

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
    if (!form.name.trim() || !form.phone.trim()) return;
    const lead: Lead = {
      id: uid('lead'),
      createdAt: new Date().toISOString(),
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      source: form.source,
      stage: 'new',
      budget: Number(form.budget) || undefined,
      houseArea: Number(form.houseArea) || undefined,
      region: form.region.trim() || undefined,
      landStatus: form.landStatus,
      mortgageStatus: form.mortgageStatus,
      nextAction: form.nextAction.trim() || 'Позвонить и квалифицировать заявку',
      nextActionAt: form.nextActionAt || undefined,
      owner: form.owner.trim() || actor,
      notes: form.notes.trim() || undefined,
    };
    onChange({
      ...state,
      leads: [lead, ...state.leads],
      activity: [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: `Новая заявка: ${lead.name} · ${sourceLabels[lead.source]}`, tone: 'neutral' }, ...state.activity],
    });
    setShowForm(false);
    setForm({ ...form, name: '', phone: '', email: '', budget: '', houseArea: '', region: '', notes: '' });
  };

  const updateLead = (leadId: string, patch: Partial<Lead>, eventText?: string) => {
    const current = state.leads.find((lead) => lead.id === leadId);
    if (!current) return;
    onChange({
      ...state,
      leads: state.leads.map((lead) => lead.id === leadId ? { ...lead, ...patch } : lead),
      activity: eventText ? [{ id: uid('activity'), timestamp: new Date().toISOString(), actor, text: eventText, tone: patch.stage === 'won' ? 'positive' : 'neutral' }, ...state.activity] : state.activity,
    });
  };

  const advanceLead = (lead: Lead) => {
    const currentIndex = stageOrder.indexOf(lead.stage);
    const nextStage = stageOrder[Math.min(currentIndex + 1, stageOrder.indexOf('won'))];
    if (nextStage === lead.stage || lead.stage === 'lost') return;
    updateLead(lead.id, { stage: nextStage }, `${lead.name}: этап «${stageLabels[nextStage]}»`);
  };

  return (
    <div className="page-stack">
      <section className="page-title-row">
        <div>
          <span className="eyebrow">Продажи и спрос</span>
          <h1>Маркетинг и воронка</h1>
          <p>От первого обращения до договора и запуска дома. Источник, следующий шаг и потенциальная выручка видны в одном месте.</p>
        </div>
        <button type="button" className="button button--primary" onClick={() => setShowForm(true)}><Plus size={18} /> Добавить заявку</button>
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
          <form className="modal-form" onSubmit={addLead}>
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
          <div className="entity-detail-grid">
            <section className="entity-detail-card"><small>Контакт</small><strong><Phone size={16} /> {selected.phone}</strong><span>{selected.email ?? 'Email не указан'}</span></section>
            <section className="entity-detail-card"><small>Параметры дома</small><strong>{selected.houseArea ? `${selected.houseArea} м²` : 'Площадь не указана'}</strong><span>{selected.region ?? 'Район не указан'}</span></section>
            <section className="entity-detail-card"><small>Потенциал</small><strong>{selected.budget ? money(selected.budget) : 'Не оценён'}</strong><span>Ответственный: {selected.owner}</span></section>
            <section className="entity-detail-card entity-detail-card--editable"><small>Земельный участок</small><select aria-label="Статус земельного участка" value={selected.landStatus ?? 'unknown'} onChange={(event) => updateLead(selected.id, { landStatus: event.target.value as NonNullable<Lead['landStatus']> }, `${selected.name}: уточнён статус участка`)}>{Object.entries(landLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span>Можно уточнить прямо в карточке</span></section>
            <section className="entity-detail-card entity-detail-card--editable"><small>Ипотека</small><select aria-label="Статус ипотеки" value={selected.mortgageStatus ?? 'unknown'} onChange={(event) => updateLead(selected.id, { mortgageStatus: event.target.value as NonNullable<Lead['mortgageStatus']> }, `${selected.name}: уточнено финансирование`)}>{Object.entries(mortgageLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><span>Нужна ли помощь с одобрением</span></section>
          </div>
          <div className="entity-detail-section"><span className="eyebrow">Текущий этап</span><div className="stage-choice">{stageOrder.map((stage) => <button type="button" key={stage} className={selected.stage === stage ? 'active' : ''} onClick={() => updateLead(selected.id, { stage }, `${selected.name}: этап «${stageLabels[stage]}»`)}>{stageLabels[stage]}</button>)}</div></div>
          <div className="entity-detail-section"><span className="eyebrow">Следующий шаг</span><h3>{selected.nextAction}</h3><p>{selected.nextActionAt ? formatDateTime(selected.nextActionAt) : 'Срок не задан'} · {selected.notes ?? 'Комментариев пока нет'}</p></div>
          <div className="modal__actions"><button type="button" className="button button--secondary" onClick={() => window.location.href = `tel:${selected.phone.replace(/\s/g, '')}`}><Phone size={17} /> Позвонить</button>{!['won', 'lost'].includes(selected.stage) && <button type="button" className="button button--primary" onClick={() => advanceLead(selected)}>Следующий этап <ArrowRight size={17} /></button>}</div>
        </Modal>
      )}
    </div>
  );
}
