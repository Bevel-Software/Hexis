import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Pencil, Eye, RotateCw } from 'lucide-react';
import { useFileNav } from '../../routing/kb-routes';
import type { FileRendererProps, RendererSaveState } from './types';
import { buildSandboxedHtml, sanitizeAgentHtml } from './htmlSandbox';
import { useRendererSurface } from './rendererSurface';
import { Button, Dialog } from '../../../../shared/components';
import {
  PageConsent,
  PageToolsClient,
  answerToolCall,
  asToolCall,
  pageName,
  useOpenPageInPlatform,
  usePageTools,
} from './htmlToolBridge';
import {
  HTML_FRAME_KEY_STEP,
  HTML_FRAME_MAX_HEIGHT,
  HTML_FRAME_MIN_HEIGHT,
  HTML_FRAME_STANDARD_HEIGHT,
  attachFrameResizeHandle,
} from './frameResizeHandle';

/**
 * The card the app shows over a page, outside its frame: the page cannot draw,
 * see or answer it. `write`: the page's first writing call asks the viewer.
 * `platform`: a page that needs tools asked for them where there are none.
 */
type PageCard = { kind: 'write' | 'platform'; answer: (ok: boolean | null) => void };

/**
 * Where the reader's chosen frame height is kept, per browser: a
 * convenience, like a remembered tab. A browser that cannot store it is
 * asked nothing and shows the standard height each time.
 */
const FRAME_HEIGHT_KEY = 'bevel.htmlFrame.height';

function rememberedFrameHeight(): number {
  try {
    const stored = Number(window.localStorage.getItem(FRAME_HEIGHT_KEY));
    return Number.isFinite(stored) && stored >= HTML_FRAME_MIN_HEIGHT && stored <= HTML_FRAME_MAX_HEIGHT
      ? Math.round(stored)
      : HTML_FRAME_STANDARD_HEIGHT;
  } catch {
    return HTML_FRAME_STANDARD_HEIGHT;
  }
}

function rememberFrameHeight(height: number): void {
  try {
    window.localStorage.setItem(FRAME_HEIGHT_KEY, String(height));
  } catch {
    // Not stored: the standard height next time, which is no worse than today.
  }
}

