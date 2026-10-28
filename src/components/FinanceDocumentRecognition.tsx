import { useEffect, useRef, useState } from "react";
import type {
  AppState,
  ProjectDocument,
  UserRole,
  VerifiedDocumentMetadata,
} from "../entities/index";
import {
  parseRecognitionAmount,
  suggestDocumentLinks,
  type RecognitionResult,
} from "../domain/document-recognition";
import {
  recognizeFinancialDocument,
  fetchRecognitionDocument,
  type RecognitionProgress,
} from "../infrastructure/document-recognition";
import { Field } from "./Ui";
import { formatDate, money } from "../presentation/formatting";
import "./finance-automation.css";
export function FinanceDocumentRecognition({
  state,
  role,
  file,
  document,
  onApply,
  onInvalidate,
  onOpenEntry,
}: {
  state: AppState;
  role: UserRole;
  file?: File | null;
  document?: ProjectDocument;
  onApply: (metadata: VerifiedDocumentMetadata, title: string) => void;
  onInvalidate?: () => void;
  onOpenEntry?: (id: string) => void;
}) {
  const [result, setResult] = useState<RecognitionResult | null>(null),
    [progress, setProgress] = useState<RecognitionProgress | null>(null),
    [error, setError] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [fields, setFields] = useState({ number: "", date: "", amount: "" });
  const abort = useRef<AbortController | null>(null),
    token = useRef(0);
  useEffect(() => {
    token.current++;
    abort.current?.abort();
    setResult(null);
    setProgress(null);
    setError("");
    setReviewed(false);
  }, [file, document?.id, state.project.id, role]);
  useEffect(
    () => () => {
      token.current++;
      abort.current?.abort();
    },
    [],
  );
  if (role !== "management") return null;
  const recognize = async () => {
    onInvalidate?.();
    const request = ++token.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setError("");
    setReviewed(false);
    setResult(null);
    setProgress({ phase: "Читаем файл", progress: 0 });
    try {
      const source =
        file ??
        (document
          ? await fetchRecognitionDocument(
              state.project.id,
              document,
              controller.signal,
            )
          : null);
      if (!source) throw new Error("Сначала выберите оригинал.");
      const next = await recognizeFinancialDocument(source, {
        signal: controller.signal,
        onProgress: (value) => {
          if (request === token.current) setProgress(value);
        },
      });
      if (controller.signal.aborted || request !== token.current) return;
      setResult(next);
      setFields({
        number: next.number?.value ?? "",
        date: next.date?.value ?? "",
        amount: next.amount ? String(next.amount.value / 100) : "",
      });
    } catch (cause) {
      if (!controller.signal.aborted && request === token.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось распознать файл.",
        );
    } finally {
      if (request === token.current) setProgress(null);
    }
  };
  const links = result ? suggestDocumentLinks(result, state) : null;
  const apply = () => {
    if (!result || !reviewed) return;
    const amount = fields.amount.trim()
      ? parseRecognitionAmount(fields.amount)
      : null;
    if (fields.amount.trim() && amount === null) {
      setError("Проверьте сумму: не более двух знаков после запятой.");
      return;
    }
    if (fields.date && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) {
      setError("Проверьте дату документа.");
      return;
    }
    onApply(
      {
        number: fields.number.trim() || undefined,
        documentDate: fields.date || undefined,
        sourceSha256: result.sha256,
        recognition: {
          sha256: result.sha256,
          method: result.method,
          confidence: result.confidence,
          reviewed: true,
          pageCount: result.pageCount,
          ...(amount !== null ? { amountCents: amount } : {}),
        },
      },
      fields.number
        ? `Счёт № ${fields.number}${fields.date ? ` от ${formatDate(fields.date, true)}` : ""}`
        : (file?.name ?? document?.name ?? "Документ"),
    );
    setError("");
  };
  return (
    <section
      className="finance-recognition"
      aria-label="Распознавание документа"
    >
      <div className="finance-automation__heading">
        <strong>Распознать документ</strong>
        <button
          type="button"
          className="button button--secondary"
          disabled={Boolean(progress) || (!file && !document)}
          onClick={() => void recognize()}
        >
          Распознать реквизиты
        </button>
      </div>
      <p>
        PDF и изображения обрабатываются в этом браузере. Результат —
        предложения для проверки; суммы обязательств и оплаты сохраняются
        отдельно.
      </p>
      {progress && (
        <div role="status">
          <span>{progress.phase}</span>
          <progress max={1} value={progress.progress} />
          <button
            type="button"
            className="text-button"
            onClick={() => {
              abort.current?.abort();
              token.current++;
              setProgress(null);
            }}
          >
            Отменить распознавание
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="form-warning">
          {error}
        </p>
      )}
      {result && (
        <>
          <p>
            {result.method === "pdf_text"
              ? "Прочитан текст PDF"
              : "Выполнено оптическое распознавание"}{" "}
            · страниц: {result.pageCount}
            {result.confidence !== null
              ? ` · уверенность OCR ${Math.round(result.confidence)}%`
              : ""}
          </p>
          {result.warnings.map((warning) => (
            <p className="finance-automation__warning" key={warning}>
              {warning}
            </p>
          ))}
          <div className="form-grid">
            <Field label="Предложенный номер">
              <input
                value={fields.number}
                maxLength={60}
                onChange={(event) => {
                  setFields({ ...fields, number: event.target.value });
                  setReviewed(false);
                  onInvalidate?.();
                }}
              />
            </Field>
            <Field label="Дата документа">
              <input
                type="date"
                value={fields.date}
                onChange={(event) => {
                  setFields({ ...fields, date: event.target.value });
                  setReviewed(false);
                  onInvalidate?.();
                }}
              />
            </Field>
            <Field
              label="Сумма в документе, ₽"
              hint="Сохраняется как проверенные реквизиты документа; платёж не создаётся"
            >
              <input
                inputMode="decimal"
                value={fields.amount}
                onChange={(event) => {
                  setFields({ ...fields, amount: event.target.value });
                  setReviewed(false);
                  onInvalidate?.();
                }}
              />
            </Field>
          </div>
          {result.counterparty && (
            <p>
              <strong>Возможный контрагент:</strong> {result.counterparty.value}
            </p>
          )}
          {result.amount?.alternatives?.length ? (
            <p className="finance-automation__warning">
              Другие найденные итоги:{" "}
              {result.amount.alternatives
                .map((value) => money(value / 100))
                .join(", ")}
              . Сверьте с оригиналом.
            </p>
          ) : null}
          <details>
            <summary>Основания предложений и распознанный текст</summary>
            {[result.number, result.date, result.amount, result.counterparty]
              .filter(Boolean)
              .map((field, index) => (
                <blockquote key={index}>
                  {field!.evidence}
                  <small>
                    Уверенность:{" "}
                    {field!.confidence === "high"
                      ? "выше"
                      : field!.confidence === "medium"
                        ? "средняя"
                        : "низкая"}
                  </small>
                </blockquote>
              ))}
            <pre className="finance-recognition__text">{result.text}</pre>
          </details>
          {!!links?.duplicates.length && (
            <div className="finance-automation__warning">
              <strong>Возможный повтор</strong>
              {links.duplicates.map((match) => (
                <p key={match.id}>
                  {match.name} · {match.reason}
                </p>
              ))}
              <p>
                Выберите уже загруженный оригинал, если это тот же документ.
              </p>
            </div>
          )}
          {!!links?.entries.length && (
            <div>
              <strong>Возможные связи с обязательствами</strong>
              {links.entries.map((match) => (
                <div className="finance-recognition__match" key={match.id}>
                  <span>
                    {match.title}
                    <small>{match.reason}</small>
                  </span>
                  {onOpenEntry && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => onOpenEntry(match.id)}
                    >
                      Открыть
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <label className="check-line">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(event) => {
                setReviewed(event.target.checked);
                if (!event.target.checked) onInvalidate?.();
              }}
            />
            Я сверил реквизиты с оригиналом
          </label>
          <button
            type="button"
            className="button button--secondary"
            disabled={!reviewed}
            onClick={apply}
          >
            Применить проверенные реквизиты
          </button>
          <p className="finance-automation__note">
            Документ сохранится после нажатия «Прикрепить документ».
          </p>
        </>
      )}
    </section>
  );
}
