import { useState, useCallback, useEffect, useRef } from 'react';
import { Pencil, Eye, RotateCw } from 'lucide-react';
import { useFileNav, KB_ROUTE_PREFIX, resolveRelativePath } from '../../routing/kb-routes';
import type { FileRendererProps, RendererSaveState } from './types';
import { buildSandboxedHtml, sanitizeAgentHtml } from './htmlSandbox';

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
  const { openFile } = useFileNav();
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [value, setValue] = useState(content);
  const [savedValue, setSavedValue] = useState(savedContent ?? content);
  const [saveState, setSaveState] = useState<RendererSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bundledSrcdoc, setBundledSrcdoc] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const prevFilePathRef = useRef(filePath);

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
      });
      setBundledSrcdoc(doc);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to build preview');
    }
  }, [mode, savedValue, filePath, reloadKey]);

  // (The enterprise build additionally installs a postMessage bridge here that
  // serves the iframe's KB-graph client from `/api/workspace/:id/graph` — the
  // knowledge system is an enterprise extension, so the core renderer has no
  // graph bridge.)

  // Navigation bridge: agent HTML deep-links into the KB by calling
  // `window.bevel.openNode(href)` or clicking an `<a>` whose href points at a
  // node — both post a `bevel.navigate` message (the iframe sandbox can't
  // navigate the host window itself). We resolve the href the same way the
  // markdown renderer does (absolute `/workspace/…` URLs pass through; relative
  // `.md` paths resolve against this file) and route it through the in-app
  // navigation so the URL reflects what's on screen.
  useEffect(() => {
    function onNavMessage(event: MessageEvent) {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return;
      const msg = event.data as { type?: unknown; href?: unknown } | null;
      if (!msg || typeof msg !== 'object' || msg.type !== 'bevel.navigate') return;
      const href = typeof msg.href === 'string' ? msg.href : null;
      if (!href) return;
      if (href.startsWith(`${KB_ROUTE_PREFIX}/`)) {
        openFile(href);
        return;
      }
      let decoded = href;
      try { decoded = decodeURIComponent(href); } catch { /* leave as-is */ }
      openFile(resolveRelativePath(filePath, decoded));
    }
    window.addEventListener('message', onNavMessage);
    return () => window.removeEventListener('message', onNavMessage);
  }, [openFile, filePath]);

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
          className="flex-1 w-full bg-white rounded-xs border border-line"
        />
      ) : (
        <div className="flex items-center justify-center h-full text-ink-muted text-sm">
          Loading preview…
        </div>
      )}
    </div>
  );
}
