import { useEffect, useState } from 'react';
// mammoth's package.json declares a `browser` field that swaps out the two
// Node-only modules (unzip / files) for browser equivalents, so a plain
// `import 'mammoth'` works under Vite. No published types; we keep the
// import untyped and cast inside the effect.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — mammoth ships no .d.ts
import mammoth from 'mammoth/mammoth.browser.js';
import { useRendererFileRef, useRendererWorkspaceId } from './rendererWorkspace';
import { RetryReadButton } from './RetryReadButton';
import { useReadRetry } from './useReadRetry';
import { authFetch } from '../../../../lib/api';
import { rawFileUrl } from '../../services/workspace.api';
import { sanitizeDocxHtml } from './sanitizeDocxHtml';
import { DownloadFileButton } from './DownloadFileButton';
import type { FileRendererProps } from './types';

/**
 * Inline .docx viewer. Fetches the binary from `/api/workspace/:id/file/raw`,
 * runs it through mammoth's browser bundle to convert OOXML → HTML, and
 * renders the result in a Tailwind `prose` block.
 *
 * The HTML goes through {@link sanitizeDocxHtml} first, and that step is
 * load-bearing rather than belt-and-braces. mammoth is a CONVERTER, not a
 * sanitizer: it emits no `<script>` only because OOXML has no such element,
 * while a hyperlink's target is copied verbatim from the document — so a
 * crafted `.docx` can carry `href="javascript:…"` into THIS origin, where a
 * single click would run it with the reader's session. The document is
 * attacker-controlled input (anyone who can write to a folder can upload
 * one), so it is sanitized like any other. See the sanitizer for the rules.
 *
 * View-only: there is no edit mode for binary office formats. The renderer
 * ignores `onSave` / `onValueChange` / `readOnly`.
 */
export function DocxRenderer({ filePath }: FileRendererProps) {
  const workspaceId = useRendererWorkspaceId();
  /** A past save, when Version history mounted this; null = the working tree. */
  const fileRef = useRendererFileRef();
  /**
   * The save as PRIMITIVES, hoisted out of the object so the read effect can
   * depend on exactly what it reads. Depending on `fileRef` itself would put
   * a context object in the dependency list.
   */
  const versionRef = fileRef?.ref ?? null;
  const versionSide = fileRef?.side;
  const { attempt, retry } = useReadRetry();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    setError(null);
    if (!workspaceId) return;

    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch(
          rawFileUrl(workspaceId, filePath, { ref: versionRef, side: versionSide }),
        );
        if (cancelled) return;
        if (!res.ok) {
          setError(`Failed to load Word document (HTTP ${res.status})`);
          return;
        }
        const buffer = await res.arrayBuffer();
        if (cancelled) return;
        const result = (await mammoth.convertToHtml({ arrayBuffer: buffer })) as {
          value: string;
        };
        if (cancelled) return;
        setHtml(sanitizeDocxHtml(result.value));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath, versionRef, versionSide, attempt]);

  if (error) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
        <p role="alert" className="text-sm text-danger">{error}</p>
        <div className="flex items-center gap-2">
          <RetryReadButton onRetry={retry} />
          {/* The conversion failed; the bytes may still open fine in Word. */}
          <DownloadFileButton filePath={filePath} />
        </div>
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex items-center justify-center min-h-40 text-ink-muted text-sm">
        Loading Word document...
      </div>
    );
  }

  return (
    // No scroller of its own: a Word document is a document, so it sits in
    // `KbDocumentShell`'s prose column and the column scrolls.
    <div className="min-w-0">
      {/* The conversion is an approximation (headers/footers, tracked
          changes and most layout are dropped) — the original stays one
          click away. */}
      <div className="mb-3 flex justify-end">
        <DownloadFileButton filePath={filePath} />
      </div>
      <div
        className="prose prose-sm max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
