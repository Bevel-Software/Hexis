import { authFetch } from '../../../lib/api';

/**
 * One row of the admin Connection keys overview
 * (`GET /api/admin/connection-keys`): a key plus the account it belongs to.
 * Never carries the plaintext — that was shown to the owner exactly once.
 */
export interface AdminConnectionKey {
  id: string;
  label: string;
  /** `key` for a hand-made key; another kind for one a flow minted (a Claude link). */
  kind: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  user: {
    id: string;
    email: string;
    name: string;
  };
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error || fallback;
}

/** Every connection key on the deployment, ordered by owner email then newest-first. */
export async function listConnectionKeys(): Promise<AdminConnectionKey[]> {
  const res = await authFetch('/api/admin/connection-keys');
  if (!res.ok) throw new Error(await readError(res, 'Could not load connection keys'));
  const body = (await res.json()) as { keys: AdminConnectionKey[] };
  return body.keys;
}

/**
 * Revoke any account's key. The row is kept so its last-used
 * time stays auditable; the agent holding the key loses access at once.
 */
export async function revokeConnectionKey(id: string): Promise<void> {
  const res = await authFetch(`/api/admin/connection-keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not revoke this key'));
}
