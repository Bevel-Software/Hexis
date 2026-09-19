import { fetchFileAccess } from '../../access/api';
import { getOrCreateWorkspace } from '../../workspace/services/workspace.api';
import { failureReason, isDenial, nearestRuleFolder, type ReadFailure } from '../utils/readFailure';

/**
 * Turning a failed file read into the fact a reviewer can act on.
 *
 * Lives beside the change-request reads rather than inside them because it
 * makes its own request: naming the folder to ask about means resolving the
 * path's access view, which the read that just failed obviously did not bring
 * back. Kept in its own module so the read services stay one round trip each.
 */

/**
 * The nearest folder whose access rules govern `repoRelativePath`, or `null`
 * when the app cannot name one.
 *
 * `GET /access` answers for any authenticated caller — it reports who may
 * reach a path, which is not itself privileged — so a path the caller was just
 * refused is still describable. Every failure here is swallowed: the folder is
 * a courtesy on top of the denial, and a reviewer who cannot be told which
 * folder to ask about still has to be told they were refused.
 */
export async function governingRuleFolder(
  branch: string,
  repoRelativePath: string,
): Promise<string | null> {
  try {
    const { workspace } = await getOrCreateWorkspace(branch);
    const access = await fetchFileAccess(workspace.id, repoRelativePath);
    return nearestRuleFolder(access.sources);
  } catch {
    return null;
  }
}

/**
 * The failure, described: a denial (with the folder to ask about when there is
 * one) or a retryable error with the reason the server gave. Async because
 * naming the folder is a second read — callers keep showing "Loading…" until
 * it settles rather than publishing a sentence they are about to rewrite.
 */
export async function describeReadFailure(
  err: unknown,
  branch: string,
  repoRelativePath: string,
): Promise<ReadFailure> {
  if (!isDenial(err)) return { kind: 'error', reason: failureReason(err) };
  return { kind: 'denied', folder: await governingRuleFolder(branch, repoRelativePath) };
}
