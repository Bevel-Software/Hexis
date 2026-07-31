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

/** One user account, as the admin user-administration dialog lists them. */
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  /** Epoch ms of account creation. */
  createdAt: number;
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  const res = await authFetch('/api/admin/users');
  if (!res.ok) throw new Error('Failed to load user accounts');
  const body = (await res.json()) as { users: AdminUser[] };
  return body.users;
}

/**
 * Permanently erase a user account (GDPR erasure path). The backend deletes
 * the account and its personal data and anonymizes the user's past review
 * activity; it refuses self-deletion (400).
 */
export async function deleteAdminUser(userId: string): Promise<void> {
  const res = await authFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    let serverError: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) serverError = body.error;
    } catch {
      // Non-JSON error body — fall through to the fallback message.
    }
    throw new Error(serverError ?? 'Failed to delete this account');
  }
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
