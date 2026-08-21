import { useEffect, useState } from 'react';
import { isProtectedBranch } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { fetchFileAccess, type AccessEligible } from '../api';

export interface FileAccessState {
  /**
   * `null` while the request is in flight (or while we don't have a path to
   * check). `true` / `false` once the backend has answered. On error we fall
   * back to `true` so a transient API failure doesn't surprise-block edits
   * — the backend is the authoritative gate at commit time anyway.
   */
  canWrite: boolean | null;
  /** Same contract as `canWrite`, for the per-path `download:` verb. */
  canDownload: boolean | null;
  eligible: AccessEligible;
  /**
   * The node's owners — who to contact about it. Populated only when the
   * access lookup actually runs (protected branches with the file inside the
   * KB). Empty on drafts / non-KB paths, where the lookup is short-circuited.
   */
  owners: AccessEligible;
  /** True while the network request is in flight. */
  loading: boolean;
  /** Non-null when the lookup failed; we default-allow in that case. */
  error: string | null;
}

const EMPTY_ELIGIBLE: AccessEligible = { roles: [], users: [] };

/**
 * Resolve write permission for the given workspace-relative path against the
 * active workspace's access tree. Returns a loading-aware state so callers can
 * render an optimistic editor (`canWrite === null`) until the answer lands.
 *
 * `workspacePath` is workspace-relative — the same string the file tree uses
 * (`knowledge-base/Knowledge/Foo.md` for KB files, `my-notes.txt` for a
 * user-owned scratch file at workspace root). `branch` is the branch the
 * user is currently on. The hook splits three cases:
 *
 *   - **Path outside the KB repo dir.** Returns `canWrite: true` with empty
 *     eligible and never hits the network. Files outside `<kbDirName>/` are
 *     the user's own workspace; the access-control tree only governs the KB.
 *   - **Branch is non-protected (a draft).** Returns `canWrite: true` and
 *     never hits the network. Drafts are free-for-all in this model — the
 *     backend doesn't gate commit / push / lock on drafts either; the real
 *     access boundary is the change-request merge against the protected
 *     base. Showing the editor as read-only on a draft would contradict
 *     what the backend would happily accept.
 *   - **Branch is protected (and path is inside the KB).** Strips the
 *     `<kbDirName>/` prefix and queries the backend with the repo-relative
 *     path the resolver expects.
 *
 * Pass `null` for `workspacePath` when no file is open, and `null` for
 * `branch` while the working-tree status is still loading. The hook also
 * returns the no-path state while `kbDirName` is still null (workspace
 * bootstrap in flight) so we don't fire a misclassified request before we
 * know where the repo lives.
 */
export function useFileAccess(
  workspacePath: string | null,
  branch: string | null,
): FileAccessState {
  const { workspaceId, kbDirName } = useWorkspace();
  const [state, setState] = useState<FileAccessState>({
    canWrite: null,
    canDownload: null,
    eligible: EMPTY_ELIGIBLE,
    owners: EMPTY_ELIGIBLE,
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (!workspacePath || !kbDirName || !workspaceId) {
      setState({ canWrite: null, canDownload: null, eligible: EMPTY_ELIGIBLE, owners: EMPTY_ELIGIBLE, loading: false, error: null });
      return;
    }
    // Files outside the KB repo dir are the user's own workspace — never
    // gated. Short-circuit before any network call so a misconfigured
    // access tree can't lock users out of their own scratch files.
    const prefix = `${kbDirName}/`;
    if (!workspacePath.startsWith(prefix)) {
      setState({ canWrite: true, canDownload: true, eligible: EMPTY_ELIGIBLE, owners: EMPTY_ELIGIBLE, loading: false, error: null });
      return;
    }
    // Drafts are free-for-all (mirrors the backend's branch-protected gates
    // in workflow/git.service.ts and workflow.service.ts). Skip the network
    // call entirely so a slow/failed lookup never grays out the editor on a
    // draft. `branch === null` is the bootstrap window before status loads;
    // return canWrite=null so callers stay optimistic until we know.
    if (branch === null) {
      setState({ canWrite: null, canDownload: null, eligible: EMPTY_ELIGIBLE, owners: EMPTY_ELIGIBLE, loading: false, error: null });
      return;
    }
    if (!isProtectedBranch(branch)) {
      setState({ canWrite: true, canDownload: true, eligible: EMPTY_ELIGIBLE, owners: EMPTY_ELIGIBLE, loading: false, error: null });
      return;
    }

    let cancelled = false;
    // Reset the verdicts to null (= optimistic/unknown) for the NEW lookup —
    // carrying the previous file's canWrite/canDownload across a file switch
    // would briefly show the old file's permissions on the new file.
    setState((s) => ({ ...s, canWrite: null, canDownload: null, loading: true, error: null }));
    // Strip kbDirName/ so the backend resolver receives the repo-relative
    // path it expects (`Knowledge/Foo.md`, not `knowledge-base/…`).
    const repoRelative = workspacePath.slice(prefix.length);
    fetchFileAccess(workspaceId, repoRelative)
      .then((res) => {
        if (cancelled) return;
        setState({
          canWrite: res.canWrite,
          canDownload: res.canDownload,
          eligible: res.eligible,
          owners: res.owners,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        // Default-allow: transient API failures shouldn't trap users in a
        // read-only editor. The backend will still refuse the save if they
        // truly don't have access.
        setState({
          canWrite: true,
          canDownload: true,
          eligible: EMPTY_ELIGIBLE,
          owners: EMPTY_ELIGIBLE,
          loading: false,
          error: msg,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, workspacePath, kbDirName, branch]);

  return state;
}

/**
 * Render-helper for the "you don't have permission to edit this file" copy.
 * Used as a tooltip on disabled save
 * buttons.
 */
export function formatEligible(eligible: AccessEligible): string {
  const parts: string[] = [];
  if (eligible.roles.length) parts.push(eligible.roles.join(', '));
  if (eligible.users.length) {
    parts.push(
      eligible.users.map((u) => (u.name ? `${u.name} (${u.email})` : u.email)).join(', '),
    );
  }
  return parts.join('; ') || 'no one';
}
