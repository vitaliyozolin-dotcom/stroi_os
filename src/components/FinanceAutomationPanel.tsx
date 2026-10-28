import { useMemo, useState, type FormEvent } from "react";
import type {
  AppState,
  FinancialRiskReview,
  UserRole,
} from "../entities/index";
import type { StateChangeSink } from "../application/state-change";
import {
  financialRiskInbox,
  type FinancialInboxRow,
} from "../domain/finance-automation.js";
import { useFinanceAutomation } from "../useFinanceAutomation";
import { financeToday } from "../presentation/finance-view";
import { formatDate, formatDateTime } from "../presentation/formatting";
import { Field, Modal } from "./Ui";
import "./finance-automation.css";
type Props = {
  state: AppState;
  role: UserRole;
  actor: string;
  userId?: string;
  onChange: StateChangeSink;
  onOpenEntry: (id: string) => void;
  onOpenForecast?: () => void;
  onOpenBudget?: () => void;
};
export function FinanceAutomationPanel(props: Props) {
  return props.role === "management" ? (
    <ManagementFinancialInbox {...props} />
  ) : null;
}
function ManagementFinancialInbox({
  state,
  role,
  actor,
  userId,
  onChange,
  onOpenEntry,
  onOpenForecast,
  onOpenBudget,
}: Props) {
  const today = financeToday(),
    commands = useFinanceAutomation(
      state,
      { name: actor, role, id: userId },
      onChange,
    );
  const rows = useMemo(
    () => financialRiskInbox(state, { today, role }),
    [state, today, role],
  );
  const [filter, setFilter] = useState<"active" | "snoozed" | "resolved">(
      "active",
    ),
    [error, setError] = useState(""),
    [editing, setEditing] = useState<{
      row: FinancialInboxRow;
      expected: string;
    } | null>(null);
  const active = rows.filter((row) => row.state !== "resolved"),
    visible = rows.filter((row) =>
      filter === "active"
        ? row.state === "active" || row.state === "acknowledged"
        : row.state === filter,
    );
  const navigate = (row: FinancialInboxRow) => {
    if (row.entryId) onOpenEntry(row.entryId);
    else if (row.kind === "budget_overrun") onOpenBudget?.();
    else onOpenForecast?.();
  };
  const refresh = () => {
    const result = commands.save({ expected: commands.snapshot, today });
    setError(result.ok ? "" : result.error);
  };
  return (
    <section className="finance-risk-inbox" aria-label="Финансовые уведомления">
      <div className="finance-automation__heading">
        <div>
          <h3>Требует внимания</h3>
          <p>
            {active.length
              ? `Активных финансовых условий: ${active.length}`
              : "По внесённым данным активных условий нет"}{" "}
            · срез {formatDate(today, true)}
          </p>
        </div>
        <button type="button" className="text-button" onClick={refresh}>
          Обновить журнал
        </button>
      </div>
      <p className="finance-automation__note">
        Уведомления пересчитываются из текущих данных. Отметка ознакомления и
        перенос напоминания сохраняют риск до устранения причины. Внешние
        сообщения не отправляются.
      </p>
      {error && (
        <p role="alert" className="form-warning">
          {error}
        </p>
      )}
      <div
        className="finance-risk-inbox__filters"
        role="group"
        aria-label="Состояние уведомлений"
      >
        {(
          [
            { id: "active", label: "Нужно решить" },
            { id: "snoozed", label: "Отложены" },
            { id: "resolved", label: "Условия сняты" },
          ] as const
        ).map((tab) => (
          <button
            type="button"
            className="text-button"
            aria-pressed={filter === tab.id}
            key={tab.id}
            onClick={() => setFilter(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {!visible.length && (
        <p className="finance-automation__note">
          В этой группе нет уведомлений. Полнота прогноза зависит от внесённых
          расчётов и подтверждённых остатков.
        </p>
      )}
      {visible.length > 0 && (
        <div className="finance-risk-inbox__list">
          {visible.map((row) => (
            <article
              className="finance-risk-inbox__item"
              data-severity={row.severity}
              key={row.id}
            >
              <div className="finance-automation__heading">
                <strong>{row.title}</strong>
                <span>
                  {row.state === "resolved"
                    ? "Причина устранена"
                    : row.state === "snoozed"
                      ? `Напомнить ${formatDate(row.review!.snoozedUntil!, true)}`
                      : row.state === "acknowledged"
                        ? "В работе"
                        : "Требует действия"}
                </span>
              </div>
              <p>{row.detail}</p>
              <p>
                <strong>Ответственный:</strong> {row.responsible}
                {row.review?.actionDueDate
                  ? ` · действие до ${formatDate(row.review.actionDueDate, true)}`
                  : ""}
              </p>
              <p>
                <strong>Следующее действие:</strong>{" "}
                {row.review?.nextAction || row.action}
              </p>
              <div className="finance-risk-inbox__actions">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => navigate(row)}
                >
                  Открыть основание
                </button>
                {row.state !== "resolved" && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setEditing({ row, expected: commands.snapshot })
                    }
                  >
                    Назначить действие
                  </button>
                )}
              </div>
              {row.review?.history?.length ? (
                <details>
                  <summary>История ({row.review.history.length})</summary>
                  {row.review.history
                    .slice(-10)
                    .reverse()
                    .map((event, index) => (
                      <p
                        className="finance-automation__note"
                        key={`${event.at}:${index}`}
                      >
                        {formatDateTime(event.at)} · {event.by} · {event.note}
                      </p>
                    ))}
                </details>
              ) : null}
            </article>
          ))}
        </div>
      )}
      {editing && (
        <RiskReviewEditor
          state={state}
          row={editing.row}
          today={today}
          onClose={() => setEditing(null)}
          onSave={(review) => {
            const result = commands.save({
              expected: editing.expected,
              today,
              riskId: editing.row.id,
              review,
            });
            if (result.ok) setEditing(null);
            return result;
          }}
        />
      )}
    </section>
  );
}
function RiskReviewEditor({
  state,
  row,
  today,
  onClose,
  onSave,
}: {
  state: AppState;
  row: FinancialInboxRow;
  today: string;
  onClose: () => void;
  onSave: (
    review: Pick<
      FinancialRiskReview,
      | "ownerId"
      | "nextAction"
      | "actionDueDate"
      | "acknowledged"
      | "snoozedUntil"
    >,
  ) => { ok: boolean; error?: string };
}) {
  const [form, setForm] = useState({
      ownerId: row.review?.ownerId ?? "",
      nextAction: row.review?.nextAction ?? row.action,
      actionDueDate: row.review?.actionDueDate ?? "",
      acknowledged: row.review?.acknowledged ?? false,
      snoozedUntil: row.review?.snoozedUntil ?? "",
    }),
    [error, setError] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = onSave({
      ownerId: form.ownerId || undefined,
      nextAction: form.nextAction.trim(),
      actionDueDate: form.actionDueDate || undefined,
      acknowledged: form.acknowledged,
      snoozedUntil: form.snoozedUntil || undefined,
    });
    if (!result.ok) setError(result.error ?? "Не удалось сохранить действие.");
  };
  return (
    <Modal
      title="Действие по финансовому риску"
      subtitle={row.title}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        <p>{row.detail}</p>
        <Field label="Ответственный">
          <select
            value={form.ownerId}
            onChange={(event) =>
              setForm({ ...form, ownerId: event.target.value })
            }
          >
            <option value="">Управление проекта</option>
            {state.settings.users
              .filter(
                (user) =>
                  user.role === "management" && user.status !== "disabled",
              )
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Следующее действие">
          <textarea
            required
            maxLength={1500}
            value={form.nextAction}
            onChange={(event) =>
              setForm({ ...form, nextAction: event.target.value })
            }
          />
        </Field>
        <div className="form-grid">
          <Field label="Срок действия">
            <input
              type="date"
              value={form.actionDueDate}
              onChange={(event) =>
                setForm({ ...form, actionDueDate: event.target.value })
              }
            />
          </Field>
          <Field
            label="Отложить напоминание до"
            hint="Не более 30 дней; риск останется видимым в группе «Отложены»"
          >
            <input
              min={today}
              type="date"
              value={form.snoozedUntil}
              onChange={(event) =>
                setForm({ ...form, snoozedUntil: event.target.value })
              }
            />
          </Field>
        </div>
        <label className="check-line">
          <input
            type="checkbox"
            checked={form.acknowledged}
            onChange={(event) =>
              setForm({ ...form, acknowledged: event.target.checked })
            }
          />
          Ознакомился, взял в работу
        </label>
        {error && (
          <p role="alert" className="form-warning">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
          >
            Отмена
          </button>
          <button type="submit" className="button button--primary">
            Сохранить действие
          </button>
        </div>
      </form>
    </Modal>
  );
}
