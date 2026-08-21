import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '../../../../shared/components';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import { DownloadFileButton } from './DownloadFileButton';
import type { FileRendererProps } from './types';

// pdf.js parses on a worker thread; the `?url` import hands Vite the worker
// file to emit as an asset and gives us its URL to point the library at.
// Module-level (not per-mount): the worker location is process-wide state.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Inline PDF viewer on `pdfjs-dist` — page-by-page canvas rendering with a
 * Prev/Next pager, fit-to-width scaling, and a Download affordance.
 *
 * This replaced the old `<iframe src={blobUrl}>` handoff to the browser's
 * built-in viewer: that one drew its own chrome (toolbar, sidebar, its own
 * dark theme) inside our pane and rendered nothing at all where the built-in
 * viewer is disabled or absent (hardened browsers, some WebViews). Rendering
 * the pages ourselves costs a lazy-loaded chunk (see `renderers/index.ts` —
 * pdf.js is why this renderer is code-split) and buys a viewer that is the
 * same surface everywhere.
 *
 * Rendering is one page at a time, on purpose: decks and reports in a KB run
 * to hundreds of pages, and rasterizing all of them up front is exactly the
 * memory profile an embedded viewer must not have. The pager is the honest
 * shape of that decision.
 *
 * View-only: there is no edit mode for PDFs. The renderer ignores
 * `onSave` / `onValueChange` / `readOnly`.
 */
