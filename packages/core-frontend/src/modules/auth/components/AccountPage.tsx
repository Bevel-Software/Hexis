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
 *
 * Every account gets the same form regardless of role. The one exception is
 * the deployment admin, whose password is set in the deployment environment
 * (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) rather than stored here: it gets an
 * explanation and no form, because that credential is the platform's rescue
 * path and must keep working. The backend refuses the change for that account
 * too — this branch is the explanation, not the enforcement.
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
          <div className="text-sm text-ink">
            Signed in as <span className="font-medium">{user.name}</span>{' '}
            <span className="text-ink-muted">({user.email})</span>
          </div>
        )}

        {user?.isEnvAdmin ? (
          <div className="space-y-2 max-w-sm">
            <h2 className="text-sm font-semibold text-ink">Change password</h2>
            <p className="text-sm text-ink-muted" role="note">
              This account&rsquo;s password is set in the deployment environment
              (<code className="text-ink">ADMIN_PASSWORD</code>) and cannot be changed here. It is
              the rescue credential for this platform, so it stays where a deployment can always
              reset it. Change it by updating that variable and restarting the deployment.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
            <h2 className="text-sm font-semibold text-ink">Change password</h2>
            <label className="block space-y-1">
              <span className="text-xs text-ink-muted">
                Current password <span className="text-ink-faint">(leave empty if you never set one)</span>
              </span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-ink-muted">New password</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-ink-muted">Confirm new password</span>
              <input
                type="password"
                required
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full rounded-md bg-sunken border border-line-strong px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent"
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
              className="rounded-md bg-accent text-white text-sm font-medium px-4 py-2 hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? 'Saving…' : 'Change password'}
            </button>
          </form>
        )}
      </div>
    </PageShell>
  );
}
