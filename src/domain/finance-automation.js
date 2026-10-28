import {
  treasuryProjection,
  treasuryCostSummary,
  treasuryScopeFingerprint,
  validTreasuryDate,
} from "./treasury.js";
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && !Array.isArray(item) && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const dayGap = (later, earlier) =>
  Math.round(
    (Date.parse(`${later}T12:00:00Z`) - Date.parse(`${earlier}T12:00:00Z`)) /
      86400000,
  );
const money = (cents) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 2,
  }).format(cents / 100);
const reviewFields = (value) => ({
  ownerId: value?.ownerId,
  nextAction: value?.nextAction,
  actionDueDate: value?.actionDueDate,
  acknowledged: value?.acknowledged,
  snoozedUntil: value?.snoozedUntil,
});
const stampedFields = (value) => ({
  firstSeenAt: value?.firstSeenAt,
  lastSeenAt: value?.lastSeenAt,
  resolvedAt: value?.resolvedAt,
  snapshot: value?.snapshot,
  history: value?.history,
});
export const emptyFinanceAutomation = () => ({ version: 1, reviews: [] });
/** Current conditions are recalculated on every read; acknowledgement never clears a live risk. */
export function financialRiskSignals(
  state,
  { today, role = "management" } = {},
) {
  if (role !== "management") return [];
  if (!validTreasuryDate(today))
    throw new Error("Укажите корректную дату уведомлений.");
  const projection = treasuryProjection(state, { today, horizonDays: 91 }),
    signals = [];
  const entries = new Map(
    (state.financeEntries ?? []).map((entry) => [entry.id, entry]),
  );
  const add = (id, kind, severity, title, detail, action, extra = {}) =>
    signals.push({ id, kind, severity, title, detail, action, ...extra });
  const invoices = new Set(
    (state.documents ?? [])
      .filter((doc) => doc.category === "invoice" && doc.fileKey)
      .map((doc) => doc.financeEntryId),
  );
  const missingInvoices = new Set();
  for (const event of projection.events) {
    const entry = entries.get(event.entryId);
    if (event.amountCents <= 0) continue;
    const description = entry?.description ?? event.description;
    const entryLink = entry ? { entryId: entry.id } : {};
    const date = event.scheduledDate,
      gap = date ? dayGap(date, today) : null;
    if (event.contractOverdue || (gap !== null && gap <= 7))
      add(
        `payment:${event.id}`,
        "payment_due",
        event.contractOverdue || gap <= 0 ? "high" : "medium",
        `${event.kind === "expense" ? "Оплата" : "Поступление"}: ${description}`,
        `${money(event.amountCents)} · ${event.contractOverdue ? "договорный срок прошёл" : gap <= 0 ? "плановый срок наступил" : `до планового срока ${gap} дн.`}${event.excluded ? " · вне счетов компании" : ""}`,
        event.kind === "expense"
          ? "Проверить основание и согласовать дату расчёта"
          : "Подтвердить поступление с заказчиком",
        {
          ...entryLink,
          date: date ?? event.contractualDueDate,
          amountCents: event.amountCents,
        },
      );
    if (!date)
      add(
        `undated:${event.id}`,
        "undated_payment",
        "high",
        `Без даты: ${description}`,
        `${money(event.amountCents)} не распределено в календаре. ${event.dateResolution?.reason ?? ""}`,
        "Уточнить правило или дату транша",
        { ...entryLink, amountCents: event.amountCents },
      );
    if (
      entry &&
      event.kind === "expense" &&
      !invoices.has(entry.id) &&
      !missingInvoices.has(entry.id) &&
      (gap === null || gap <= 7 || event.contractOverdue)
    ) {
      missingInvoices.add(entry.id);
      add(
        `invoice:${entry.id}`,
        "invoice_missing",
        "medium",
        `Нет оригинала счёта: ${entry.description}`,
        "У обязательства отсутствует связанный файл счёта. Текстовое основание не считается оригиналом.",
        "Запросить счёт и прикрепить документ",
        { entryId: entry.id },
      );
    }
  }
  if (state.treasury?.enabled) {
    if (projection.firstDeficitDate && projection.peakFundingCents > 0)
      add(
        "cash-gap:project",
        "cash_gap",
        "high",
        "Прогнозируется кассовый разрыв",
        `Первый день: ${projection.firstDeficitDate}; пик потребности ${money(projection.peakFundingCents)}.${projection.completeness ? "" : " Расчёт только по внесённым событиям; полнота не подтверждена."}`,
        "Проверить платежи-причины и согласовать финансирование",
        {
          date: projection.firstDeficitDate,
          amountCents: projection.peakFundingCents,
        },
      );
    const cost = treasuryCostSummary(state, { today });
    if (cost.varianceCents !== null && cost.varianceCents > 0)
      add(
        "budget-overrun:project",
        "budget_overrun",
        "high",
        "Прогноз превышает бюджет",
        `Отклонение ${money(cost.varianceCents)}.${cost.complete ? "" : " Оценка всей достройки ещё неполна."}`,
        "Разобрать отклонение и согласовать изменения бюджета",
        { amountCents: cost.varianceCents },
      );
    const review = state.treasury.cashScopeReview;
    if (
      !review ||
      !validTreasuryDate(review.asOf) ||
      dayGap(today, review.asOf) > 7 ||
      review.asOf > today ||
      review.fingerprint !== treasuryScopeFingerprint(state) ||
      !projection.openingKnown
    ) {
      add(
        "forecast-stale:project",
        "forecast_stale",
        "high",
        "Денежный прогноз требует сверки",
        !projection.openingKnown
          ? "Нет подтверждённого доступного остатка для текущего среза."
          : "Состав будущих расчётов изменился или подтверждён более семи дней назад.",
        "Сверить остатки и полноту будущих платежей",
      );
    }
  }
  return signals.sort(
    (a, b) =>
      (a.severity === "high" ? 0 : 1) - (b.severity === "high" ? 0 : 1) ||
      (a.date ?? "9999").localeCompare(b.date ?? "9999") ||
      a.id.localeCompare(b.id),
  );
}
export function financialRiskInbox(state, options) {
  if (options?.role && options.role !== "management") return [];
  const active = financialRiskSignals(state, options),
    reviews = new Map(
      (state.financeAutomation?.reviews ?? []).map((review) => [
        review.riskId,
        review,
      ]),
    );
  const rows = active.map((signal) => {
    const review = reviews.get(signal.id);
    return {
      ...signal,
      review,
      state: review?.resolvedAt
        ? "active"
        : review?.snoozedUntil && review.snoozedUntil > options.today
          ? "snoozed"
          : review?.acknowledged
            ? "acknowledged"
            : "active",
      responsible:
        (state.settings?.users ?? []).find(
          (user) => user.id === review?.ownerId,
        )?.name ?? "Управление проекта",
    };
  });
  const ids = new Set(active.map((signal) => signal.id));
  for (const review of reviews.values())
    if (!ids.has(review.riskId) && review.snapshot)
      rows.push({
        id: review.riskId,
        ...review.snapshot,
        severity: "low",
        action: review.nextAction ?? "Условие риска больше не наблюдается",
        review,
        state: "resolved",
        responsible:
          (state.settings?.users ?? []).find(
            (user) => user.id === review.ownerId,
          )?.name ?? "Управление проекта",
      });
  return rows;
}
/** Server stamps observations/history only after validating the submitted editable review fields. */
export function validateFinanceAutomationChanges(
  previous,
  next,
  identity,
  now,
) {
  const old = previous?.financeAutomation,
    candidate = next?.financeAutomation;
  if (!candidate)
    return old ? "Нельзя удалить журнал финансовых уведомлений." : "";
  const changed = stable(candidate) !== stable(old);
  if (changed && identity?.role !== "management")
    return "Финансовые уведомления изменяет управление.";
  if (
    candidate.version !== 1 ||
    !Array.isArray(candidate.reviews) ||
    candidate.reviews.length > 5000
  )
    return "Некорректный журнал финансовых уведомлений.";
  const today = now
    ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
        new Date(now),
      )
    : new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(
        new Date(),
      );
  const signals = new Map(
    financialRiskSignals(next, { today }).map((signal) => [signal.id, signal]),
  );
  const oldById = new Map(
      (old?.reviews ?? []).map((review) => [review.riskId, review]),
    ),
    seen = new Set();
  for (const review of candidate.reviews) {
    if (
      !review ||
      typeof review.riskId !== "string" ||
      review.riskId.length > 300 ||
      seen.has(review.riskId)
    )
      return "Повтор или неверный ID финансового уведомления.";
    seen.add(review.riskId);
    const before = oldById.get(review.riskId);
    if (!before && !signals.has(review.riskId))
      return "Уведомление больше не актуально. Обновите список.";
    if (stable(stampedFields(review)) !== stable(stampedFields(before)))
      return "Историю и время уведомлений фиксирует сервер.";
    if (
      review.ownerId &&
      review.ownerId !== before?.ownerId &&
      !(next.settings?.users ?? []).some(
        (user) =>
          user.id === review.ownerId &&
          user.role === "management" &&
          user.status !== "disabled",
      )
    )
      return "Выберите действующего сотрудника управления.";
    if (
      review.nextAction !== undefined &&
      (typeof review.nextAction !== "string" || review.nextAction.length > 1500)
    )
      return "Следующее действие: не более 1500 символов.";
    if (
      review.acknowledged !== undefined &&
      typeof review.acknowledged !== "boolean"
    )
      return "Некорректная отметка ознакомления.";
    for (const key of ["actionDueDate", "snoozedUntil"])
      if (review[key] && !validTreasuryDate(review[key]))
        return "Некорректная дата действия или напоминания.";
    if (
      review.snoozedUntil &&
      review.snoozedUntil !== before?.snoozedUntil &&
      (review.snoozedUntil < today || dayGap(review.snoozedUntil, today) > 30)
    )
      return "Напоминание можно отложить не более чем на 30 дней.";
  }
  if ([...oldById.keys()].some((id) => !seen.has(id)))
    return "История уведомлений сохраняется; записи нельзя удалять.";
  if (now) {
    const current = new Map(
      candidate.reviews.map((review) => [
        review.riskId,
        structuredClone(review),
      ]),
    );
    // Refresh records already being tracked. New risks stay visible immediately and are tracked on explicit review.
    for (const [id, review] of current) {
      const before = oldById.get(id),
        signal = signals.get(id),
        edits = stable(reviewFields(review)) !== stable(reviewFields(before));
      review.history = [...(before?.history ?? [])];
      if (signal) {
        review.firstSeenAt = before?.firstSeenAt ?? now;
        review.lastSeenAt = now;
        delete review.resolvedAt;
        review.snapshot = {
          kind: signal.kind,
          title: signal.title,
          detail: signal.detail,
          ...(signal.entryId ? { entryId: signal.entryId } : {}),
          ...(signal.date ? { date: signal.date } : {}),
          ...(Number.isSafeInteger(signal.amountCents)
            ? { amountCents: signal.amountCents }
            : {}),
        };
        if (!before)
          review.history.push({
            at: now,
            by: identity?.name || "Система",
            action: "observed",
            note: "Условие риска зафиксировано",
          });
        else if (before.resolvedAt) {
          review.acknowledged = false;
          delete review.snoozedUntil;
          review.history.push({
            at: now,
            by: "Система",
            action: "reopened",
            note: "Условие риска появилось повторно",
          });
        }
      } else if (!before?.resolvedAt) {
        review.resolvedAt = now;
        review.history.push({
          at: now,
          by: "Система",
          action: "resolved",
          note: "Условие риска больше не наблюдается",
        });
      }
      if (edits)
        review.history.push({
          at: now,
          by: identity?.name || "Управление",
          action: "reviewed",
          note:
            review.nextAction?.trim() ||
            "Обновлены ответственный, ознакомление или напоминание",
        });
      current.set(id, review);
    }
    candidate.reviews = [...current.values()];
  }
  return "";
}