export function PdfRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The page whose render last COMPLETED. Its cached resources are released
  // only after the NEXT page's render settles — never mid-render (pdf.js
  // corrupts a render whose page is cleaned up under it).
  // The loading task, kept in a ref: it owns the worker-side document, and the
  // page-render effect must be able to release it when it gives up for good.
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);

  /** Tear down the worker-side document and forget it. Safe to call twice. */
  const releaseDoc = useCallback(() => {
    loadingTaskRef.current?.destroy().catch(() => {});
    loadingTaskRef.current = null;
    setDoc(null);
  }, []);

  const renderedPageRef = useRef<PDFPageProxy | null>(null);
  // Fit-to-width: the page is scaled so its width matches the container's.
  // 0 = not measured yet; the render effect waits for a real measurement so
  // the first paint is already at the right size instead of flashing 1:1.
  const [width, setWidth] = useState(0);

  useEffect(() => {
    // Reset stale state from a prior filePath / workspaceId before starting
    // the new load — including teardown (workspaceId → null). The rendered-
    // page ref dies with its document (task.destroy frees the pages).
    setDoc(null);
    setPageNumber(1);
    setError(null);
    renderedPageRef.current = null;

    if (!workspaceId) return;

    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    (async () => {
      try {
        const res = await authFetch(
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load PDF (HTTP ${res.status})`);
          return;
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        let loadedDoc: PDFDocumentProxy;
        try {
          // The TASK is retained (not just the resolved doc) so cleanup can
          // tear it down in every state: still loading, resolved, or a doc
          // that resolves only AFTER cancellation.
          loadingTask = getDocument({ data: new Uint8Array(buffer) });
          loadingTaskRef.current = loadingTask;
          loadedDoc = await loadingTask.promise;
        } catch (parseErr) {
          // A destroyed task rejects its promise — that is this effect's own
          // cleanup, not a parse failure to report.
          if (cancelled) return;
          // A REJECTED task still holds worker-side state. Tear it down now —
          // the error view may stay mounted indefinitely — and null the ref so
          // the effect cleanup doesn't destroy it a second time.
          loadingTask?.destroy().catch(() => {});
          loadingTaskRef.current = null;
          loadingTask = null;
          // The bytes arrived but pdf.js rejected them — a renamed file, a
          // truncated upload. Distinct copy from the transport failure above.
          console.warn('[PdfRenderer] parse failed:', parseErr);
          setError('This file could not be parsed as a PDF.');
          return;
        }
        // Resolved after cancellation: cleanup already destroyed the task
        // (which destroys the document with it) — just don't publish it.
        if (cancelled) return;
        setDoc(loadedDoc);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      // Destroying the loading task frees the worker-side document and every
      // cached page, whether the load is mid-flight or long resolved.
      loadingTask?.destroy().catch(() => {});
      loadingTaskRef.current = null;
    };
  }, [workspaceId, filePath]);

  // Track the page column's width so the canvas re-renders to fit it. The
  // container only mounts once the document is loaded, hence the `doc` dep.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    // happy-dom (tests) has no ResizeObserver; the initial measure suffices.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [doc]);

  // The render task most recently STARTED, surviving across effect runs: a
  // canvas can only host one render at a time, and pdf.js rejects a second
  // render() while the previous one — cancelled or not — has yet to settle.
  // Each effect run parks on this before it draws.
  const renderTaskRef = useRef<{ promise: Promise<unknown>; cancel(): void } | null>(null);

  // Render the current page into the canvas whenever the page or the width
  // changes. Cancellation matters twice over: a rapid Next-Next leaves the
  // first render mid-flight (pdf.js throws RenderingCancelledException into
  // the awaited promise), and a canvas can only host one render at a time.
  useEffect(() => {
    if (!doc || width <= 0) return;
    // The loading task `doc` belongs to, captured now: if this render loses a
    // race with a file switch (the load effect destroys the task — and the doc
    // under it — before the null doc flushes), the failure path below must
    // neither report an error over the NEW file nor release the new file's
    // loading task.
    const task = loadingTaskRef.current;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let renderTask: { promise: Promise<unknown>; cancel(): void } | null = null;
    // Cancelled AFTER its render task settled: this page will never be the
    // displayed one, so its resources go now — never the on-screen page's,
    // and never mid-render (any superseding effect is still parked on this
    // task's promise, so no render is active on the page).
    const releaseCancelledPage = () => {
      if (renderTask && page && page !== renderedPageRef.current) page.cleanup();
    };
    (async () => {
      try {
        // Wait out the previous render (its own cleanup has already requested
        // cancellation): starting a second render on the shared canvas before
        // the first settles is the concurrent use pdf.js rejects.
        const priorTask = renderTaskRef.current;
        if (priorTask) await priorTask.promise.catch(() => {});
        if (cancelled) return;
        page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const base = page.getViewport({ scale: 1 });
        const cssScale = width / base.width;
        // Render at device resolution, display at CSS size — otherwise text
        // is visibly blurry on any HiDPI screen.
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: cssScale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        // v5 API: hand over the canvas itself; pdf.js takes the 2D context.
        const startedTask: { promise: Promise<unknown>; cancel(): void } = page.render({
          canvas,
          viewport,
        });
        renderTask = startedTask;
        renderTaskRef.current = startedTask;
        await startedTask.promise;
        if (cancelled) {
          releaseCancelledPage();
          return;
        }
        // THIS page's render has settled, so the PRIOR page's cached
        // resources (fonts, operator lists) can be released. Sequenced here
        // — after the render task resolves — because cleanup() during an
        // active render is the one forbidden call.
        const prior = renderedPageRef.current;
        if (prior && prior !== page) prior.cleanup();
        renderedPageRef.current = page;
      } catch (err) {
        // A cancelled render is this effect's own cleanup, not a failure.
        if (cancelled || (err as Error | null)?.name === 'RenderingCancelledException') {
          releaseCancelledPage();
          return;
        }
        // Superseded by a file switch mid-render: the load effect owns that
        // teardown (this failure is its fallout), and `loadingTaskRef` may by
        // now hold the NEW file's task — which must not be destroyed here.
        if (task === null || loadingTaskRef.current !== task) return;
        console.error('[PdfRenderer] page render failed:', err);
        // The error view is terminal, so nothing will read `doc` again: release it
        // (and the loading task it retains) rather than leaving worker-side PDF
        // resources held for the lifetime of the view.
        setError(`Could not render page ${pageNumber}.`);
        releaseDoc();
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, pageNumber, width]);

  const goTo = useCallback(
    (delta: number) => {
      setPageNumber((current) => {
        const total = doc?.numPages ?? 1;
        return Math.min(total, Math.max(1, current + delta));
      });
    },
    [doc],
  );

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-ui text-danger">{error}</p>
        {/* The rendering failed; the bytes may still be perfectly good to
            someone with a desktop viewer. */}
        <DownloadFileButton filePath={filePath} />
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex h-full items-center justify-center text-ui text-ink-muted">
        Loading PDF…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line pb-2">
        <Button
          variant="quiet"
          size="tiny"
          leadingIcon={<ChevronLeft size={13} />}
          onClick={() => goTo(-1)}
          disabled={pageNumber <= 1}
          title="Previous page"
        >
          Prev
        </Button>
        <span aria-live="polite" className="text-detail text-ink-muted whitespace-nowrap">
          Page {pageNumber} of {doc.numPages}
        </span>
        <Button
          variant="quiet"
          size="tiny"
          onClick={() => goTo(1)}
          disabled={pageNumber >= doc.numPages}
          title="Next page"
        >
          Next
          <ChevronRight size={13} />
        </Button>
        <span className="flex-1" />
        <DownloadFileButton filePath={filePath} />
      </div>
      {/* The measured column. Fit-to-width means horizontal scrolling never
          happens; tall pages scroll vertically inside this pane. */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-3">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${filePath}, page ${pageNumber} of ${doc.numPages}`}
          className="block rounded-xs border border-line bg-white"
        />
      </div>
    </div>
  );
}
