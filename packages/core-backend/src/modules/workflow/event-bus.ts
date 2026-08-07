/**
 * In-process event bus that fans workflow state-change events out to
 * subscribed SSE sessions. The shape and scope rules live in
 * `@bevel-software/platform-shared/workflow/events.ts` — this module is the runtime that
 * makes them deliverable.
 *
 * **What this owns**
 *
 *   1. **The monotonic event id.** Each `emit` stamps the next id; clients
 *      reconnecting with `Last-Event-ID: <n>` use it to replay everything
 *      they missed.
 *
 *   2. **A per-process ring buffer** of the last `BUFFER_CAPACITY` events.
 *      Replay works if the gap is short. Long disconnects fall back to
 *      `{ kind: 'resync' }` so the client refetches cleanly.
 *
 *   3. **A registry of subscribers**, each owning a per-session push
 *      function. On `emit`, every subscriber that matches the event's scope
 *      (see `isWorkspaceScoped` / `isUserScoped`) gets the event pushed
 *      synchronously to its push callback — the route layer translates that
 *      to an SSE `data:` line.
 *
 * **What this does NOT own**
 *
 *   - Transport (SSE framing, heartbeats): the route layer.
 *   - Auth (which user owns a session): the route layer wires
 *     userId + sessionId in at subscription time, this just stores them.
 *   - Persistence: in-memory only. A server restart resets the id counter
 *     and empties the buffer; clients that reconnect after a restart will
 *     get a `resync` (their stored Last-Event-ID is necessarily older than
 *     the new buffer can serve), which is exactly the right behavior.
 *
 * **Concurrency** — Node is single-threaded for JS, so a synchronous fan-out
 * inside `emit` is safe. Subscribers must not throw from their push
 * callback; we wrap every push in try/catch and log so one bad subscriber
 * never blocks the rest.
 */

import {
  isUserScoped,
  isWorkspaceScoped,
  type WorkflowEvent,
  type WorkflowEventPayload,
} from '@bevel-software/platform-shared';

/**
 * Capacity of the global event ring buffer. A new event evicts the oldest
 * when full. Sized for "should comfortably catch any client through a brief
 * network blip" — 500 events at e.g. one edit per second buys ~8 minutes of
 * coverage, plenty for transient reconnects. Sized down would push more
 * clients onto the `resync` path; sized up wastes RSS on no-op edits.
 */
const BUFFER_CAPACITY = 500;

/**
 * Push callback the route layer provides at subscription time. Receives the
 * stamped envelope + payload and SHOULD NOT throw — exceptions are caught
 * and logged so one misbehaving subscriber never blocks fan-out to the rest.
 */
export type SubscriberPush = (event: WorkflowEvent) => void;

/**
 * Per-session subscription bookkeeping. `getFocusedWorkspaceId` is a getter
 * (not a value) so the route layer can update the session's focus via a
 * separate POST without re-subscribing — the next `emit` sees the new focus
 * on the next call.
 */
export interface Subscriber {
  sessionId: string;
  userId: string;
  getFocusedWorkspaceId: () => string | null;
  push: SubscriberPush;
}

/**
 * Decode-once, idempotent. Both sides of the focus / workspaceId
 * comparison get fed through this so we don't care whether the caller
 * sent the URL-encoded form (`razvan-radulescu%2Fsc`) or the canonical
 * form (`razvan-radulescu/sc`). Catches malformed input by returning the
 * original string — broken encoding shouldn't crash the dispatcher.
 */
function canonicalize(workspaceId: string): string {
  try {
    return decodeURIComponent(workspaceId);
  } catch {
    return workspaceId;
  }
}

export class WorkflowEventBus {
  private nextId = 1;
  private readonly buffer: WorkflowEvent[] = [];
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly emitListeners = new Set<(event: WorkflowEvent) => void>();

