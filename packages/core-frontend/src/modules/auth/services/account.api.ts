import { authFetch } from '../../../lib/api';

/** One row of the admin Accounts list (`GET /api/admin/accounts`). */
export interface AccountSummary {
  id: string;
  email: string;
  name: string;
  /** False for accounts that only ever signed in via SSO. */
  hasPassword: boolean;
  createdAt: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error || fallback;
}

/** Self-service password change. `currentPassword` is required once one is set. */
export async function changePassword(
  currentPassword: string | undefined,
  newPassword: string,
): Promise<void> {
  const res = await authFetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not change password'));
}

export async function listAccounts(): Promise<AccountSummary[]> {
  const res = await authFetch('/api/admin/accounts');
  if (!res.ok) throw new Error(await readError(res, 'Could not load accounts'));
  const body = (await res.json()) as { accounts: AccountSummary[] };
  return body.accounts;
}

/** Create an account (or reset an existing account's password — deliberate upsert). */
export async function createAccount(
  email: string,
  name: string,
  password: string,
): Promise<void> {
  const res = await authFetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: name || undefined, password }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not create account'));
}

/**
 * Permanently erase an account (GDPR erasure path). The backend deletes the
 * account and its personal data and anonymizes the user's past review
 * activity; it refuses self-deletion (400).
 */
export async function deleteAccount(userId: string): Promise<void> {
  const res = await authFetch(`/api/admin/accounts/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not delete this account'));
}
