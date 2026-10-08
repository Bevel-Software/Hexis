import { useContext, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import { authFetch } from '../../../lib/api';
import { resetAgentConnectionForTests } from './agent-connection';

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
 * One client-side piece around the server truth: `doneLocally`, an
 * optimistic session override. The auth context's user object is a snapshot
 * from sign-in; after POSTing we don't refetch it, we just remember the
 * answer. A failed POST logs and DROPS the override at once, so the pill
 * comes back immediately rather than reappearing at the next sign-in with no
 * account of why it left.
 *
 * Nothing here sends anyone to the welcome page. `/` lands on Knowledge for
 * everyone (see `RootLanding`); the pill and the Get set up list are the
 * reminder, and the page is theirs to open.
 */

const doneLocally = new Set<string>();
/** Full storage keys set this session — see {@link setFlag}. */
const flagsLocally = new Set<string>();
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

/**
 * The "Get set up" column's per-account notes: the starter guide has been
 * opened, the command menu has been opened, the column was dismissed, and its
 * "You're set up" was seen and closed. All per-browser conveniences, not server truth, so they live beside
 * the session override and wake the same listeners, through one tiny flag
 * pair rather than a hand-written copy of the read/write/try-catch dance per
 * note.
 */
const READ_GUIDE_PREFIX = 'bevel.onboarding.readGuide.';
const COMMAND_MENU_PREFIX = 'bevel.onboarding.commandMenuOpened.';
const SETUP_DISMISSED_PREFIX = 'bevel.onboarding.setupDismissed.';
const SETUP_COMPLETE_PREFIX = 'bevel.onboarding.setupCompleteClosed.';

/** Storage is best-effort: private-mode Safari throws, and a lost flag costs
 *  one extra row on screen, not a failure. */
function hasFlag(key: string): boolean {
  if (flagsLocally.has(key)) return true;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * Raise a one-way flag. Remembered in memory as well as storage so a browser
 * that refuses the write still honours it for the rest of the session.
 * Idempotent: a raised flag returns without touching storage or waking
 * listeners.
 */
function setFlag(key: string): void {
  if (hasFlag(key)) return;
  flagsLocally.add(key);
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    /* held in memory for this session */
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
 * Test seam: forget the session overrides and the per-browser notes.
 *
 * Scans storage by PREFIX rather than walking `flagsLocally`, because that
 * set is not a record of what is in storage. `setFlag` returns early when the
 * key is already there, so a flag raised by an earlier test file — or by an
 * earlier run against the same jsdom `localStorage` — never enters the set,
 * and its key would survive a reset that only knew about the set.
 */
export function resetOnboardingForTests(): void {
  try {
    for (const key of Object.keys(window.localStorage)) {
      if (
        key.startsWith(READ_GUIDE_PREFIX) ||
        key.startsWith(COMMAND_MENU_PREFIX) ||
        key.startsWith(SETUP_DISMISSED_PREFIX) ||
        key.startsWith(SETUP_COMPLETE_PREFIX)
      ) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    /* ignore */
  }
  doneLocally.clear();
  flagsLocally.clear();
  // The remembered "your agent is connected" is session state of the same
  // kind; a test that connects must not leave the next one connected.
  resetAgentConnectionForTests();
  emit();
}

export interface OnboardingController {
  /** The reminder is alive: the server says onboarding is not done. */
  showPill: boolean;
  markDone(): void;
}

/** The subscription's version counter: every override and note changes it. */
const snapshot = () => `${doneLocally.size}:${flagsLocally.size}`;
const serverSnapshot = () => '0:0';

const SIGNED_OUT: OnboardingController = {
  showPill: false,
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
  // The subscription's version counter: overrides and notes change under it. The snapshot is a cheap string so identity comparison is exact.
  useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (!user) return SIGNED_OUT;
  const email = user.email;
  const done = user.onboardingDone !== false || doneLocally.has(email);
  return {
    showPill: !done,
    markDone: () => markOnboardingDone(user.id, email),
  };
}

export interface SetupChecklistState {
  /** The starter guide ("How to get started") has been opened on this browser. */
  readGuide: boolean;
  /** The command menu (Ctrl/⌘K) has been opened on this browser, by any route. */
  openedCommandMenu: boolean;
  /** The person closed the "Get set up" column; it stays closed. */
  dismissed: boolean;
  /**
   * The person closed the column's "You're set up" — the list was finished
   * and celebrated, and the column is gone for good.
   */
  completionClosed: boolean;
  markGuideRead(): void;
  markCommandMenuOpened(): void;
  dismiss(): void;
  closeCompletion(): void;
}

const NO_CHECKLIST: SetupChecklistState = {
  readGuide: false,
  openedCommandMenu: false,
  dismissed: false,
  completionClosed: false,
  markGuideRead: () => {},
  markCommandMenuOpened: () => {},
  dismiss: () => {},
  closeCompletion: () => {},
};

/**
 * The client-side half of the "Get set up" column: the tick the server has no
 * field for, and the column's two ways of going away. Keyed by lower-cased email, so `Juan@…` and `juan@…` are
 * one person, and tolerant of a missing auth provider for the same reason
 * {@link useOnboarding} is.
 */
export function useSetupChecklist(): SetupChecklistState {
  const auth = useContext(AuthContext);
  const user = auth?.user ?? null;
  useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (!user) return NO_CHECKLIST;
  const email = user.email.toLowerCase();
  const readKey = `${READ_GUIDE_PREFIX}${email}`;
  const commandMenuKey = `${COMMAND_MENU_PREFIX}${email}`;
  const dismissedKey = `${SETUP_DISMISSED_PREFIX}${email}`;
  const completeKey = `${SETUP_COMPLETE_PREFIX}${email}`;
  return {
    readGuide: hasFlag(readKey),
    openedCommandMenu: hasFlag(commandMenuKey),
    dismissed: hasFlag(dismissedKey),
    completionClosed: hasFlag(completeKey),
    markGuideRead: () => setFlag(readKey),
    markCommandMenuOpened: () => setFlag(commandMenuKey),
    dismiss: () => setFlag(dismissedKey),
    closeCompletion: () => setFlag(completeKey),
  };
}
