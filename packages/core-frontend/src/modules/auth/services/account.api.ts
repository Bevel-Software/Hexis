import { authFetch } from '../../../lib/api';

/** One row of the admin Accounts list (`GET /api/admin/accounts`). */
export interface AccountSummary {
  id: string;
  email: string;
  name: string;
  /** A password hash is stored for this account. */
  hasPassword: boolean;
  /**
   * The deployment admin (`ADMIN_EMAIL` while `ADMIN_PASSWORD` is set): signs
   * in with the environment password whether or not a hash is stored.
   */
  isEnvAdmin: boolean;
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
 * How many places in the knowledge base name an account's address
 * (`GET /api/admin/accounts/:id/references`), and whether removing them is
 * allowed — the deployment owner and the last Admin never are.
 */
export interface AccountReferences {
  roles: number;
  groups: number;
  accessRules: number;
  fileGrants: number;
  total: number;
  files: string[];
  removable: boolean;
  blockedReason: string | null;
}

export async function getAccountReferences(userId: string): Promise<AccountReferences> {
  const res = await authFetch(`/api/admin/accounts/${encodeURIComponent(userId)}/references`);
  if (!res.ok) throw new Error(await readError(res, 'Could not count where this account is named'));
  return (await res.json()) as AccountReferences;
}

/** What happened to the address in roles, groups and access rules. */
export interface AccessRemovalOutcome {
  ok: boolean;
  /** Present when `ok` is false. */
  error?: string;
  removedFrom: string[];
  /**
   * Files that still name the deleted user — for the admin to fix. null when
   * they could not be checked (not the same as none).
   */
  stillNamedIn: string[] | null;
  /** The removal was committed but is not published yet; it is retried. */
  publishPending?: boolean;
}

/**
 * Permanently erase an account (GDPR erasure path). The backend deletes the
 * account and its personal data and anonymizes the user's past review
 * activity; it refuses self-deletion (400). With `removeFromAccess`, the
 * address is also removed from roles, groups and access rules in one commit —
 * the account is deleted even when that commit fails, and the outcome says
 * which files still name the user. Resolves to that outcome, or null when
 * removal was not requested.
 */
export async function deleteAccount(
  userId: string,
  opts: { removeFromAccess?: boolean } = {},
): Promise<AccessRemovalOutcome | null> {
  const query = opts.removeFromAccess ? '?removeFromAccess=1' : '';
  const res = await authFetch(`/api/admin/accounts/${encodeURIComponent(userId)}${query}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not delete this account'));
  if (!opts.removeFromAccess || res.status === 204) return null;
  const body = (await res.json().catch(() => ({}))) as { accessRemoval?: AccessRemovalOutcome };
  return body.accessRemoval ?? null;
}
