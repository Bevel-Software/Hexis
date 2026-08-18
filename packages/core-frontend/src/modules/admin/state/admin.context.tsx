import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from '../../auth/state/auth.context';
import { fetchAdminAccess } from '../services/admin.api';
import { useAppRegistry } from '../../../core/registry';
import { getRolesHealth, recoverRoles } from '../services/roles.api';

// Exported because it is already the return type of `useAdmin()`, so it was
// public in everything but name — and a consumer providing this context (a
// test, or a host app supplying its own admin state) has to be able to say so.
export interface AdminContextValue {
  isAdmin: boolean;
  /**
   * True until the signed-in person's admin verdict has settled.
   *
   * Optional so host applications and older test harnesses that provide this
   * public context directly remain source-compatible. The built-in provider
   * always supplies it.
   */
  isAdminLoading?: boolean;
  /** Number of feedback rows submitted after `lastSeen` (or total if null). */
  unreadCount: number;
  /** ISO timestamp; null means the admin has never opened the inbox. */
  lastSeen: string | null;
  /** Marks "now" as the new lastSeen, clears the badge, persists to storage. */
  markSeen(): void;
  /** Force a fresh count fetch — used after opening the inbox. */
  refresh(): void;
  /**
   * True when the default-branch roles.yaml fails to parse — an app-wide admin
   * lockout. Tracked independently of `isAdmin` (a corrupted file resolves
   * nobody as admin, so this must surface even to non-admins) to drive the
   * recovery banner.
   */
  rolesConfigCorrupted: boolean;
  /** Parser errors backing `rolesConfigCorrupted`, for display. */
  rolesConfigErrors: string[];
  /** Run the Bevel Recovery: restore roles.yaml from the known-good default. */
  runRolesRecovery(): Promise<void>;
}

export const AdminContext = createContext<AdminContextValue | null>(null);

// Per-admin so two accounts on the same machine don't share a baseline. The
// email is stable for the lifetime of an account.
function lastSeenKey(email: string): string {
  return `bevel.adminFeedback.lastSeen.${email.toLowerCase()}`;
}

// 30s while the tab is visible. Hidden tabs skip the interval entirely so we
// don't burn battery / API quota for a backgrounded inbox.
const POLL_INTERVAL_MS = 30_000;

export function AdminProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const email = user?.email ?? null;
  // Undefined on a core deployment, which is what keeps the badge — and its
  // poll — from existing at all.
  const countUnread = useAppRegistry().adminUnreadCount;

  const [isAdmin, setIsAdmin] = useState(false);
  const [isAdminLoading, setIsAdminLoading] = useState(true);
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [rolesConfigCorrupted, setRolesConfigCorrupted] = useState(false);
  const [rolesConfigErrors, setRolesConfigErrors] = useState<string[]>([]);

  // Latest lastSeen for the poller without re-creating the interval on every
  // markSeen. Mirrors the pattern used in FeedbackDialog for submitting state.
  const lastSeenRef = useRef<string | null>(null);
  useEffect(() => {
    lastSeenRef.current = lastSeen;
  }, [lastSeen]);

  // Resolve admin status + restore lastSeen whenever the signed-in email
  // changes. Reset everything up front so a previous (possibly admin) user's
  // state never lingers while the access check is in flight, and so a fetch
  // failure falls back to "no admin" rather than stale access.
  useEffect(() => {
    setIsAdmin(false);
    setIsAdminLoading(Boolean(email));
    setLastSeen(null);
    setUnreadCount(0);
    if (!email) return;
    let cancelled = false;
    fetchAdminAccess()
      .then((res) => {
        if (cancelled) return;
        setIsAdmin(res.isAdmin);
        if (res.isAdmin) {
          setLastSeen(localStorage.getItem(lastSeenKey(email)));
        }
      })
      .catch(() => {
        if (cancelled) return;
        setIsAdmin(false);
        setLastSeen(null);
        setUnreadCount(0);
      })
      .finally(() => {
        if (!cancelled) setIsAdminLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  // roles.yaml health — polled INDEPENDENTLY of admin status. A corrupted file
  // locks everyone out (nobody resolves as admin), so the recovery banner must
  // reach non-admins too. On mount per signed-in user, then every 60s while the
  // tab is visible so a mid-session corruption surfaces without a reload.
  useEffect(() => {
    // No synchronous reset here: the immediate check() below sets the correct
    // value, and on logout the whole AdminProvider unmounts (state goes with
    // it). Health is deployment-wide, so it never differs between users anyway.
    if (!email) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = () => {
      getRolesHealth().then((h) => {
        if (cancelled) return;
        setRolesConfigCorrupted(!h.ok);
        setRolesConfigErrors(h.errors);
      });
    };
    const start = () => {
      check();
      if (timer === null) timer = setInterval(check, 60_000);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [email]);

  const runRolesRecovery = useCallback(async () => {
    await recoverRoles();
    // The known-good default is now on disk; clear the banner. A full reload
    // lets every view re-fetch with working access (the lockout poisoned them).
    setRolesConfigCorrupted(false);
    setRolesConfigErrors([]);
  }, []);

  const refresh = useCallback(() => {
    if (!isAdmin || !countUnread) return;
    countUnread(lastSeenRef.current).then(setUnreadCount).catch(() => {
      // Swallow — a transient failure shouldn't blank the badge. Next poll
      // will resync.
    });
  }, [isAdmin, countUnread]);

  // Poll while admin + tab is visible. Re-run on visibility change so a tab
  // returning to the foreground gets a fresh count immediately instead of
  // waiting up to 30s.
  useEffect(() => {
    // Nothing to count on a core deployment — see `adminUnreadCount`. Bailing
    // here is what stops the thirty-second 404.
    if (!isAdmin || !countUnread) return;
    let timer: ReturnType<typeof setInterval> | null = null;

    function start() {
      refresh();
      timer = setInterval(refresh, POLL_INTERVAL_MS);
    }
    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    function onVisibility() {
      if (document.visibilityState === 'visible') start();
      else stop();
    }

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [isAdmin, refresh]);

  const markSeen = useCallback(() => {
    if (!email) return;
    const now = new Date().toISOString();
    localStorage.setItem(lastSeenKey(email), now);
    setLastSeen(now);
    setUnreadCount(0);
  }, [email]);

  const value = useMemo<AdminContextValue>(
    () => ({
      isAdmin,
      isAdminLoading,
      unreadCount,
      lastSeen,
      markSeen,
      refresh,
      rolesConfigCorrupted,
      rolesConfigErrors,
      runRolesRecovery,
    }),
    [
      isAdmin,
      isAdminLoading,
      unreadCount,
      lastSeen,
      markSeen,
      refresh,
      rolesConfigCorrupted,
      rolesConfigErrors,
      runRolesRecovery,
    ],
  );

  return <AdminContext.Provider value={value}>{children}</AdminContext.Provider>;
}

export function useAdmin(): AdminContextValue {
  const ctx = useContext(AdminContext);
  if (!ctx) throw new Error('useAdmin must be used within AdminProvider');
  return ctx;
}
