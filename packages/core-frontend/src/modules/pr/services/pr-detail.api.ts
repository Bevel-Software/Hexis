import type { PullRequestDetail } from '@bevel-software/shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Fetch the full PR detail (metadata + file diffs). `fresh` bypasses the
 * backend's 30s detail cache — use from event-driven refreshes (post-merge,
 * post-comment, post-open-change-request) but leave off for user-triggered
 * navigation.
 */
export async function fetchPrDetail(
  prNumber: number,
  opts: { fresh?: boolean } = {},
): Promise<PullRequestDetail> {
  const query = opts.fresh ? '?fresh=1' : '';
  return handleApiResponse(await authFetch(`/api/workflow/change-requests/${prNumber}/detail${query}`));
}
