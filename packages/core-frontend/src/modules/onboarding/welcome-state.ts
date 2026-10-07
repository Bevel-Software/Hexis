import { useLocation } from 'react-router-dom';

/**
 * What an arrival at the welcome route carries — parsed in ONE place.
 *
 * Two components read this state: `WelcomeRoute`, which decides WHICH welcome
 * you get, and `WelcomePage`, which decides where its exits go. They have to
 * agree — a router that preserves a deep link in front of a page that
 * discards it (or the reverse) loses the destination silently, and neither
 * side's tests would notice. So the shape and the rules live here rather than
 * being re-derived from `location.state` at each call site.
 */
export interface WelcomeRouteState {
  /**
   * How you got here. Everything ceremonial on the welcome hangs off this
   * flag. No navigation sets it today: `/` used to redirect a brand-new
   * account here with it, and no longer redirects anyone (see `RootLanding`).
   * The sidebar pill, the Get set up list and a typed URL are visits.
   */
  greeting: boolean;
  /**
   * Where the person was actually GOING when the sign-in interrupted them — a
   * deep link that survived the SSO round-trip. `RootLanding` now sends that
   * link straight to itself, so this too is only ever set by a greeting.
   *
   * Null unless this is the greeting arrival, and that condition is the rule
   * worth centralising: a `returnTo` on a later, non-greeting visit is not a
   * carried intention, it is stale state on a page someone opened themselves.
   */
  returnTo: string | null;
}

/** Reads the welcome contract off the current location. */
export function useWelcomeRouteState(): WelcomeRouteState {
  const state = useLocation().state as { greeting?: boolean; returnTo?: string | null } | null;
  const greeting = state?.greeting === true;
  return { greeting, returnTo: greeting ? (state?.returnTo ?? null) : null };
}
