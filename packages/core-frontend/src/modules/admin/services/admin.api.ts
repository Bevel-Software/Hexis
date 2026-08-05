import { authFetch } from '../../../lib/api';

/**
 * Single source of types for the admin inbox UI. Mirrors the backend shape in
 * `feedback.interface.ts`. Re-declared here (rather than imported from
 * `@bevel-software/platform-shared`) because the admin feature is small and lives entirely on
 * the frontend + a couple of backend files — putting types in `shared` would
 * pull a build-graph dependency for two interfaces.
 */
export type FeedbackSource = 'user' | 'agent';

export interface FeedbackListItem {
  id: string;
  userId: string;
  userEmail: string;
  userName: string;
  message: string;
  source: FeedbackSource;
  submittedAt: string;
}

export interface FeedbackListParams {
  limit?: number;
  cursor?: string;
  source?: FeedbackSource;
  q?: string;
}

export async function fetchAdminAccess(): Promise<{ isAdmin: boolean }> {
  const res = await authFetch('/api/admin/access');
  if (!res.ok) return { isAdmin: false };
  return res.json();
}

export async function fetchFeedbackList(
  params: FeedbackListParams,
): Promise<FeedbackListItem[]> {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set('limit', String(params.limit));
  if (params.cursor) qs.set('cursor', params.cursor);
  if (params.source) qs.set('source', params.source);
  if (params.q && params.q.trim().length > 0) qs.set('q', params.q.trim());
  const res = await authFetch(`/api/admin/feedback?${qs.toString()}`);
  if (!res.ok) throw new Error('Failed to load feedback');
  const body = (await res.json()) as { items: FeedbackListItem[] };
  return body.items;
}

export async function fetchUnreadCount(since: string | null): Promise<number> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const res = await authFetch(`/api/admin/feedback/unread-count${qs}`);
  if (!res.ok) return 0;
  const body = (await res.json()) as { count: number };
  return typeof body.count === 'number' ? body.count : 0;
}
