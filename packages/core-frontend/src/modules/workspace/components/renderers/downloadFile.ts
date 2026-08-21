import { authFetch } from '../../../../lib/api';

/** What an authenticated blob download came back with. Network errors THROW — callers already catch. */
export type DownloadOutcome = { ok: true } | { ok: false; status: number; body: string };

/**
 * The one authenticated blob-download path, shared by `DownloadFileButton`
 * and the file tree's context-menu Download (`FileExplorer.handleDownload`):
 * fetch with auth → blob → synthetic `<a download>` click → DEFERRED
 * `revokeObjectURL`. The revoke is deferred via `setTimeout(…, 0)` because
 * revoking synchronously after `click()` can invalidate the blob URL before
 * the browser has actually begun the navigation the click started — the
 * download silently never happens on the affected engines.
 *
 * On a non-OK response the outcome carries the status and (best-effort) body
 * so each caller keeps its own error copy; nothing is downloaded.
 */
export async function downloadViaBlob(url: string, fileName: string): Promise<DownloadOutcome> {
  const res = await authFetch(url);
  if (!res.ok) {
    return { ok: false, status: res.status, body: await res.text().catch(() => '') };
  }
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  return { ok: true };
}
