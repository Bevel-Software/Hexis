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

/**
 * What the Edit control offers as the description: the author's part of the
 * body exactly as the server cuts it when it replaces it — everything before
 * the LAST `## Affected owners` line, Hexis's own hidden markers dropped (the
 * server keeps those). Not the dialog's one-line reason, which stops at the
 * first heading of any kind: offering that would drop an author's own `##`
 * sections from the text they then save.
 */
export function editableDescription(body: string | undefined): string {
  if (!body) return '';
  const lines = body.split('\n');
  const at = lines.lastIndexOf('## Affected owners');
  return (at === -1 ? lines : lines.slice(0, at))
    .join('\n')
    .replace(/<!--\s*(?:hexis|bevel)[:/][\s\S]*?-->/g, '')
    .trim();
}
