import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGit } from '../../git/state/git.context';
import { useWorkspace } from '../state/workspace.context';
import { authFetch } from '../../../lib/api';

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

function safeDecode(s: string): string {
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

export function useFileNav() {
  const navigate = useNavigate();
  const git = useGit();
  const { kbDirName } = useWorkspace();
  const branch = git.status?.branch ?? null;

  const openFile = useCallback(
    (pathOrUrl: string) => {
      // Split off a trailing heading anchor (`…/Node.md#goal`) so it survives as
      // a real URL fragment. Without this, `kbFileUrl` would percent-encode the
      // `#` into the path (`Node.md%23goal`) and the deep-link scroll would never
      // fire. The fragment is preserved verbatim and re-appended after the
      // canonical file URL is built.
      const hashIdx = pathOrUrl.indexOf('#');
      const hash = hashIdx >= 0 ? pathOrUrl.slice(hashIdx) : '';
      const path = hashIdx >= 0 ? pathOrUrl.slice(0, hashIdx) : pathOrUrl;

      // Absolute workspace URLs (`/workspace/<branch>/<path>`) carry their
      // own branch — never override with the current branch. Parse out the
      // branch + path segments and re-route via kbFileUrl so encoding is
      // canonical regardless of how the caller produced the URL (literal
      // spaces, mixed encoding, etc.). FileRoute handles the actual git
      // checkout if the URL's branch differs from the current one.
      if (path.startsWith(`${KB_ROUTE_PREFIX}/`)) {
        const rest = path.slice(KB_ROUTE_PREFIX.length + 1);
        const slashIdx = rest.indexOf('/');
        if (slashIdx < 0) {
          navigate(kbFileUrl(safeDecode(rest)) + hash);
        } else {
          navigate(
            kbFileUrl(
              safeDecode(rest.slice(0, slashIdx)),
              stripJunkBeforeKbDir(safeDecode(rest.slice(slashIdx + 1)), kbDirName),
            ) + hash,
          );
        }
        return;
      }
      if (!branch) return;
      navigate(kbFileUrl(branch, stripJunkBeforeKbDir(path, kbDirName)) + hash);
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
   */
  const openWorkspacePath = useCallback(
    (path: string) => {
      if (!branch) return;
      navigate(kbFileUrl(branch, stripJunkBeforeKbDir(path, kbDirName)));
    },
    [branch, kbDirName, navigate],
  );

  const closeFile = useCallback(() => {
    if (!branch) return;
    navigate(kbFileUrl(branch));
  }, [branch, navigate]);

  return { openFile, openWorkspacePath, closeFile };
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
