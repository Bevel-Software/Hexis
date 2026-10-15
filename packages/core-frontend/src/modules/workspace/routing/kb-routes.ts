import { useCallback, useContext, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GitContext } from '../../git/state/git.context';
import { WorkspaceContext } from '../state/workspace.context';
import { useRendererSurface } from '../components/renderers/rendererSurface';
import { authFetch } from '../../../lib/api';
import { isOpenableExternalHref, normalizeHref } from '../../../shared/markdown/hrefs';
import {
  KB_ROUTE_PREFIX,
  kbFileUrl,
  resolveKbHref,
  resolveRelativePath,
  safeDecode,
  stripJunkBeforeKbDir,
  type KbHref,
} from '@bevel-software/platform-shared';

// The link grammar lives in platform-shared (workspace/kb-hrefs.ts), where the
// local MCP server's knowledge views resolve links with it too. Re-exported so
// the app's callers keep importing it from here.
export { KB_ROUTE_PREFIX, kbFileUrl, resolveKbHref, resolveRelativePath, safeDecode, stripJunkBeforeKbDir };
export type { KbHref };


/**
 * The open change request, in the URL. A proposed row opens the shared
 * change-request dialog AT the file that was clicked, and both halves of
 * that — which request, which file — live in the query so a reload (or a
 * pasted link) lands on the same file of the same request.
 *
 * `CR_FILE_PARAM` is WORKSPACE-relative — the same path space as the route's
 * own segments and as every path the tree holds, so the row that was clicked
 * and the query that records it are the one string. The dialog speaks
 * repo-relative and the conversion happens where it is handed over, once.
 */
export const CR_PARAM = 'cr';
export const CR_FILE_PARAM = 'file';

/**
 * Matches an id-link destination: a bare frontmatter id (`bdl-cpb-service-terms`,
 * or a snake_case tool/skill id like `my_tool`), optionally followed by a heading
 * anchor (`#id`, `#offer`). The id grammar (lowercase alphanumeric + hyphens +
 * underscores) can't collide with a `.md` path, an `http(s):` URL, or a same-page
 * `#anchor`; the anchor tail forbids `/` so a path link never matches.
 */
