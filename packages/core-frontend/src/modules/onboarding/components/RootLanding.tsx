import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
import { takePostLoginRedirect } from '../../auth/services/sso';

/**
 * Where `/` lands: Knowledge, for everyone, brand-new accounts included.
 *
 * There is no automatic welcome page. Choosing where the knowledge lives is
 * the one step that has to come before the app (the setup gate asks it);
 * connecting an agent can wait, and it waits in plain sight — the sidebar's
 * Connect your agent pill and the Get set up list both lead to the welcome
 * page, and neither takes over the screen on the way in.
 *
 * A deep link that came through SSO arrives HERE rather than at itself — the
 * OAuth round-trip returns to a fixed callback URL, which scrubs to `/`
 * (see `consumeSsoCallback`) — so the link's intention survives as the stash
 * `startSsoLogin` left behind, and it outranks Knowledge.
 */
export function RootLanding() {
  const [stash, setStash] = useState<{ returnTo: string | null } | null>(null);

  // Taken in an effect, not a state initializer: the take CLEARS the stash,
  // and StrictMode double-invokes initializers — the second invocation would
  // read the empty slot and win. The effect's second run reads null too, but
  // only the run that found something writes.
  useEffect(() => {
    const returnTo = takePostLoginRedirect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the one-shot take described above; it settles in one extra render
    setStash((s) => s ?? { returnTo });
  }, []);

  // One settle-frame while the stash is read — navigating first and correcting
  // after would put the wrong page in the history.
  if (stash === null) return null;

  return <Navigate to={stash.returnTo ?? KB_ROUTE_PREFIX} replace />;
}
