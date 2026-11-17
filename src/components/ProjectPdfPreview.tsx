import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

/** Render PDF pages as pixels; document scripts and external actions are not executed. */
export function ProjectPdfPreview({ url, name }: { url: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof import('pdfjs-dist').getDocument> | undefined;
    setPdf(null); setError(''); setPageNumber(1); setLoading(true);
    void (async () => {
      try {
        const engine = await import('pdfjs-dist');
        if (cancelled) return;
        engine.GlobalWorkerOptions.workerSrc = '/recognition-assets/v1/pdf.worker.min.mjs';
        task = engine.getDocument({ url, enableXfa: false, wasmUrl: '/recognition-assets/v1/pdf/wasm/', standardFontDataUrl: '/recognition-assets/v1/pdf/standard_fonts/', cMapUrl: '/recognition-assets/v1/pdf/cmaps/', cMapPacked: true });
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch { if (!cancelled) { setError('Предпросмотр PDF недоступен. Оригинал можно скачать ниже.'); setLoading(false); } }
    })();
    return () => { cancelled = true; void task?.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    setLoading(true); setError('');
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled || !canvas.current) return;
        const original = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(1.5, 1100 / original.width) });
        const element = canvas.current;
        element.width = viewport.width; element.height = viewport.height;
        render = page.render({ canvas: element, viewport });
        await render.promise;
        if (!cancelled) setLoading(false);
      } catch { if (!cancelled) { setError('Не удалось показать страницу. Скачайте оригинал.'); setLoading(false); } }
    })();
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, pageNumber]);
  return <div className="project-pdf-preview">
    {pdf && <div className="project-pdf-preview__controls"><button type="button" className="button button--secondary button--compact" disabled={pageNumber <= 1} onClick={() => setPageNumber(value => value - 1)}>Назад</button><span>Страница {pageNumber} из {pdf.numPages}</span><button type="button" className="button button--secondary button--compact" disabled={pageNumber >= pdf.numPages} onClick={() => setPageNumber(value => value + 1)}>Далее</button></div>}
    {loading && <p role="status">Открываем страницу…</p>}
    {error && <p role="alert">{error}</p>}
    <div className="project-pdf-preview__page"><canvas ref={canvas} aria-label={`${name}, страница ${pageNumber}`} hidden={Boolean(error) || !pdf} /></div>
  </div>;
}
