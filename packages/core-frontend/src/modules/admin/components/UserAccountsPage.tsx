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
 * The User Accounts page (`/user-accounts`, admins only) — the ONE
 * account-management surface: every account on the deployment, whether it can
 * sign in with a password, set a user's password (accounts that predate
 * per-user passwords can't sign in until an admin sets one), permanently
 * delete an account (the GDPR erasure path — overlays contribute their data
 * slices via erasure participants), and add a new account. Password
 * set/create both go through `POST /api/admin/accounts`, an upsert-by-email
 * that preserves an existing display name when none is supplied. The
 * signed-in admin's own row offers neither action — the backend refuses
 * self-erasure, and their own password lives on the Account page.
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
  const [passwordSetFor, setPasswordSetFor] = useState<string | null>(null);
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
        // Leave no eternal "Loading…" next to the error banner.
        setAccounts((prev) => prev ?? []);
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
    setPasswordSetFor(null);
  }

  async function confirmSetPassword() {
    if (!passwordTarget || savingPassword || newPassword.length === 0) return;
    setSavingPassword(true);
    setPasswordError(null);
    try {
      // No name → the upsert keeps the account's existing display name.
      await createAccount(passwordTarget.email, '', newPassword);
      setPasswordSetFor(passwordTarget.email);
      setPasswordTarget(null);
      refresh();
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : "Couldn't set the password.");
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
        <div className="text-sm text-slate-600">
          Admins only. Ask an admin if you need an account created or changed.
        </div>
      </PageShell>
    );
  }

  const inputClass =
    'w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-slate-400';

  return (
    <>
      <PageShell title="User accounts">
        <div className="space-y-4">
          <p className="text-xs text-slate-600 leading-snug">
            Everyone with an account on this deployment. Deleting an account permanently removes
            the person&apos;s data and anonymizes their past review activity; their saves in the
            knowledge base keep their history. Setting a password lets someone sign in with
            email + password (existing accounts keep everything else).
          </p>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {error}
            </div>
          )}
          {passwordSetFor && (
            <div
              className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5"
              role="status"
            >
              Password set for {passwordSetFor}.
            </div>
          )}

          {accounts === null ? (
            <div className="text-xs text-slate-600">Loading…</div>
          ) : accounts.length === 0 ? (
            <div className="text-xs text-slate-600">No user accounts.</div>
          ) : (
            <ul className="divide-y divide-slate-200 border border-slate-200 rounded">
              {accounts.map((account) => {
                const isSelf = account.id === me?.id;
                return (
                  <li key={account.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {account.name}
                        {isSelf && (
                          <span className="ml-1.5 text-[11px] font-normal text-slate-500">(you)</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-600 truncate">
                        {account.email} · Joined {new Date(account.createdAt).toLocaleDateString()} ·{' '}
                        {account.hasPassword ? 'Password sign-in' : 'Single sign-on only'}
                      </div>
                    </div>
                    {!isSelf && (
                      <button
                        onClick={() => openPasswordDialog(account)}
                        className="text-xs px-2 py-1 rounded text-slate-700 hover:bg-slate-100 border border-slate-200"
                        title="Set a new sign-in password for this account."
                        aria-label={`Set password for ${account.email}`}
                      >
                        Set password
                      </button>
                    )}
                    {!isSelf && (
                      <button
                        onClick={() => setPendingDelete(account)}
                        className="text-xs px-2 py-1 rounded text-red-700 hover:bg-red-50 border border-red-200"
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

          <form onSubmit={handleAdd} className="border-t border-slate-200 pt-3 space-y-2 max-w-md">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Add account
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">Email</span>
                <input
                  type="email"
                  required
                  value={addEmail}
                  onChange={(e) => setAddEmail(e.target.value)}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-slate-600">
                  Name <span className="text-slate-400">(optional)</span>
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
              <span className="text-xs text-slate-600">Password</span>
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
              className="rounded-md bg-bevel text-white text-sm font-medium px-3 py-1.5 hover:bg-bevel-deep disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {adding ? 'Adding…' : 'Add account'}
            </button>
          </form>
        </div>
      </PageShell>

      <Dialog
        open={passwordTarget !== null}
        onClose={() => setPasswordTarget(null)}
        title="Set password"
        size="sm"
        busy={savingPassword}
        footer={
          <>
            <button
              onClick={() => setPasswordTarget(null)}
              disabled={savingPassword}
              className="px-3 py-1.5 text-sm rounded text-slate-700 hover:bg-slate-100 border border-slate-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmSetPassword}
              disabled={savingPassword || newPassword.length === 0}
              className="px-3 py-1.5 text-sm rounded bg-bevel hover:bg-bevel-deep text-white disabled:opacity-50"
            >
              {savingPassword ? 'Saving…' : 'Set password'}
            </button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-xs text-slate-700 leading-snug">
            New sign-in password for{' '}
            <span className="font-medium">
              {passwordTarget?.name} ({passwordTarget?.email})
            </span>
            . Share it with them out-of-band; they can change it later on their Account page.
          </p>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600">New password</span>
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
              className="px-3 py-1.5 text-sm rounded text-slate-700 hover:bg-slate-100 border border-slate-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:hover:bg-red-600"
            >
              {deleting ? 'Deleting…' : 'Delete account'}
            </button>
          </>
        }
      >
        <p className="text-xs text-slate-700 leading-snug">
          Permanently delete{' '}
          <span className="font-medium">
            {pendingDelete?.name} ({pendingDelete?.email})
          </span>
          ? This removes their personal data for good and anonymizes their past review activity.
          Their saves in the knowledge base keep their history.{' '}
          {pendingDelete?.hasPassword
            ? 'To sign in again they will need an admin to create a new account for them.'
            : 'They can sign in again later with single sign-on, but will start fresh.'}
        </p>
      </Dialog>
    </>
  );
}
