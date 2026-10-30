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
 *
 * Its routing contract (the Knowledge URL prefix and the segment decode),
 * where the page lands once the file on screen has closed, the hook that
 * says when an item on screen was deleted elsewhere, and the workspace
 * context those pages read the checkout from. The "This file was deleted"
 * notice itself is a component: other modules compose it from
 * `components/DeletedFileNotice`, not from here.
 */
export {
  CanDownloadContext,
  isViewOnlyFile,
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
// Reached by other modules; exported here so they stop importing the files.
export { useCreatePage } from './hooks/useCreatePage';
export { useMergedWorkspaceTree } from './hooks/useMergedWorkspaceTree';
export { useOpenChangeRequests } from './hooks/useOpenChangeRequests';
export { useWorkspaceImageResolver } from './hooks/useWorkspaceImageResolver';
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
export { landingAfterClose } from './routing/landing';
export { useItemDeletedElsewhere } from './hooks/useItemDeletedElsewhere';
