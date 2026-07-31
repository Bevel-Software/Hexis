import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/shared';
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
  const [focusVersion, setFocusVersion] = useState(0);

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

  const postFocus = useCallback(async (workspaceId: string | null) => {
    if (!sessionId) return;
    if (workspaceId === null) {
      // No "clear focus" endpoint server-side; setting null is a frontend
      // signal that we don't currently want workspace events. The next
      // setFocus(workspaceId) re-syncs the server. This is fine because
      // an idle focus simply means no workspace-scoped events arrive.
      focusRef.current = null;
      return;
    }
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(sessionId)}/focus`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
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
    } catch (err) {
      // Network blip — `focusRef` stays at its last successfully-synced
      // value, so a follow-up setFocus to the same workspaceId still
      // detects desync and retries.
      console.warn('[event-bus] focus POST failed:', err);
    }
  }, [sessionId]);

  const setFocus = useCallback<EventBusContextValue['setFocus']>((workspaceId) => {
    // Compare against SYNCED focus, not desired — that way a retry
    // after a previous POST failure isn't short-circuited.
    if (focusRef.current === workspaceId) {
      desiredFocusRef.current = workspaceId;
      return;
    }
    console.debug('[event-bus] setFocus', { from: focusRef.current, to: workspaceId });
    desiredFocusRef.current = workspaceId;
    setFocusVersion((v) => v + 1);
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
        void postFocus(desiredFocusRef.current);
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
    void postFocus(desiredFocusRef.current);
  }, [focusVersion, postFocus]);

  const value = useMemo<EventBusContextValue>(() => ({ subscribe, setFocus }), [subscribe, setFocus]);

  return <EventBusContext.Provider value={value}>{children}</EventBusContext.Provider>;
}
