import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue, type EventHandler } from './event-bus.context';

/** Storage key for the per-tab sessionId. SessionStorage so it survives a
 * page refresh (allowing Last-Event-ID replay across the gap) but doesn't
 * leak across browser tabs (each tab has its own connection). */
// Exported so `authFetch` can stamp the per-tab session id onto outgoing
// requests as an `x-bevel-session` header. Route handlers that emit
// originating-session-scoped events include this id so the originating tab
// can self-skip and only OTHER tabs of the same user act on the event.
export const SESSION_ID_KEY = 'bevel-event-bus-session-id';

/**
 * Provider that owns the single EventSource connection for this browser
 * tab and demultiplexes incoming events to registered handlers.
 *
 * **Lifecycle.** One EventSource is opened on mount and closed on unmount
 * — that's the entire lifetime. Branch switches, route changes, chat
 * turns, and reconnect storms all happen *inside* this connection. We
 * never re-open per workspace; the backend's focus endpoint is what
 * changes which workspace events we receive.
 *
 * **Reconnect.** The browser's EventSource auto-reconnects with a default
 * ~3 s backoff. We don't do anything to help it — but we DO re-POST the
 * current focus on every `open` event so the server's session map picks
 * up the desired filter again after a transient drop.
 *
 * **Auth.** EventSource can't set headers, so authentication happens via
 * the `bevel_token` cookie set at login. `withCredentials: true` makes
 * the browser include it. The cookie is HttpOnly + SameSite=Lax, so the
 * frontend can't read it directly — that's fine, the server reads it.
 */
