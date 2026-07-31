/**
 * SSE event-bus HTTP surface.
 *
 *   GET  /api/events?session=<sessionId>     — open the long-lived SSE stream
 *   POST /api/events/:sessionId/focus        — update which workspace this
 *                                              session cares about (changes
 *                                              over the connection's lifetime
 *                                              as the user / agent switches
 *                                              branches)
 *
 * **Why a per-tab session id, not per-workspace** — the connection must
 * survive a workspace re-focus (when the user navigates between branches
 * the URL changes and the workspace bootstrap rebinds `workspaceId`, but
 * the EventSource stays open). So scope = `(userId, sessionId)`; the
 * "what workspace events do I want" state is mutable and lives in the
 * focus endpoint above.
 *
 * **Auth** — the SSE route can't read `Authorization: Bearer …` (the
 * browser's EventSource API can't set headers), so the auth middleware
 * also accepts the JWT from the `bevel_token` cookie set at login. The
 * focus POST goes through the regular auth middleware too, and verifies
 * that the cookie-authed user matches the session's owner.
 *
 * **Reconnect** — the browser's EventSource auto-reconnects on close
 * (~3 s backoff). On reconnect it sends `Last-Event-ID: <n>` and the
 * route replays anything still in the bus's ring buffer; if the buffer
 * has evicted past `n`, the route emits `{ kind: 'resync' }` so the
 * client refetches state from scratch.
 *
 * **Heartbeat** — every 25 s the route writes an SSE comment (`:\n\n`).
 * Keeps proxies (nginx, Coolify's Traefik, Cloudflare) from killing the
 * connection as idle. Cheap (~15 bytes), eliminates a whole class of bug.
 */

import type { Request, Response } from 'express';
import express from 'express';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import type { WorkflowEventBus } from './event-bus.js';
import '../auth/auth.middleware.js'; // Express Request augmentation

/** Interval between SSE keep-alive comments (ms). 25 s sits comfortably under
 * the typical 30–100 s proxy idle timeout. */
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * Per-session bookkeeping the route owns. The bus's `Subscriber` holds a
 * `getFocusedWorkspaceId()` getter pointing at `session.focusedWorkspaceId`,
 * so the focus POST mutates this object and the next event fan-out picks
 * up the new value with no re-subscribe.
 */
interface ActiveSession {
  sessionId: string;
  userId: string;
  focusedWorkspaceId: string | null;
  /** Set when the SSE connection closes. Used by the focus POST so a
   *  request that arrives after the connection drops 404s cleanly. */
  closed: boolean;
  /** The Express response stream backing this session. Stored so a
   *  same-id reconnect can `end()` the old response and close its TCP
   *  socket immediately, rather than leaving a dangling connection that
   *  silently accumulates server-side resources. */
  res: Response;
  /** Tear down bus subscription + heartbeat. Stored on the session so a
   *  same-id reconnect can run cleanup directly rather than relying on
   *  the old `res.on('close')` path (which short-circuits if we mark the
   *  session closed before the OS-level close event fires). */
  cleanup: () => void;
}

