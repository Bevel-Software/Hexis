import type { PullRequestSummary, UpdateChangeRequestInput } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/**
 * Change an open change request's title and/or description. The server
 * re-checks who may (the author, or anyone who may merge it — the
 * `viewerCanEdit` verdict) and refuses a merged or closed request; its
 * refusal's words arrive as the thrown error's message.
 */
export async function updateChangeRequest(
  prNumber: number,
  input: UpdateChangeRequestInput,
): Promise<PullRequestSummary> {
  return handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}
