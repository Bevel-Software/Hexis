import { useState, type FormEvent } from 'react';
import { PageShell } from '../../../shared/components/PageShell';
import { useAuth } from '../state/auth.context';
import { changePassword } from '../services/account.api';

/**
 * The standalone Account page (`/account`): who you're signed in as, and
 * self-service password change. The current password is required once one is
 * set; an account that only ever signed in via SSO sets its first password
 * without one (the backend enforces both rules — the form always offers the
 * field and simply sends it when filled).
 */
export function AccountPage() {
  const { user } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword(currentPassword || undefined, newPassword);
      setSaved(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change password');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageShell title="Account">
      <div className="space-y-6">
        {user && (
          <div className="text-sm text-slate-700">
            Signed in as <span className="font-medium">{user.name}</span>{' '}
            <span className="text-slate-500">({user.email})</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
          <h2 className="text-sm font-semibold text-slate-800">Change password</h2>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600">
              Current password <span className="text-slate-400">(leave empty if you never set one)</span>
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-slate-400"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600">New password</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-slate-400"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-slate-600">Confirm new password</span>
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full rounded-md bg-slate-100 border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:outline-none focus:border-slate-400"
            />
          </label>

          {error && (
            <div className="text-sm text-red-600" role="alert">
              {error}
            </div>
          )}
          {saved && (
            <div className="text-sm text-emerald-700" role="status">
              Password changed.
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-bevel text-white text-sm font-medium px-4 py-2 hover:bg-bevel-deep disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </div>
    </PageShell>
  );
}
