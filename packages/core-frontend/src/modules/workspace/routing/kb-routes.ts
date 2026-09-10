import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGit } from '../../git/state/git.context';
import { useWorkspace } from '../state/workspace.context';
import { authFetch } from '../../../lib/api';
import { isExternalHref, isOpenableExternalHref } from '../../../shared/markdown/hrefs';

export const KB_ROUTE_PREFIX = '/workspace';

/**
 * Matches an id-link destination: a bare frontmatter id (`bdl-cpb-service-terms`,
 * or a snake_case tool/skill id like `my_tool`), optionally followed by a heading
 * anchor (`#id`, `#offer`). The id grammar (lowercase alphanumeric + hyphens +
 * underscores) can't collide with a `.md` path, an `http(s):` URL, or a same-page
 * `#anchor`; the anchor tail forbids `/` so a path link never matches.
 */
export const NODE_ID_LINK_RE = /^[a-z0-9][a-z0-9_-]*(#[^/]+)?$/;

/**
 * Self-heal a workspace-relative path the model may have mangled when it wrote
 * a citation link. The LLM sometimes corrupts the URL by inserting a junk
 * segment before the KB dir — e.g. `bevel-process-of-truth/knowledge-base/…`,
 * a blend of the branch name and the dir name — which then 404s. A well-formed
 * KB path has `<kbDirName>/` as its first segment, so when that segment shows up
 * *later* in the path we drop everything before it. No-op when the path is
 * already well-formed (kbDirName first) or has no `<kbDirName>` segment at all
 * (a non-repo file like `my-notes.txt`). Segment-exact match avoids the
 * `<kbDirName>-backup/…` substring foot-gun.
 */
export function stripJunkBeforeKbDir(path: string, kbDirName: string | null): string {
  if (!kbDirName) return path;
  const segs = path.split('/');
  const idx = segs.indexOf(kbDirName);
  return idx > 0 ? segs.slice(idx).join('/') : path;
}

export function kbFileUrl(branch: string, relativePath: string = ''): string {
  const branchPart = encodeURIComponent(branch);
  if (!relativePath) return `${KB_ROUTE_PREFIX}/${branchPart}`;
  const pathPart = relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${KB_ROUTE_PREFIX}/${branchPart}/${pathPart}`;
}

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
  const git = useGit();
  const branch = git.status?.branch ?? null;
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

  if (!branch || !workspacePath) return null;
  const nodeId = resolved && resolved.key === key ? resolved.id : null;
  const relative = nodeId ? kbNodeUrl(branch, nodeId) : kbFileUrl(branch, workspacePath);
  return `${window.location.origin}${relative}`;
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Resolve a relative path against a base file path (like `path.resolve`, but for
 * workspace-relative paths). Used to turn an internal link's href
 * (`../NodeTypes/Process.md`) into a workspace-relative path before navigating.
 */
export function resolveRelativePath(basePath: string, relative: string): string {
  // Root-relative hrefs (`/Knowledge/Node.md`) are anchored at the workspace
  // root, not the current file — resolve against an empty base so the leading
  // `/` doesn't get appended onto `baseDir` (`Knowledge/Knowledge/Node.md`).
  const baseDir =
    relative.startsWith('/')
      ? ''
      : basePath.includes('/')
        ? basePath.slice(0, basePath.lastIndexOf('/'))
        : '';
  const parts = baseDir ? baseDir.split('/') : [];
  for (const segment of relative.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

/**
 * A link destination as written in a knowledge page, classified and resolved.
 */
export type KbHref =
  | { kind: 'external' }
  | { kind: 'workspace'; branch: string | null; path: string; hash: string };

/**
 * The grammar of a link or image destination, as one function. `basePath` is
 * the file the link sits in; `kbDirName` drives the junk-segment repair.
 *
 *   href                                    kind       branch    path                  hash
 *   ──────────────────────────────────────  ─────────  ────────  ────────────────────  ──────
 *   https://x.y/z, mailto:a@b, tel:…        external
 *   //cdn.x.y/z  (protocol-relative)        external
 *   /workspace/<b>/<p>#h  (absolute app)    workspace  <b>       <p>, junk stripped    #h
 *   /workspace/<b>                          workspace  <b>       ''
 *   ../NodeTypes/Process.md#goal            workspace  null      resolved vs basePath  #goal
 *   /KB/x.png  (root-relative)              workspace  null      KB/x.png
 *   #overview  (same document)              workspace  null      basePath              #overview
 *   ''  (empty)                             null
 *
 * Percent-escapes are decoded (react-markdown encodes the spaces in a
 * destination; the file on disk has real spaces); a malformed escape is left
 * as-is, the tolerance `safeDecode` has always given the URL form. `branch` is
 * null for a relative link: the caller supplies the branch it is standing on.
 *
 * `repairMangledPath` runs {@link stripJunkBeforeKbDir} on the result. It is on
 * for a LINK, which may have been written by a model that mangled the path,
 * and off for an IMAGE, which was not: the repair rewrites any path whose
 * later segment happens to equal `kbDirName`, so on an image source it
 * truncates a correctly-authored `./assets/knowledge-base/shot.png` down to
 * `knowledge-base/shot.png` and the reader gets a placeholder where a picture
 * belongs. Same reasoning as `openWorkspacePath` below: a destination nobody
 * garbled needs no repair, and applying one can only find the wrong file.
 *
 * THE BRANCH RULE. A link handler navigates with the URL's branch, as
 * `openFile` always has: an absolute citation URL names the branch the cited
 * node lives on. An IMAGE resolver takes the path and ignores the branch: the
 * bytes come from the workspace the page is rendered from, so a cross-branch
 * image URL shows that tree's copy, or the placeholder when there is none.
 * Serving bytes at another branch is the `?ref=` item in TODOS.md.
 */
export function resolveKbHref(
  href: string,
  {
    basePath,
    kbDirName,
    repairMangledPath = true,
  }: { basePath: string; kbDirName: string | null; repairMangledPath?: boolean },
): KbHref | null {
  if (!href) return null;
  if (isExternalHref(href)) return { kind: 'external' };
  const hashIdx = href.indexOf('#');
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : '';
  const location = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const repair = (path: string) => (repairMangledPath ? stripJunkBeforeKbDir(path, kbDirName) : path);
  // Same document: `#overview` names a heading in the file the link sits in,
  // not a destination to resolve. Without this row an empty location falls
  // through to `resolveRelativePath`, which drops the file segment off
  // `basePath` and hands the caller the PARENT DIRECTORY — a reader who
  // clicked a section link lands on a folder listing.
  if (!location) return { kind: 'workspace', branch: null, path: basePath, hash };
  if (location.startsWith(`${KB_ROUTE_PREFIX}/`)) {
    const rest = location.slice(KB_ROUTE_PREFIX.length + 1);
    const slashIdx = rest.indexOf('/');
    if (slashIdx < 0) return { kind: 'workspace', branch: safeDecode(rest), path: '', hash };
    return {
      kind: 'workspace',
      branch: safeDecode(rest.slice(0, slashIdx)),
      path: repair(safeDecode(rest.slice(slashIdx + 1))),
      hash,
    };
  }
  return {
    kind: 'workspace',
    branch: null,
    path: repair(resolveRelativePath(basePath, safeDecode(location))),
    hash,
  };
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
  window.open(href, '_blank', 'noopener,noreferrer');
  return true;
}

export function useFileNav() {
  const navigate = useNavigate();
  const git = useGit();
  const { kbDirName } = useWorkspace();
  const branch = git.status?.branch ?? null;

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
   *   - Agent HTML, via `bevel.navigate(href)` from its own inline script.
   *     NOT via an anchor: `sanitizeAgentHtml` strips an `href` that
   *     `isInternalNodeLink` rejects, which is every scheme-bearing URL, so
   *     an external anchor loses its href before the nav bridge ever sees
   *     it. The scripted call is the reachable path, and it is why the
   *     allowlist below is load-bearing rather than belt-and-braces: that
   *     argument is an arbitrary string no sanitizer inspected.
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
   */
  const openWorkspacePath = useCallback(
    (path: string) => {
      if (!branch) return;
      navigate(kbFileUrl(branch, path));
    },
    [branch, navigate],
  );

  const closeFile = useCallback(() => {
    if (!branch) return;
    navigate(kbFileUrl(branch));
  }, [branch, navigate]);

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
  const { openFile } = useFileNav();
  const git = useGit();
  const branch = git.status?.branch ?? null;

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

  return { openNodeId };
}
