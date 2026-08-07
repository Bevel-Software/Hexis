import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
import { takePostLoginRedirect } from '../../auth/services/sso';
import { useOnboarding } from '../state/onboarding';
import { WELCOME_PATH } from '../paths';

/**
 * Where `/` lands. For everyone, forever: Knowledge — except the ONE visit
 * where an account is brand new (`users.onboarding_done` false, and never
 * greeted in this browser), which lands on the welcome page instead.
 *
 * Deliberately only the root route: a deep link is an intention, and
 * onboarding must never hijack one. Whoever skips the welcome is reminded by
 * the sidebar pill, not by the router.
 *
 * A deep link that came through SSO arrives HERE rather than at itself — the
 * OAuth round-trip returns to a fixed callback URL, which scrubs to `/`
 * (see `consumeSsoCallback`) — so the link's intention survives as the stash
 * `startSsoLogin` left behind. An existing account goes straight to it; a
 * brand-new one is still greeted first, and the welcome page's Done returns
 * to the link instead of the usual shelf (the `returnTo` state below).
 *
 * `useOnboarding` is provider-tolerant, so `ShellRoutes` stays renderable
 * without the full stack (its own documented property); providerless or
 * signed out this is exactly the old `<Navigate to={KB_ROUTE_PREFIX}>`.
 *
 * The redirect carries `greeting`, and it is the ONLY navigation that does:
 * arriving here because you just signed in is a different event from opening
 * the same page from the sidebar, and the page needs to tell them apart to
 * know whether it is a ceremony or a page. See `WelcomePage`.
 */
export function RootLanding() {
  const { shouldWelcome } = useOnboarding();
  const [stash, setStash] = useState<{ returnTo: string | null } | null>(null);

  // Taken in an effect, not a state initializer: the take CLEARS the stash,
  // and StrictMode double-invokes initializers — the second invocation would
  // read the empty slot and win. The effect's second run reads null too, but
  // only the run that found something writes.
  useEffect(() => {
    const returnTo = takePostLoginRedirect();
    setStash((s) => s ?? { returnTo });
  }, []);

  // One settle-frame while the stash is read — navigating first and correcting
  // after would put the wrong page in the history.
  if (stash === null) return null;

  if (shouldWelcome) {
    return <Navigate to={WELCOME_PATH} state={{ greeting: true, returnTo: stash.returnTo }} replace />;
  }
  return <Navigate to={stash.returnTo ?? KB_ROUTE_PREFIX} replace />;
}
