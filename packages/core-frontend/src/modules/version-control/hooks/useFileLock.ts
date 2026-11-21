import { useCallback, useEffect, useRef, useState } from 'react';
import type { Change, FileLock } from '@bevel-software/platform-shared';
import {
  acquireLock as acquireLockApi,
  EDITING_ENDED_MESSAGE,
  checkpointLockedFile,
  getLock as getLockApi,
  heartbeatLock,
  LockApiError,
  releaseLock as releaseLockApi,
  SELF_HOLD_MESSAGE,
} from '../services/lock.api';
import { useEventBus, canonicalizeWorkspaceId } from '../state/event-bus.context';

const HEARTBEAT_INTERVAL_MS = 30_000;
const AUTOSAVE_INTERVAL_MS = 60_000;
/**
 * Idle threshold (no typing, no scrolling) after which the held lock is
 * auto-released. Other users can then enter Edit mode on the file without
 * waiting for the current editor to explicitly leave. The heartbeat keeps
 * the backend TTL refreshed for as long as we hold the lock, so this can
 * exceed the server-side TTL; it is the *frontend's* policy for "user
 * wandered off, give the file back to the team". Long enough that pausing
 * to think doesn't kick the user out of Edit mode mid-work.
 */
const IDLE_RELEASE_MS = 120_000;
/**
 * When a held notice is on screen, the hook asks again just after the hold
 * would expire, so the notice clears by itself (and Edit comes back) when
 * the holder's tab died without giving the page back. The margin covers
 * the server answering a moment late; the bounds keep a skewed client
 * clock from polling in a tight loop or waiting far past the server's
 * 60-second hold. A hold with no known expiry (one learned from the event
 * bus) is asked about after the longest wait.
 */
const EXPIRY_RECHECK_MARGIN_MS = 1_000;
const MIN_EXPIRY_RECHECK_MS = 5_000;
const MAX_EXPIRY_RECHECK_MS = 65_000;

/**
 * Lock requests this browser tab has sent and not yet heard back from,
 * across every mounted editor, keyed by `lockKey`. What the viewer sees for
 * a hold depends on whose it is and on these:
 *
 *   | hold under            | request of this tab in flight | shown            |
 *   |-----------------------|-------------------------------|------------------|
 *   | someone else's id     | either                        | "<name> is       |
 *   |                       |                               |  editing…"       |
 *   | the viewer's own id   | yes (release of the editor    | nothing, then    |
 *   |                       |  that just unmounted, or the  |  asked again     |
 *   |                       |  echo of its own acquire)     |  once it settles |
 *   | the viewer's own id   | no (another tab, their agent, | SELF_HOLD_MESSAGE|
 *   |                       |  a closed browser whose hold  |  — Edit waits    |
 *   |                       |  has not expired)             |  for it to end   |
 *
 * "Asked again once it settles" is what keeps the middle row honest: a
 * release that fails leaves the hold in place, and the re-ask then finds it
 * with nothing in flight and shows the self-hold notice.
 */
const requestsInFlight = new Map<string, number>();
const settleWaiters = new Map<string, Array<() => void>>();

function lockKey(workspaceId: string, branch: string, path: string): string {
  return `${canonicalizeWorkspaceId(workspaceId)}\n${branch}\n${path}`;
}

function inFlight(key: string): boolean {
  return (requestsInFlight.get(key) ?? 0) > 0;
}

/** Resolves once nothing is in flight for `key` (at once if nothing is). */
function whenSettled(key: string): Promise<void> {
  if (!inFlight(key)) return Promise.resolve();
  return new Promise((resolve) => {
    settleWaiters.set(key, [...(settleWaiters.get(key) ?? []), resolve]);
  });
}

/** Count `request` as in flight for `key` until it settles, either way. */
function trackInFlight<T>(key: string, request: () => Promise<T>): Promise<T> {
  requestsInFlight.set(key, (requestsInFlight.get(key) ?? 0) + 1);
  const settle = () => {
    const left = (requestsInFlight.get(key) ?? 1) - 1;
    if (left > 0) {
      requestsInFlight.set(key, left);
      return;
    }
    requestsInFlight.delete(key);
    const waiters = settleWaiters.get(key) ?? [];
    settleWaiters.delete(key);
    waiters.forEach((resolve) => resolve());
  };
  let pending: Promise<T>;
  try {
    pending = request();
  } catch (err) {
    settle();
    throw err;
  }
  return pending.finally(settle);
}

