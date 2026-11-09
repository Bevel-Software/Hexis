import type { InvitationRequest, InvitationResult } from '@bevel-software/platform-shared';
import { authFetch, getToken, setToken } from '../../../lib/api';

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
  /** One of the deployment's owners (`ADMIN_EMAIL`): never switched off, and its password is not set here. */
  isOwner: boolean;
  /** An owner who can sign back in with the server's password, so their account may be deleted; false otherwise. */
  ownerCanBeDeleted: boolean;
  /** When an admin switched the account off; null while it is on. */
  deactivatedAt: string | null;
  /** One of the accounts the platform runs its own work as: it is never switched off. */
  isSystem: boolean;
  createdAt: string;
}

/**
 * A refused account request, with the HTTP status and the server's `kind`
 * kept. Most callers only show the message; the invite dialog also needs to
 * tell the deployment having no place for another account (a seat limit,
 * say: 403 with `kind: 'admission'`) from any other refusal — a 403 from the
 * admin check included — and the message alone is the host's own words, not
 * a code.
 */
export class AccountRequestError extends Error {
  status: number;
  /** The server's machine-readable reason, when it gave one (`admission`). */
  kind: string | null;
  constructor(message: string, status: number, kind: string | null = null) {
    super(message);
    this.name = 'AccountRequestError';
    this.status = status;
    this.kind = kind;
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body as { error?: string }).error || fallback;
}

/**
 * The refusal of a request that makes an account, both routes alike (the
 * admins' accounts API and the invitation): the server's words, or
 * `fallback`, and its `kind` (`admission` when no seat was left).
 */
async function accountRefusal(res: Response, fallback: string): Promise<AccountRequestError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; kind?: unknown };
  const message = typeof body.error === 'string' && body.error ? body.error : fallback;
  return new AccountRequestError(message, res.status, typeof body.kind === 'string' ? body.kind : null);
}

/**
 * `notified` on a reply that made an account: how the deployment told the
 * person of the invite (`'email'`, say), as its listeners answered. Empty
 * when nobody did, and the inviter hands over the link themselves.
 */
function notifiedChannels(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}

/**
 * Self-service password change. `currentPassword` is required once one is set.
 * The change ends every session opened before it, this one's included, so the
 * fresh token the server hands back replaces the stored one — but only the
 * one this request sent: the stored token is one key shared by every tab, and
 * a tab that signed in as someone else while this request was in flight has
 * replaced it already. That sign-in is kept; this change's token belongs to
 * a session that tab no longer has.
 */
export async function changePassword(
  currentPassword: string | undefined,
  newPassword: string,
): Promise<void> {
  const sent = getToken();
  const res = await authFetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) throw new Error(await readError(res, 'Could not change password'));
  const body = (await res.json().catch(() => ({}))) as { token?: unknown };
  // The change is written by now. Only a token the server actually handed
  // back replaces the stored one: an answer without one (a replica from
  // before the change handed tokens back, mid-deploy) must not turn the
  // stored token into the string "undefined" and sign the person out.
  const token = typeof body.token === 'string' && body.token ? body.token : null;
  if (token && getToken() === sent) setToken(token);
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
 * With `keepExistingPassword` (an invite's starting password) the password
 * goes only to a new account or a switched-on one that has none; the reply's
 * `passwordSet` says whether it did, and `deactivated` whether it did not
 * because the account is switched off.
 *
 * A refusal throws {@link AccountRequestError}; `kind: 'admission'` means
 * the deployment's admission rules had no place for the account.
 */
export async function createAccount(
  email: string,
  name: string,
  password?: string,
  options: { keepExistingPassword?: boolean } = {},
): Promise<{ passwordSet?: boolean; deactivated?: boolean; notified?: string[] }> {
  const res = await authFetch('/api/admin/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      name: name || undefined,
      password: password || undefined,
      keepExistingPassword: options.keepExistingPassword || undefined,
    }),
  });
  if (!res.ok) throw await accountRefusal(res, 'Could not create account');
  const body = (await res.json().catch(() => ({}))) as {
    passwordSet?: unknown;
    deactivated?: unknown;
    notified?: unknown;
  };
  const notified = notifiedChannels(body.notified);
  return {
    ...(typeof body.passwordSet === 'boolean' ? { passwordSet: body.passwordSet } : {}),
    ...(body.deactivated === true ? { deactivated: true } : {}),
    ...(notified.length > 0 ? { notified } : {}),
  };
}

/**
 * Invite one address (`POST /api/invitations`), for anyone signed in: a NEW
 * account, or `{ status: 'existing' }` for an address that has one, which
 * the server leaves exactly as it was. `startingPassword` asks the server to
 * generate a password for the new account; the answer carries it this once.
 *
 * A refusal throws {@link AccountRequestError}; `kind: 'admission'` means
 * the deployment's admission rules had no place for the account.
 */
export async function sendInvitation(request: InvitationRequest): Promise<InvitationResult> {
  const res = await authFetch('/api/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw await accountRefusal(res, 'Could not invite them');
  const body = (await res.json().catch(() => ({}))) as {
    status?: unknown;
    account?: Extract<InvitationResult, { status: 'created' }>['account'];
    startingPassword?: unknown;
    notified?: unknown;
    singleSignOn?: unknown;
  };
  if (body.status === 'existing') return { status: 'existing' };
  if (body.status !== 'created' || !body.account) throw new AccountRequestError('Could not invite them', res.status);
  return {
    status: 'created',
    account: body.account,
    ...(typeof body.startingPassword === 'string' && body.startingPassword ? { startingPassword: body.startingPassword } : {}),
    notified: notifiedChannels(body.notified),
    // Never assumed: only a server that says so has single sign-on letting them in.
    singleSignOn: body.singleSignOn === true,
  };
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
