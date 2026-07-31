import { useCallback, useEffect, useRef, useState } from 'react';
import type { Change, FileLock } from '@bevel-software/platform-shared';
import {
  acquireLock as acquireLockApi,
  checkpointLockedFile,
  getLock as getLockApi,
  heartbeatLock,
  LockApiError,
  releaseLock as releaseLockApi,
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

interface UseFileLockArgs {
  /** The workspace id of the branch we're editing on. Null disables the hook. */
  workspaceId: string | null;
  /** The branch name. Null disables the hook. */
  branch: string | null;
  /** Workspace-relative path of the file under edit. Null disables the hook. */
  path: string | null;
  /**
   * Current authenticated user's id. Used to recognise "this lock is held
   * by me" responses from the server during the brief window between a
   * tab-switch cleanup releasing the lock and the backend actually
   * committing the release — without this, switching away and back to a
   * file you were just editing would flicker an amber "Locked by [your
   * own name]" banner. Optional so test harnesses without auth context
   * still work; in that case nothing is filtered.
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
 * `contended` is true only when the failure is another user's lock (the
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
  /** Lock currently held by someone else (or null if we hold it / nobody does). */
  externalLock: FileLock | null;
  /** Latest acquire / heartbeat error, surfaced in the UI as a banner. */
  lockError: string | null;
  /**
   * Acquire the lock. Idempotent — re-acquiring a lock you already hold
   * refreshes the TTL. Resolves to an outcome the caller can act on
   * WITHOUT reading `lockError`/`externalLock` off the hook return —
   * those are React state and are stale in the caller's closure right
   * after the `await`. `contended` distinguishes "held by someone else"
   * (surfaced by the externalLock banner) from an access-denied / network
   * failure (`error` set, `contended` false) that the caller must surface
   * itself.
   */
  acquire: () => Promise<AcquireOutcome>;
  /**
   * Persist + checkpoint: write the current buffer to disk and commit it
   * as a change without releasing the lock. Used by both the autosave
   * timer and the explicit Save button.
   */
  saveCheckpoint: (summary?: string) => Promise<Change | null>;
  /**
   * Final save: write the current buffer to disk, commit it, and release
   * the lock. Used on file-close / navigate-away / explicit "done editing".
   */
  saveAndRelease: (summary?: string) => Promise<Change | null>;
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
 *     surface shows "Locked by X" via `externalLock`.
 *   - Autosave checkpoints. Every minute while holding the lock, persist
 *     the latest buffer + commit. The lock stays held — releasing here
 *     would race against the next keystroke.
 *   - Release on unmount / branch-or-path change. The cleanup callback
 *     commits the final pending content and drops the lock so the next
 *     editor can take over.
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
  // a different file is a fresh lock context, not a continuation.
  useEffect(() => {
    setHoldingLock(false);
    setExternalLock(null);
    setLockError(null);
  }, [workspaceId, branch, path]);

  const acquire = useCallback(async (): Promise<AcquireOutcome> => {
    if (!workspaceId || !branch || !path) return { acquired: false, contended: false, error: null };
    console.debug('[useFileLock] acquire start', { workspaceId, branch, path });
    try {
      const result = await acquireLockApi(workspaceId, branch, path);
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
      const msg = `Locked by ${result.lock.holderName}`;
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
  }, [workspaceId, branch, path]);

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
        const change = await releaseLockApi(workspaceId, branch, path, summary);
        console.debug('[useFileLock] release ok', { workspaceId, branch, path, sha: change?.sha ?? null });
        setHoldingLock(false);
        return change;
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
    (summary?: string) => persistAndCommit('release', summary),
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
        setLockError(`Lost lock: ${msg}`);
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
  //   2. **`lock-acquired` / `lock-released` events** from the workflow
  //      event bus — replace the 15s poll the hook used to do. The bus
  //      fans these out within milliseconds of the acquire/release on
  //      the backend, so the banner appears / disappears in near real
  //      time without per-tab polling traffic.
  //
  // We bail on the subscription path when the bus isn't mounted (tests),
  // and the initial fetch is enough to render a static "Locked by X" if
  // anyone holds it at mount time.
  const bus = useEventBus();
  useEffect(() => {
    if (holdingLock || !workspaceId || !branch || !path) return;
    let cancelled = false;
    // "Lock held by me" means the previous tab's cleanup hasn't finished
    // committing the release on the backend yet — we just switched away
    // and back fast enough that the persist+release is still in flight.
    // We don't want to render an amber "Locked by [yourself]" banner
    // for that fraction of a second; the SSE `lock-released` event
    // will arrive shortly and we'll be back to a clean state.
    const isSelfLock = (lock: FileLock | null): boolean =>
      !!lock && !!currentUserId && lock.holderUserId === currentUserId;
    getLockApi(workspaceId, branch, path)
      .then((lock) => {
        if (cancelled) return;
        setExternalLock(isSelfLock(lock) ? null : lock);
      })
      .catch(() => { /* network blip — events will catch us up */ });
    if (!bus) return () => { cancelled = true; };
    // Canonicalise once; event.workspaceId from the backend is decoded
    // (`razvan-radulescu/sc`) while the `workspaceId` prop is encoded
    // (`razvan-radulescu%2Fsc`). See `canonicalizeWorkspaceId` doc.
    const workspaceCanon = canonicalizeWorkspaceId(workspaceId);
    const offAcquired = bus.subscribe('lock-acquired', (e) => {
      if (e.branch !== branch || e.path !== path || canonicalizeWorkspaceId(e.workspaceId) !== workspaceCanon) return;
      // SSE echoes our own acquire too. If the event is about a lock
      // we just took on this client (rare — we'd already be in the
      // `holdingLock=true` branch and not subscribed — but cover it
      // for safety against state races), ignore it.
      if (currentUserId && e.holderUserId === currentUserId) return;
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
      setExternalLock(null);
    });
    return () => {
      cancelled = true;
      offAcquired();
      offReleased();
    };
  }, [holdingLock, workspaceId, branch, path, bus, currentUserId]);

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
      // saveAndRelease writes the current buffer (if any), commits, and
      // releases the lock. On success the `holdingLock` state flips to
      // false; the editor's `readOnly` check reacts on the next render.
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
      const release = () =>
        releaseLockApi(workspaceId, branch, path).catch((err) => {
          console.warn('[useFileLock] release on unmount failed:', err);
        });
      if (pending !== null) {
        persistToDiskRef.current(pending).then(release, (err) => {
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

  return { holdingLock, externalLock, lockError, acquire, saveCheckpoint, saveAndRelease, recordActivity };
}
