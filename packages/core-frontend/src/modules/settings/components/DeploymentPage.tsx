import { useCallback, useEffect, useState } from 'react';
import { PageShell } from '../../../shared/components/PageShell';
import { Banner, Button } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { fetchSetupStatus, type SetupStatus } from '../../setup/services/setup.api';
import { SetupScreen } from '../../setup/components/SetupScreen';

/**
 * Deployment settings, routed at `/deployment` — the first-run setup screen
 * given a permanent address.
 *
 * Setup used to be reachable exactly once: the gate showed it while the
 * deployment was unconfigured and never again, so adding single sign-on (or
 * rotating its client secret, or renaming a branch) later meant knowing which
 * environment variable to set and restarting — the very thing the setup
 * screen exists to spare people. The FORM was never the limitation — the
 * backend accepts these writes from any admin at any time — only the door
 * was. This page is that door.
 *
 * It reuses `SetupScreen` whole rather than extracting the SSO half: the
 * knowledge-base connection and branch model are exactly as legitimate to
 * revisit, and one form means the env-lock rule, the connection test and the
 * restart notices cannot drift between first run and later.
 *
 * Admin-gated as presentation only — the backend enforces the same gate on
 * every settings endpoint, and non-admin status responses carry no settings
 * at all.
 */
export function DeploymentPage() {
  const { isAdmin } = useAdmin();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    // Non-admins never fetch: the endpoint would answer them safely (status
    // without settings), but this page has already told them it is not
    // theirs — a request whose answer nothing renders is noise.
    if (!isAdmin) return;
    fetchSetupStatus()
      .then((s) => {
        setStatus(s);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoaded(true));
  }, [isAdmin]);

  useEffect(refresh, [refresh]);

  if (!isAdmin) {
    return (
      <PageShell title="Deployment" width="4xl">
        <div className="text-sm text-ink-muted">
          Admins only. Ask an admin if the sign-in method or the repository connection needs
          changing.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Deployment" width="4xl">
      {!loaded && <div className="mt-6 text-sm text-ink-muted">Loading…</div>}

      {/* A failed fetch never clears `status`, so a refresh that breaks
          AFTER a save leaves the form (and any restart notice inside it)
          mounted below this banner — the failure costs a retry button, never
          the confirmation of what was just saved. The copy tells the two
          apart: nothing on screen yet is a load problem, a form still on
          screen is a refresh problem. */}
      {loaded && (failed || !status?.settings) && (
        <Banner tone="danger" role="alert" className="mt-6">
          {status?.settings
            ? "Couldn't refresh the deployment settings."
            : "Couldn't load the deployment settings."}
          <Button variant="outline" size="sm" className="ml-3" onClick={refresh}>
            Try again
          </Button>
        </Banner>
      )}

      {loaded && status?.settings && (
        <div className="mt-6">
          <SetupScreen
            settings={status.settings}
            sync={status.sync}
            onSaved={refresh}
            variant="settings"
          />
        </div>
      )}
    </PageShell>
  );
}
