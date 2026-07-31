import { useEffect, useState } from 'react';
// mammoth's package.json declares a `browser` field that swaps out the two
// Node-only modules (unzip / files) for browser equivalents, so a plain
// `import 'mammoth'` works under Vite. No published types; we keep the
// import untyped and cast inside the effect.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — mammoth ships no .d.ts
import mammoth from 'mammoth/mammoth.browser.js';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import type { FileRendererProps } from './types';

/**
 * Inline .docx viewer. Fetches the binary from `/api/workspace/:id/file/raw`,
 * runs it through mammoth's browser bundle to convert OOXML → HTML, then
 * drops the HTML straight into a Tailwind `prose` block. mammoth strips
 * scripts and unknown elements when it builds the HTML so the output is
 * safe to inject — the same approach `react-markdown` uses for sanitised
 * HTML in the markdown renderer.
 *
 * View-only: there is no edit mode for binary office formats. The renderer
 * ignores `onSave` / `onValueChange` / `readOnly`.
 */
export function DocxRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
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
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
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
        setHtml(result.value);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [workspaceId, filePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-red-600 text-sm">
        {error}
      </div>
    );
  }

  if (html === null) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        Loading Word document...
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div
        className="prose prose-sm max-w-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
