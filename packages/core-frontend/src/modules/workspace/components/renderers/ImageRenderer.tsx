import { useState, useEffect } from 'react';
import { useRendererWorkspaceId } from './rendererWorkspace';
import { RetryReadButton } from './RetryReadButton';
import { useReadRetry } from './useReadRetry';
import { useImageRevision } from '../../hooks/useImageRevision';
import { useRendererRawRead } from './rendererRawRead';
import type { FileRendererProps } from './types';

/** How the read of one image ended. */
interface ImageRead {
  objectUrl: string | null;
  /**
   * A failed read, NAMED. A non-ok response used to return silently, leaving
   * the pane on "Loading image…" for as long as anyone cared to watch — which
   * is the shape a 403 on a restricted file takes, and a 404 on a path the
   * workspace's branch does not have (the change-request pane reads someone
   * else's branch, where a file may well be absent).
   */
  error: string | null;
}

const NOT_READ: ImageRead = { objectUrl: null, error: null };

export function ImageRenderer({ filePath }: FileRendererProps) {
  const workspaceId = useRendererWorkspaceId();
  /**
   * A replaced picture reaches an open pane. The `<img>` tags the markdown
   * pipeline emits already carry this revision (`useWorkspaceImageResolver`);
   * the whole-file image view was the one image on the page that stayed stale
   * until a reload — including the change-request pane, which reads a branch
   * its author may still be pushing to while a reviewer looks at it.
   */
  const revision = useImageRevision(workspaceId);
  /**
   * Where the picture's bytes come from — the workspace raw route under the
   * session in the app, the surface's own route in an embed. It folds the
   * save this viewer is bound to in itself, so a version pane needs nothing
   * extra here.
   */
  const rawRead = useRendererRawRead();
  /**
   * The cache key of a WORKING-TREE read, and nothing else. Folding the
   * revision into a version read would not just waste a request: a teammate
   * saving the file while a past save is on screen would bump it, the read
   * effect would re-run, and the picture the reader is looking at would blink
   * back to "Loading image…" for bytes that cannot have changed. Which kind
   * of read this is belongs to the raw source, so that is what is asked.
   */
  const revisionKey = rawRead?.pinnedToVersion ? null : revision;
  // Blob and failure in ONE value, so the cleanup that drops the old blob
  // drops the old failure with it — a second `useState` would need a reset in
  // the effect body, which costs a cascading render on every path change.
  const [read, setRead] = useState<ImageRead>(NOT_READ);
  /** Bumped by Try again, and a dependency of the read below — see the hook. */
  const { attempt, retry } = useReadRetry();

  useEffect(() => {
    if (!rawRead) return;

    let revoked = false;
    (async () => {
      try {
        const res = await rawRead.fetch(filePath, { version: revisionKey ?? undefined });
        if (revoked) return;
        if (!res.ok) {
          setRead({ objectUrl: null, error: `Couldn't load this image (HTTP ${res.status}).` });
          return;
        }
        const blob = await res.blob();
        if (revoked) return;
        setRead({ objectUrl: URL.createObjectURL(blob), error: null });
      } catch {
        if (!revoked) setRead({ objectUrl: null, error: "Couldn't load this image." });
      }
    })();

    return () => {
      revoked = true;
      setRead((prev) => {
        if (prev.objectUrl) URL.revokeObjectURL(prev.objectUrl);
        // `prev` back when there is nothing to clear, so React bails out of
        // the render rather than seeing a fresh object with the same fields.
        return prev === NOT_READ ? prev : NOT_READ;
      });
    };
  }, [rawRead, filePath, revisionKey, attempt]);

  if (read.error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4">
        <p role="alert" className="text-detail text-danger">
          {read.error}
        </p>
        <RetryReadButton onRetry={retry} />
      </div>
    );
  }

  if (!read.objectUrl) {
    return (
      <div className="flex items-center justify-center h-full text-ink-muted text-sm">
        Loading image...
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full overflow-auto">
      <img
        src={read.objectUrl}
        alt={filePath}
        className="max-w-full max-h-full object-contain rounded-xs"
      />
    </div>
  );
}
