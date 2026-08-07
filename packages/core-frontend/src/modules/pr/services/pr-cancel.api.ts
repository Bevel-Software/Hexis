import type { CancelPrResult } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Close the change request without merging. The backend re-validates that the
 * caller is the author, a base-branch admin, or holds write on every changed
 * file (the same set driving the `viewerCanCancel` UI hint), refuses if the
 * PR is already merged/closed, and flips the row to `closed`. No body needed —
 * the authorization gate is server-side.
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
