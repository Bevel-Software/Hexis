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
  /** When an admin switched the account off; null while it is on. */
  deactivatedAt: string | null;
  /** One of the accounts the platform runs its own work as: it is never switched off. */
  isSystem: boolean;
  createdAt: string;
}

/**
 * A refused account request, with the HTTP status kept. Most callers only
 * show the message; the invite dialog also needs to tell a 403 — the
 * deployment has no place for another account, a seat limit say — from any
 * other refusal, and the message alone is the host's own words, not a code.
 */
export class AccountRequestError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'AccountRequestError';
    this.status = status;
  }
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

/**
 * Create an account (or reset an existing account's password — deliberate
 * upsert). Without a password the account is for single sign-on: the person
 * finds it waiting the first time they sign in.
 *
 * A refusal throws {@link AccountRequestError}; 403 means the deployment's
 * admission rules had no place for the account.
 */
export async function createAccount(
  email: string,
  name: string,
  password?: string,
): Promise<void> {
  const res = await authFetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: name || undefined, password: password || undefined }),
  });
  if (!res.ok) throw new AccountRequestError(await readError(res, 'Could not create account'), res.status);
}

/**
 * Switch an account off: it keeps its history and its place in roles and
 * groups, but cannot sign in, and its keys and agent connections stop working.
 */
export async function deactivateAccount(userId: string): Promise<void> {
  const res = await authFetch(`/api/admin/accounts/${encodeURIComponent(userId)}/deactivate`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Could not switch this account off'));
}

/** Switch it back on — refused (with the deployment's reason) when there is no room for it. */
export async function reactivateAccount(userId: string): Promise<void> {
  const res = await authFetch(`/api/admin/accounts/${encodeURIComponent(userId)}/reactivate`, { method: 'POST' });
  if (!res.ok) throw new Error(await readError(res, 'Could not switch this account on'));
}

/**
 * How many places in the knowledge base name an account's address
 * (`GET /api/admin/accounts/:id/references`), whether removing them is
 * allowed — the deployment owner and the last Admin never are — and which of
 * those files the signed-in admin cannot write, so will keep the address.
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
  /**
   * Of `files`, the ones the signed-in admin may not write (a folder that
   * excludes Admin, the machine-owned `synced-groups.yaml`). The cleanup
   * skips these and they keep the address. null when write access could not
   * be judged at all — not the same as none.
   */
  unwritable: string[] | null;
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
 *
 * A removal that WAS requested and came back with no outcome (a 204: the
 * deployment has no access-removal service wired) is not the same as none
 * requested — the account is gone and its address still stands in the files
 * — so it resolves to a failed outcome that says so, with `stillNamedIn`
 * unknown, rather than to the silence the page would read as success.
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
  if (!opts.removeFromAccess) return null;
  const notDone: AccessRemovalOutcome = {
    ok: false,
    error: 'this deployment cannot remove addresses from access files',
    removedFrom: [],
    stillNamedIn: null,
  };
  if (res.status === 204) return notDone;
  const body = (await res.json().catch(() => ({}))) as { accessRemoval?: AccessRemovalOutcome };
  return body.accessRemoval ?? notDone;
}
