import { useState, useCallback, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { KbMarkdownView } from './KbMarkdownView';
import { useAutoGrowTextarea } from '../../hooks/useAutoGrowTextarea';
import {
  useFileNav,
  useNodeIdNav,
  useCanonicalFileUrl,
  KB_ROUTE_PREFIX,
  resolveRelativePath,
} from '../../routing/kb-routes';
import type { FileRendererProps, RendererSaveState } from './types';

/** Decode a URL hash (`#some%20slug`) to its bare slug, tolerating bad escapes. */
function safeDecodeHash(hash: string): string {
  const raw = hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Escape a slug for safe interpolation into an attribute-selector string. */
function escapeForSelector(value: string): string {
  return (
    value
      .replace(/["\\]/g, '\\$&')
      // CSS-hex-escape control characters (newline, CR, …): a raw control char in
      // a CSS string is a syntax error that would make querySelector throw. The
      // trailing space terminates the hex escape.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)
  );
}

/**
 * Markdown view/edit renderer driven entirely by the parent's `readOnly`
 * prop:
 *
 *   - `readOnly === true`  → rendered preview (view mode, via `KbMarkdownView`)
 *   - `readOnly === false` → source textarea (edit mode)
 *
 * There is no internal mode toggle. The FileViewer's top-level "Edit" /
 * "Done" button is the single mode switch. The dirty/save state still works
 * the same: typing in edit mode emits `onValueChange`, Ctrl/Cmd+S triggers
 * `onSave`, and the parent owns when to flip `readOnly` back to true.
 *
 * The read view itself lives in `KbMarkdownView`, shared with the Atlassian
 * embed; this component owns the edit textarea, save lifecycle, deep-link
 * scroll, and in-workspace link navigation.
 */
export function MarkdownRenderer({
  content,
  savedContent,
  filePath,
  onSave,
  onDirtyChange,
  onValueChange,
  onSaveStateChange,
  readOnly = false,
}: FileRendererProps) {
  // openFile here is the navigating version: clicking a markdown link to a file
  // updates the URL so the route reflects what's on screen.
  const { openFile } = useFileNav();
  // Shared id-link resolver (resolve-id → openFile, heading preserved) — same
  // implementation the chat citation renderer uses.
  const { openNodeId } = useNodeIdNav();
  // The URL hash carries a heading slug for citation deep-links
  // (`…/Node.md#goal`); we scroll the matching heading into view once the
  // rendered content is in the DOM.
  const location = useLocation();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(content);
  // savedContent is the on-disk baseline; falls back to content when the
  // caller doesn't track a separate saved version (single-file legacy).
  const [savedValue, setSavedValue] = useState(savedContent ?? content);
  const [saveState, setSaveState] = useState<RendererSaveState>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const dirty = !readOnly && value !== savedValue;

  // On-disk baseline for the dirty flag. Runs even mid-edit so an autosave
  // checkpoint that advances `savedContent` clears the "Unsaved" indicator.
  //
  // The editable `value` is only re-derived from `content` in read-only preview
  // mode — in EDIT mode the textarea owns `value`. Re-seeding `value` from
  // `content` during an edit is what made a background autosave visibly jump the
  // UI: the checkpoint round-trips the buffer back through the `content` prop
  // (and commit can line-ending-normalize it), so `setValue(content)` re-assigned
  // the controlled textarea, throwing the caret to the end and scrolling the
  // document to the top. File switches and Edit/View flips remount this component
  // via the FileViewer `key`, so mount-time `useState(content)` already loads the
  // correct buffer for a new file or when (re-)entering edit mode.
  useEffect(() => {
    // Intentional prop→state sync (same pattern useWorkspaceState uses):
    // mirror the on-disk baseline, and the buffer in preview mode only.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSavedValue(savedContent ?? content);
    if (readOnly) setValue(content);
  }, [content, savedContent, readOnly]);

  // Reset transient save UI when the file or its content identity changes.
  // A background autosave echo can advance `content`/`savedContent` while a
  // manual save is still in flight; don't clobber the 'saving' strip in that
  // window — `save()` owns the transition out of 'saving' (→ idle on success,
  // → error on failure). Only clear idle/error state on a genuine reset.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSaveState((current) => (current === 'saving' ? current : 'idle'));
    setSaveError(null);
  }, [content, savedContent, filePath]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [saveState, onSaveStateChange]);

  // Deep-link scroll: when the URL has a `#heading-slug` fragment, scroll the
  // heading with that id (added by rehype-slug) into view. Re-runs when the
  // hash, the file, or the rendered value changes — the latter because the
  // content may still be loading when the route first resolves.
  useEffect(() => {
    if (!readOnly) return;
    const slug = location.hash ? safeDecodeHash(location.hash) : '';
    if (!slug) return;
    const raf = requestAnimationFrame(() => {
      const container = scrollContainerRef.current;
      if (!container) return;
      const target = container.querySelector(`[id="${escapeForSelector(slug)}"]`);
      target?.scrollIntoView({ block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
  }, [location.hash, filePath, value, readOnly]);

  // Navigate to a workspace file referenced by a relative link. react-markdown
  // percent-encodes spaces in hrefs (`Some%20File.md`), so decode before
  // resolving or the path won't match a real file.
  // Citation deep-link for a heading: the node's canonical URL (its id URL when
  // it's a node, else the path URL) plus the heading's `#slug`. Matches the "copy
  // link to this file" affordance, scoped to a section. Falls back to the current
  // location while the id resolves / for non-node files.
  const canonicalFileUrl = useCanonicalFileUrl(filePath);
  const headingLink = useCallback(
    (slug: string) =>
      `${canonicalFileUrl ?? `${window.location.origin}${location.pathname}`}#${slug}`,
    [canonicalFileUrl, location.pathname],
  );

  const handleFileLink = useCallback(
    (href: string) => {
      // Absolute workspace citation URLs (`/workspace/<branch>/<path>`, e.g. the
      // links the agent emits) carry their own branch and are resolved by
      // `openFile` directly. Never run them through `resolveRelativePath` — that
      // would treat them as relative to the current file and mangle the path.
      if (href.startsWith(`${KB_ROUTE_PREFIX}/`)) {
        openFile(href);
        return;
      }
      let decoded = href;
      try { decoded = decodeURIComponent(href); } catch { /* leave as-is */ }
      openFile(resolveRelativePath(filePath, decoded));
    },
    [openFile, filePath],
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (readOnly || value === savedValue) return true;
    setSaveState('saving');
    setSaveError(null);
    try {
      await onSave(value);
      setSavedValue(value);
      setSaveState('idle');
      return true;
    } catch (err) {
      // Keep the raw error for console/telemetry — never render it. The DOM
      // gets a stable, user-friendly string so we don't leak backend internals.
      console.error('[MarkdownRenderer] save failed:', err);
      setSaveState('error');
      setSaveError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [readOnly, value, savedValue, onSave]);

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

  // Optional save-state strip — only shown when there's actually something to
  // surface (mid-save spinner or an error message), so view mode stays clean.
  const showStatusStrip = saveState === 'saving' || (saveState === 'error' && saveError);

  useAutoGrowTextarea(textareaRef, value, !readOnly);

  return (
    // Auto-height, not `h-full`: `KbDocumentShell` is the scroller now, and a
    // document has no natural height — it is as tall as it is.
    <div className="flex min-w-0 flex-col">
      {showStatusStrip && (
        <div className="flex items-center gap-2 pb-2 mb-2 border-b border-line shrink-0">
          {saveState === 'saving' && (
            <span
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="text-xs text-ink-muted"
            >
              Saving…
            </span>
          )}
          {saveState === 'error' && saveError && (
            <span
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              className="text-xs text-red-600"
            >
              Couldn't save your changes. Try again in a moment.
            </span>
          )}
        </div>
      )}

      {readOnly ? (
        <KbMarkdownView
          source={value}
          onOpenFile={handleFileLink}
          onOpenNodeId={openNodeId}
          headingLink={headingLink}
          containerRef={scrollContainerRef}
          // The document column scrolls; this view does not. See the prop's
          // docstring — the embed and the library dialog keep the default.
          scroll={false}
        />
      ) : (
        <textarea
          ref={textareaRef}
          // Grows with its content so the column keeps the only scrollbar on
          // the page — see `useAutoGrowTextarea`. `min-h-[50vh]` is the empty
          // file's height, so a new document is a page rather than a slot.
          className="w-full min-h-[50vh] resize-none overflow-hidden bg-transparent text-sm text-ink font-mono whitespace-pre-wrap break-words leading-relaxed outline-none"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
      )}
    </div>
  );
}
