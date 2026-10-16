/**
 * Workspace's public surface for other modules.
 *
 * What it takes to mount the app's own renderer for a file somewhere other
 * than the file page. The embed (a page shown inside a chat) does exactly
 * that, and imports these from here rather than reaching into workspace's
 * components.
 *
 *  - `pickFileRenderer` and `isViewOnlyFile`: the same lookup the file page
 *    runs, registered renderers included, and whether the file has an
 *    editing surface behind it at all.
 *  - `RendererSurfaceContext` and `RendererSurface`: where a renderer reads
 *    bytes from and how its links leave, when there is no workspace around
 *    it (see `rendererSurface.ts` for why it is this narrow).
 *  - `RendererWorkspaceContext`: the workspace a renderer believes it reads
 *    from, where there is none to dial.
 *  - `CanDownloadContext`: whether a renderer may offer Download.
 *  - `useRendererSurface` and `useKbGraphLoader`: what a renderer mounted
 *    there reads its surroundings with, for a renderer a distribution
 *    registers (and for a stand-in one in a test).
 *  - `kbFileUrl` and `resolveKbHref`: the app's address for a file on a
 *    branch, and what a link in a page resolves to there, which a link out
 *    of such a mount has to name.
 *
 * Its routing contract (the Knowledge URL prefix and the segment decode),
 * where the page lands once the file on screen has closed, the "This file
 * was deleted" notice and the hook that says when an item on screen was
 * deleted elsewhere, and the workspace context those pages read the checkout
 * from.
 */
export {
  CanDownloadContext,
  isViewOnlyFile,
  pickFileRenderer,
  RendererSurfaceContext,
  useKbGraphLoader,
  useRendererSurface,
  type RendererSurface,
} from './components/renderers';
export { RendererWorkspaceContext } from './components/renderers/rendererWorkspace';
export { KB_ROUTE_PREFIX, kbFileUrl, resolveKbHref, safeDecode } from './routing/kb-routes';
export { landingAfterClose } from './routing/landing';
export { DeletedFileNotice } from './components/DeletedFileNotice';
export { useItemDeletedElsewhere } from './hooks/useItemDeletedElsewhere';
export { WorkspaceContext } from './state/workspace.context';
