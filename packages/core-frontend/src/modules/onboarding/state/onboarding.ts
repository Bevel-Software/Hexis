import { useContext, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import { authFetch } from '../../../lib/api';

/**
 * The connect-your-agent onboarding, backed by ONE server-side field:
 * `users.onboarding_done`.
 *
 * The pill shows exactly while that field is `false` — across sign-ins,
 * across browsers — and two things end it: the welcome page's Done and the
 * pill's ×. Both call {@link markOnboardingDone}; the write is one-way and
 * idempotent, so neither caller has to know about the other.
 *
 * Only an EXPLICIT `false` counts as "still onboarding". The field is
 * optional on {@link AuthUser} for old fixtures and cached sessions, and an
 * absent field must never resurrect the welcome flow for an account that
 * finished it.
 *
 * Two small client-side pieces around the server truth:
 *
 *  - `doneLocally` — an optimistic session override. The auth context's user
 *    object is a snapshot from sign-in; after POSTing we don't refetch it,
 *    we just remember the answer. A failed POST logs and keeps the override
 *    for the session — the pill returning on next sign-in is the correct
 *    outcome of a write that never landed.
 *  - `welcomed` (localStorage, per account) — "the welcome page was shown
 *    once". The auto-redirect there happens on the FIRST sign-in only;
 *    the pill, not the router, is the standing reminder. Per-browser by
 *    nature, which is fine: being greeted once per new machine is a welcome,
 *    not a bug.
 */

const welcomedKey = (email: string) => `bevel.onboarding.welcomed.${email.toLowerCase()}`;

const doneLocally = new Set<string>();
const welcomedLocally = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Storage is best-effort: private-mode Safari throws, and a forgotten
 *  "welcomed" costs one extra greeting, not a failure. */
function hasBeenWelcomed(email: string): boolean {
  if (welcomedLocally.has(email)) return true;
  try {
    return window.localStorage.getItem(welcomedKey(email)) === '1';
  } catch {
    return false;
  }
}

export function markWelcomed(email: string): void {
  if (hasBeenWelcomed(email)) return;
  welcomedLocally.add(email);
  try {
    window.localStorage.setItem(welcomedKey(email), '1');
  } catch {
    /* one extra greeting next boot */
  }
  emit();
}

export function markOnboardingDone(email: string): void {
  if (doneLocally.has(email)) return;
  doneLocally.add(email);
  emit();
  // Fire-and-record: the UI has already concluded, and the server write is
  // idempotent. On failure the pill simply returns next sign-in — the honest
  // outcome of a write that never landed.
  void authFetch('/api/auth/onboarding-done', { method: 'POST' })
    .then((res) => {
      if (!res.ok) console.error('onboarding-done failed:', res.status);
    })
    .catch((err) => console.error('onboarding-done failed:', err));
}

/** Test seam: forget the session overrides and the welcomed notes. */
export function resetOnboardingForTests(): void {
  for (const email of welcomedLocally) {
    try {
      window.localStorage.removeItem(welcomedKey(email));
    } catch {
      /* ignore */
    }
  }
  doneLocally.clear();
  welcomedLocally.clear();
  emit();
}

export interface OnboardingController {
  /** The reminder is alive: the server says onboarding is not done. */
  showPill: boolean;
  /** First sign-in, still unanswered: drives the ONE-TIME redirect to the welcome page. */
  shouldWelcome: boolean;
  markWelcomed(): void;
  markDone(): void;
}

const SIGNED_OUT: OnboardingController = {
  showPill: false,
  shouldWelcome: false,
  markWelcomed: () => {},
  markDone: () => {},
};

/**
 * Reads `AuthContext` directly (tolerantly) rather than through `useAuth`,
 * which throws outside a provider: this hook is consumed at the shell's root
 * route, and `ShellRoutes` is deliberately testable without the full provider
 * stack. Signed out — or providerless — there is nobody to onboard, and the
 * answer is simply "nothing pending".
 */
export function useOnboarding(): OnboardingController {
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;
  // The subscription's version counter: overrides and welcomed notes change
  // under it. The snapshot is a cheap string so identity comparison is exact.
  useSyncExternalStore(
    subscribe,
    () => `${doneLocally.size}:${welcomedLocally.size}`,
    () => '0:0',
  );
  if (!user) return SIGNED_OUT;
  const email = user.email;
  const done = user.onboardingDone !== false || doneLocally.has(email);
  return {
    showPill: !done,
    shouldWelcome: !done && !hasBeenWelcomed(email),
    markWelcomed: () => markWelcomed(email),
    markDone: () => markOnboardingDone(email),
  };
}
