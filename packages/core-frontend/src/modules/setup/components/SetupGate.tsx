import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchSetupStatus, type SetupStatus } from '../services/setup.api';
import { SetupScreen } from './SetupScreen';

/**
 * Stands between a signed-in session and the application, and only lets it
 * through once the deployment can reach its knowledge base.
 *
 * WHY IT SITS INSIDE THE AUTH GATE. Setup is not public — it is where a
 * repository URL and an access token are entered. It works on an unconfigured
 * deployment because the bootstrap admin (`ADMIN_EMAIL`) is recognised without
 * consulting `roles.yaml`, so the one person who can finish setup can always
 * sign in even though nothing has been cloned yet.
 *
 * WHY NON-ADMINS GET A DIFFERENT SCREEN RATHER THAN THE APP. Every surface
 * behind here reads from a workspace that cannot exist yet; letting someone in
 * would show them a broken file tree and a stream of failed requests. "Still
 * being set up" is both true and useful, and it does not tell them what is
 * missing — that is the admin's business.
 *
 * A FAILED STATUS CHECK OPENS THE GATE. The check is a guard against an
 * unconfigured deployment, not an authorisation boundary: if it cannot be
 * reached, the app behind it is no less usable than it was, and blocking on a
 * transient network failure would lock everyone out of a working deployment.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checked, setChecked] = useState(false);

  const refresh = useCallback(() => {
    fetchSetupStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setChecked(true));
  }, []);

  useEffect(refresh, [refresh]);

  // Nothing is claimed until the answer is in. Rendering the app here and
  // replacing it a moment later would flash a broken workspace at exactly the
  // people this gate exists to protect from one.
  if (!checked) {
    return (
      <div className="flex h-full items-center justify-center bg-surface text-ui text-ink-muted">
        Loading…
      </div>
    );
  }

  if (!status || status.complete) return <>{children}</>;

  if (!status.isAdmin || !status.settings) {
    return (
      <div className="flex h-full items-center justify-center bg-sunken px-6">
        <div className="max-w-[46ch] text-center">
          <h1 className="text-title font-semibold text-ink">Still being set up</h1>
          <p className="mt-2 text-body text-ink-muted">
            An admin is connecting this deployment to its knowledge base. It will be ready shortly —
            try again in a few minutes.
          </p>
        </div>
      </div>
    );
  }

  return <SetupScreen settings={status.settings} onSaved={refresh} />;
}
