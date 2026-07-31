import { memo, useEffect, useRef, useState, useCallback } from 'react';
import mermaid from 'mermaid';
import { ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  darkMode: true,
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  themeVariables: {
    darkMode: true,
    background: '#171717',
    primaryColor: '#3b82f6',
    primaryTextColor: '#e5e5e5',
    primaryBorderColor: '#525252',
    lineColor: '#737373',
    secondaryColor: '#1e3a5f',
    tertiaryColor: '#262626',
  },
});

let diagramCounter = 0;

interface MermaidDiagramProps {
  code: string;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 20;
const ZOOM_FACTOR = 0.15;

export const MermaidDiagram = memo(function MermaidDiagram({ code }: MermaidDiagramProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgContainerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  // Use refs for transform state so the wheel handler always sees current values
  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const [, forceRender] = useState(0);
  const rerender = useCallback(() => forceRender(n => n + 1), []);

  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });
  const translateStart = useRef({ x: 0, y: 0 });

  // Render mermaid SVG
  useEffect(() => {
    const el = svgContainerRef.current;
    if (!el) return;

    let cancelled = false;
    const id = `mermaid-diagram-${++diagramCounter}`;

    (async () => {
      try {
        const { svg } = await mermaid.render(id, code);
        if (cancelled) return;
        el.innerHTML = svg;
        setError(null);

        const svgEl = el.querySelector('svg');
        if (svgEl) {
          svgEl.style.maxWidth = 'none';
          svgEl.style.height = 'auto';
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to render diagram');
        el.innerHTML = '';
      }
    })();

    return () => { cancelled = true; };
  }, [code]);

  // Reset view when code changes
  useEffect(() => {
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    rerender();
  }, [code, rerender]);

  // Native wheel listener (non-passive so we can preventDefault)
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    function onWheel(e: WheelEvent) {
      e.preventDefault();

      const oldScale = scaleRef.current;
      const factor = e.deltaY > 0 ? 1 - ZOOM_FACTOR : 1 + ZOOM_FACTOR;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor));

      // Zoom toward cursor position
      const rect = viewport!.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;

      const t = translateRef.current;
      const ratio = newScale / oldScale;
      translateRef.current = {
        x: cursorX - ratio * (cursorX - t.x),
        y: cursorY - ratio * (cursorY - t.y),
      };
      scaleRef.current = newScale;
      rerender();
    }

    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [rerender]);

  // Track the active pointer so a stray second touch (e.g. user resting a
  // thumb mid-drag) doesn't hijack the pan. Single-pointer pan only; pinch
  // zoom is intentionally left to the visible +/- buttons for now.
  const activePointerId = useRef<number | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    // For mouse pointers, only react to the primary button.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (activePointerId.current !== null) return;
    activePointerId.current = e.pointerId;
    // setPointerCapture keeps move/up events flowing to this element even if
    // the pointer drifts outside its bounds — without it, releasing a touch
    // outside the diagram never fires pointerup and the diagram stays "stuck"
    // in panning mode.
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY };
    translateStart.current = { ...translateRef.current };
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (activePointerId.current !== e.pointerId) return;
    translateRef.current = {
      x: translateStart.current.x + (e.clientX - panStart.current.x),
      y: translateStart.current.y + (e.clientY - panStart.current.y),
    };
    rerender();
  }, [rerender]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (activePointerId.current !== e.pointerId) return;
    // Symmetric with the setPointerCapture in handlePointerDown. Browsers
    // typically release capture implicitly on pointerup, but pointercancel
    // semantics vary across engines and `releasePointerCapture` is a no-op
    // when the pointer is no longer captured, so calling it unconditionally
    // here keeps both code paths consistent.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    activePointerId.current = null;
    setIsPanning(false);
  }, []);

  const zoomIn = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const oldScale = scaleRef.current;
    const newScale = Math.min(MAX_SCALE, oldScale * (1 + ZOOM_FACTOR));
    const ratio = newScale / oldScale;
    const t = translateRef.current;
    translateRef.current = { x: cx - ratio * (cx - t.x), y: cy - ratio * (cy - t.y) };
    scaleRef.current = newScale;
    rerender();
  }, [rerender]);

  const zoomOut = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    const oldScale = scaleRef.current;
    const newScale = Math.max(MIN_SCALE, oldScale * (1 - ZOOM_FACTOR));
    const ratio = newScale / oldScale;
    const t = translateRef.current;
    translateRef.current = { x: cx - ratio * (cx - t.x), y: cy - ratio * (cy - t.y) };
    scaleRef.current = newScale;
    rerender();
  }, [rerender]);

  const resetView = useCallback(() => {
    scaleRef.current = 1;
    translateRef.current = { x: 0, y: 0 };
    rerender();
  }, [rerender]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200/50 bg-red-50 p-4 my-4">
        <p className="text-xs text-red-600 font-medium mb-1">Mermaid diagram error</p>
        <pre className="text-xs text-red-700/70 whitespace-pre-wrap">{error}</pre>
        <pre className="mt-2 text-xs text-slate-600 whitespace-pre-wrap">{code}</pre>
      </div>
    );
  }

  const scale = scaleRef.current;
  const translate = translateRef.current;

  return (
    <div className="relative my-4 rounded-lg border border-slate-300 bg-white overflow-hidden group">
      {/* Zoom controls */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={zoomOut}
          className="p-1.5 rounded bg-slate-100/90 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={14} />
        </button>
        <span className="text-xs text-slate-600 min-w-[3rem] text-center tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={zoomIn}
          className="p-1.5 rounded bg-slate-100/90 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={14} />
        </button>
        <button
          onClick={resetView}
          className="p-1.5 rounded bg-slate-100/90 hover:bg-slate-200 text-slate-600 hover:text-slate-900 transition-colors"
          title="Reset view"
        >
          <Maximize2 size={14} />
        </button>
      </div>

      {/* Pannable / zoomable diagram area */}
      <div
        ref={viewportRef}
        className="overflow-hidden"
        // touchAction: 'none' stops the browser from claiming the gesture for
        // page scrolling, so a finger drag inside the diagram pans the SVG
        // instead of scrolling the chat behind it.
        style={{
          cursor: isPanning ? 'grabbing' : 'grab',
          minHeight: 200,
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <div
          ref={svgContainerRef}
          className="p-4 [&_svg]:mx-auto"
          style={{
            transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
            transformOrigin: '0 0',
            transition: isPanning ? 'none' : 'transform 0.15s ease-out',
          }}
        />
      </div>
    </div>
  );
});
