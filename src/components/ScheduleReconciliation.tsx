import { useState, type FormEvent } from 'react';
import type { AppState, Stage, StageSchedule, StageSiteUpdate, UserRole } from '../entities/index';
import type { StageAction } from '../application/stage-control';
import { addScheduleDays, confirmedSiteUpdate, forecastSchedule, schedulePayload, sitePayload } from '../../sites/lib/schedule-forecast.js';
import { planToday, validPlanDate } from '../../sites/lib/plan-baseline.js';
import { formatDate } from '../presentation/formatting';
import { stageStatusLabel } from '../presentation/status-labels';
import { Field, Modal } from './Ui';
import { StageControlModal } from './StageControlModal';

type Props = { state: AppState; role: UserRole; actor: string; userId?: string; initialId?: string; onChange: (state: AppState) => void; onClose: () => void };
const reviewSource = (stage: Stage) => JSON.stringify([sitePayload(stage.siteUpdate), schedulePayload(stage.schedule), stage.status, stage.blocker, stage.actualStart, stage.completedOn, stage.actualEnd, stage.acceptedAt]);
export function ScheduleReconciliation(props: Props) {
  const [id, setId] = useState(props.initialId || props.state.stages[0]?.id || '');
  const [action, setAction] = useState<StageAction | null>(null);
  const stage = props.state.stages.find((s) => s.id === id);
  const view = forecastSchedule(props.state);
  if (action && stage) return <StageControlModal {...props} stageId={id} action={action} onClose={() => setAction(null)} />;
  return <Modal title="Сверка ППР и состояния работ" subtitle="Исходные сроки и записи сохраняются. Сверяем структуру, затем факты и оставшуюся работу." onClose={props.onClose}>
    <div className="schedule-review">
      <Field label="Строка исходного ППР"><select value={id} onChange={(e) => setId(e.target.value)}>{props.state.stages.map((s) => <option key={s.id} value={s.id}>{s.name}{view.issues.some((i) => i.stageId === s.id) ? ' · нужна сверка' : ''}</option>)}</select></Field>
      {stage ? <RowReview key={stage.id} {...props} stage={stage} onAction={setAction} /> : <p>Сначала добавьте строки ППР.</p>}
    </div>
  </Modal>;
}