export function EventBusProvider({ children }: { children: ReactNode }) {
  // Per-tab session id. Generated once and persisted in sessionStorage so
  // a refresh keeps the same id (which lets the server's ring buffer
  // replay anything missed in the gap via Last-Event-ID).
  const sessionId = useMemo(() => {
    if (typeof window === 'undefined') return ''; // SSR / test fallback
    let id = window.sessionStorage.getItem(SESSION_ID_KEY);
    if (!id) {
      id = (window.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      window.sessionStorage.setItem(SESSION_ID_KEY, id);
    }
    return id;
  }, []);

  // Subscriber registry. Keyed by event kind so dispatch is O(handlers
  // for THIS kind) rather than scanning every subscriber on every event.
  // `Set` so duplicate registrations don't double-fire.
  const subscribersRef = useRef<Map<string, Set<EventHandler<WorkflowEvent['kind']>>>>(new Map());

  // **Two focus refs, not one** — the "synced" focus (what the server
  // confirmed) and the "desired" focus (what the client wants).
  //
  // Why this matters: without the split, a failed POST left `focusRef`
  // advanced to the new value, so the next `setFocus(sameValue)` would
  // short-circuit on equality and never retry — the server stays stuck
  // on the OLD focus, and the client thinks it's on the new one. With
  // the split, `desiredFocusRef` is what `setFocus` updates and what
  // the post-attempt reads; `focusRef` only advances on a 2xx, so a
  // retry is possible whenever desired ≠ synced.
  const focusRef = useRef<string | null>(null);
  const desiredFocusRef = useRef<string | null>(null);
  // Extra workspaces this tab wants events for beyond the focused one, and how
  // many mounted consumers each. Ref-counted because two components can want
  // the same workspace (a skill page and its review panel) and must release
  // independently — a plain Set would let the first unmount cut the second's
  // events. Kept in a ref, not state: it changes on mount/unmount, and the
  // POST is driven by `focusVersion` like every other focus change.
  const watchCountsRef = useRef<Map<string, number>>(new Map());
  // What the last ACCEPTED POST carried, primary + extras. The synced/desired
  // comparison in `setFocus` is against this, so adding a watch on the same
  // primary focus still counts as a desync and gets posted.
  const syncedKeyRef = useRef<string | null>(null);
  // Tail of the focus-POST chain. See `postFocus`.
  const focusChainRef = useRef<Promise<void>>(Promise.resolve());
  const [focusVersion, setFocusVersion] = useState(0);

  /** What this tab wants delivered, primary first — the wire form and the key. */
  const watchListOf = useCallback(
    (primary: string) => [
      primary,
      ...[...watchCountsRef.current.keys()].filter((id) => id !== primary),
    ],
    [],
  );

  const dispatch = useCallback((event: WorkflowEvent) => {
    // Heartbeats are connection-keepalives only — they shouldn't reach
    // app code. Same for resync (we'd want to refetch state from
    // scratch, but that's left to consumers that subscribe to it
    // explicitly).
    if (event.kind === 'heartbeat') return;
    const handlers = subscribersRef.current.get(event.kind);
    // One-line dispatch log: which event arrived, how many local
    // handlers it'll fan out to, and the most useful identifying
    // fields. Helps catch "event arrived but no handler was
    // subscribed" symptoms quickly in DevTools.
    const path = 'path' in event && event.path ? event.path : undefined;
    const sha = 'newSha' in event ? event.newSha : undefined;
    console.debug('[event-bus] receive', {
      kind: event.kind,
      id: 'id' in event ? event.id : undefined,
      handlerCount: handlers?.size ?? 0,
      ...(path !== undefined ? { path } : {}),
      ...(sha !== undefined ? { newSha: sha } : {}),
    });
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(event as never);
      } catch (err) {
        console.warn(`[event-bus] handler for ${event.kind} threw:`, err);
      }
    }
  }, []);

  const subscribe = useCallback<EventBusContextValue['subscribe']>((kind, handler) => {
    let bucket = subscribersRef.current.get(kind);
    if (!bucket) {
      bucket = new Set();
      subscribersRef.current.set(kind, bucket);
    }
    bucket.add(handler as unknown as EventHandler<WorkflowEvent['kind']>);
    return () => {
      bucket?.delete(handler as unknown as EventHandler<WorkflowEvent['kind']>);
      if (bucket && bucket.size === 0) {
        subscribersRef.current.delete(kind);
      }
    };
  }, []);

  /**
   * Send the CURRENT desired list, once. Reads `desiredFocusRef` and the watch
   * counts at send time rather than taking them as arguments: by the time a
   * queued send runs, a watch may have been added or released, and the only
   * list worth sending is the one that is true now.
   */
  const sendFocus = useCallback(async () => {
    if (!sessionId) return;
    const workspaceId = desiredFocusRef.current;
    if (workspaceId === null) {
      // No "clear focus" endpoint server-side; setting null is a frontend
      // signal that we don't currently want workspace events. The next
      // setFocus(workspaceId) re-syncs the server. This is fine because
      // an idle focus simply means no workspace-scoped events arrive.
      focusRef.current = null;
      syncedKeyRef.current = null;
      return;
    }
    const alsoWatch = watchListOf(workspaceId).slice(1);
    const key = [workspaceId, ...alsoWatch].join('\n');
    // Coalesce: several sends can queue behind one slow request (a watch
    // added and released while it is in flight), and every one of them would
    // otherwise re-send a list the server already has. `syncedKeyRef` is
    // cleared on reconnect, so this never skips the resync.
    if (syncedKeyRef.current === key) return;
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(sessionId)}/focus`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // `workspaceId` stays the primary field it always was; `alsoWatch`
        // carries the rest. A server that doesn't know the second field still
        // gets the focus right, it just doesn't deliver the extras.
        body: JSON.stringify({ workspaceId, alsoWatch }),
      });
      if (!response.ok) {
        // Server rejected the focus update (most likely 404 — session
        // expired or was evicted, e.g. after a backend restart). The
        // SSE connection's `open` handler re-POSTs the latest desired
        // focus on every reconnect, so a transient rejection corrects
        // itself the next time the connection cycles.
        let detail = '';
        try { detail = await response.text(); } catch { /* ignore */ }
        console.warn(
          `[event-bus] focus POST rejected: ${response.status}`,
          detail || '(no body)',
        );
        // Leave `focusRef` (synced) UN-advanced so the next
        // `setFocus(sameWorkspaceId)` doesn't short-circuit on
        // equality — the desired focus is still unsynced and we want
        // to retry.
        return;
      }
      // Server accepted: synced focus catches up to desired.
      focusRef.current = workspaceId;
      syncedKeyRef.current = key;
    } catch (err) {
      // Network blip — `focusRef` stays at its last successfully-synced
      // value, so a follow-up setFocus to the same workspaceId still
      // detects desync and retries.
      console.warn('[event-bus] focus POST failed:', err);
    }
  }, [sessionId, watchListOf]);

  /**
   * ONE FOCUS POST AT A TIME, in the order they were asked for.
   *
   * These requests are not independent: each one REPLACES the session's whole
   * delivery list, so the last to reach the server wins. Fired concurrently —
   * which is what a watch registered while a focus change is in flight does —
   * two can be processed out of order, leaving the server holding the older
   * list while this tab records the newer one as synced. Nothing retries after
   * that, and the workspace that lost its watch goes quiet for the life of the
   * tab: the exact silent staleness the watch list exists to fix.
   *
   * Chaining is enough because `sendFocus` reads the desired state when it
   * runs, so a queued send carries the latest list rather than a stale
   * snapshot, and a redundant one returns without a request.
   */
  const postFocus = useCallback(() => {
    const next = focusChainRef.current.then(() => sendFocus());
    focusChainRef.current = next.catch(() => {});
    return next;
  }, [sendFocus]);

  const setFocus = useCallback<EventBusContextValue['setFocus']>((workspaceId) => {
    // Compare against the SYNCED list, not the desired one — that way a retry
    // after a previous POST failure isn't short-circuited. The whole list, not
    // just the primary, so a watch added while the focus stands still is still
    // a desync worth posting.
    const desiredKey = workspaceId === null ? null : watchListOf(workspaceId).join('\n');
    if (syncedKeyRef.current === desiredKey && focusRef.current === workspaceId) {
      desiredFocusRef.current = workspaceId;
      return;
    }
    console.debug('[event-bus] setFocus', { from: focusRef.current, to: workspaceId });
    desiredFocusRef.current = workspaceId;
    setFocusVersion((v) => v + 1);
  }, [watchListOf]);

  /**
   * Add a workspace to this tab's delivery list until the returned fn runs.
   * Re-POSTs the focus so the server hears about it; if there is no focus yet
   * the new entry rides along with the first `setFocus`, which the workspace
   * bootstrap always issues.
   */
  const watchWorkspace = useCallback<EventBusContextValue['watchWorkspace']>((workspaceId) => {
    const counts = watchCountsRef.current;
    counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
    if (desiredFocusRef.current !== null) setFocusVersion((v) => v + 1);
    let released = false;
    return () => {
      // Idempotent: a double release must not decrement someone else's count.
      if (released) return;
      released = true;
      const remaining = (counts.get(workspaceId) ?? 1) - 1;
      if (remaining > 0) counts.set(workspaceId, remaining);
      else counts.delete(workspaceId);
      if (desiredFocusRef.current !== null) setFocusVersion((v) => v + 1);
    };
  }, []);

  // EventSource lifecycle. One connection per tab, opened once on mount,
  // closed on unmount. The browser handles reconnect with its built-in
  // backoff; we re-POST focus inside the `open` handler so reconnects
  // resynchronise the server's session filter for free.
  useEffect(() => {
    if (!sessionId || typeof EventSource === 'undefined') return;
    const url = `/api/events?session=${encodeURIComponent(sessionId)}`;
    const source = new EventSource(url, { withCredentials: true });

    const handleOpen = () => {
      console.debug('[event-bus] SSE open', { session: sessionId, desiredFocus: desiredFocusRef.current });
      // Reconnect path: re-POST the DESIRED focus so the new connection
      // catches up to what the client wants — using `desiredFocusRef`
      // (not synced `focusRef`) means a previous POST failure also
      // self-heals on the next open. First-time-open will have desired
      // === null until a consumer (workspace state) calls setFocus.
      if (desiredFocusRef.current !== null) {
        // A reconnect is a NEW server-side session record, with an empty
        // delivery list — whatever this tab had synced is gone with the old
        // one. Clearing the synced key is what stops `sendFocus` coalescing
        // the resync away as "already sent".
        syncedKeyRef.current = null;
        focusRef.current = null;
        void postFocus();
      }
    };

    const handleMessage = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as WorkflowEvent;
        dispatch(event);
      } catch (err) {
        console.warn('[event-bus] failed to parse SSE payload:', err);
      }
    };

    const handleError = (e: Event) => {
      // EventSource auto-reconnects; we just log so a misbehaving
      // backend surfaces in the console. Don't close — closing would
      // cancel the auto-reconnect.
      console.warn('[event-bus] connection error (auto-reconnecting):', e);
    };

    source.addEventListener('open', handleOpen);
    source.addEventListener('message', handleMessage);
    source.addEventListener('error', handleError);

    return () => {
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('message', handleMessage);
      source.removeEventListener('error', handleError);
      source.close();
    };
    // Intentionally re-subscribing only on sessionId / postFocus / dispatch
    // identity changes. Focus updates flow through `postFocus` directly
    // (no reconnect needed); a focus change must never tear the
    // connection down.
  }, [sessionId, dispatch, postFocus]);

  // Propagate focus changes to the server. Decoupled from the EventSource
  // lifecycle so a focus change doesn't reconnect.
  useEffect(() => {
    if (focusVersion === 0) return;
    void postFocus();
  }, [focusVersion, postFocus]);

  const value = useMemo<EventBusContextValue>(
    () => ({ subscribe, setFocus, watchWorkspace }),
    [subscribe, setFocus, watchWorkspace],
  );

  return <EventBusContext.Provider value={value}>{children}</EventBusContext.Provider>;
}
