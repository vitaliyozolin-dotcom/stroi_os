import {
  extractFinancialDocument,
  type RecognitionResult,
} from "../domain/document-recognition";
import { requestApi } from "./api-http";
const assets = "/recognition-assets/v1/";
export interface RecognitionProgress {
  phase: string;
  progress: number;
}
const aborted = () => new DOMException("Распознавание отменено", "AbortError");
const withAbort = <T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted());
    signal.addEventListener("abort", cancel, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", cancel));
  });
};
export async function recognizeFinancialDocument(
  file: File,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: RecognitionProgress) => void;
  } = {},
): Promise<RecognitionResult> {
  const { signal, onProgress } = options,
    check = () => {
      if (signal?.aborted) throw aborted();
    };
  check();
  if (!file.size || file.size > 20 * 1024 * 1024)
    throw new Error("Для распознавания нужен файл до 20 МБ.");
  const pdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name),
    image =
      /^image\/(png|jpeg|webp)$/.test(file.type) ||
      /\.(png|jpe?g|webp)$/i.test(file.name);
  if (!pdf && !image)
    throw new Error(
      "Распознавание поддерживает PDF, PNG, JPG и WebP. Для других форматов заполните данные вручную.",
    );
  onProgress?.({ phase: "Читаем оригинал", progress: 0 });
  const bytes = await file.arrayBuffer();
  check();
  const sha256 = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  check();
  let worker:
      | Awaited<ReturnType<(typeof import("tesseract.js"))["createWorker"]>>
      | undefined,
    terminated = false;
  const terminate = async () => {
    if (worker && !terminated) {
      terminated = true;
      await worker.terminate();
    }
  };
  const abort = () => {
    void terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const readImage = async (
    source: File | HTMLCanvasElement,
    page: number,
    total: number,
  ) => {
    if (!worker) {
      onProgress?.({
        phase: "Загружаем локальный модуль распознавания",
        progress: (page - 1) / total,
      });
      const { createWorker, OEM } = await import("tesseract.js");
      check();
      const creating = createWorker(["rus", "eng"], OEM.LSTM_ONLY, {
        workerPath: new URL(`${assets}worker.min.js`, location.origin).href,
        corePath: new URL(`${assets}core`, location.origin).href,
        langPath: new URL(`${assets}lang`, location.origin).href,
        gzip: true,
        cacheMethod: "write",
        logger: (message) => {
          if (!signal?.aborted)
            onProgress?.({
              phase:
                message.status === "recognizing text"
                  ? `Распознаём страницу ${page} из ${total}`
                  : "Подготавливаем распознавание",
              progress:
                (page -
                  1 +
                  (message.status === "recognizing text"
                    ? message.progress
                    : 0)) /
                total,
            });
        },
      });
      worker = await withAbort(
        creating.then((created) => {
          worker = created;
          if (signal?.aborted) void terminate();
          return created;
        }),
        signal,
      );
      if (signal?.aborted) {
        await terminate();
        throw aborted();
      }
    }
    check();
    const activeWorker = worker;
    if (!activeWorker) throw new Error("Модуль распознавания недоступен.");
    const result = await withAbort(activeWorker.recognize(source), signal);
    check();
    return { text: result.data.text, confidence: result.data.confidence };
  };
  try {
    if (image) {
      const result = await readImage(file, 1, 1);
      return extractFinancialDocument(result.text, {
        sha256,
        method: "image_ocr",
        confidence: result.confidence,
        pageCount: 1,
      });
    }
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      `${assets}pdf.worker.min.mjs`,
      location.origin,
    ).href;
    const loading = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      stopAtErrors: true,
      wasmUrl: new URL(`${assets}pdf/wasm/`, location.origin).href,
      standardFontDataUrl: new URL(
        `${assets}pdf/standard_fonts/`,
        location.origin,
      ).href,
      cMapUrl: new URL(`${assets}pdf/cmaps/`, location.origin).href,
      cMapPacked: true,
    });
    const abortPdf = () => {
      void loading.destroy();
    };
    signal?.addEventListener("abort", abortPdf, { once: true });
    try {
      const document = await withAbort(loading.promise, signal);
      check();
      if (document.numPages > 20)
        throw new Error(
          "Для одного распознавания выберите PDF не более чем на 20 страниц. Разделите большой документ.",
        );
      const pages: string[] = [],
        confidences: number[] = [];
      let usedOcr = false;
      for (let number = 1; number <= document.numPages; number++) {
        check();
        onProgress?.({
          phase: `Читаем страницу ${number} из ${document.numPages}`,
          progress: (number - 1) / document.numPages,
        });
        const page = await document.getPage(number),
          content = await page.getTextContent();
        let text = "",
          lastY: number | undefined;
        for (const item of content.items)
          if ("str" in item) {
            const y = item.transform[5];
            if (lastY !== undefined && Math.abs(y - lastY) > 3) text += "\n";
            text += item.str + (item.hasEOL ? "\n" : " ");
            lastY = y;
          }
        if (text.replace(/[^\p{L}\d]/gu, "").length < 20) {
          const natural = page.getViewport({ scale: 1 }),
            scale = Math.min(
              2,
              Math.sqrt(12_000_000 / (natural.width * natural.height)),
            ),
            viewport = page.getViewport({ scale });
          const imageCanvas = window.document.createElement("canvas");
          imageCanvas.width = Math.ceil(viewport.width);
          imageCanvas.height = Math.ceil(viewport.height);
          const context = imageCanvas.getContext("2d");
          if (!context)
            throw new Error("Браузер не поддерживает распознавание PDF.");
          const render = page.render({
            canvas: imageCanvas,
            canvasContext: context,
            viewport,
          });
          const abortRender = () => render.cancel();
          signal?.addEventListener("abort", abortRender, { once: true });
          try {
            await render.promise;
          } finally {
            signal?.removeEventListener("abort", abortRender);
          }
          check();
          const result = await readImage(
            imageCanvas,
            number,
            document.numPages,
          );
          text = result.text;
          confidences.push(result.confidence);
          usedOcr = true;
          imageCanvas.width = 0;
          imageCanvas.height = 0;
        }
        pages.push(text);
        page.cleanup();
      }
      check();
      onProgress?.({ phase: "Предложения готовы", progress: 1 });
      return extractFinancialDocument(pages.join("\n\n"), {
        sha256,
        method: usedOcr ? "mixed_pdf" : "pdf_text",
        confidence: confidences.length
          ? confidences.reduce((a, b) => a + b, 0) / confidences.length
          : null,
        pageCount: document.numPages,
      });
    } finally {
      signal?.removeEventListener("abort", abortPdf);
      await loading.destroy();
    }
  } catch (error) {
    if (signal?.aborted) throw aborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await terminate();
  }
}
export async function fetchRecognitionDocument(
  projectId: string,
  document: {
    fileKey?: string;
    fileName?: string;
    name: string;
    mimeType?: string;
  },
  signal?: AbortSignal,
): Promise<File> {
  if (!document.fileKey?.startsWith(`${projectId}/`))
    throw new Error("Оригинал документа не найден в этом проекте.");
  const response = await requestApi(
    `/api/documents/file?projectId=${encodeURIComponent(projectId)}&key=${encodeURIComponent(document.fileKey)}`,
    { signal },
  );
  if (!response.ok)
    throw new Error("Документ недоступен или нет прав на оригинал.");
  const blob = await response.blob();
  if (blob.size > 20 * 1024 * 1024) throw new Error("Файл больше 20 МБ.");
  return new File([blob], document.fileName ?? document.name, {
    type: document.mimeType ?? blob.type,
  });
}
