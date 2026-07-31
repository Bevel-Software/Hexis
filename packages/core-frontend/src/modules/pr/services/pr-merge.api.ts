import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/** The 202 ack the merge endpoint returns — the merge then runs in the background. */
export interface MergeAccepted {
  status: 'merging';
  number: number;
}

/**
 * Trigger the server-side merge. `bypass: true` tells the gate to proceed
 * despite soft warnings (unapproved md-with-owner files); the bypassed list
 * is inlined in the merge commit body for audit. Hard blocks (PR closed,
 * no files) are refused regardless.
 *
 * **Asynchronous** — the gate re-validation + `gh pr merge` can take tens of
 * seconds on a large change request (long enough to hit the gateway's idle
 * timeout), so the endpoint acks with 202 and runs the merge in the
 * background. The outcome arrives over the workflow event bus:
 * `change-request-merged` on success, `change-request-merge-failed`
 * (with a `conflicts` flag) on failure. Callers show a pending state until
 * one of those events lands.
 */
export async function mergePullRequest(
  prNumber: number,
  opts: { bypass?: boolean } = {},
): Promise<MergeAccepted> {
  return handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bypass: opts.bypass === true }),
    }),
  );
}

/**
 * Re-runs the auto-merge of target → source on an existing change request.
 * On clean merge, the CR detail refreshes to reflect the new diff. On
 * conflicts, the response body carries the structured
 * `change-request-conflicts` error payload (status 409) listing the
 * conflicting paths — the caller catches it via `GitApiError` and
 * routes the agent into the resolution flow.
 */
export async function refreshChangeRequestFromTarget(prNumber: number): Promise<unknown> {
  return handleApiResponse(
    await authFetch(`/api/workflow/change-requests/${prNumber}/update-from-target`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
}