interface UseFileLockArgs {
  /** The workspace id of the branch we're editing on. Null disables the hook. */
  workspaceId: string | null;
  /** The branch name. Null disables the hook. */
  branch: string | null;
  /** Workspace-relative path of the file under edit. Null disables the hook. */
  path: string | null;
  /**
   * Current authenticated user's id. Used to recognise "this lock is held
   * by me" responses from the server while a tab-switch cleanup's save or
   * release request for the page is still in flight (both count, see
   * `requestsInFlight`) — without this, switching away and back to a file
   * you were just editing would flicker an amber "[your own name] is
   * editing this page" banner. Optional so test harnesses without auth
   * context still work; in that case nothing is filtered.
   */
  currentUserId?: string | null;
  /**
   * `() => string | null` — pulls the latest in-memory file contents so the
   * autosave checkpoint can persist them to disk before committing. Returning
   * null skips the disk write. Implemented as a getter so the hook reads the
   * current tab buffer without re-subscribing on every keystroke.
   */
  readPendingContent: () => string | null;
  /**
   * Persist `content` to disk via the existing workspace file-write API.
   * Separated from the hook so the hook stays unaware of HTTP routing /
   * tab bookkeeping; the FileViewer wires this to its `saveFile` helper.
   */
  persistToDisk: (content: string) => Promise<void>;
}

/**
 * Result of an `acquire()` attempt. `acquired` is the success flag;
 * `contended` is true only when the failure is a live hold held elsewhere —
 * someone else's, or the viewer's own from another tab or their agent (the
 * externalLock banner covers that case); `error` carries the message for
 * every non-contention failure (access-denied 403, network, etc.).
 */
export interface AcquireOutcome {
  acquired: boolean;
  contended: boolean;
  error: string | null;
}

interface UseFileLockReturn {
  /** True iff this client currently holds the lock. */
  holdingLock: boolean;
  /**
   * Lock this client does not hold (or null if we hold it / nobody does).
   * It can still be the viewer's own: another of their tabs, a closed
   * browser whose hold has not expired, or their agent saving — see
   * `externalLockIsMine`.
   */
  externalLock: FileLock | null;
  /**
   * True when `externalLock` is held under the viewer's own user id. The
   * UI then says "You have this page open for editing somewhere else…"
   * (`SELF_HOLD_MESSAGE`) and never names the viewer as someone else.
   */
  externalLockIsMine: boolean;
  /** Latest acquire / heartbeat error, surfaced in the UI as a banner. */
  lockError: string | null;
  /**
   * Acquire the lock. Not a refresh: the server refuses any live hold,
   * the caller's own included (another tab, their agent), and only takes
   * over an expired one; the heartbeat is what extends a hold this client
   * already has. Resolves to an outcome the caller can act on
   * WITHOUT reading `lockError`/`externalLock` off the hook return —
   * those are React state and are stale in the caller's closure right
   * after the `await`. `contended` distinguishes "held elsewhere"
   * (surfaced by the externalLock banner, as the self-hold notice when the
   * hold is the viewer's own) from an access-denied / network failure
   * (`error` set, `contended` false) that the caller must surface itself.
   */
  acquire: () => Promise<AcquireOutcome>;
  /**
   * Persist + checkpoint: write the current buffer to disk and commit it
   * as a change without releasing the lock. Used by both the autosave
   * timer and the explicit Save button.
   */
  saveCheckpoint: (summary?: string) => Promise<Change | null>;
  /**
   * Final save: write the current buffer to disk and release the lock;
   * the server queues the commit of what is on disk, so there is no
   * change to return. Used on file-close / navigate-away / explicit
   * "done editing".
   */
  saveAndRelease: (summary?: string) => Promise<void>;
  /**
   * Reset the idle-release timer. Callers (the editor) wire this to every
   * interaction with the file — keystrokes, scroll events. After
   * `IDLE_RELEASE_MS` without a call, the held lock auto-releases and
   * the editor flips to read-only.
   */
  recordActivity: () => void;
}

