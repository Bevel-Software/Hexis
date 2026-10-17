/**
 * Workspace's public surface for other modules: what it takes to mount the
 * app's own renderer for a file somewhere other than the file page. The
 * embed (a page shown inside a chat) does exactly that, and imports these
 * from here rather than reaching into workspace's components.
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
 *    of such a mount has to name; `kbFilePageUrl`, the file page's address
 *    even for a file a skill's page would otherwise claim.
 *  - `OpenPageInPlatformContext`: how an HTML page mounted there is taken
 *    to the file page when it needs tools and the viewer picks Open in the
 *    platform (a skill page provides it; without it the renderer opens the
 *    file's own address).
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
export { kbFilePageUrl, kbFileUrl, resolveKbHref } from './routing/kb-routes';
export { OpenPageInPlatformContext } from './components/renderers/htmlToolBridge';
