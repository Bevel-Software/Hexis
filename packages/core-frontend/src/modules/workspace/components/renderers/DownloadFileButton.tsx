import { useCallback, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '../../../../shared/components';
import { useWorkspace } from '../../state/workspace.context';
import { authFetch } from '../../../../lib/api';

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
export function DownloadFileButton({
  filePath,
  size = 'tiny',
}: {
  filePath: string;
  /** `sm` where the download is the page's main affordance (pptx outline). */
  size?: 'tiny' | 'sm';
}) {
  const { workspaceId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);

  const handleDownload = useCallback(async () => {
    if (!workspaceId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(
        `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(filePath)}&download=1`,
      );
      if (!res.ok) {
        setError(`Download failed (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
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
        disabled={busy}
        title={`Download ${fileName}`}
      >
        {busy ? 'Downloading…' : 'Download'}
      </Button>
    </span>
  );
}
