import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import {
  createAccount,
  listAccounts,
  type AccountSummary,
} from '../../auth/services/account.api';

/**
 * The Accounts block of the Roles & Members page (admins only — the page
 * itself gates): every known user, whether they can sign in with a password,
 * and a create form. "Create" is an upsert by email — entering an existing
 * account's email (re)sets that account's password, which doubles as the
 * admin reset flow for a locked-out user.
 */
export function AccountsSection() {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(() => {
    listAccounts()
      .then((rows) => {
        setAccounts(rows);
        setLoadError(null);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Could not load accounts'));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setCreated(null);
    setSubmitting(true);
    try {
      await createAccount(email.trim(), name.trim(), password);
      setCreated(email.trim());
      setEmail('');
      setName('');
      setPassword('');
      reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create account');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-6 border-t border-line pt-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-ink">Accounts</h2>
        <p className="text-xs text-ink-muted mt-0.5">
          Who can sign in with a password. Creating an account with an existing
          email resets that account's password.
        </p>
      </div>

      {loadError ? (
        <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded">
          {loadError}
        </div>
      ) : accounts === null ? (
        <div className="flex items-center gap-2 p-2 text-sm text-ink-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : accounts.length === 0 ? (
        <div className="p-2 text-sm text-ink-muted">No accounts yet.</div>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-md">
          {accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="font-medium text-ink">{account.name}</span>
              <span className="text-ink-muted truncate">{account.email}</span>
              <span className="ml-auto shrink-0 text-xs text-ink-muted">
                {account.hasPassword ? 'Password sign-in' : 'Single sign-on only'}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Create account
        </h3>
        <label className="block space-y-1">
          <span className="text-xs text-ink-muted">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-ink-muted">
            Name <span className="text-ink-faint">(optional)</span>
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-ink-muted">Password</span>
          <input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
          />
        </label>

        {formError && (
          <div className="text-sm text-red-600" role="alert">
            {formError}
          </div>
        )}
        {created && (
          <div className="text-sm text-emerald-700" role="status">
            Account for {created} saved.
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-bevel text-white text-sm font-medium px-4 py-2 hover:bg-bevel-deep disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {submitting ? 'Saving…' : 'Create account'}
        </button>
      </form>
    </div>
  );
}