function RowReview({ state, stage, role, actor, userId, onChange, onAction }: Props & { stage: Stage; onAction: (action: StageAction) => void }) {
  const previous = state.stages.find((s) => s.id === stage.dependencyId || !stage.dependencyId && [s.name, s.shortName].includes(stage.dependency || ''));
  const [structure, setStructure] = useState<StageSchedule>(() => stage.schedule ? structuredClone(stage.schedule) : {
    kind: 'work', phase: '', summaryOf: [], dependencies: previous ? [{ stageId: previous.id, gate: 'accepted', lagDays: 0 }] : [],
    calendar: 'daily', daysOff: [], crew: '', reporterId: '',
  });
  const [daysOff, setDaysOff] = useState(structure.daysOff.join(', '));
  const [checked, setChecked] = useState(false), [message, setMessage] = useState('');
  const [structureBase, setStructureBase] = useState(() => JSON.stringify(schedulePayload(stage.schedule)));
  const [reviewBase, setReviewBase] = useState(() => reviewSource(stage));
  const [form, setForm] = useState<StageSiteUpdate>(() => ({
    asOf: planToday(), reviewOn: '', remainingDays: null, readyOn: '', acceptanceOn: '', note: '', nextAction: '', issueOwner: '',
    ...sitePayload(stage.siteUpdate),
  }));
  const manager = role === 'management', allowed = manager || role === 'foreman' && Boolean(userId && userId === stage.schedule?.reporterId);
  const finished = ['accepted', 'awaiting_inspection'].includes(stage.status), summary = stage.schedule?.kind === 'summary';
  const today = planToday(), fresh = confirmedSiteUpdate(stage, today);
  const changedElsewhere = structureBase !== JSON.stringify(schedulePayload(stage.schedule)) || reviewBase !== reviewSource(stage);
  const patchStructure = (patch: Partial<StageSchedule>) => { setStructure({ ...structure, ...patch }); setChecked(false); setMessage(''); };
  const patchForm = (patch: Partial<StageSiteUpdate>) => { setForm({ ...form, ...patch }); setMessage(''); };
  const saveStructure = (event: FormEvent) => {
    event.preventDefault();
    if (!checked || !manager) return;
    if (structureBase !== JSON.stringify(schedulePayload(stage.schedule))) { setMessage('Структура изменилась, пока форма была открыта. Загрузите свежую запись перед сохранением.'); return; }
    const next = structuredClone(state), row = next.stages.find((s) => s.id === stage.id)!;
    // No server stamps are authored here. A changed structure invalidates the
    // old site confirmation until the assigned person checks it again.
    row.schedule = { ...schedulePayload(structure)!, phase: structure.phase.trim(), crew: structure.crew.trim(), daysOff: daysOff.split(/[\s,;]+/).filter(Boolean) };
    setStructureBase(JSON.stringify(schedulePayload(row.schedule)));
    if (reviewBase === reviewSource(stage)) setReviewBase(reviewSource(row));
    onChange(next); setChecked(false); setMessage('Структура передана на сохранение. Затем подтвердите состояние и остаток.');
  };
  const saveReview = (event: FormEvent) => {
    event.preventDefault();
    if (!allowed || !stage.schedule) return;
    if (reviewBase !== reviewSource(stage)) { setMessage('Состояние работы изменилось, пока форма была открыта. Загрузите свежую запись и проверьте остаток.'); return; }
    const next = structuredClone(state), row = next.stages.find((s) => s.id === stage.id)!;
    row.siteUpdate = { ...sitePayload(form)!, note: form.note.trim(), remainingDays: finished || summary ? null : form.remainingDays, requestId: crypto.randomUUID() };
    setReviewBase(reviewSource(row));
    onChange(next); setMessage('Сверка передана на сохранение. Подтверждение и автор появятся после ответа сервера.');
  };
  const dependency = (id: string, selected: boolean) => patchStructure({ dependencies: selected ? [...structure.dependencies, { stageId: id, gate: 'completed', lagDays: 0 }] : structure.dependencies.filter((d) => d.stageId !== id) });
  const workRows = state.stages.filter((s) => s.id !== stage.id && s.schedule?.kind !== 'summary');
  const reporter = state.settings.users.find((u) => u.id === stage.schedule?.reporterId);
  const reload = () => {
    const latest = stage.schedule ? structuredClone(stage.schedule) : { ...structure, updatedAt: undefined, updatedBy: undefined };
    setStructure(latest); setDaysOff(latest.daysOff.join(', ')); setStructureBase(JSON.stringify(schedulePayload(stage.schedule)));
    setForm({ asOf: today, reviewOn: '', remainingDays: null, readyOn: '', acceptanceOn: '', note: '', nextAction: '', issueOwner: '', ...sitePayload(stage.siteUpdate) });
    setReviewBase(reviewSource(stage)); setChecked(false); setMessage('Загружена текущая запись. Незавершённый ввод этой формы заменён.');
  };
  return <>
    {changedElsewhere && <div className="blocker-note"><p>Запись обновилась, пока форма была открыта. Незавершённый ввод сохранён на экране, но не перезапишет свежие сведения.</p><button type="button" className="button button--secondary" onClick={reload}>Загрузить свежую запись и заменить ввод</button></div>}
    <div className="schedule-review__status"><strong>{stageStatusLabel[stage.status]}</strong><span>План 0: {stage.baseline?.end ? formatDate(stage.baseline.end) : 'дата неизвестна'} · текущий план: {formatDate(stage.planEnd)}</span>{stage.completedOn && <span>Выполнено: {formatDate(stage.completedOn)}{stage.status === 'awaiting_inspection' ? ' · приёмка впереди' : ''}</span>}{stage.blocker && <p className="blocker-note">Мешает: {stage.blocker}</p>}</div>
    <details open={!stage.schedule} className="schedule-review__section"><summary>1. Структура ППР · {stage.schedule?.updatedAt ? 'сверена управлением' : 'требует подтверждения'}</summary>
      {manager ? <form className="modal-form" onSubmit={saveStructure}>
        <p className="muted">Названия и даты исходного ППР не меняются. Крупный этап объединяет работы и поставки, например «Фундамент». Сводная строка — уже имеющийся в ППР итог по вложенным строкам, без собственной длительности.</p>
        <div className="schedule-review__grid">
          <Field label="Тип строки"><select value={structure.kind} onChange={(e) => patchStructure({ kind: e.target.value as StageSchedule['kind'], summaryOf: [], dependencies: [] })}><option value="work">Работа</option><option value="supply">Поставка</option><option value="control">Контроль / мероприятие</option><option value="summary">Сводная строка</option></select></Field>
          <Field label="Крупный этап строительства"><input required maxLength={100} value={structure.phase} list="schedule-phases" onChange={(e) => patchStructure({ phase: e.target.value })} placeholder="Например, фундамент" /><datalist id="schedule-phases">{[...new Set(state.stages.map((s) => s.schedule?.phase).filter(Boolean))].map((phase) => <option key={phase} value={phase} />)}</datalist></Field>
        </div>
        {structure.kind === 'summary' ? <fieldset className="schedule-review__choices"><legend>Какие строки входят в этот итог</legend>{workRows.map((s) => <label className="stage-check" key={s.id}><input type="checkbox" checked={structure.summaryOf.includes(s.id)} onChange={(e) => patchStructure({ summaryOf: e.target.checked ? [...structure.summaryOf, s.id] : structure.summaryOf.filter((id) => id !== s.id) })} /><span>{s.name}</span></label>)}</fieldset> : <>
          <div className="schedule-review__grid"><Field label="Рабочий календарь"><select value={structure.calendar} onChange={(e) => patchStructure({ calendar: e.target.value as StageSchedule['calendar'] })}><option value="daily">Каждый день</option><option value="weekdays">Понедельник — пятница</option><option value="six-day">Понедельник — суббота</option></select></Field><Field label="Бригада / ресурс"><input required={structure.kind === 'work'} maxLength={100} value={structure.crew} onChange={(e) => patchStructure({ crew: e.target.value })} placeholder="Одинаковое имя = одна бригада" /></Field></div>
          <Field label="Дополнительные нерабочие дни"><textarea rows={2} value={daysOff} onChange={(e) => { setDaysOff(e.target.value); setChecked(false); }} placeholder="2026-09-15, 2026-09-16" /><small>Праздники автоматически не добавляются. Даты: ГГГГ-ММ-ДД через запятую.</small></Field>
          <details><summary>Предшественники · {structure.dependencies.length ? structure.dependencies.length : 'независимая работа'}</summary><p className="muted">Следующий рабочий день после выполнения или приёмки. Лаг — дополнительные календарные дни ожидания. Уже идущие параллельно работы не связывайте последовательно без основания.</p>{stage.dependency && !stage.schedule && <p className="muted">Старая запись: {stage.dependency}. {previous ? 'Предложенная связь требует проверки.' : 'Не удалось сопоставить: выберите предшественника явно.'}</p>}
            {state.stages.filter((s) => s.id !== stage.id).map((s) => {
              const d = structure.dependencies.find((item) => item.stageId === s.id);
              return <div className="schedule-review__dependency" key={s.id}><label className="stage-check"><input type="checkbox" checked={Boolean(d)} onChange={(e) => dependency(s.id, e.target.checked)} /><span>{s.name}</span></label>{d && <div className="schedule-review__grid"><Field label="Условие старта"><select value={d.gate} onChange={(e) => patchStructure({ dependencies: structure.dependencies.map((item) => item.stageId === s.id ? { ...item, gate: e.target.value as 'completed' | 'accepted' } : item) })}><option value="completed">После выполнения</option><option value="accepted">После приёмки</option></select></Field><Field label="Лаг, календарных дней"><input required type="number" min={0} max={365} value={d.lagDays} onChange={(e) => patchStructure({ dependencies: structure.dependencies.map((item) => item.stageId === s.id ? { ...item, lagDays: Number(e.target.value) } : item) })} /></Field></div>}</div>;
            })}
          </details>
        </>}
        <Field label="Кто подтверждает состояние"><select value={structure.reporterId} onChange={(e) => patchStructure({ reporterId: e.target.value })}><option value="">Только управление</option>{state.settings.users.filter((u) => u.status === 'active' && u.role !== 'client').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <label className="stage-check"><input required type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /><span>Подтверждаю состав, связи, календарь и ресурс. Пустой список связей означает независимый старт.</span></label>
        <button className="button button--secondary" type="submit">Сохранить структуру</button>
      </form> : <p>Структуру сверяет управление. Назначенный сотрудник: {reporter?.name || 'управление'}.</p>}
    </details>
    {!summary && <section className="schedule-review__section"><h3>2. Что с работой?</h3><p className="muted">Выполнение и приёмка — отдельные действия. Соседние работы, задачи и расходы сами не закрываются.</p>
      {allowed && stage.status !== 'accepted' && <div className="stage-radar__actions">
        {!finished && <><button className="button button--primary" type="button" onClick={() => onAction('complete')}>Выполнена</button><button className="button button--secondary" type="button" onClick={() => onAction('start')}>Идёт / началась</button>{!stage.actualStart && ['not_ready', 'ready', 'blocked'].includes(stage.status) && <button className="button button--ghost" type="button" onClick={() => onAction('not_started')}>Ещё не началась</button>}<button className="button button--ghost" type="button" onClick={() => onAction('delay')}>Есть задержка</button></>}
        {stage.status === 'awaiting_inspection' && manager && <><button className="button button--primary" type="button" onClick={() => onAction('accept')}>Принять работу</button><button className="button button--ghost" type="button" onClick={() => onAction('rework')}>На доработку</button></>}
      </div>}
      {!allowed && <p>Обновляет {reporter?.name || 'управление'}. Вашей роли доступен просмотр.</p>}
    </section>}
    {manager && finished && (!validPlanDate(stage.completedOn || stage.actualEnd) || stage.status === 'accepted' && !stage.acceptedAt) && <FactRecovery state={state} stage={stage} onChange={onChange} />}
    {stage.schedule && allowed && <section className="schedule-review__section"><h3>{summary ? '2. Ожидаемая приёмка сводной строки' : '3. Подтвердить оставшуюся работу'}</h3>
      <p className="muted">Срез — на конец указанного дня. Остаток начинается со следующего доступного рабочего дня. Проверка — не реже раза в 7 календарных дней, при задержке раньше. Это оценка исполнителя, не новый согласованный план.</p>
      <form className="modal-form" onSubmit={saveReview}>
        <div className="schedule-review__grid"><Field label="Состояние на конец дня"><input required type="date" min={addScheduleDays(today, -7)} max={today} value={form.asOf} onChange={(e) => patchForm({ asOf: e.target.value })} /></Field><Field label="Проверить сведения не позже"><input required type="date" min={today} max={addScheduleDays(form.asOf || today, 7)} value={form.reviewOn} onChange={(e) => patchForm({ reviewOn: e.target.value })} /></Field></div>
        <div className="schedule-review__grid">{!finished && !summary && <Field label="Осталось рабочих дней"><input required type="number" min={1} max={730} step={1} value={form.remainingDays ?? ''} onChange={(e) => patchForm({ remainingDays: e.target.value ? Number(e.target.value) : null })} /></Field>}<Field label={finished || summary ? 'Готовность к следующему действию' : 'Работа / ресурс доступны с'}><input required type="date" value={form.readyOn} onChange={(e) => patchForm({ readyOn: e.target.value })} /><small>Не раньше этой даты, с учётом всех указанных связей.</small></Field></div>
        <Field label="Ожидаемая приёмка, если нужна для следующих работ"><input type="date" min={today} value={form.acceptanceOn} onChange={(e) => patchForm({ acceptanceOn: e.target.value })} /></Field>
        <Field label="На чём основано подтверждение"><textarea required maxLength={2000} value={form.note} onChange={(e) => patchForm({ note: e.target.value })} placeholder="Что проверили на объекте, оставшийся объём, акт или ссылка" /></Field>
        <Field label="Ближайшее действие"><input required={Boolean(stage.blocker)} maxLength={1000} value={form.nextAction} onChange={(e) => patchForm({ nextAction: e.target.value })} placeholder="Например: согласовать дату поставки" /></Field>
        <Field label="Кто отвечает за решение"><input required={Boolean(stage.blocker)} maxLength={120} value={form.issueOwner} onChange={(e) => patchForm({ issueOwner: e.target.value })} /></Field>
        <button className="button button--primary" type="submit">Подтвердить сведения · {actor}</button>
      </form>
    </section>}
    <p className="muted">{fresh ? `Сведения подтверждены: ${stage.siteUpdate?.updatedBy}, срез ${formatDate(stage.siteUpdate!.asOf)}; следующая сверка ${formatDate(stage.siteUpdate!.reviewOn)}.` : stage.siteUpdate?.requestId ? 'Ожидается сохранение сверки.' : 'Для расчёта нет действующего подтверждения состояния.'}</p>
    {message && <p role="status">{message}</p>}
    {stage.scheduleHistory?.length ? <details><summary>История сверок · {stage.scheduleHistory.length}</summary>{stage.scheduleHistory.slice(-6).reverse().map((entry, i) => <p key={`${entry.at}-${i}`}>{entry.note}<small>{entry.actor} · {formatDate(entry.at.slice(0, 10))}</small></p>)}</details> : null}
  </>;
}

function FactRecovery({ state, stage, onChange }: { state: AppState; stage: Stage; onChange: (state: AppState) => void }) {
  const knownEnd = stage.completedOn || stage.actualEnd;
  const [end, setEnd] = useState(knownEnd || ''), [accepted, setAccepted] = useState(''), [note, setNote] = useState(''), [message, setMessage] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = structuredClone(state), row = next.stages.find((s) => s.id === stage.id)!;
    // Fill only blanks. Server independently rejects any overwrite of a known fact.
    row.completedOn ||= knownEnd || end;
    if (row.status === 'accepted') { row.actualEnd ||= row.completedOn; if (!row.acceptedAt && accepted) row.acceptedAt = `${accepted}T12:00:00+03:00`; }
    row.factRecoveryNote = note.trim(); onChange(next); setMessage('Уточнение передано на сохранение. Затем обновите сверку остатка / приёмки.');
  };
  return <details className="schedule-review__section"><summary>Уточнить неизвестную фактическую дату</summary><p className="muted">Только управление и только по подтверждению: акту, журналу или проверенному сообщению. Известные даты не заменяются. Если дата неизвестна — оставьте запись без неё, не подставляйте сегодня.</p><form className="modal-form" onSubmit={submit}><Field label="Фактическое выполнение"><input required type="date" max={planToday()} disabled={Boolean(knownEnd)} value={knownEnd || end} onChange={(e) => setEnd(e.target.value)} /></Field>{stage.status === 'accepted' && !stage.acceptedAt && <Field label="Дата уже состоявшейся приёмки, если известна"><input type="date" min={knownEnd || end || undefined} max={planToday()} value={accepted} onChange={(e) => setAccepted(e.target.value)} /></Field>}<Field label="Основание уточнения"><textarea required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Документ, журнал или ссылка на подтверждение" /></Field><button type="submit" className="button button--secondary">Записать неизвестные даты с основанием</button>{message && <p role="status">{message}</p>}</form></details>;
}
