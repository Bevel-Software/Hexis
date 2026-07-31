import type { PullRequestSummary } from '@bevel-software/shared';
import { authFetch } from '../../../lib/api';
import { GitApiError } from './git.api';

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let body: unknown;
  let message = `HTTP ${res.status}`;
  try {
    body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      message = String((body as { error: unknown }).error);
    }
  } catch {
    // non-JSON body
  }
  throw new GitApiError(res.status, message, body);
}

/**
 * `opts.fresh` bypasses the backend's 30s list cache. Use it from event-driven
 * refreshes (agent turn end) where we specifically believe the underlying list
 * just changed; leave it off for the background poll so we don't hammer `gh`
 * every minute.
 */
export async function listPullRequestsForMe(
  opts: { fresh?: boolean } = {},
): Promise<PullRequestSummary[]> {
  const query = opts.fresh ? '?fresh=1' : '';
  return handle(await authFetch(`/api/workflow/change-requests/for-me${query}`));
}

export async function listMyPullRequests(): Promise<PullRequestSummary[]> {
  return handle(await authFetch('/api/workflow/change-requests/mine'));
}

export async function getPullRequest(num: number): Promise<PullRequestSummary> {
  return handle(await authFetch(`/api/workflow/change-requests/${num}`));
}
