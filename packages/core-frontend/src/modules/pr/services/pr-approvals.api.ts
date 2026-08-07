import type { FileApprovalState } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

export async function approvePrFile(
  prNumber: number,
  path: string,
): Promise<FileApprovalState[]> {
  const data = await handleApiResponse<{ approvals: FileApprovalState[] }>(
    await authFetch(`/api/workflow/change-requests/${prNumber}/files/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
  return data.approvals;
}

/**
 * Decline one file of a change request: the backend restores its merge-base
 * version on the source branch, dropping it from the request's diff. Same
 * permission as approving. `closed` is true when this was the LAST file and
 * the request closed itself (its branch is retired with it).
 */
export async function revertPrFile(
  prNumber: number,
  path: string,
): Promise<{ closed: boolean; remainingPaths: string[] }> {
  return handleApiResponse<{ closed: boolean; remainingPaths: string[] }>(
    await authFetch(`/api/workflow/change-requests/${prNumber}/files/revert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  );
}

export async function unapprovePrFile(
  prNumber: number,
  path: string,
): Promise<FileApprovalState[]> {
  // `path` goes in the query string rather than a DELETE body — some proxies
  // strip request bodies on DELETE. `encodeURIComponent` handles the slashes
  // in KB paths (e.g. `Process/Checkout.md`) cleanly.
  const qs = new URLSearchParams({ path }).toString();
  const data = await handleApiResponse<{ approvals: FileApprovalState[] }>(
    await authFetch(`/api/workflow/change-requests/${prNumber}/files/approve?${qs}`, { method: 'DELETE' }),
  );
  return data.approvals;
}
