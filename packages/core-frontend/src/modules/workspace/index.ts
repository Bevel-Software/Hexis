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
 *    file's own address). `PageLinkHomeContext`: the file such a page's
 *    links resolve against, where its `filePath` is not one (a skill page).
 *  - `useHtmlToolBridge`, `PageToolsContext` and their types: the page
 *    tool bridge a distribution's own HTML renderer calls to answer a page's
 *    `window.bevel.tools` exactly as the app's renderer does, and the
 *    file page's provider its tests mount it under.
 *  - `useFileNav` and `useNodeIdNav` (with `KbLinkTarget`, `OpenLinkOptions`
 *    and `stripJunkBeforeKbDir`): where a link inside rendered content leads
 *    and how it is followed — the one rule for those links, which a surface
 *    rendering a file of the knowledge base outside the file page (a skill
 *    page, a review diff) follows too. `scrollToHeading`: how such a surface
 *    goes to a section of its own markdown file.
 */
export {
  CanDownloadContext,
  hasFileViewer,
  isBinaryFile,
  isViewOnlyFile,
  rendersAsText,
  OpenPageInPlatformContext,
  PageToolsContext,
  pickFileRenderer,
  RendererSurfaceContext,
  useHtmlToolBridge,
  useKbGraphLoader,
  useRendererSurface,
  type HtmlToolBridgeOptions,
  type HtmlToolBridgeResult,
  type PageTools,
  type RendererSurface,
} from './components/renderers';
export { RendererWorkspaceContext } from './components/renderers/rendererWorkspace';
export { asksForFilePage, kbFilePageUrl, kbFileUrl, resolveKbHref } from './routing/kb-routes';
export { PageLinkHomeContext } from './components/renderers/htmlToolBridge';
export type { KbLinkTarget } from './components/renderers/KbAppLink';
export { scrollToHeading } from './components/renderers/scrollToHeading';
// The KB markdown pipeline, for a surface that renders a file's markdown in
// fragments outside the file page: the review diff, which shows the HTML
// comments of a changed fragment as source.
export {
  KB_DIFF_CHANGE_REHYPE_PLUGINS,
  KB_DIFF_REHYPE_PLUGINS,
  KB_REMARK_PLUGINS,
  useKbMarkdownComponents,
  type KbImageResolver,
} from './components/renderers/kbMarkdownPipeline';
// Reached by other modules; exported here so they stop importing the files.
export { useCreatePage } from './hooks/useCreatePage';
export { useMergedWorkspaceTree } from './hooks/useMergedWorkspaceTree';
export { useOpenChangeRequests } from './hooks/useOpenChangeRequests';
export { NO_CHANGE_REQUESTS, OpenChangeRequestsContext } from './state/open-change-requests.context';
export { useWorkspaceImageResolver } from './hooks/useWorkspaceImageResolver';
// What the explorer's `lead` (a hosting app's navigation) may be: a node
// that renders something. The shell's folder surface narrows its `nav` to it.
export type { GivenNode } from './components/FileExplorer';
export {
  KB_ROUTE_PREFIX,
  openExternalHref,
  safeDecode,
  stripJunkBeforeKbDir,
  useFileNav,
  useFileNodeId,
  useNodeIdNav,
  type OpenLinkOptions,
} from './routing/kb-routes';
export { WorkspaceApiError, deleteFile, getOrCreateWorkspace, listFiles, readFile, writeFile } from './services/workspace.api';
export type { SkillToolWarning } from './services/workspace.api';
export { useEditablePage } from './state/editable-page';
export { WorkspaceContext, libraryUploadTarget, useWorkspace } from './state/workspace.context';
export type { WorkspaceContextValue } from './state/workspace.context';
export { computeDiff } from './utils/diff';
export type { DiffLine } from './utils/diff';
export { displayFileName, fileNameTooltip } from './utils/display-file-name';
export { checkoutRoot, findEntryByPath, knowledgeFiles, pathExistsInTree } from './utils/fileTree';
export { labelFor, parseFrontmatter } from './utils/frontmatter';
export type { FrontmatterData } from './utils/frontmatter';
