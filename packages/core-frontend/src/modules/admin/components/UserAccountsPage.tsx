import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { PageShell } from '../../../shared/components/PageShell';
import { Dialog } from '../../../shared/components/Dialog';
import { useAdmin } from '../state/admin.context';
import { useAuth } from '../../auth/state/auth.context';
import {
  createAccount,
  deleteAccount,
  listAccounts,
  type AccountSummary,
} from '../../auth/services/account.api';

/**
 * How an account signs in, in the words this page uses everywhere (the row and
 * the delete confirmation). The deployment admin wins over a stored hash: both
 * can be true, and the environment credential is the one that survives.
 */
function signInMethodLabel(account: Pick<AccountSummary, 'hasPassword' | 'isEnvAdmin'>): string {
  if (account.isEnvAdmin) return 'Password (deployment admin)';
  if (account.hasPassword) return 'Password';
  return 'No password — signs in with single sign-on';
}

/**
 * What deleting the account means for signing in again, keyed off the same
 * facts as {@link signInMethodLabel} and opening with its wording.
 */
function signInAfterDelete(account: AccountSummary): string {
  const label = signInMethodLabel(account);
  if (account.isEnvAdmin) {
    return `${label}: they can still sign in with the deployment admin password, but will start fresh.`;
  }
  if (account.hasPassword) {
    return `${label}: to sign in again they will need an admin to create a new account for them.`;
  }
  return `${label}: they can sign in again later with single sign-on, but will start fresh.`;
}

/**
 * The two password actions and everything the page says about each. Setting a
 * first password and replacing one someone signs in with today are different
 * acts — the second takes a working credential away — so they get different
 * labels and different copy, and a reset asks before it does it.
 *
 * The whole branch is `hasPassword`, the flag the list already carries for the
 * sign-in method line: nothing about the credential itself is read here, and
 * nothing more needs to be.
 */
type PasswordAction = {
  /** The row button, the dialog title and the confirm button all read this. */
  label: string;
  /** The row button's tooltip. */
  title: string;
  /** What the new password does, said after the account it is for. */
  effect: string;
  /** The question the confirm button answers, or none when there is nothing to lose. */
  confirm: string | null;
  /** The inline banner once it is done. */
  done: string;
};

const SET_PASSWORD: PasswordAction = {
  label: 'Set password',
  title: 'Set a sign-in password for this account.',
  effect:
    'They have no password today, so from now on they will be able to sign in with this one as well as with single sign-on.',
  confirm: null,
  done: 'Password set',
};

const RESET_PASSWORD: PasswordAction = {
  label: 'Reset password',
  title: 'Replace the sign-in password this account has now.',
  effect:
    'Their current password stops working immediately and this one takes its place, so they are locked out of password sign-in until they have it.',
  confirm: 'Reset it?',
  done: 'Password reset',
};

function passwordAction(account: Pick<AccountSummary, 'hasPassword'>): PasswordAction {
  return account.hasPassword ? RESET_PASSWORD : SET_PASSWORD;
}

/**
 * The User Accounts page (`/user-accounts`, admins only) — the ONE
 * account-management surface: every account on the deployment, whether it can
 * sign in with a password, set a user's first password (accounts that predate
 * per-user passwords can't sign in until an admin sets one) or reset the one
 * they have — two acts the page names apart, see {@link PasswordAction} —
 * permanently delete an account (the GDPR erasure path — overlays contribute
 * their data slices via erasure participants), and add a new account. Set,
 * reset and create all go through `POST /api/admin/accounts`, an
 * upsert-by-email that preserves an existing display name when none is
 * supplied. The signed-in admin's own row offers neither action — the backend
 * refuses self-erasure, and their own password lives on the Account page. The
 * deployment admin's row offers no password action either, from any admin:
 * that account's password is set in the deployment environment, and the
 * backend refuses to store one for it.
 */
