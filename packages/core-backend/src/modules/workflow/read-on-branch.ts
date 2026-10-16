import type { IAccessControl } from '../access/access-control.interface.js';
import { WorkflowDomainError } from '../../shared/domain-errors.js';

/**
 * Whether `userEmail` may read `repoRelativePath` as another branch has it —
 * ONE answer for the app's compare route and the agent's history tools.
 *
 * Content served from another branch is read at the refs that could serve
 * it: the comparison prefers a local ref over `origin/<branch>`, so both
 * candidates are authorized. Every ref that resolves must grant the read,
 * and a branch none of whose refs resolve is denied: a ref that cannot be
 * authorized is never served. An access-model FAILURE is not an unresolvable
 * ref: it propagates with its own status (an unreadable access tree is the
 * documented 503 a client retries), never mapped to null, where the other
 * candidate's grant would serve a ref whose authorization errored.
 */
export async function readableOnBranch(
  accessControl: Pick<IAccessControl, 'canReadAtRef'>,
  workspaceId: string,
  userEmail: string,
  repoRelativePath: string,
  branch: string,
): Promise<boolean> {
  const verdicts: (boolean | null)[] = [];
  for (const ref of [`origin/${branch}`, branch]) {
    verdicts.push(await accessControl.canReadAtRef(workspaceId, ref, userEmail, repoRelativePath));
  }
  return !verdicts.some((v) => v === false) && !verdicts.every((v) => v === null);
}

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

/** The refusal `readableOnBranch` answers false with, as both callers word it. */
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

/** `readableOnBranch`, thrown when it answers false. */
export async function assertReadableOnBranch(
  accessControl: Pick<IAccessControl, 'canReadAtRef'>,
  workspaceId: string,
  userEmail: string,
  repoRelativePath: string,
  branch: string,
  displayPath: string = repoRelativePath,
): Promise<void> {
  if (!(await readableOnBranch(accessControl, workspaceId, userEmail, repoRelativePath, branch))) {
    throw new ReadOnBranchDeniedError(displayPath, branch);
  }
}
