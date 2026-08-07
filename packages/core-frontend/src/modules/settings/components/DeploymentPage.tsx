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
    fetchSetupStatus()
      .then((s) => {
        setStatus(s);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(refresh, [refresh]);

  if (!isAdmin) {
    return (
      <PageShell title="Deployment" width="4xl">
        <div className="text-sm text-ink-muted">
          Admins only. Ask an admin if the sign-in method or the knowledge-base connection needs
          changing.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="Deployment" width="4xl">
      <p className="max-w-[62ch] text-detail text-ink-muted">
        The knowledge-base connection, the branch model, and single sign-on — the same form as
        first-run setup, editable whenever something changes. Values set in the environment stay
        locked here; change them where they are set.
      </p>

      {!loaded && <div className="mt-6 text-sm text-ink-muted">Loading…</div>}

      {loaded && (failed || !status?.settings) && (
        <Banner tone="danger" role="alert" className="mt-6">
          Couldn&apos;t load the deployment settings.
          <Button variant="outline" size="sm" className="ml-3" onClick={refresh}>
            Try again
          </Button>
        </Banner>
      )}

      {loaded && status?.settings && (
        <div className="mt-6">
          <SetupScreen settings={status.settings} onSaved={refresh} variant="settings" />
        </div>
      )}
    </PageShell>
  );
}
