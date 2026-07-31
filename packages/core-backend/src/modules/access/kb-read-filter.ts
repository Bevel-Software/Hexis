/**
 * Shared read-filter primitive.
 *
 * One place that knows how to turn workspace-relative paths into read verdicts,
 * reused by every surface that must hide nodes a user can't read: the agent
 * tools (`read_file`/`list_files`/`grep`), the file-explorer tree, the content
 * routes, the diff/review routes, and the KB graph.
 *
 * It deliberately shares only the PRIMITIVE — the path mapping and the batched
 * verdict map — NOT the inclusion policy. Callers differ on that: the agent's
 * `list_files` keeps directory entries visible (a restricted child is filtered
 * when read), whereas the explorer tree hides a restricted directory's whole
 * subtree. Each caller applies the verdict to its own policy.
 *
 * It is parameterized by the access method to call (`ReadBatchFn`); every
 * caller — the tree, the agent tools, and the graph — now uses the full
 * `canReadBatch` (folder chain + per-node frontmatter `read:` rules), with the
 * per-file frontmatter reads memoized inside the access service.
 */

/**
 * A batched read check over KB-repo-relative paths. Returns a map keyed by the
 * input paths. `IAccessControl.canReadBatch` satisfies this shape.
 */
export type ReadBatchFn = (
  workspaceId: string,
  userEmail: string,
  kbRelPaths: string[],
) => Promise<Map<string, boolean>>;

/**
 * Map a workspace-relative path to its KB-repo-relative form (what the access
 * tree is keyed on), or null when the path is outside the KB repo — reserved
 * workspace files and the KB dir itself carry no `read:` rules and are never
 * gated. Tolerates a leading `./` or `/` and a trailing `/`.
 */
export function toKbRelative(p: string, kbDirName: string): string | null {
  const norm = p.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  const prefix = `${kbDirName}/`;
  if (!norm.startsWith(prefix)) return null;
  const rel = norm.slice(prefix.length);
  return rel.length > 0 ? rel : null;
}

/**
 * Resolve read verdicts for a set of workspace-relative paths in ONE batched
 * access call. Non-KB paths (outside `kbDirName`) are always readable — they
 * carry no `read:` rules. KB paths are checked via `batchFn`. Returns a map
 * keyed by the original `wsPaths` (so callers can look up by the entry path
 * they passed). A path absent from the access verdict resolves to `false`
 * (fail-closed) — never silently readable.
 */
export async function resolveReadableMap(
  batchFn: ReadBatchFn,
  workspaceId: string,
  userEmail: string,
  kbDirName: string,
  wsPaths: string[],
): Promise<Map<string, boolean>> {
  const relByWsPath = new Map<string, string>();
  for (const wp of wsPaths) {
    const rel = toKbRelative(wp, kbDirName);
    if (rel !== null) relByWsPath.set(wp, rel);
  }
  const verdict =
    relByWsPath.size > 0
      ? await batchFn(workspaceId, userEmail, [...new Set(relByWsPath.values())])
      : new Map<string, boolean>();
  const out = new Map<string, boolean>();
  for (const wp of wsPaths) {
    const rel = relByWsPath.get(wp);
    // Non-KB path → always readable. KB path → the verdict, fail-closed if absent.
    out.set(wp, rel === undefined ? true : verdict.get(rel) === true);
  }
  return out;
}
