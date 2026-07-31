import { authFetch } from '../../../lib/api';
import { handleApiResponse } from '../../git/services/git.api';

/** Request shape of `POST /api/workflow/change-requests` (see backend
 *  `modules/workflow/workflow.routes.ts`). */
export interface OpenChangeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
}

/**
 * Open a change request directly — no agent in the loop. The backend resolves
 * the source branch's workspace, runs the target→source auto-merge, and
 * creates the CR. This is the core fallback path behind the change-request
 * port; the enterprise registry overrides the port with the agent-driven
 * chat flow (cascade impact analysis + `gh pr create`).
 */
export async function openChangeRequest(
  input: OpenChangeRequestInput,
): Promise<unknown> {
  return handleApiResponse(
    await authFetch('/api/workflow/change-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}