export const NODE_ID_LINK_RE = /^[a-z0-9][a-z0-9_-]*(#[^/]+)?$/;


/**
 * The canonical URL for a node: `/workspace/<branch>/<id>`. A bare id segment is
 * disjoint from a `.md` path (no slash/dot — see `NODE_ID_LINK_RE`), so the route
 * tells the two forms apart. `FileRoute` resolves the id to the underlying file.
 */
export function kbNodeUrl(branch: string, id: string): string {
  return `${KB_ROUTE_PREFIX}/${encodeURIComponent(branch)}/${encodeURIComponent(id)}`;
}

/**
 * Resolve a node id → its workspace file path via the backend, or null when no
 * readable node has that id (dangling/forbidden — the route 404s fail-closed).
 */
export async function fetchNodeWorkspacePath(branch: string, id: string): Promise<string | null> {
  try {
    const r = await authFetch(
      `/api/workspace/${encodeURIComponent(branch)}/resolve-id/${encodeURIComponent(id)}`,
    );
    if (!r.ok) return null;
    const { workspacePath } = (await r.json()) as { workspacePath: string };
    return workspacePath;
  } catch {
    return null;
  }
}

/**
 * Short-lived memo for {@link fetchNodeId}. Its callers are per-render hooks
 * (`useCanonicalFileUrl` in FileViewer + MarkdownRenderer) that remount on
 * every content refresh — uncached, browsing fired the SAME `resolve-path`
 * request over and over (visible as 404 spam for non-node files, which are a
 * perfectly normal "no id" answer). The in-flight promise is shared so
 * concurrent mounts dedupe, and a resolved answer — including the stable
 * "not a node" null — is reused for the TTL. Network failures are evicted
 * immediately so an offline blip doesn't stick.
 */
const NODE_ID_TTL_MS = 30_000;
const nodeIdCache = new Map<string, { at: number; value: Promise<string | null> }>();

/**
 * Reverse of {@link fetchNodeWorkspacePath}: a file's frontmatter id, or null when
 * the file isn't an id-bearing node (or the caller may not read it). Used to
 * canonicalize a path URL to the node's id URL.
 */
export function fetchNodeId(branch: string, workspacePath: string): Promise<string | null> {
  const key = `${branch}\n${workspacePath}`;
  const now = Date.now();
  const hit = nodeIdCache.get(key);
  if (hit && now - hit.at < NODE_ID_TTL_MS) return hit.value;
  const value = (async (): Promise<string | null> => {
    const r = await authFetch(
      `/api/workspace/${encodeURIComponent(branch)}/resolve-path?path=${encodeURIComponent(workspacePath)}`,
    );
    if (!r.ok) return null; // 404 = "not a node" — a stable, cacheable answer
    const { id } = (await r.json()) as { id: string };
    return id;
  })();
  const guarded = value.catch(() => {
    nodeIdCache.delete(key);
    return null;
  });
  nodeIdCache.set(key, { at: now, value: guarded });
  return guarded;
}

/**
 * The canonical absolute URL for a file, for the "copy link" affordances: a node's
 * id URL (`<origin>/workspace/<branch>/<id>`) when the file is an id-bearing node,
 * else its path URL. Resolves the id in the background and falls back to the path
 * URL until it resolves (and permanently for non-node files). Null when there's no
 * branch or path yet. Callers append any `#heading` themselves. This makes copied
 * links id-based on their own, independent of the `FileRoute` path→id redirect.
 */
export function useCanonicalFileUrl(workspacePath: string | null): string | null {
  // A surface outside the app knows the address of the file it is showing —
  // it was told it by whatever opened it — and has no git status to resolve
  // one from. Asked FIRST, and before `useGit`, which has no provider there.
  const surface = useRendererSurface();
  const git = useContext(GitContext);
  const branch = surface ? null : (git?.status?.branch ?? null);
  // Tie the resolved id to the exact (branch, path) it was fetched for. Inputs
  // change a render before the effect re-resolves, so without this key the URL
  // would briefly pair the new path with the *previous* node's id.
  const key = branch && workspacePath ? `${branch}\n${workspacePath}` : null;
  const [resolved, setResolved] = useState<{ key: string; id: string | null } | null>(null);

  useEffect(() => {
    if (!key || !branch || !workspacePath) return;
    let cancelled = false;
    (async () => {
      const id = await fetchNodeId(branch, workspacePath);
      if (!cancelled) setResolved({ key, id });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, branch, workspacePath]);

  if (surface) return workspacePath ? surface.canonicalUrlFor(workspacePath) : null;
  if (!branch || !workspacePath) return null;
  const nodeId = resolved && resolved.key === key ? resolved.id : null;
  const relative = nodeId ? kbNodeUrl(branch, nodeId) : kbFileUrl(branch, workspacePath);
  return `${window.location.origin}${relative}`;
}


/**
 * Open an external destination in a new tab, the one way this app does it.
 * Returns whether it opened, so a caller that resolved a `{ kind: 'external' }`
 * can hand the href over and stop. See {@link isOpenableExternalHref} for why
 * this is an allowlist and not a straight `window.open`.
 */
export function openExternalHref(href: string): boolean {
  if (!isOpenableExternalHref(href)) return false;
  // Both flags, for different holes: `noopener` severs `window.opener` so the
  // opened page cannot reach back into this one, and `noreferrer` withholds
  // the `Referer` header, which would otherwise carry the workspace URL — a
  // branch name and a file path — to the destination. The markdown pipeline's
  // body links already ship `rel="noopener noreferrer"`; this is the same
  // policy on the scripted path.
  // The NORMALIZED string, so the address opened is the one the allowlist
  // approved rather than whatever padding the author left around it.
  window.open(normalizeHref(href), '_blank', 'noopener,noreferrer');
  return true;
}

/**
 * The branch segment of a `/workspace/<branch>/…` pathname, decoded, or null
 * when this location is not a workspace URL. The pathname from the router is
 * still percent-encoded (unlike `useParams`, which decodes for you), so this
 * decodes exactly once. A malformed escape (a name ending in a bare `%`)
 * throws out of `decodeURIComponent`; the raw segment is the honest fallback.
 */
export function branchFromPathname(pathname: string): string | null {
  if (!pathname.startsWith(`${KB_ROUTE_PREFIX}/`)) return null;
  const segment = pathname.slice(KB_ROUTE_PREFIX.length + 1).split('/')[0];
  return segment ? safeDecode(segment) : null;
}

export function useFileNav() {
  // Outside the app every opener is the surface's: the embed opens a page in
  // a NEW TAB through its host and never navigates itself. Read before the
  // two app contexts, which have no provider there — so they are read
  // non-throwing and asserted only on the app path below.
  const surface = useRendererSurface();
  const navigate = useNavigate();
  const location = useLocation();
  const git = useContext(GitContext);
  const workspace = useContext(WorkspaceContext);
  if (!surface && (!git || !workspace)) {
    throw new Error('useFileNav must be used within GitContext/WorkspaceContext or a RendererSurface');
  }
  const kbDirName = surface?.kbDirName ?? workspace?.kbDirName ?? '';
  // The URL's branch first, the git status second. During a branch switch the
  // status still reports the branch being LEFT — it only catches up once the
  // destination workspace has bootstrapped and answered — so building a click
  // target from it sent the user back to the branch they were leaving, which
  // read as the switch undoing itself. The URL is the app's authority for
  // which branch is on screen (`FileRoute` bootstraps to match it), so a click
  // lands on the branch being switched TO. Off a workspace route there is no
  // branch in the URL and the status is the only answer there is.
  const branch = branchFromPathname(location.pathname) ?? git?.status?.branch ?? null;

  const openFile = useCallback(
    (pathOrUrl: string) => {
      // Absolute workspace URLs (`/workspace/<branch>/<path>`) carry their own
      // branch, which is never overridden with the current one. `resolveKbHref`
      // parses out the branch and path segments and the route is rebuilt via
      // kbFileUrl so encoding is canonical regardless of how the caller
      // produced the URL (literal spaces, mixed encoding, etc.). FileRoute
      // handles the actual git checkout if the URL's branch differs from the
      // current one.
      if (pathOrUrl.startsWith(`${KB_ROUTE_PREFIX}/`)) {
        const target = resolveKbHref(pathOrUrl, { basePath: '', kbDirName });
        if (target?.kind !== 'workspace' || target.branch === null) return;
        navigate(kbFileUrl(target.branch, target.path) + target.hash);
        return;
      }
      // A workspace path the caller has already resolved. Split off a trailing
      // heading anchor (`…/Node.md#goal`) so it survives as a real URL
      // fragment: otherwise `kbFileUrl` would percent-encode the `#` into the
      // path (`Node.md%23goal`) and the deep-link scroll would never fire. Not
      // decoded: this is a path, and a `%` in it is a character in a name.
      const hashIdx = pathOrUrl.indexOf('#');
      const hash = hashIdx >= 0 ? pathOrUrl.slice(hashIdx) : '';
      const path = hashIdx >= 0 ? pathOrUrl.slice(0, hashIdx) : pathOrUrl;
      if (!branch) return;
      navigate(kbFileUrl(branch, stripJunkBeforeKbDir(path, kbDirName)) + hash);
    },
    [branch, kbDirName, navigate],
  );

  /**
   * Follow a link DESTINATION out of a rendered document: the href as the
   * author wrote it (or as react-markdown encoded it), resolved against
   * `basePath`, the file the link sits in. The one entry for the markdown,
   * HTML and review-diff link handlers, which used to resolve by hand and had
   * drifted (one decoded, one did not). An absolute app URL keeps its own
   * branch; a relative one opens on the branch you are standing on. See
   * {@link resolveKbHref}.
   *
   * AN EXTERNAL LINK IS OPENED HERE TOO, in a new tab. It used to be dropped
   * on the floor — "not ours to open" — which is true of a link the browser
   * still owns, and false of every link that reaches this function. Callers
   * reach it by CANCELLING the browser's own navigation first, and once the
   * default is cancelled, returning without navigating is not deference, it
   * is a dead click. Two surfaces do that:
   *
   *   - The frontmatter panel, for a link-valued field.
   *   - Agent HTML, two ways. A WRITTEN anchor whose address
   *     `sanitizeAgentHtml` kept — a document of the knowledge base, or an
   *     `http:`, `https:` or `mailto:` address — reaches here through the
   *     nav bridge, which cancels the click the sandbox would not let the
   *     iframe make. And `bevel.navigate(href)` from the page's own inline
   *     script, which is why the allowlist below is load-bearing rather than
   *     belt-and-braces: that argument is an arbitrary string no sanitizer
   *     ever inspected.
   *
   * (A markdown BODY link never arrives here: the pipeline renders an
   * external destination as a plain `target="_blank"` anchor and the browser
   * handles it.)
   *
   * `noopener,noreferrer` severs `window.opener` and withholds the workspace
   * URL as a `Referer`, and the scheme allowlist is what keeps the sandbox
   * sealed — see {@link isOpenableExternalHref}. A destination that is
   * external but not openable stays a no-op, as it was.
   */
  const openLink = useCallback(
    (href: string, basePath: string) => {
      const target = resolveKbHref(href, { basePath, kbDirName });
      if (target?.kind === 'external') {
        openExternalHref(href);
        return;
      }
      if (target?.kind !== 'workspace') return;
      const onBranch = target.branch ?? branch;
      if (!onBranch) return;
      navigate(kbFileUrl(onBranch, target.path) + target.hash);
    },
    [branch, kbDirName, navigate],
  );

  /**
   * Navigate to a KNOWN workspace-relative path, verbatim. `openFile` parses
   * link-shaped input — it splits off `#heading` anchors and unwraps absolute
   * workspace URLs — which is right for hrefs and wrong for a path that came
   * from the file tree, where `#` is just a character in a filename. Callers
   * holding a real path (suggestions, explorers) use this; callers holding a
   * link destination keep `openFile`.
   *
   * VERBATIM means verbatim: no `stripJunkBeforeKbDir` either. That repair
   * exists for paths an LLM may have mangled, and it rewrites any path whose
   * later segment happens to equal `kbDirName` — which a real folder inside
   * the tree is allowed to be. A path that came from the tree needs no
   * repair, so applying one could only ever open the wrong file.
   *
   * `edit` asks the viewer to open the file straight into edit mode — for a
   * page the caller has just created, which is there to be written, not read.
   * It travels as router state (`startEditing`, the key the skill page
   * already answers to), not in the URL, so a shared or bookmarked link never
   * drops anyone into the editor; `FileViewer` honours it once and clears it.
   * The path rides along (`startEditingPath`) because the URL does not keep
   * naming it: `FileRoute` swaps a node's path URL for its id URL.
   *
   * `replace` swaps the current history entry instead of adding one — for
   * asking to edit the page already on screen, where a second entry for the
   * same URL would make Back look like it did nothing.
   */
  const openWorkspacePath = useCallback(
    (path: string, options?: { edit?: boolean; replace?: boolean }) => {
      if (!branch) return;
      const url = kbFileUrl(branch, path);
      const replace = options?.replace === true;
      const state = { startEditing: true, startEditingPath: path };
      if (options?.edit) navigate(url, replace ? { state, replace } : { state });
      else if (replace) navigate(url, { replace });
      else navigate(url);
    },
    [branch, navigate],
  );

  const closeFile = useCallback(() => {
    if (!branch) return;
    navigate(kbFileUrl(branch));
  }, [branch, navigate]);

  // One return for the app, one for a surface. The surface's verbs are
  // substituted WHOLESALE rather than branched inside each opener: "open it
  // in a new tab, never navigate" is a different behaviour, not a parameter
  // of this one, and a half-overridden navigator is how an embed ends up on
  // a page no token was minted for.
  if (surface) {
    return {
      openFile: (pathOrUrl: string) => surface.openLink(pathOrUrl, ''),
      openLink: surface.openLink,
      openWorkspacePath: surface.openWorkspacePath,
      closeFile: () => undefined,
    };
  }
  return { openFile, openLink, openWorkspacePath, closeFile };
}

/**
 * Navigate to a node referenced by its frontmatter id (`<id>` or `<id#heading>`).
 * Resolves the id → its file location via the backend (the same `resolve-id`
 * route the in-KB markdown renderer uses; it 404s fail-closed for ids the caller
 * may not read), then opens the file, preserving any heading anchor as a real
 * URL fragment so the deep-link scroll fires. Shared by the file renderer and
 * the chat citation renderer so both resolve id-links identically.
 */
export function useNodeIdNav() {
  const surface = useRendererSurface();
  const { openFile } = useFileNav();
  const git = useContext(GitContext);
  const location = useLocation();
  // The URL's branch first, the git status second — the same order as
  // `useFileNav`: during a branch switch the status still names the branch
  // being left, and an id resolved against it would open the wrong tree.
  const branch = branchFromPathname(location.pathname) ?? git?.status?.branch ?? null;

  const openNodeId = useCallback(
    async (idOrLink: string) => {
      if (!branch) return;
      const hashIdx = idOrLink.indexOf('#');
      const id = hashIdx >= 0 ? idOrLink.slice(0, hashIdx) : idOrLink;
      const hash = hashIdx >= 0 ? idOrLink.slice(hashIdx) : '';
      try {
        const r = await authFetch(
          `/api/workspace/${encodeURIComponent(branch)}/resolve-id/${encodeURIComponent(id)}`,
        );
        if (!r.ok) {
          console.warn(`[useNodeIdNav] unresolved id-link '${id}' (HTTP ${r.status})`);
          return;
        }
        const { workspacePath } = (await r.json()) as { workspacePath: string };
        openFile(workspacePath + hash);
      } catch (err) {
        console.error('[useNodeIdNav] id-link resolve failed:', err);
      }
    },
    [branch, openFile],
  );

  // The surface resolves an id its own way — the embed hands it to its host
  // as an app address, which the app then resolves with the reader's own
  // session. Resolving it HERE would need a session the embed does not have.
  if (surface) return { openNodeId: surface.openNodeId };
  return { openNodeId };
}
