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
 */
export function RootLanding() {
  const { shouldWelcome } = useOnboarding();
  return <Navigate to={shouldWelcome ? WELCOME_PATH : KB_ROUTE_PREFIX} replace />;
}
