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
 *    even for a file a skill's page would otherwise claim, and
 *    `asksForFilePage`, whether a location's query makes that ask.
 *  - `PageToolsContext`: the page-tool bridge, for a mount that is the
 *    platform itself (the skill page) — see `htmlToolBridge.ts` for the
 *    hosts that provide it and the ones that must not.
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
export { asksForFilePage, kbFilePageUrl, kbFileUrl, resolveKbHref } from './routing/kb-routes';
export { OpenPageInPlatformContext, PageToolsContext } from './components/renderers/htmlToolBridge';

/**
 * The rest of what the shell and other modules use from the workspace, grouped by
 * the file that defines it.
 */
export {
  EmptyTreeNotice,
  FileExplorer,
  FileTreeNode,
  TreeChrome,
  type TreeMenuItem,
  type TreeNav,
  UploadNotices,
} from './components/FileExplorer';
export { FilePaneCard } from './components/FilePaneCard';
export { FileRoute } from './components/FileRoute';
export { FileViewer } from './components/FileViewer';
export { DownloadFileButton } from './components/renderers/DownloadFileButton';
export { HtmlRenderer } from './components/renderers/HtmlRenderer';
export { KbMarkdownView } from './components/renderers/KbMarkdownView';
export { RetryReadButton } from './components/renderers/RetryReadButton';
export {
  getFileRenderer,
  getRendererLayout,
  hasFileViewer,
  isBinaryFile,
  type RendererFileRef,
  rendersAsText,
} from './components/renderers';
export {
  KB_DIFF_REHYPE_PLUGINS,
  KB_REMARK_PLUGINS,
  type KbImageResolver,
  useKbMarkdownComponents,
} from './components/renderers/kbMarkdownPipeline';
export { READ_PANE } from './components/renderers/readPane';
export type { FileRendererProps } from './components/renderers/types';
export { useCreatePage } from './hooks/useCreatePage';
export { useMergedWorkspaceTree } from './hooks/useMergedWorkspaceTree';
export { useOpenChangeRequests } from './hooks/useOpenChangeRequests';
export { useWorkspaceImageResolver } from './hooks/useWorkspaceImageResolver';
export { useWorkspaceState } from './hooks/useWorkspaceState';
export {
  KB_ROUTE_PREFIX,
  openExternalHref,
  safeDecode,
  stripJunkBeforeKbDir,
  useFileNav,
  useNodeIdNav,
} from './routing/kb-routes';
export {
  deleteFile,
  getOrCreateWorkspace,
  listFiles,
  readFile,
  type SkillToolWarning,
  WorkspaceApiError,
  writeFile,
} from './services/workspace.api';
export { useEditablePage } from './state/editable-page';
export { OpenChangeRequestsProvider } from './state/open-change-requests';
export {
  libraryUploadTarget,
  useWorkspace,
  WorkspaceContext,
  type WorkspaceContextValue,
} from './state/workspace.context';
export { computeDiff, type DiffLine } from './utils/diff';
export { displayFileName, fileNameTooltip } from './utils/display-file-name';
export { checkoutRoot, findEntryByPath, knowledgeFiles, pathExistsInTree } from './utils/fileTree';
export { type FrontmatterData, labelFor, parseFrontmatter } from './utils/frontmatter';
