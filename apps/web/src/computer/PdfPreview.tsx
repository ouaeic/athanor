import { useEffect, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import { Button, Field } from '../ui.js';
import { message } from './format.js';
import './pdf-preview.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const assetBase = '/pdfjs/';
const MAX_CANVAS_PIXELS = 4_000_000;

export default function PdfPreview({ url, name }: { url: string; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1),
    [zoom, setZoom] = useState(1),
    [width, setWidth] = useState(600);
  const [error, setError] = useState(''),
    [text, setText] = useState(''),
    [rendering, setRendering] = useState(true);
  const [password, setPassword] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState<{
    reason: number;
    submit: (password: string) => void;
  } | null>(null);
  useEffect(() => {
    setDocument(null);
    setPage(1);
    setError('');
    setText('');
    setPasswordPrompt(null);
    let active = true;
    const loading = getDocument({
      url,
      withCredentials: true,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      maxImageSize: 16_000_000,
      canvasMaxAreaInBytes: 16_000_000,
      cMapUrl: `${assetBase}cmaps/`,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      wasmUrl: `${assetBase}wasm/`,
      iccUrl: `${assetBase}iccs/`
    });
    loading.onPassword = (submit: (password: string) => void, reason: number) => {
      if (active) setPasswordPrompt({ submit, reason });
    };
    void loading.promise
      .then((value) => {
        if (active) {
          setDocument(value);
          setPasswordPrompt(null);
        }
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
      void loading.destroy();
    };
  }, [url]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document) return;
    let active = true,
      render: RenderTask | undefined;
    setRendering(true);
    setError('');
    setText('');
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        if (!active || !canvas.current) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const cssScale = Math.max(0.1, width / natural.width) * zoom;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.min(
          cssScale * ratio,
          Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height))
        );
        const viewport = pdfPage.getViewport({ scale });
        const target = canvas.current;
        target.width = Math.ceil(viewport.width);
        target.height = Math.ceil(viewport.height);
        target.style.width = `${natural.width * cssScale}px`;
        target.style.height = `${natural.height * cssScale}px`;
        render = pdfPage.render({ canvas: target, viewport, background: '#ffffff' });
        const content = await pdfPage.getTextContent();
        if (active) setText(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
        await render.promise;
        if (active) setRendering(false);
      })
      .catch((cause) => {
        if (active) {
          setError(message(cause));
          setRendering(false);
        }
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page, zoom, width]);
  return (
    <section className="pdf-viewer" aria-label={`${name} document`}>
      <div className="pdf-toolbar">
        <Button
          disabled={!document || page === 1}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          Previous page
        </Button>
        <Field label="Page">
          <input
            type="number"
            min={1}
            max={document?.numPages ?? 1}
            value={page}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (document && Number.isInteger(value) && value >= 1 && value <= document.numPages)
                setPage(value);
            }}
          />
        </Field>
        <span>of {document?.numPages ?? '…'}</span>
        <Button
          disabled={!document || page === document.numPages}
          onClick={() => setPage((value) => Math.min(document?.numPages ?? value, value + 1))}
        >
          Next page
        </Button>
        <Field label="Zoom">
          <select
            aria-label="Zoom"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            <option value={1}>Fit width</option>
            <option value={1.5}>150%</option>
            <option value={2}>200%</option>
            <option value={3}>300%</option>
          </select>
        </Field>
        <a className="button" href={url} download={name}>
          Download PDF
        </a>
      </div>
      {passwordPrompt && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            passwordPrompt.submit(password);
            setPassword('');
            setPasswordPrompt(null);
          }}
        >
          <Field
            label={passwordPrompt.reason === 2 ? 'Incorrect password. Try again' : 'PDF password'}
          >
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
            />
          </Field>
          <Button type="submit">Open document</Button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error} You can download the complete PDF above.
        </p>
      )}
      {!error && rendering && (
        <p className="muted" role="status">
          Rendering page {page}…
        </p>
      )}
      <div className="pdf-page-scroll" ref={container}>
        <canvas ref={canvas} aria-label={`Page ${page} of ${name}`} role="img" />
      </div>
      {text && (
        <details>
          <summary>Readable page text</summary>
          <p className="pdf-page-text">{text}</p>
        </details>
      )}
    </section>
  );
}