export function UserAccountsPage() {
  const { isAdmin } = useAdmin();
  const { user: me } = useAuth();
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The account awaiting delete confirmation; non-null drives the confirm
  // Dialog. `deleting` keeps the confirm open while the request is in flight.
  const [pendingDelete, setPendingDelete] = useState<AccountSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The account whose password is being set; non-null drives the password
  // Dialog. Success feedback surfaces inline above the list.
  const [passwordTarget, setPasswordTarget] = useState<AccountSummary | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);
  // Which account was just given a password, and which of the two actions it
  // was — the target is cleared when the dialog closes, and "set" and "reset"
  // are not the same news to report.
  const [passwordDone, setPasswordDone] = useState<{
    email: string;
    action: PasswordAction;
  } | null>(null);
  // Add-account form.
  const [addEmail, setAddEmail] = useState('');
  const [addName, setAddName] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(() => {
    listAccounts()
      .then((rows) => {
        setAccounts(rows);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Couldn't load accounts.");
        // `accounts` is deliberately left alone. A RELOAD that fails keeps the
        // rows it already had; a FIRST load that fails stays `null`, because
        // storing `[]` would render "No user accounts." — an admin reading
        // that would take a deployment they cannot reach for one nobody is on.
      });
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount(pendingDelete.id);
      setPendingDelete(null);
      refresh();
    } catch (err) {
      setPendingDelete(null);
      setError(err instanceof Error ? err.message : "Couldn't delete this account.");
    } finally {
      setDeleting(false);
    }
  }

  function openPasswordDialog(account: AccountSummary) {
    setPasswordTarget(account);
    setNewPassword('');
    setPasswordError(null);
    setPasswordDone(null);
  }

  async function confirmPasswordChange() {
    if (!passwordTarget || savingPassword || newPassword.length === 0) return;
    setSavingPassword(true);
    setPasswordError(null);
    try {
      // No name → the upsert keeps the account's existing display name.
      await createAccount(passwordTarget.email, '', newPassword);
      setPasswordDone({ email: passwordTarget.email, action: passwordAction(passwordTarget) });
      setPasswordTarget(null);
      refresh();
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Couldn't save the password.");
    } finally {
      setSavingPassword(false);
    }
  }

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await createAccount(addEmail.trim(), addName.trim(), addPassword);
      setAddEmail('');
      setAddName('');
      setAddPassword('');
      refresh();
    } catch (err) {
      setAddError(err instanceof Error ? err.message : "Couldn't add the account.");
    } finally {
      setAdding(false);
    }
  }

  if (!isAdmin) {
    return (
      <PageShell title="User accounts">
        <div className="text-sm text-ink-muted">
          Admins only. Ask an admin if you need an account created or changed.
        </div>
      </PageShell>
    );
  }

  const inputClass =
    'w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent';

  // Which of the two the open dialog is. The Dialog renders nothing without a
  // target, so the fallback is never on screen — it just keeps the type honest.
  const passwordDialog = passwordTarget ? passwordAction(passwordTarget) : SET_PASSWORD;

  return (
    <>
      <PageShell title="User accounts">
        <div className="space-y-4">
          <p className="text-xs text-ink-muted leading-snug">
            Everyone with an account on this deployment. Deleting an account permanently removes
            the person&apos;s data and anonymizes their past review activity; their saves in the
            knowledge base keep their history. Setting a password lets someone sign in with
            email + password (existing accounts keep everything else); resetting one replaces
            the password they have now.
          </p>

          {error && (
            <div
              className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-sm px-2 py-1.5"
              role="alert"
            >
              {error}
            </div>
          )}
          {passwordDone && (
            <div
              className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-sm px-2 py-1.5"
              role="status"
            >
              {passwordDone.action.done} for {passwordDone.email}.
            </div>
          )}

          {accounts === null ? (
            // Nothing to list and nothing to call empty: the banner above is
            // the whole answer, so this renders nothing rather than a
            // "Loading…" that would never resolve.
            error ? null : <div className="text-xs text-ink-muted">Loading…</div>
          ) : accounts.length === 0 ? (
            <div className="text-xs text-ink-muted">No user accounts.</div>
          ) : (
            <ul className="divide-y divide-line border border-line rounded-sm">
              {accounts.map((account) => {
                const isSelf = account.id === me?.id;
                return (
                  <li key={account.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {account.name}
                        {isSelf && (
                          <span className="ml-1.5 text-meta font-normal text-ink-muted">(you)</span>
                        )}
                      </div>
                      <div className="text-meta text-ink-muted truncate">
                        {account.email} · Joined {new Date(account.createdAt).toLocaleDateString()} ·{' '}
                        {signInMethodLabel(account)}
                      </div>
                    </div>
                    {!isSelf &&
                      (account.isEnvAdmin ? (
                        // Neither password action for the deployment admin: its
                        // password is the environment's, and a stored one
                        // would only ADD a credential that outlives rotating
                        // ADMIN_PASSWORD. The backend refuses it too — this
                        // says why instead of offering a button that fails.
                        // `hasPassword` does not change that on this row.
                        <span className="text-meta text-ink-muted text-right max-w-[13rem]">
                          Password set in the deployment environment
                        </span>
                      ) : (
                        <button
                          onClick={() => openPasswordDialog(account)}
                          className="text-xs px-2 py-1 rounded-sm text-ink hover:bg-hover border border-line"
                          title={passwordAction(account).title}
                          aria-label={`${passwordAction(account).label} for ${account.email}`}
                        >
                          {passwordAction(account).label}
                        </button>
                      ))}
                    {!isSelf && (
                      <button
                        onClick={() => setPendingDelete(account)}
                        className="text-xs px-2 py-1 rounded-sm text-red-700 hover:bg-red-50 border border-red-200"
                        title="Permanently delete this account and its personal data."
                        aria-label={`Delete account ${account.email}`}
                      >
                        Delete account
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <form onSubmit={handleAdd} className="border-t border-line pt-3 space-y-2 max-w-md">
            <div className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Add account
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-xs text-ink-muted">Email</span>
                <input
                  type="email"
                  required
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-ink-muted">
                  Name <span className="text-ink-faint">(optional)</span>
                </span>
                <input
                  type="text"
                  value={addName}
                  onChange={(e) => setAddName(e.target.value)}
                  className={inputClass}
                />
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-ink-muted">Password</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={addPassword}
                onChange={(e) => setAddPassword(e.target.value)}
                className={inputClass}
              />
            </label>
            {addError && (
              <div className="text-xs text-red-600" role="alert">
                {addError}
              </div>
            )}
            <button
              type="submit"
              disabled={adding}
              className="rounded-md bg-accent text-white text-sm font-medium px-3 py-1.5 hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {adding ? 'Adding…' : 'Add account'}
            </button>
          </form>
        </div>
      </PageShell>

      <Dialog
        open={passwordTarget !== null}
        onClose={() => setPasswordTarget(null)}
        title={passwordDialog.label}
        size="sm"
        busy={savingPassword}
        footer={
          <>
            <button
              onClick={() => setPasswordTarget(null)}
              disabled={savingPassword}
              className="px-3 py-1.5 text-sm rounded-sm text-ink hover:bg-hover border border-line disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmPasswordChange}
              disabled={savingPassword || newPassword.length === 0}
              className="px-3 py-1.5 text-sm rounded-sm bg-accent hover:bg-accent-hover text-white disabled:opacity-50"
            >
              {savingPassword ? 'Saving…' : passwordDialog.label}
            </button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-xs text-ink leading-snug">
            New sign-in password for{' '}
            <span className="font-medium">
              {passwordTarget?.name} ({passwordTarget?.email})
            </span>
            . {passwordDialog.effect} Share it with them out-of-band; they can change it later on
            their Account page.
            {passwordDialog.confirm && ` ${passwordDialog.confirm}`}
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-ink-muted">New password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={inputClass}
            />
          </label>
          {passwordError && (
            <div className="text-xs text-red-600" role="alert">
              {passwordError}
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete user account"
        size="sm"
        busy={deleting}
        footer={
          <>
            <button
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded-sm text-ink hover:bg-hover border border-line disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded-sm bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:hover:bg-red-600"
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          </>
        }
      >
        <p className="text-xs text-ink leading-snug">
          Permanently delete{' '}
          <span className="font-medium">
            {pendingDelete?.name} ({pendingDelete?.email})
          </span>
          ? This removes their personal data for good and anonymizes their past review activity.
          Their saves in the knowledge base keep their history.{' '}
          {pendingDelete && signInAfterDelete(pendingDelete)}
        </p>
      </Dialog>
    </>
  );
}