export function HtmlRenderer({
  content,
  savedContent,
  filePath,
  onSave,
  onDirtyChange,
  onValueChange,
  onSaveStateChange,
  readOnly = false,
}: FileRendererProps) {
  const { openLink, openFilePage } = useFileNav();
  const surface = useRendererSurface();
  // Whether the surface's host grows with the page (an issue panel) rather
  // than giving it a pane to scroll in (the app, the MCP App's pane).
  const sizesToContent = surface?.sizesToContent === true;
  // The viewer's tools, for a page on a host that provides them (the file
  // page, the skill page — `PageToolsContext` lists them). Everywhere else
  // the page gets `bevel.tools = null`.
  const pageTools = usePageTools();
  const openPageInPlatform = useOpenPageInPlatform();
  const toolPagePath = surface === null && pageTools ? pageTools.pagePath : null;
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  /**
   * The frame's height where the host grows with the page: the standard
   * height, or the one this reader last chose in this browser; the reader
   * drags the handle under the frame to change it. Never derived from the
   * page — a frame is its own document, and a height read off a page that
   * is itself laid out in the frame feeds back into itself.
   */
  const [frameHeight, setFrameHeight] = useState(() => (sizesToContent ? rememberedFrameHeight() : HTML_FRAME_STANDARD_HEIGHT));
  const frameHeightRef = useRef(frameHeight);
  const [dragging, setDragging] = useState(false);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState(content);
  const [savedValue, setSavedValue] = useState(savedContent ?? content);
  const [saveState, setSaveState] = useState<RendererSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bundledSrcdoc, setBundledSrcdoc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const prevFilePathRef = useRef(filePath);
  const [card, setCard] = useState<PageCard | null>(null);
  const cardRef = useRef<PageCard | null>(null);
  const toolsClient = useMemo(() => (toolPagePath ? new PageToolsClient(toolPagePath) : null), [toolPagePath]);
  // The viewer's answer about this page's writes holds for one VIEW of it: a
  // new frame document (a reload, a saved edit, another file) asks again.
  const consentRef = useRef<PageConsent | null>(null);

  const dirty = !readOnly && value !== savedValue;

  useEffect(() => {
    const fileChanged = prevFilePathRef.current !== filePath;
    prevFilePathRef.current = filePath;
    setValue(content);
    setSavedValue(savedContent ?? content);
    setSaveState('idle');
    setSaveError(null);
    if (fileChanged) {
      setMode('preview');
      setReloadKey((k) => k + 1);
    }
  }, [content, savedContent, filePath]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);

  // Build the iframe document whenever we enter preview mode or the saved
  // content changes. The agent's HTML is sanitized to strip any external URLs
  // (defense in depth — CSP also blocks them at runtime), then bundled with
  // the KB's JS library inlined as a `<script type="module">`. The result is a
  // fully self-contained srcdoc — the iframe makes no network calls of any kind.
  useEffect(() => {
    if (mode !== 'preview') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- safe transient reset before rebuild
    setPreviewError(null);
    try {
      const doc = buildSandboxedHtml({
        title: filePath,
        // Core ships no inlined vendor libraries. (The enterprise build inlines
        // d3 + mermaid and the KB graph client here — the knowledge system,
        // including the graph API the client talks to, is an enterprise
        // extension.)
        libModuleSources: [],
        bodyHtml: sanitizeAgentHtml(savedValue),
        toolBridge: toolPagePath !== null,
      });
      setBundledSrcdoc(doc);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to build preview');
    }
  }, [mode, savedValue, filePath, reloadKey, toolPagePath]);

  // (The enterprise build additionally installs a postMessage bridge here that
  // serves the iframe's KB-graph client from `/api/workspace/:id/graph` — the
  // knowledge system is an enterprise extension, so the core renderer has no
  // graph bridge.)

  // Navigation bridge: agent HTML deep-links into the KB by calling
  // `window.bevel.openNode(href)` or clicking an `<a>` whose href points at a
  // node — both post a `bevel.navigate` message (the iframe sandbox can't
  // navigate the host window itself). `openLink` resolves the href the same
  // way the markdown renderer does (absolute `/workspace/…` URLs keep their
  // branch; relative paths resolve against this file) and routes it through
  // the in-app navigation so the URL reflects what's on screen.
  useEffect(() => {
    function onNavMessage(event: MessageEvent) {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;
      const msg = event.data as { type?: unknown; href?: unknown } | null;
      if (!msg || typeof msg !== 'object' || msg.type !== 'bevel.navigate') return;
      const href = typeof msg.href === 'string' ? msg.href : null;
      if (!href) return;
      openLink(href, filePath);
    }
    window.addEventListener('message', onNavMessage);
    return () => window.removeEventListener('message', onNavMessage);
  }, [openLink, filePath]);

  /** Show one of the app's cards over the page and resolve with the viewer's answer. A card already up answers this ask too. */
  function showCard(kind: PageCard['kind']): Promise<boolean | null> {
    const open = cardRef.current;
    if (open && open.kind === kind) {
      return new Promise((resolve) => {
        const first = open.answer;
        open.answer = (ok) => {
          first(ok);
          resolve(ok);
        };
      });
    }
    return new Promise((resolve) => {
      const next: PageCard = { kind, answer: resolve };
      cardRef.current = next;
      setCard(next);
    });
  }

  /** Close the card with the viewer's answer, or null when the view went before they gave one. */
  const closeCard = useCallback((ok: boolean | null) => {
    const open = cardRef.current;
    cardRef.current = null;
    setCard(null);
    open?.answer(ok);
  }, []);

  // When the page's document goes (a reload, a saved edit, another file, or
  // Edit, which unmounts the frame even when the document comes back the same)
  // its consent goes with it, and a card left open answers no: nothing the old
  // view asked for runs in the new one.
  useEffect(
    () => () => {
      consentRef.current = null;
      closeCard(null);
    },
    [bundledSrcdoc, reloadKey, mode, closeCard],
  );

  // Tool bridge: a page's `window.bevel.tools` calls and its
  // `requireTools()`, posted by the runtime in the frame (see
  // `htmlSandbox.ts`), answered here with the viewer's session.
  useEffect(() => {
    function onToolMessage(event: MessageEvent) {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;
      const reply = (message: unknown) => {
        // Only to the document that asked: a reloaded frame is a new window.
        if (iframeRef.current?.contentWindow === iframeWin) iframeWin.postMessage(message, '*');
      };
      const data = event.data as { type?: unknown; requestId?: unknown } | null;
      if (data && data.type === 'bevel.tools.require' && typeof data.requestId === 'string') {
        const requestId = data.requestId;
        if (toolsClient) {
          reply({ type: 'bevel.tools.require.response', requestId, ok: true, result: true });
          return;
        }
        void showCard('platform').then(() =>
          // Either way the page that asked carries on without tools: Open in
          // the platform opened it elsewhere, it did not give it tools here.
          reply({ type: 'bevel.tools.require.response', requestId, ok: true, result: false }),
        );
        return;
      }
      const call = asToolCall(data);
      if (!call) return;
      if (!toolsClient) {
        reply({
          type: 'bevel.tool.response',
          requestId: call.requestId,
          ok: false,
          error: 'Tools are only available on the page in the platform.',
          code: 'unavailable',
        });
        return;
      }
      consentRef.current ??= new PageConsent(() => showCard('write'));
      void answerToolCall(call, toolsClient, consentRef.current).then(reply);
    }
    window.addEventListener('message', onToolMessage);
    return () => window.removeEventListener('message', onToolMessage);
  }, [toolsClient]);

  const openInPlatform = useCallback(() => {
    closeCard(false);
    // The host's own way when it has one (a skill page, whose filePath is
    // relative to the skill); otherwise the file page, by an address that
    // asks for it outright: on the embed the surface opens it through the
    // host in a new tab, which carries no router state, and a page inside a
    // skill's folder would otherwise open as that skill's page again.
    if (openPageInPlatform) openPageInPlatform();
    else openFilePage(filePath);
  }, [closeCard, openPageInPlatform, openFilePage, filePath]);

  useEffect(() => {
    frameHeightRef.current = frameHeight;
  }, [frameHeight]);

  // The handle under the frame, where the host grows with the page: a drag
  // or the arrow keys set the frame's height, and a height the reader
  // settled on is remembered in this browser. Attached whenever the handle
  // is on screen — it comes and goes with the preview.
  useEffect(() => {
    const handle = handleRef.current;
    if (!sizesToContent || !handle) return;
    return attachFrameResizeHandle(handle, {
      current: () => frameHeightRef.current,
      apply: (height) => {
        setDragging(true);
        setFrameHeight(height);
      },
      settle: (height) => {
        setDragging(false);
        setFrameHeight(height);
        rememberFrameHeight(height);
      },
      min: HTML_FRAME_MIN_HEIGHT,
      max: HTML_FRAME_MAX_HEIGHT,
      step: HTML_FRAME_KEY_STEP,
    });
  }, [sizesToContent, mode, previewError, bundledSrcdoc]);

  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly || value === savedValue) return true;
    setSaveState('saving');
    setSaveError(null);
    try {
      await onSave(value);
      setSavedValue(value);
      setSaveState('idle');
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
      return false;
    }
  }, [readOnly, value, savedValue, onSave]);

  const switchToPreview = useCallback(() => {
    void (async () => {
      const ok = await save();
      if (ok) setMode('preview');
    })();
  }, [save]);

  const switchToEdit = useCallback(() => {
    if (!readOnly) setMode('edit');
  }, [readOnly]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    onValueChange?.(next);
  }, [onValueChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      void save();
    }
  }, [save]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 pb-3 border-b border-line mb-3 shrink-0">
        {!readOnly && (
          <button
            onClick={switchToEdit}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xs text-xs font-medium transition-colors ${
              mode === 'edit'
                ? 'bg-line-strong text-ink'
                : 'text-ink-muted hover:text-ink hover:bg-hover'
            }`}
          >
            <Pencil size={12} />
            Edit
          </button>
        )}
        <button
          onClick={switchToPreview}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-xs text-xs font-medium transition-colors ${
            mode === 'preview'
              ? 'bg-line-strong text-ink'
              : 'text-ink-muted hover:text-ink hover:bg-hover'
          }`}
        >
          <Eye size={12} />
          Preview
        </button>
        {mode === 'preview' && (
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-xs text-xs font-medium text-ink-muted hover:text-ink hover:bg-hover transition-colors"
            title="Reload preview"
          >
            <RotateCw size={12} />
            Refresh
          </button>
        )}
        {saveState === 'saving' && (
          <span className="ml-2 text-xs text-ink-muted">Saving…</span>
        )}
        {saveState === 'error' && saveError && (
          <span className="ml-2 text-xs text-danger truncate" title={saveError}>
            {saveError}
          </span>
        )}
      </div>

      {mode === 'edit' && !readOnly ? (
        <textarea
          className="flex-1 w-full bg-transparent text-sm text-ink font-mono whitespace-pre-wrap break-words leading-relaxed resize-none outline-none"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
      ) : previewError ? (
        <div className="flex items-center justify-center h-full text-sm text-danger px-4 text-center">
          {previewError}
        </div>
      ) : bundledSrcdoc ? (
        <>
          <iframe
            key={reloadKey}
            ref={iframeRef}
            srcDoc={bundledSrcdoc}
            title={filePath}
            // `allow-scripts` only — without `allow-same-origin` the iframe's
            // origin is opaque/null. Combined with the document's CSP
            // (`connect-src 'none'`) and the postMessage-only data channel, the
            // iframe cannot exfiltrate, navigate, popup, or fetch.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            // In a pane the frame fills it and scrolls inside; where the host
            // grows with the page, the frame has the reader's height (a
            // flex-grown frame in an auto-height column would collapse to the
            // browser's default 150px instead), as its CONTENT box, so the
            // page's viewport is exactly that height and the border is not
            // taken out of it. While the handle is dragged the frame takes no
            // pointer — a frame is its own document, and would keep the
            // pointer the moment it crossed in.
            className={`w-full bg-white rounded-xs border border-line ${sizesToContent ? 'shrink-0' : 'flex-1'}`}
            style={
              sizesToContent
                ? { height: frameHeight, boxSizing: 'content-box', pointerEvents: dragging ? 'none' : undefined }
                : undefined
            }
          />
          {sizesToContent && (
            <div
              ref={handleRef}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the page"
              aria-valuenow={frameHeight}
              aria-valuemin={HTML_FRAME_MIN_HEIGHT}
              aria-valuemax={HTML_FRAME_MAX_HEIGHT}
              tabIndex={0}
              title="Drag to make the page taller or shorter"
              className="shrink-0 h-2 mt-1 rounded-xs cursor-row-resize outline-none hover:bg-hover focus-visible:bg-accent-hover/60 data-[dragging=true]:bg-accent-hover/60 transition-colors"
            />
          )}
        </>
      ) : (
        <div className="flex items-center justify-center h-full text-ink-muted text-sm">
          Loading preview…
        </div>
      )}
      <Dialog
        open={card?.kind === 'write'}
        onClose={() => closeCard(false)}
        title={`${pageName(filePath)} wants to write to the knowledge base`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => closeCard(false)}>
              Deny
            </Button>
            <Button variant="primary" onClick={() => closeCard(true)}>
              Allow while open
            </Button>
          </>
        }
      >
        <p className="font-mono text-detail text-ink-muted break-all">{toolPagePath ?? filePath}</p>
      </Dialog>
      <Dialog
        open={card?.kind === 'platform'}
        onClose={() => closeCard(false)}
        title={`${pageName(filePath)} uses tools that are only available in the platform`}
        size="md"
        footer={
          <>
            <Button variant="outline" onClick={() => closeCard(false)}>
              Continue without tools
            </Button>
            <Button variant="primary" onClick={openInPlatform}>
              Open in the platform
            </Button>
          </>
        }
      >
        <p className="font-mono text-detail text-ink-muted break-all">{filePath}</p>
      </Dialog>
    </div>
  );
}
