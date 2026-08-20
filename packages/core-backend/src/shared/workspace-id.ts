/**
 * The branch ↔ workspace-directory naming convention. Workspaces are
 * per-branch (one on-disk clone per branch name), and the workspace id IS the
 * URL-encoded branch name — deterministic both ways, so every caller
 * (backend, frontend, agent) can compute one from the other without a DB
 * round-trip. Consumed by nearly every module that touches a workspace, so it
 * lives in `backend/src/shared` rather than inside the workspace module.
 *
 * Pure string handling — no IO, no DB.
 */

/**
 * Map a branch name to the directory that contains its workspace clone.
 * `encodeURIComponent` handles `/` in branch names (e.g. `alice/foo`) by
 * encoding it to `%2F` — single-segment-safe on every supported filesystem.
 */
export function workspaceIdForBranch(branch: string): string {
  return encodeURIComponent(branch);
}

/**
 * Map a workspace id back to its branch name. Workspace ids come in from
 * request paths and from directory names on disk, so malformed input (a lone
 * `%`, `%` without two hex digits) must not throw — `decodeURIComponent`
 * would raise a `URIError` that surfaces as an unhandled 500 in every route
 * that resolves an id. A malformed id can never equal a valid encoding, so
 * returning it unchanged is safe: it simply names a branch that does not
 * exist, and the caller's own lookup fails with its normal not-found path.
 */
export function branchForWorkspaceId(workspaceId: string): string {
  try {
    return decodeURIComponent(workspaceId);
  } catch {
    return workspaceId;
  }
}