/**
 * Per-file lock lifecycle (PLAN §2). One instance per (branch, file) the
 * editor has open. Concerns:
 *
 *   - Acquisition on demand. Lock is acquired on the caller's terms
 *     (`acquire()`) — typically on first dirty edit. We don't auto-acquire
 *     on mount because read-only views shouldn't claim the lock.
 *   - Heartbeat while held. A `setInterval` extends the TTL every 30s; if
 *     a heartbeat fails (lock expired, stolen, branch deleted) we drop
 *     `holdingLock` so the UI can re-arm.
 *   - External holder polling when we don't hold the lock. The editor
 *     surface shows "X is editing this page" via `externalLock`.
 *   - Autosave checkpoints. Every minute while holding the lock, persist
 *     the latest buffer + commit. The lock stays held — releasing here
 *     would race against the next keystroke.
 *   - Release on unmount / branch-or-path change. The cleanup callback
 *     writes the final pending content to disk and drops the lock so the
 *     next editor can take over; the server queues the commit of what is
 *     on disk.
 */
export function useFileLock(args: UseFileLockArgs): UseFileLockReturn {
  const { workspaceId, branch, path, currentUserId } = args;
  const [holdingLock, setHoldingLock] = useState(false);
  const [externalLock, setExternalLock] = useState<FileLock | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);

  // Refs so the long-lived intervals (heartbeat, autosave) see the latest
  // getters without re-subscribing on every prop change.
  const readPendingContentRef = useRef(args.readPendingContent);
  const persistToDiskRef = useRef(args.persistToDisk);
  const holdingLockRef = useRef(false);
  useEffect(() => { readPendingContentRef.current = args.readPendingContent; }, [args.readPendingContent]);
  useEffect(() => { persistToDiskRef.current = args.persistToDisk; }, [args.persistToDisk]);
  useEffect(() => { holdingLockRef.current = holdingLock; }, [holdingLock]);

  // Reset state when the (workspace, branch, path) tuple changes — opening
  // a different file is a fresh lock context, not a continuation. Done while
  // rendering (React's "adjusting state when a prop changes"), not in an
  // effect, so no effect of the new file ever runs with the old file's
  // state. `holdingLockRef` still follows in its effect, after the old
  // file's unmount cleanup has read it and released.
  const lockContext = `${workspaceId ?? ''}\n${branch ?? ''}\n${path ?? ''}`;
  const [stateContext, setStateContext] = useState(lockContext);
  if (stateContext !== lockContext) {
    setStateContext(lockContext);
    setHoldingLock(false);
    setExternalLock(null);
    setLockError(null);
  }

  const isMine = useCallback(
    (lock: FileLock | null): boolean => !!lock && !!currentUserId && lock.holderUserId === currentUserId,
    [currentUserId],
  );
  const heldMessage = useCallback(
    (lock: FileLock): string => (isMine(lock) ? SELF_HOLD_MESSAGE : `${lock.holderName} is editing this page`),
    [isMine],
  );

  const acquire = useCallback(async (): Promise<AcquireOutcome> => {
    if (!workspaceId || !branch || !path) return { acquired: false, contended: false, error: null };
    console.debug('[useFileLock] acquire start', { workspaceId, branch, path });
    try {
      const result = await trackInFlight(lockKey(workspaceId, branch, path), () =>
        acquireLockApi(workspaceId, branch, path));
      if (result.acquired) {
        console.debug('[useFileLock] acquire ok', { workspaceId, branch, path });
        setHoldingLock(true);
        setExternalLock(null);
        setLockError(null);
        return { acquired: true, contended: false, error: null };
      }
      console.debug('[useFileLock] acquire contended', {
        workspaceId, branch, path,
        holder: result.lock.holderName,
        holderUserId: result.lock.holderUserId,
      });
      const msg = heldMessage(result.lock);
      setHoldingLock(false);
      setExternalLock(result.lock);
      setLockError(msg);
      return { acquired: false, contended: true, error: msg };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[useFileLock] acquire failed', { workspaceId, branch, path, error: msg });
      setLockError(msg);
      setHoldingLock(false);
      return { acquired: false, contended: false, error: msg };
    }
  }, [workspaceId, branch, path, heldMessage]);

  const persistAndCommit = useCallback(
    async (mode: 'checkpoint' | 'release', summary?: string): Promise<Change | null> => {
      if (!workspaceId || !branch || !path) return null;
      console.debug(`[useFileLock] ${mode} start`, { workspaceId, branch, path });
      const pending = readPendingContentRef.current();
      if (pending !== null) {
        try {
          await persistToDiskRef.current(pending);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[useFileLock] ${mode} persist failed`, { workspaceId, branch, path, error: msg });
          setLockError(`Save failed: ${msg}`);
          throw err;
        }
      }
      try {
        if (mode === 'checkpoint') {
          const change = await checkpointLockedFile(workspaceId, branch, path, summary);
          console.debug('[useFileLock] checkpoint ok', { workspaceId, branch, path, sha: change?.sha ?? null });
          return change;
        }
        await trackInFlight(lockKey(workspaceId, branch, path), () =>
          releaseLockApi(workspaceId, branch, path, summary));
        console.debug('[useFileLock] release ok', { workspaceId, branch, path });
        setHoldingLock(false);
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[useFileLock] ${mode} failed`, {
          workspaceId, branch, path,
          status: err instanceof LockApiError ? err.status : undefined,
          error: msg,
        });
        // 409 from the backend means the lock was stolen / expired —
        // surface the state so the editor can re-arm.
        if (err instanceof LockApiError && err.status === 409) {
          setHoldingLock(false);
        }
        setLockError(`Save failed: ${msg}`);
        throw err;
      }
    },
    [workspaceId, branch, path],
  );

  const saveCheckpoint = useCallback(
    (summary?: string) => persistAndCommit('checkpoint', summary),
    [persistAndCommit],
  );

  const saveAndRelease = useCallback(
    async (summary?: string): Promise<void> => { await persistAndCommit('release', summary); },
    [persistAndCommit],
  );

  // Heartbeat while we hold the lock. Refreshes the TTL so a long edit
  // session doesn't lose the lock to a brief network blip.
  useEffect(() => {
    if (!holdingLock || !workspaceId || !branch || !path) return;
    const id = window.setInterval(async () => {
      try {
        await heartbeatLock(workspaceId, branch, path);
        console.debug('[useFileLock] heartbeat ok', { workspaceId, branch, path });
      } catch (err) {
        // Lost the lock — back off the holding state so the UI re-acquires
        // on the next dirty edit.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[useFileLock] heartbeat lost', { workspaceId, branch, path, error: msg });
        // The session-ended sentence already says editing stopped; anything
        // else is a reason, and gets the prefix that makes it one.
        setLockError(msg === EDITING_ENDED_MESSAGE ? msg : `Editing stopped: ${msg}`);
        setHoldingLock(false);
      }
    }, HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [holdingLock, workspaceId, branch, path]);

  // Live lock state when we don't hold it. Two paths feed `externalLock`:
  //
  //   1. **Initial fetch on (workspace, branch, path) change** — we need
  //      to know who currently holds the lock (if anyone) at the moment
  //      the editor opens this file. The SSE stream only delivers events
  //      that fire AFTER subscribe, so without this query a tab opened on
  //      an already-locked file would render "free" until the next
  //      release.
  //
  //   2. **`lock-acquired` / `lock-released` events** from the version-control service
  //      event bus — replace the 15s poll the hook used to do. The bus
  //      fans these out within milliseconds of the acquire/release on
  //      the backend, so the banner appears / disappears in near real
  //      time without per-tab polling traffic.
  //
  // We bail on the subscription path when the bus isn't mounted (tests),
  // and the initial fetch is enough to render a static "X is editing this page" if
  // anyone holds it at mount time.
  const bus = useEventBus();
  useEffect(() => {
    if (holdingLock || !workspaceId || !branch || !path) return;
    let cancelled = false;
    const key = lockKey(workspaceId, branch, path);
    // A hold under the viewer's own id while this tab still has a request
    // in flight for the page is the previous editor's save+release not yet
    // committed (we switched away and back fast enough). A notice for that
    // fraction of a second would be wrong; the SSE `lock-released` event
    // arrives shortly. Any other hold of theirs is live — another tab,
    // their agent — and gets the self-hold notice now, so the page does
    // not look editable until Edit fails. Hidden is never final: once the
    // request settles we ask again, so a release that failed (and left the
    // hold in place, with no `lock-released` to come) shows as the
    // self-hold notice instead of a page that looks free. That re-ask is
    // retried until it gets an answer (5 s, 10 s, 20 s, 40 s, then every
    // 65 s): a hold was seen and hidden, and if the release failed no event
    // will ever correct the page. See the table on `requestsInFlight`.
    let retryTimer: number | undefined;
    // Every `lock-acquired` / `lock-released` event moves this on. An answer
    // to a lookup asked BEFORE the event is older than the event and must
    // not be applied over it: a stale `null` would clear a hold that was
    // just acquired and make Edit look available while the server refuses
    // the write; a stale holder would bring back a notice for a hold that
    // was just released.
    let generation = 0;
    const ask = () => {
      const asked = generation;
      return getLockApi(workspaceId, branch, path).then((lock) => {
        if (asked !== generation) return undefined;
        return lock;
      });
    };
    const reask = (failures = 0) => {
      if (cancelled) return;
      ask()
        .then(onAnswer)
        .catch(() => {
          if (cancelled) return;
          retryTimer = window.setTimeout(
            () => reask(failures + 1),
            Math.min(MIN_EXPIRY_RECHECK_MS * 2 ** failures, MAX_EXPIRY_RECHECK_MS),
          );
        });
    };
    const reaskOnceSettled = () => {
      void whenSettled(key).then(() => { if (!cancelled) reask(); });
    };
    /** `undefined` is an answer overtaken by an event: nothing to apply. */
    const onAnswer = (lock: FileLock | null | undefined) => {
      if (cancelled || lock === undefined) return;
      if (isMine(lock) && inFlight(key)) {
        setExternalLock(null);
        reaskOnceSettled();
        return;
      }
      setExternalLock(lock);
    };
    ask()
      .then(onAnswer)
      .catch(() => { /* network blip, nothing seen yet — events will catch us up */ });
    const stop = () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
    if (!bus) return stop;
    // Canonicalise once; event.workspaceId from the backend is decoded
    // (`razvan-radulescu/sc`) while the `workspaceId` prop is encoded
    // (`razvan-radulescu%2Fsc`). See `canonicalizeWorkspaceId` doc.
    const workspaceCanon = canonicalizeWorkspaceId(workspaceId);
    const offAcquired = bus.subscribe('lock-acquired', (e) => {
      if (e.branch !== branch || e.path !== path || canonicalizeWorkspaceId(e.workspaceId) !== workspaceCanon) return;
      generation += 1;
      // SSE echoes our own acquire too. If the event is about a lock this
      // tab is taking right now (the echo can beat the response that flips
      // `holdingLock`), ignore it — and ask again once that acquire
      // settles, in case it did not end with this tab holding the page.
      // The viewer's hold from another tab or their agent is shown, as the
      // self-hold notice.
      if (currentUserId && e.holderUserId === currentUserId && inFlight(key)) {
        reaskOnceSettled();
        return;
      }
      setExternalLock({
        branch: e.branch,
        path: e.path,
        holderUserId: e.holderUserId,
        holderName: e.holderName,
        // SSE doesn't carry the lock TTL fields; the banner only renders
        // holder name, so leaving them blank is harmless. A subsequent
        // get-lock fetch on file open would refresh them if needed.
        acquiredAt: '',
        lastHeartbeatAt: '',
        expiresAt: '',
      });
    });
    const offReleased = bus.subscribe('lock-released', (e) => {
      if (e.branch !== branch || e.path !== path || canonicalizeWorkspaceId(e.workspaceId) !== workspaceCanon) return;
      generation += 1;
      // The hold ended while its notice was on screen: the notice goes and
      // Edit is available again, without a reload.
      setExternalLock(null);
      setLockError(null);
    });
    return () => {
      stop();
      offAcquired();
      offReleased();
    };
  }, [holdingLock, workspaceId, branch, path, bus, currentUserId, isMine]);

  // Consecutive failed expiry re-checks. Each doubles the next wait, so an
  // unreachable server is not asked every few seconds for as long as a
  // notice stays on screen.
  const recheckFailuresRef = useRef(0);
  useEffect(() => { recheckFailuresRef.current = 0; }, [workspaceId, branch, path]);

  // Re-check at expiry. A hold whose tab crashed, slept or lost the
  // network as it closed sends no `lock-released`; it simply expires on the
  // server. While its notice is on screen, ask again just after the expiry:
  // gone → clear the notice so Edit works without a reload; renewed (the
  // holder is still there) → keep it, with the new expiry scheduling the
  // next ask.
  useEffect(() => {
    if (holdingLock || !externalLock || !workspaceId || !branch || !path) return;
    const expiresAtMs = Date.parse(externalLock.expiresAt);
    const failures = recheckFailuresRef.current;
    const delay = failures > 0
      ? Math.min(MIN_EXPIRY_RECHECK_MS * 2 ** failures, MAX_EXPIRY_RECHECK_MS)
      : Number.isNaN(expiresAtMs)
        ? MAX_EXPIRY_RECHECK_MS
        : Math.min(
          Math.max(expiresAtMs - Date.now() + EXPIRY_RECHECK_MARGIN_MS, MIN_EXPIRY_RECHECK_MS),
          MAX_EXPIRY_RECHECK_MS,
        );
    let cancelled = false;
    const id = window.setTimeout(() => {
      getLockApi(workspaceId, branch, path)
        .then((lock) => {
          if (cancelled) return;
          recheckFailuresRef.current = 0;
          if (lock) {
            setExternalLock(lock);
            setLockError(heldMessage(lock));
            return;
          }
          setExternalLock(null);
          setLockError(null);
        })
        .catch(() => {
          // Network blip: ask again, waiting twice as long as last time
          // (10 s, 20 s, 40 s, then every 65 s). A fresh object re-runs
          // this effect with the longer wait.
          if (cancelled) return;
          recheckFailuresRef.current += 1;
          setExternalLock((current) => (current ? { ...current } : current));
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [holdingLock, externalLock, workspaceId, branch, path, heldMessage]);

  // Autosave checkpoint timer. Runs every minute while holding the lock
  // *and* the buffer is non-null. The lock stays held across checkpoints
  // — release happens explicitly on save+close.
  useEffect(() => {
    if (!holdingLock || !workspaceId || !branch || !path) return;
    const id = window.setInterval(() => {
      if (!holdingLockRef.current) return;
      const pending = readPendingContentRef.current();
      if (pending === null) return;
      saveCheckpoint().catch((err) => {
        // saveCheckpoint already wrote `lockError`; the periodic retry
        // will resync on the next interval.
        console.warn('[useFileLock] autosave checkpoint failed:', err);
      });
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [holdingLock, workspaceId, branch, path, saveCheckpoint]);

  // Idle-release timer. While we hold the lock, the editor wires its
  // keystroke + scroll handlers into `recordActivity()` below; each call
  // resets the timer. If the timer fires (no activity for
  // IDLE_RELEASE_MS) we save and release — the user has stepped away,
  // and the file should be available to others without anyone having to
  // explicitly hand it back.
  //
  // We store the timeout id in a ref so `recordActivity` can clear and
  // restart it cheaply without re-running this effect.
  const idleTimerRef = useRef<number | null>(null);
  const clearIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);
  const startIdleTimer = useCallback(() => {
    clearIdleTimer();
    if (!holdingLockRef.current) return;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      if (!holdingLockRef.current) return;
      // saveAndRelease writes the current buffer (if any) and releases
      // the lock; the server queues the commit of what is on disk. On
      // success the `holdingLock` state flips to false; the editor's
      // `readOnly` check reacts on the next render.
      // On failure we leave the timer cleared — the user's next
      // activity will start a fresh one. Errors are logged here because
      // the hook user has already moved on by definition (they were
      // idle).
      saveAndRelease().catch((err) => {
        console.warn('[useFileLock] idle release failed:', err);
      });
    }, IDLE_RELEASE_MS);
  }, [clearIdleTimer, saveAndRelease]);

  // Wire the timer to the holding-lock lifecycle: arm when we acquire,
  // tear down when we no longer hold it (manual release, lost lock,
  // file switch).
  useEffect(() => {
    if (!holdingLock) {
      clearIdleTimer();
      return;
    }
    startIdleTimer();
    return clearIdleTimer;
  }, [holdingLock, startIdleTimer, clearIdleTimer]);

  const recordActivity = useCallback(() => {
    // No-op when we don't hold the lock — there's no timer to reset.
    // (The editor still fires activity events from any rendered file,
    // including those we're viewing read-only; we just ignore them.)
    if (!holdingLockRef.current) return;
    startIdleTimer();
  }, [startIdleTimer]);

  // Release on close, reload or leaving for another site. None of those
  // unmounts React, so the cleanup below never runs for them, and the hold
  // used to linger until its expiry. `pagehide` fires only once the page is
  // really going (after the person accepts the unsaved-changes warning, and
  // never for a tab switch or a minimised window — those are
  // `visibilitychange`, which deliberately releases nothing). The request is
  // keep-alive so it outlives the page; if it never arrives, the server's
  // expiry ends the hold as before. Nothing is persisted first: text typed
  // since the last automatic save is not saved on close, as before — the
  // server's release commits only what is already on disk.
  useEffect(() => {
    if (!holdingLock || !workspaceId || !branch || !path) return;
    const onPageHide = () => {
      if (!holdingLockRef.current) return;
      // Not holding any more, so the unmount cleanup does not release a
      // second time, and a page restored from the back-forward cache
      // re-acquires on Edit rather than believing it still holds.
      holdingLockRef.current = false;
      setHoldingLock(false);
      trackInFlight(lockKey(workspaceId, branch, path), () =>
        releaseLockApi(workspaceId, branch, path, undefined, { keepalive: true })).catch((err) => {
        console.warn('[useFileLock] release on pagehide failed:', err);
      });
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [holdingLock, workspaceId, branch, path]);

  // Release the lock when the editor unmounts or switches files. Best-
  // effort — a failure here is logged but doesn't surface to the user,
  // they've already moved on. Before releasing, persist the latest
  // in-memory buffer to disk so the final keystrokes don't get
  // discarded — without this, closing a tab mid-edit would commit
  // whatever was last saved to disk and lose the unsaved tail (the
  // backend's `commitFile` reads the on-disk state, not our buffer).
  useEffect(() => {
    return () => {
      if (!holdingLockRef.current || !workspaceId || !branch || !path) return;
      const pending = readPendingContentRef.current();
      const key = lockKey(workspaceId, branch, path);
      const release = () =>
        trackInFlight(key, () => releaseLockApi(workspaceId, branch, path)).catch((err) => {
          console.warn('[useFileLock] release on unmount failed:', err);
        });
      if (pending !== null) {
        // Counted from the save, not the release: the editor that mounts
        // next asks who holds the page while the save is still running.
        trackInFlight(key, () => persistToDiskRef.current(pending)).then(release, (err) => {
          console.warn('[useFileLock] persist on unmount failed:', err);
          // Release anyway so the lock doesn't get stuck; whatever was
          // last successfully written to disk will be what the release-
          // time commit captures.
          void release();
        });
      } else {
        void release();
      }
    };
  }, [workspaceId, branch, path]);

  const externalLockIsMine = isMine(externalLock);

  return {
    holdingLock,
    externalLock,
    externalLockIsMine,
    lockError,
    acquire,
    saveCheckpoint,
    saveAndRelease,
    recordActivity,
  };
}
