import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&url';
import { Button, Field } from '../ui.js';
import { message } from './format.js';
import './pdf-preview.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const assetBase = '/pdfjs/';
const MAX_CANVAS_PIXELS = 4_000_000;
/** Pages rendered ahead of and behind the viewport while scrolling. */
const OVERSCAN_PAGES = 2;
/** A page is released again once it sits this far outside the viewport. */
const RELEASE_PAGES = 4;

interface PageHandle {
  proxy: PDFPageProxy;
  render?: RenderTask;
}

/**
 * A continuously scrolling PDF: every page is its own canvas, laid out top to bottom in one
 * scroller, rendered as it approaches the viewport and released when it leaves. No page turns - the
 * document reads like a document.
 *
 * One canvas per page is what makes both directions cheap to be wrong about. A rendered page costs
 * its canvas memory; an unrendered one costs a placeholder sized from the page's own aspect ratio,
 * so the scrollbar is honest before anything draws. The intersection observer schedules work, and
 * a page that scrolls away before its render starts is cancelled for free.
 */
export default function PdfPreview({ url, name }: { url: string; name: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const [documentProxy, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageSizes, setPageSizes] = useState<Array<{ width: number; height: number }> | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [passwordPrompt, setPasswordPrompt] = useState<{
    reason: number;
    submit: (password: string) => void;
  } | null>(null);
  const [rendered, setRendered] = useState<Set<number>>(() => new Set());
  const pages = useMemo(
    () => Array.from({ length: pageCount }, (_, index) => index + 1),
    [pageCount]
  );
  const handles = useRef(new Map<number, PageHandle>());
  const firstPageRatio = useRef<number | null>(null);

  useEffect(() => {
    setDocument(null);
    setPageCount(0);
    setPageSizes(null);
    firstPageRatio.current = null;
    setError('');
    setPasswordPrompt(null);
    let active = true;
    const loading = getDocument({
      url,
      assetBase,
      ...(password ? { password } : {})
    } as Parameters<typeof getDocument>[0]);
    loading.onPassword = (submit: (password: string) => void, reason: number) => {
      if (active) setPasswordPrompt({ submit, reason });
    };
    void loading.promise
      .then(async (value) => {
        if (!active) {
          await value.cleanup();
          return value;
        }
        setDocument(value);
        setPageCount(value.numPages);
        // Page sizes are measured once, from the document itself, so every placeholder has the
        // right aspect ratio before a single pixel renders. The first page's ratio stands in for
        // the rest when the provider withholds per-page geometry.
        const sizes: Array<{ width: number; height: number }> = [];
        for (let number = 1; number <= value.numPages; number += 1) {
          const page = await value.getPage(number);
          const viewport = page.getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }
        if (!active) {
          await value.cleanup();
          return value;
        }
        setPageSizes(sizes);
        return value;
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
      for (const handle of handles.current.values()) handle.render?.cancel();
      handles.current.clear();
      void loading.destroy();
    };
  }, [url, password]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width;
      if (measured) setWidth(measured);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Renders and releases pages as the viewport moves. The whole set is re-derived from one
  // intersection pass, so the cost is a map scan per scroll frame - no per-page observers to
  // churn when the document is long.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !document || !pageSizes) return;
    let frame = 0;
    const pass = () => {
      const bounds = element.getBoundingClientRect();
      const viewTop = element.scrollTop - bounds.height * OVERSCAN_PAGES;
      const viewBottom = element.scrollTop + bounds.height * (OVERSCAN_PAGES + 1);
      let offsets = 0;
      const next = new Set<number>();
      const release = new Set<number>();
      for (let number = 1; number <= pageCount; number += 1) {
        const size = pageSizes[number - 1];
        const cssScale = Math.max(0.1, width / (size?.width ?? width)) * zoom;
        const pageHeight = (size?.height ?? size?.width ?? width) * cssScale;
        const top = offsets;
        const bottom = offsets + pageHeight;
        offsets = bottom;
        if (bottom >= viewTop && top <= viewBottom) next.add(number);
        else if (
          bottom < viewTop - pageHeight * RELEASE_PAGES ||
          top > viewBottom + pageHeight * RELEASE_PAGES
        )
          release.add(number);
      }
      for (const number of release) {
        const handle = handles.current.get(number);
        if (!handle) continue;
        handle.render?.cancel();
        handle.proxy.cleanup();
        handles.current.delete(number);
      }
      setRendered((current) => {
        const changed = [...next].some((number) => !current.has(number));
        if (!changed && current.size === next.size) return current;
        const merged = new Set(current);
        for (const number of next) merged.add(number);
        for (const number of merged)
          if (!next.has(number) && release.has(number)) merged.delete(number);
        return merged;
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(pass);
    };
    schedule();
    element.addEventListener('scroll', schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener('scroll', schedule);
    };
  }, [document, pageSizes, pageCount, width, zoom]);

  // One render per visible page. A canvas holds its pixels until release; a re-render happens
  // only when the page's own scale changed under it.
  useEffect(() => {
    if (!documentProxy || !pageSizes) return;
    let active = true;
    for (const number of rendered) {
      if (handles.current.has(number)) continue;
      void documentProxy.getPage(number).then(async (proxy) => {
        if (!active) return proxy.cleanup();
        const host = pageRefs.current.get(number);
        if (!host) return proxy.cleanup();
        const existing = handles.current.get(number);
        if (existing) {
          if (existing.render) existing.render.cancel();
          else return proxy.cleanup();
        }
        const natural = proxy.getViewport({ scale: 1 });
        const cssScale = Math.max(0.1, width / natural.width) * zoom;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const scale = Math.min(
          cssScale * ratio,
          Math.sqrt(MAX_CANVAS_PIXELS / (natural.width * natural.height))
        );
        const viewport = proxy.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${natural.width * cssScale}px`;
        canvas.style.height = `${natural.height * cssScale}px`;
        canvas.setAttribute('aria-label', `Page ${number} of ${name}`);
        canvas.setAttribute('role', 'img');
        host.replaceChildren(canvas);
        const render = proxy.render({ canvas, viewport, background: '#ffffff' });
        handles.current.set(number, { proxy, render });
        await render.promise.catch(() => undefined);
      });
    }
    return () => {
      active = false;
    };
  }, [document, pageSizes, rendered, width, zoom, name]);

  // Jump-to-page on scroll position, so the toolbar's page field tracks where the reader is.
  useEffect(() => {
    const element = scroller.current;
    if (!element || !pageSizes) return;
    const onScroll = () => {
      const bounds = element.getBoundingClientRect();
      const middle = element.scrollTop + bounds.height / 2;
      let offsets = 0;
      for (let number = 1; number <= pageCount; number += 1) {
        const size = pageSizes[number - 1];
        const cssScale = Math.max(0.1, width / (size?.width ?? width)) * zoom;
        const pageHeight = (size?.height ?? size?.width ?? width) * cssScale;
        if (middle >= offsets && middle < offsets + pageHeight) {
          setCurrentPage(number);
          return;
        }
        offsets += pageHeight;
      }
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [pageSizes, pageCount, width, zoom]);

  const [currentPage, setCurrentPage] = useState(1);
  const scrollToPage = (value: number) => {
    const element = scroller.current;
    if (!element || !pageSizes) return;
    let offsets = 0;
    for (let number = 1; number < value; number += 1) {
      const size = pageSizes[number - 1];
      const cssScale = Math.max(0.1, width / (size?.width ?? width)) * zoom;
      offsets += (size?.height ?? size?.width ?? width) * cssScale;
    }
    element.scrollTo({ top: offsets });
  };

  return (
    <section className="pdf-viewer" aria-label={`${name} document`}>
      <div className="pdf-toolbar">
        <Field label="Page">
          <input
            type="number"
            min={1}
            max={pageCount || 1}
            value={currentPage}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 1 && value <= pageCount) scrollToPage(value);
            }}
          />
        </Field>
        <span>of {pageCount || '…'}</span>
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
        <Button
          disabled={currentPage <= 1}
          onClick={() => scrollToPage(Math.max(1, currentPage - 1))}
        >
          Previous page
        </Button>
        <Button
          disabled={!pageCount || currentPage >= pageCount}
          onClick={() => scrollToPage(Math.min(pageCount, currentPage + 1))}
        >
          Next page
        </Button>
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
      <div className="pdf-page-scroll" ref={scroller}>
        {pageSizes
          ? pages.map((number) => {
              const size = pageSizes[number - 1];
              const cssScale = Math.max(0.1, width / (size?.width ?? width)) * zoom;
              return (
                <div
                  className="pdf-page"
                  key={number}
                  ref={(host) => {
                    if (host) pageRefs.current.set(number, host);
                    else pageRefs.current.delete(number);
                  }}
                  style={{
                    width: (size?.width ?? width) * cssScale,
                    height: (size?.height ?? size?.width ?? width) * cssScale
                  }}
                >
                  {rendered.has(number) ? null : (
                    <span className="pdf-page-placeholder">Page {number}</span>
                  )}
                </div>
              );
            })
          : null}
      </div>
    </section>
  );
}
