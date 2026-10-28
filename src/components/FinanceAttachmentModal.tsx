import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  AppState,
  FinanceEntry,
  UserRole,
  VerifiedDocumentMetadata,
} from "../entities/index";
import type { FinanceCommandResult } from "../application";
import { documentUploader } from "../infrastructure/document-upload";
import { Field, Modal } from "./Ui";
import { FinanceDocumentRecognition } from "./FinanceDocumentRecognition";

type UploadedFile = Awaited<ReturnType<typeof documentUploader.upload>>;
type AttachmentInput = {
  entryId: string;
  category: "invoice" | "other";
  document?: string;
  uploadedFile?: UploadedFile;
  documentId?: string;
  metadata?: VerifiedDocumentMetadata;
};

type AttachmentProps = {
  state: AppState;
  role: UserRole;
  entry: FinanceEntry;
  onAttach: (input: AttachmentInput) => FinanceCommandResult;
  onClose: () => void;
};
export function FinanceAttachmentModal(props: AttachmentProps) {
  return props.role === "management" ? (
    <ManagementFinanceAttachmentModal {...props} />
  ) : null;
}
function ManagementFinanceAttachmentModal({
  state,
  role,
  entry,
  onAttach,
  onClose,
}: AttachmentProps) {
  const [metadata, setMetadata] = useState<
    VerifiedDocumentMetadata | undefined
  >();
  const [category, setCategory] = useState<"invoice" | "other">("invoice");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [documentId, setDocumentId] = useState("");
  const [uploaded, setUploaded] = useState<UploadedFile | undefined>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  useEffect(() => () => controller.current?.abort(), [state.project.id]);
  const documents = state.documents.filter(
    (document) =>
      document.fileKey &&
      !document.clientVisible &&
      (document.financeEntryId === entry.id ||
        document.counterpartyId === entry.counterpartyId),
  );
  const close = () => {
    controller.current?.abort();
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy.current) return;
    if (!file && !documentId) {
      setError("Выберите файл или уже загруженный оригинал.");
      return;
    }
    if (file && file.size > 20 * 1024 * 1024) {
      setError("Файл больше 20 МБ.");
      return;
    }
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      let uploadedFile = uploaded;
      if (file && !uploadedFile) {
        const signalController = new AbortController();
        controller.current = signalController;
        uploadedFile = await documentUploader.upload(
          state.project.id,
          file,
          signalController.signal,
        );
        if (signalController.signal.aborted) return;
        setUploaded(uploadedFile);
      }
      const result = onAttach({
        entryId: entry.id,
        category,
        document: name.trim() || file?.name,
        uploadedFile,
        documentId: documentId || undefined,
        metadata,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onClose();
    } catch (cause) {
      if (!controller.current?.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить документ. Попробуйте ещё раз.",
        );
    } finally {
      busy.current = false;
      setSaving(false);
      controller.current = null;
    }
  };
  return (
    <Modal
      title="Прикрепить счёт или документ"
      subtitle="Файл будет связан с обязательством. Суммы, оплаты и приёмка не изменятся."
      onClose={close}
    >
      <form className="modal-form" onSubmit={submit}>
        {error && (
          <p role="alert" className="form-warning">
            {error}
          </p>
        )}
        <fieldset className="finance-action-fields" disabled={saving}>
          <Field label="Вид документа">
            <select
              value={category}
              onChange={(event) =>
                setCategory(event.target.value as "invoice" | "other")
              }
            >
              <option value="invoice">Счёт</option>
              <option value="other">Другой документ</option>
            </select>
          </Field>
          <Field label="Название или номер">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Счёт №…"
            />
          </Field>
          <Field
            label="Загрузить оригинал"
            hint="PDF, изображение или офисный документ · до 20 МБ"
          >
            <input
              type="file"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.txt"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setMetadata(undefined);
                setUploaded(undefined);
                setDocumentId("");
              }}
            />
          </Field>
          {documents.length > 0 && (
            <Field label="Или выбрать документ проекта">
              <select
                value={documentId}
                onChange={(event) => {
                  setDocumentId(event.target.value);
                  setMetadata(undefined);
                  setFile(null);
                  setUploaded(undefined);
                }}
              >
                <option value="">Не выбран</option>
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </fieldset>
        {(file || documentId) && !saving && (
          <FinanceDocumentRecognition
            state={state}
            role={role}
            file={file}
            document={state.documents.find((item) => item.id === documentId)}
            onInvalidate={() => setMetadata(undefined)}
            onApply={(value, title) => {
              setMetadata(value);
              setName(title);
            }}
          />
        )}
        {metadata && (
          <p className="finance-muted">
            Проверенные реквизиты подготовлены к сохранению.
          </p>
        )}
        {saving && (
          <p role="status" className="finance-muted">
            {file && !uploaded
              ? "Загружаем оригинал…"
              : "Связываем документ с обязательством…"}
          </p>
        )}
        {uploaded && !saving && (
          <p className="finance-muted">
            Оригинал уже загружен. Повторная попытка использует тот же файл.
          </p>
        )}
        <div className="modal__actions">
          <button
            type="button"
            className="button button--ghost"
            onClick={close}
          >
            {saving ? "Отменить" : "Закрыть"}
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={saving || (!file && !documentId)}
          >
            {saving ? "Сохраняем…" : "Прикрепить документ"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