  /**
   * Server-side tap: called for EVERY emitted event, before the per-session
   * scope filtering (which exists for SSE fan-out, not for in-process
   * consumers). The composition root uses this for write-time cache
   * invalidation — the routes emit `fs-tree-changed` the moment bytes hit a
   * working tree, long before the async commit reaches `FileChangeNotifier`.
   * Best-effort like SSE dispatch: a throwing listener is logged, never
   * propagated to the emitter. Returns the unsubscribe.
   */
  onEmit(listener: (event: WorkflowEvent) => void): () => void {
    this.emitListeners.add(listener);
    return () => this.emitListeners.delete(listener);
  }

  /**
   * Stamp `payload` with `id` + `ts`, append to the ring buffer, then fan
   * out synchronously to every matching subscriber. Returns the stamped
   * event so callers (e.g. tests, debug logs) can see what was actually
   * delivered.
   */
  emit(payload: WorkflowEventPayload): WorkflowEvent {
    const event: WorkflowEvent = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      ...payload,
    };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_CAPACITY) {
      this.buffer.shift();
    }
    for (const listener of this.emitListeners) {
      try {
        listener(event);
      } catch (err) {
        console.warn(
          '[event-bus] onEmit listener threw:',
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Single-line emit log with all the fields most useful for tracing a
    // failed delivery: which event, which scope it'll filter on, and the
    // total subscriber pool size before fan-out. Per-subscriber matched/
    // skipped decisions are logged below at debug level.
    const scope =
      'workspaceId' in event && event.workspaceId
        ? `ws=${event.workspaceId}`
        : 'forUserId' in event && event.forUserId
          ? `user=${event.forUserId}`
          : 'global';
    const extra: string[] = [];
    if ('path' in event && event.path) extra.push(`path=${event.path}`);
    if ('branch' in event && event.branch) extra.push(`branch=${event.branch}`);
    if ('newSha' in event && event.newSha !== undefined) extra.push(`sha=${event.newSha ?? 'null'}`);
    if ('holderName' in event && event.holderName) extra.push(`holder=${event.holderName}`);
    console.log(
      `[event-bus] EMIT id=${event.id} kind=${event.kind} ${scope}${extra.length ? ' ' + extra.join(' ') : ''} subs=${this.subscribers.size}`,
    );
    let matched = 0;
    let skipped = 0;
    for (const sub of this.subscribers.values()) {
      // Best-effort per subscriber — one bad subscriber must not block
      // the rest of the fan-out OR propagate back to the caller. The
      // try/catch covers both the scope check (`matches` reaches into
      // `sub.getFocusedWorkspaceId()`, which could throw if a bizarre
      // subscriber holds buggy state) and the dispatch itself, so
      // workflow mutations stay successful even if a listener throws.
      // Callers can rely on `emit` never throwing, so they don't need
      // to wrap every emit call site in their own try/catch.
      try {
        if (!this.matches(event, sub)) {
          skipped++;
          continue;
        }
        sub.push(event);
        matched++;
      } catch (err) {
        console.warn(
          `[event-bus] dispatch to session ${sub.sessionId} threw:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    console.log(
      `[event-bus] EMIT id=${event.id} kind=${event.kind} → delivered=${matched} skipped=${skipped}`,
    );
    return event;
  }

  /**
   * Register a subscriber. Returns an `unsubscribe` function the route
   * layer is expected to call from `res.on('close', …)` — without it a
   * disconnected client leaks the session entry forever.
   */
  subscribe(sub: Subscriber): () => void {
    this.subscribers.set(sub.sessionId, sub);
    console.log(
      `[event-bus] SUBSCRIBE session=${sub.sessionId} user=${sub.userId} → total=${this.subscribers.size}`,
    );
    return () => {
      // Only delete if the same Subscriber is still registered — protects
      // against a stale unsubscribe (e.g. a reconnect replaced the entry
      // before the old `close` handler fired).
      if (this.subscribers.get(sub.sessionId) === sub) {
        this.subscribers.delete(sub.sessionId);
        console.log(
          `[event-bus] UNSUBSCRIBE session=${sub.sessionId} user=${sub.userId} → total=${this.subscribers.size}`,
        );
      }
    };
  }

  /**
   * Snapshot of every event in the ring buffer strictly newer than
   * `lastSeenId` that this `sub` would have received if it had been
   * subscribed at the time. Used by the SSE route on reconnect:
   *
   *   - The client sends `Last-Event-ID: <n>` (browser does this
   *     automatically when an `EventSource` reconnects).
   *   - The route fetches `replayAfter(n, sub)` and emits each event
   *     before resuming live delivery.
   *
   * Returns `null` when the gap is larger than the buffer — the route
   * sends a `resync` event in that case and the client refetches everything.
   * "Gap is larger" is detected by checking whether the buffer's oldest id
   * is greater than `lastSeenId + 1` (i.e. we evicted events the client
   * needs to see).
   */
  replayAfter(lastSeenId: number, sub: Pick<Subscriber, 'userId' | 'getFocusedWorkspaceId'>): WorkflowEvent[] | null {
    // Empty buffer: a client that never saw anything (lastSeenId === 0) has
    // nothing to replay and the empty array is correct. A client that DID
    // see events (lastSeenId > 0) but reached an empty buffer means the
    // process restarted — the id counter reset to 1, so anything the client
    // saw before is unreachable. Force a `resync` rather than silently
    // delivering nothing.
    if (this.buffer.length === 0) {
      return lastSeenId === 0 ? [] : null;
    }
    const oldestBufferedId = this.buffer[0]!.id;
    const newestBufferedId = this.buffer[this.buffer.length - 1]!.id;
    if (oldestBufferedId > lastSeenId + 1) {
      return null; // Caller emits a `resync`.
    }
    // Process restart can also leave `lastSeenId` ahead of the buffer's
    // newest id (counter reset → newer events have lower ids than what the
    // client last saw). Same outcome: client must resync from scratch.
    if (lastSeenId > newestBufferedId) {
      return null;
    }
    const tail = this.buffer.filter((e) => e.id > lastSeenId);
    return tail.filter((e) => this.matches(e, sub));
  }

  /** Subscriber count — exposed for `/health` and tests. */
  size(): number {
    return this.subscribers.size;
  }

  /**
   * Filter rule that decides whether `event` should reach `sub`:
   *
   *   - Workspace-scoped events: only sessions currently focused on the
   *     same `workspaceId`.
   *   - User-scoped events: only sessions whose `userId` matches `forUserId`.
   *   - Global events (heartbeat, resync, change-request-*): everyone.
   *
   * The focus check resolves through `getFocusedWorkspaceId()` so a session
   * that hasn't yet POSTed its focus gets no workspace events (correct —
   * we don't know what it cares about).
   */
  private matches(event: WorkflowEvent, sub: Pick<Subscriber, 'userId' | 'getFocusedWorkspaceId'>): boolean {
    if (isWorkspaceScoped(event)) {
      const focus = sub.getFocusedWorkspaceId();
      if (focus === null) return false;
      // **Normalise URL encoding before comparing.** The frontend stores
      // `workspace.id` as `encodeURIComponent(branch)` (e.g.
      // `razvan-radulescu%2Fsc`) and sends that as the focus value via
      // the POST /focus endpoint. The backend route handlers, however,
      // extract `req.params.id` which Express auto-decodes — so events
      // fire with `workspaceId = razvan-radulescu/sc`. Naïve `===` then
      // rejects every workspace-scoped event for any branch that
      // contains a `/`, silently dropping all live updates (lock state,
      // file-changed, fs-tree) on feature branches. Decoding both sides
      // collapses the two forms into the same canonical key.
      return canonicalize(focus) === canonicalize(event.workspaceId);
    }
    if (isUserScoped(event)) {
      return sub.userId === event.forUserId;
    }
    return true;
  }
}
