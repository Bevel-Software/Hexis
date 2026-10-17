import type { IAccessControl } from '../access/access-control.interface.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';

/**
 * Which of `paths` `userEmail` may read at `origin/<base>`, as a membership
 * set — ONE rule for the change-request reads (their file lists, judged at
 * the request's base) and for `branch_status` (the paths a request would
 * carry). A null answer (the ref, or its `roles.yaml`, does not resolve)
 * withholds everything, which is the same reading the app's fork-point
 * route gives it.
 */
export async function readablePathsAt(
  accessControl: Pick<IAccessControl, 'canReadBatchAtRef'>,
  workspaceId: string,
  userEmail: string,
  base: string,
  paths: string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const verdicts = await accessControl.canReadBatchAtRef(workspaceId, `origin/${base}`, userEmail, [...new Set(paths)]);
  if (!verdicts) return new Set();
  return new Set([...verdicts].filter(([, allowed]) => allowed).map(([p]) => p));
}

/**
 * Whether `userEmail` may read `repoRelativePath` at EVERY one of `commits`
 * — ONE rule for content served from another branch, for the app's compare
 * route and the agent's history tools alike: the commits the service read
 * the content at, pinned by the service inside its reservation (a diff's two
 * sides, a file at a branch's published tip, the two commits a merge is of),
 * so the verdict is about the bytes actually served, never about a branch
 * ref a fetch may have moved between the verdict and the read. A commit
 * whose rules cannot be read (null) grants nothing. An access-model FAILURE
 * is not a null: it propagates with its own status (an unreadable access
 * tree is the documented 503 a client retries).
 */
export async function readableAtCommits(
  accessControl: Pick<IAccessControl, 'canReadAtRef'>,
  workspaceId: string,
  userEmail: string,
  repoRelativePath: string,
  commits: readonly string[],
): Promise<boolean> {
  for (const sha of commits) {
    if ((await accessControl.canReadAtRef(workspaceId, sha, userEmail, repoRelativePath)) !== true) return false;
  }
  return true;
}

/** The refusal `readableAtCommits` answers false with, as every caller words it: the branch named, never the commit. */
export class ReadOnBranchDeniedError extends WorkflowDomainError {
  constructor(displayPath: string, branch: string) {
    super(`You don't have permission to read "${displayPath}" on "${branch}".`, 403, {
      kind: 'read-denied',
      path: displayPath,
      branch,
    });
    this.name = 'ReadOnBranchDeniedError';
  }
}

/**
 * `readableAtCommits` at every commit `branch` resolves to (the one its
 * content was served from, and any other its local head or published tip
 * names), thrown when it answers false.
 */
export async function assertReadableAtCommits(
  accessControl: Pick<IAccessControl, 'canReadAtRef'>,
  workspaceId: string,
  userEmail: string,
  repoRelativePath: string,
  commits: readonly string[],
  branch: string,
  displayPath: string = repoRelativePath,
): Promise<void> {
  if (!(await readableAtCommits(accessControl, workspaceId, userEmail, repoRelativePath, commits))) {
    throw new ReadOnBranchDeniedError(displayPath, branch);
  }
}
