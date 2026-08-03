import { Navigate } from 'react-router-dom';
import { KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
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
  if (!shouldWelcome) return <Navigate to={KB_ROUTE_PREFIX} replace />;
  return <Navigate to={WELCOME_PATH} state={{ greeting: true }} replace />;
}