export function createEventsRoutes(
  bus: WorkflowEventBus,
  authMiddleware: express.RequestHandler,
): express.Router {
  const router = express.Router();

  /**
   * Process-wide session registry. The same map services the SSE open
   * (creates the entry) and the focus POST (mutates `focusedWorkspaceId`).
   * Entries clear when the SSE connection closes.
   */
  const sessions = new Map<string, ActiveSession>();

  router.get('/events', authMiddleware, (req, res) => {
    const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
    if (!sessionId) {
      res.status(400).json({ error: 'session query parameter is required' });
      return;
    }
    const userId = req.userId!;

    // SSE headers. `X-Accel-Buffering: no` tells nginx not to buffer the
    // response (would batch events behind a flush boundary, killing
    // latency). `Cache-Control: no-cache` + omitted `Content-Length`
    // signal "long-lived stream, don't cache."
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // If a previous session with the same id is still registered (e.g.
    // browser refresh that reuses sessionStorage), close it gracefully
    // before we replace it. Two SSE streams for one session id would
    // double-fire every event to that browser. We also `end()` the old
    // response so the underlying TCP socket goes away immediately —
    // without that, the previous `res` lingers in keep-alive state
    // until the network times it out (minutes), wasting an FD per
    // refresh.
    const existing = sessions.get(sessionId);
    if (existing && !existing.closed) {
      // Tear down the bus subscription + heartbeat FIRST, then mark
      // closed, then end the response. Order matters: marking `closed`
      // before cleanup would make the OS-close handler's own cleanup
      // short-circuit (it returns early on `closed`), leaking the
      // subscriber + heartbeat for this session id forever.
      try {
        existing.cleanup();
      } catch (err) {
        console.warn(
          `[events] supersede cleanup threw for session=${sessionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
      existing.closed = true;
      try {
        if (!existing.res.writableEnded) existing.res.end();
      } catch (err) {
        console.warn(
          `[events] failed to end superseded SSE response for session=${sessionId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const session: ActiveSession = {
      sessionId,
      userId,
      focusedWorkspaceId: null,
      closed: false,
      res,
      // Filled in below once `unsubscribe` + `heartbeat` exist.
      cleanup: () => {},
    };
    sessions.set(sessionId, session);

    const push = (event: WorkflowEvent): void => {
      if (session.closed) return;
      writeSseEvent(res, event);
    };

    const unsubscribe = bus.subscribe({
      sessionId,
      userId,
      getFocusedWorkspaceId: () => session.focusedWorkspaceId,
      push,
    });

    // Replay anything the client missed since their last seen id. Browsers
    // auto-send `Last-Event-ID` when EventSource reconnects, so this just
    // works — no client cooperation needed beyond using the standard API.
    const lastSeenHeader = req.headers['last-event-id'];
    const lastSeenId = typeof lastSeenHeader === 'string' ? Number(lastSeenHeader) : NaN;
    if (Number.isFinite(lastSeenId) && lastSeenId > 0) {
      const replay = bus.replayAfter(lastSeenId, {
        userId,
        getFocusedWorkspaceId: () => session.focusedWorkspaceId,
      });
      if (replay === null) {
        // Buffer evicted past `lastSeenId` — client must refetch from
        // scratch rather than trust a partial replay.
        writeSseEvent(res, {
          id: 0,
          ts: new Date().toISOString(),
          kind: 'resync',
          reason: 'last-event-id too old; ring buffer evicted',
        });
      } else {
        for (const event of replay) writeSseEvent(res, event);
      }
    }

    const heartbeat = setInterval(() => {
      if (session.closed) return;
      // SSE comments start with `:` and are ignored by the EventSource
      // parser. Cheapest possible keep-alive payload.
      res.write(': heartbeat\n\n');
    }, HEARTBEAT_INTERVAL_MS);

    const cleanup = () => {
      if (session.closed) return;
      session.closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      // Only delete if we're still the registered session — a reconnect
      // for the same id may have already replaced us.
      if (sessions.get(sessionId) === session) {
        sessions.delete(sessionId);
      }
    };
    session.cleanup = cleanup;

    res.on('close', cleanup);
    res.on('error', cleanup);

    console.log(`[events] open session=${sessionId} user=${userId} subscribers=${bus.size()}`);
  });

  router.post('/events/:sessionId/focus', authMiddleware, express.json(), (req, res) => {
    const sessionId = String(req.params.sessionId ?? '');
    const userId = req.userId!;
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId is required' });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session || session.closed) {
      // 404 is the cleanest signal — the client should open a new SSE
      // stream and POST focus again on success. (Browser EventSource
      // auto-reconnects, so this should be rare in practice.)
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    if (session.userId !== userId) {
      // Hard 403 — a user must never be able to set focus on another
      // user's session, which would let them mirror that user's events
      // into their own connection. Belt-and-braces; cookie auth already
      // gates which userId reaches this handler.
      res.status(403).json({ error: 'Session belongs to another user' });
      return;
    }
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: unknown };
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      res.status(400).json({ error: 'workspaceId is required in body' });
      return;
    }
    const previous = session.focusedWorkspaceId;
    session.focusedWorkspaceId = workspaceId;
    console.log(
      `[events] FOCUS session=${sessionId} user=${userId} ${previous ?? '(none)'} → ${workspaceId}`,
    );
    res.json({ status: 'ok', focusedWorkspaceId: workspaceId });
  });

  return router;
}

/**
 * Serialise `event` into the SSE wire format. Each frame is:
 *
 *   id: <event.id>
 *   data: <JSON payload>
 *   \n
 *
 * The `id` field is what the browser's EventSource exposes as
 * `event.lastEventId` and re-sends as `Last-Event-ID` on reconnect.
 * Data is a single line of JSON — never embedded newlines, which would
 * break the SSE parser. JSON.stringify guarantees that.
 */
function writeSseEvent(res: Response, event: WorkflowEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Re-exported so tests / future hooks can construct the response shape. */
export { writeSseEvent as _writeSseEventForTests };
export type { ActiveSession };
