/**
 * `⋯ → View raw file` — open the file's bytes in a new tab.
 *
 * A one-line wrapper around `window.open` so the intent is spy-able. Tests may
 * never assign `window.location.href` (it navigates the test runner's own
 * document), and the same rule makes a bare `window.open` call awkward to
 * assert on — a named helper is something a test can stub.
 *
 * Uses the existing raw endpoint WITHOUT `download=1`: the MIME map on
 * `workspace.routes.ts` is what makes the browser render markdown, an image or
 * a PDF inline instead of saving it. "View raw" means view.
 *
 * This is the one place the raw endpoint is opened as a TOP-LEVEL DOCUMENT
 * rather than fetched as bytes, which is why that route sandboxes an inline
 * `.svg` — see the note beside the MIME map. `workspaceId` is a server-issued
 * id, and the path is the only caller-shaped part of the URL, so it is the
 * only part encoded here.
 */
export function openRawFile(workspaceId: string, path: string): void {
  const url = `/api/workspace/${workspaceId}/file/raw?path=${encodeURIComponent(path)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}
