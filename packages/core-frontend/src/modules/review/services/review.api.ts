import type { FileDiffPayload, ReviewSession } from '@bevel-software/platform-shared';
import { authFetch } from '../../../lib/api';

export class ReviewApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ReviewApiError';
    this.status = status;
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      message = String((body as { error: unknown }).error);
    }
  } catch {
    // non-JSON body — keep default
  }
  throw new ReviewApiError(res.status, message);
}

export async function fetchReviewSession(
  workspaceId: string,
): Promise<ReviewSession | null> {
  const data = await handle<{ session: ReviewSession | null }>(
    await authFetch(`/api/workspace/${workspaceId}/review`),
  );
  return data.session;
}

export async function fetchReviewFile(
  workspaceId: string,
  path: string,
): Promise<FileDiffPayload> {
  const q = new URLSearchParams({ path });
  return handle<FileDiffPayload>(
    await authFetch(`/api/workspace/${workspaceId}/review/file?${q.toString()}`),
  );
}

export async function acceptReviewChange(
  workspaceId: string,
  path?: string,
): Promise<ReviewSession | null> {
  const data = await handle<{ session: ReviewSession | null }>(
    await authFetch(`/api/workspace/${workspaceId}/review/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(path ? { path } : {}),
    }),
  );
  return data.session;
}

export async function rejectReviewChange(
  workspaceId: string,
  path?: string,
): Promise<ReviewSession | null> {
  const data = await handle<{ session: ReviewSession | null }>(
    await authFetch(`/api/workspace/${workspaceId}/review/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(path ? { path } : {}),
    }),
  );
  return data.session;
}
