import type { CancelPrResult } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Close the change request without merging. The backend re-validates that the
 * caller is the author or a base-branch admin (same predicate driving the
 * `viewerCanCancel` UI hint), refuses if the PR is already merged/closed, and
 * shells out to `gh pr close`. No body needed — author/admin gate is server-side.
 */
export async function cancelPullRequest(prNumber: number): Promise<CancelPrResult> {
  return handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}

/**
 * Delete a change request outright: close it AND retire its source branch.
 * Admin-only — the server refuses everyone else; callers gate the button on
 * `detail.viewerCanBypassMerge`, the same admin verdict.
 */
export async function deleteChangeRequest(prNumber: number): Promise<void> {
  await handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}`, { method: 'DELETE' }),
  );
}
