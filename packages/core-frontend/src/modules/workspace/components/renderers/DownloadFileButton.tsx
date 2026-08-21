import { createContext, useCallback, useContext, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../../../shared/components';
import { useWorkspace } from '../../state/workspace.context';
import { downloadViaBlob } from './downloadFile';

/**
 * The document viewers' way out of the browser. Every office-document viewer
 * here is a REDUCTION — a pptx becomes an outline, an xlsx grid gets capped,
 * a legacy `.doc` is not rendered at all — so each one offers the original
 * bytes alongside its own rendering.
 *
 * Same endpoint and `?download=1` shape as the file tree's context-menu
 * Download (see `FileExplorer.handleDownload`): the backend resolves the
 * per-path `download:` access verb and sets Content-Disposition; a 403
 * surfaces in the error text below rather than being preflighted away.
 */
/**
 * The open file's resolved `download:` permission, provided by FileViewer
 * from the access lookup it already performs (null = unknown/in flight —
 * treated optimistically, like the editor; the backend stays the
 * authoritative gate either way). A context rather than a renderer prop so
 * the renderer contract stays permission-agnostic.
 */
export const CanDownloadContext = createContext<boolean | null>(null);

export function DownloadFileButton({
  filePath,
  size = 'tiny',
}: {
  filePath: string;
  /** `sm` where the download is the page's main affordance (pptx outline). */
  size?: 'tiny' | 'sm';
}) {
  const { workspaceId } = useWorkspace();
  const canDownload = useContext(CanDownloadContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);

  const handleDownload = useCallback(async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await downloadViaBlob(
        `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}&download=1`,
        fileName,
      );
      if (!outcome.ok) {
        setError(`Download failed (HTTP ${outcome.status})`);
        return;
      }
    } catch (err) {
      console.error('[DownloadFileButton] download failed:', err);
      setError(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      setBusy(false);
    }
  }, [workspaceId, busy, filePath, fileName]);

  return (
    <span className="inline-flex items-center gap-2">
      {error && (
        <span role="alert" className="text-detail text-danger">
          {error}
        </span>
      )}
      <Button
        variant="outline"
        size={size}
        leadingIcon={<Download size={size === 'sm' ? 14 : 12} />}
        onClick={() => void handleDownload()}
        // Disabled only on a hard "no" — while the lookup is in flight the
        // button stays optimistic, mirroring the editor; a wrong guess is
        // still caught by the backend's own gate on the raw endpoint.
        disabled={busy || canDownload === false}
        title={
          canDownload === false
            ? 'You do not have download permission for this file.'
            : `Download ${fileName}`
        }
      >
        {busy ? 'Downloading…' : 'Download'}
      </Button>
    </span>
  );
}
