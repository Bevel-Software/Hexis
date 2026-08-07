import { useState, useEffect } from 'react';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';
import type { FileRendererProps } from './types';

/**
 * Inline PDF viewer. Fetches the binary from `/api/workspace/:id/file/raw`,
 * wraps it in a blob URL, and hands it to the browser's native PDF.js viewer
 * via `<iframe>`. Zero JS PDF dependencies — toolbar, zoom, page navigation,
 * search and print all come from Chromium/Firefox. The MIME map entry for
 * `.pdf` in `workspace.routes.ts` is what makes the iframe render inline
 * instead of triggering a download.
 */
export function PdfRenderer({ filePath }: FileRendererProps) {
  const { workspaceId } = useWorkspace();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Reset stale state from a prior filePath / workspaceId before starting
    // the new fetch — including the case where the workspace is being torn
    // down (workspaceId → null). Without resetting on the null branch, the
    // previous effect's cleanup revokes the blob URL but `objectUrl` is
    // still in state, leaving the iframe pointing at a revoked URL.
    setError(null);
    setObjectUrl(null);

    if (!workspaceId) return;

    let revoked = false;
    let createdUrl: string | null = null;
    (async () => {
      try {
        const res = await authFetch(
          `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}`,
        );
        if (revoked) return;
        if (!res.ok) {
          setError(`Failed to load PDF (HTTP ${res.status})`);
          return;
        }
        const blob = await res.blob();
        if (revoked) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch (e) {
        if (revoked) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      revoked = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [workspaceId, filePath]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-danger text-sm">
        {error}
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        Loading PDF...
      </div>
    );
  }

  return (
    <iframe
      src={objectUrl}
      title={filePath}
      className="w-full h-full border-0"
    />
  );
}
