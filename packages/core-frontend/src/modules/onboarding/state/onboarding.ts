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
 *    we just remember the answer. A failed POST logs and DROPS the override
 *    at once, so the pill comes back immediately rather than reappearing at
 *    the next sign-in with no account of why it left.
 *  - `welcomed` (localStorage, per account) — "the welcome page was shown
 *    once". The auto-redirect there happens on the FIRST sign-in only;
 *    the pill, not the router, is the standing reminder. Per-browser by
 *    nature, which is fine: being greeted once per new machine is a welcome,
 *    not a bug.
 */

const WELCOMED_PREFIX = 'bevel.onboarding.welcomed.';

/**
 * The storage key holding "this account has seen the welcome page", keyed by
 * lower-cased email so `Juan@…` and `juan@…` are one person rather than two
 * greetings.
 */
const welcomedKey = (email: string) => `${WELCOMED_PREFIX}${email.toLowerCase()}`;

const doneLocally = new Set<string>();
const welcomedLocally = new Set<string>();
const listeners = new Set<() => void>();

/** Tell every mounted `useOnboarding` that the overrides above moved. */
function emit(): void {
  listeners.forEach((l) => l());
}

/**
 * The `useSyncExternalStore` half of the subscription: register a listener and
 * hand back its unsubscribe, so a hook that unmounts stops being notified.
 */
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

/**
 * Note that this account has now been greeted, which is what makes the
 * welcome redirect one-time. Idempotent: already-welcomed returns without
 * touching storage or waking listeners.
 */
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

/**
 * Conclude the connect-your-agent onboarding — the shared act behind the
 * welcome page's Done and the pill's ×.
 *
 * Optimistic: the pill disappears on the click, before the server answers,
 * because a reminder that lingers while a request flies reads as a control
 * that did not work. The override is dropped again if the write fails, so the
 * UI never keeps claiming something the server refused.
 */
export function markOnboardingDone(userId: string, email: string): void {
  if (doneLocally.has(email)) return;
  doneLocally.add(email);
  emit();
  // `userId` states WHICH account this click meant. The bearer token is one
  // shared localStorage key, so a tab still rendering account A after account
  // B signed in elsewhere would otherwise conclude B's onboarding with A's
  // intent. The server refuses the mismatch (409) rather than applying it.
  void authFetch('/api/auth/onboarding-done', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId }),
  })
    .then((res) => {
      if (res.ok) return;
      console.error('onboarding-done failed:', res.status);
      // The write did not land, so the UI must stop claiming it did — the
      // pill comes back now rather than mysteriously reappearing on the next
      // sign-in. A 409 in particular means this tab is stale.
      doneLocally.delete(email);
      emit();
    })
    .catch((err) => {
      console.error('onboarding-done failed:', err);
      doneLocally.delete(email);
      emit();
    });
}

/**
 * Test seam: forget the session overrides and the welcomed notes.
 *
 * Scans storage by PREFIX rather than walking `welcomedLocally`, because that
 * set is not a record of what is in storage. `markWelcomed` returns early when
 * the key is already there, so an email welcomed by an earlier test file — or
 * by an earlier run against the same jsdom `localStorage` — never enters the
 * set, and its key would survive a reset that only knew about the set. The
 * next "greets ONCE" assertion would then read "already welcomed" and fail on
 * a state no test put there.
 */
export function resetOnboardingForTests(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(WELCOMED_PREFIX)) window.localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
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
    markDone: () => markOnboardingDone(user.id, email),
  };
}
