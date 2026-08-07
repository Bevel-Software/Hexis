import { useContext, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { isPublicDemo } from '../../../core/bootstrap';
import { KB_ROUTE_PREFIX, kbFileUrl } from '../../workspace/routing/kb-routes';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { takePostLoginRedirect } from '../../auth/services/sso';
import { useOnboarding } from '../state/onboarding';
import { WELCOME_PATH } from '../paths';

/**
 * The public demo's front door is its guided tour, not an empty file tree:
 * a first-time visitor landing on the bare domain has no idea what they are
 * looking at, and this page exists to tell them. Demo-branch content
 * knowledge, deliberately — the file is seeded on the demo workspace, and
 * this constant lives only on the public-demo branch.
 */
const DEMO_HOME_FILE = 'KnowledgeBase/Start here.md';

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
  // Read tolerantly, not via useWorkspace(): this component's documented
  // property is that it renders providerless (tests, bare ShellRoutes), and
  // only the demo-home redirect needs the workspace at all.
  const kbDirName = useContext(WorkspaceContext)?.kbDirName ?? null;
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
  if (stash.returnTo) return <Navigate to={stash.returnTo} replace />;
  if (isPublicDemo()) {
    // Hold for the workspace context rather than landing somewhere else and
    // correcting — kbDirName resolves within the first round-trip.
    if (kbDirName === null) return null;
    return <Navigate to={kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${DEMO_HOME_FILE}`)} replace />;
  }
  return <Navigate to={KB_ROUTE_PREFIX} replace />;
}
