import { useEffect, useState } from 'react';
import { AlertCircle, Download, ExternalLink, FileText, LoaderCircle } from 'lucide-react';
import { requestApi } from '../infrastructure/api-http';
import { filePreviewKind } from '../domain/file-preview.js';
import { ProjectPdfPreview } from './ProjectPdfPreview';

/** Loads through the existing authenticated endpoint; never exposes a storage URL. */
export function ProjectFilePreview({ url, name }: { url?: string; name: string }) {
  const [file, setFile] = useState<{ url: string; kind: string; text?: string } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setFile(null); setError('');
    if (!url) { setError('Оригинал файла не прикреплён. Загрузите его в документы проекта.'); return; }
    const controller = new AbortController();
    let objectUrl = '';
    void (async () => {
      try {
        const response = await requestApi(url, { signal: controller.signal, credentials: 'same-origin' });
        if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? 'Нет доступа к этому файлу. Проверьте вход и права на проект.' : response.status === 404 ? 'Оригинал файла недоступен. Нужно восстановить его из источника или загрузить заново.' : 'Не удалось получить файл. Проверьте связь и повторите.');
        const blob = await response.blob();
        if (!blob.size) throw new Error('Файл пуст. Нужно загрузить оригинал повторно.');
        const signature = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        const preview = filePreviewKind(signature, name);
        let text: string | undefined;
        if (preview.kind === 'text') text = await blob.slice(0, 200_000).text();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([blob], { type: preview.mime }));
        setFile({ url: objectUrl, kind: preview.kind, text });
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Файл недоступен.');
      }
    })();
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, name, attempt]);
  return <section className="project-file-preview" aria-label={`Просмотр: ${name}`}>
    {error ? <div className="project-file-preview__error" role="alert"><AlertCircle size={24} /><strong>Файл недоступен</strong><p>{error}</p>{url && <button className="button button--secondary" type="button" onClick={() => setAttempt(value => value + 1)}>Повторить</button>}</div> : !file ? <div className="project-file-preview__loading" role="status"><LoaderCircle size={24} /><span>Открываем оригинал…</span></div> : <>
      {file.kind === 'image' ? <a className="project-file-preview__image" href={file.url} target="_blank" rel="noreferrer"><img src={file.url} alt={name} /><span>Открыть в полном размере <ExternalLink size={14} /></span></a>
        : file.kind === 'pdf' ? <ProjectPdfPreview url={file.url} name={name} />
        : file.kind === 'text' ? <pre className="project-file-preview__text">{file.text}</pre>
        : <div className="project-file-preview__unsupported"><FileText size={32} /><p>Оригинал доступен. Скачайте его для просмотра в подходящем приложении.</p></div>}
      <div className="project-file-preview__actions"><a className="button button--primary" href={file.url} download={name}><Download size={16} /> Скачать оригинал</a></div>
    </>}
  </section>;
}
