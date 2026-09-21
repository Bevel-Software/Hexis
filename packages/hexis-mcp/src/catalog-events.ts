/**
 * Hear about a catalog change instead of asking for one.
 *
 * `catalog-watch.ts` explains the problem: this process registered the
 * deployment's manuals ONCE, at startup, so a `.tool` or a `SKILL.md`
 * committed on the default branch is invisible here until something says
 * otherwise. Its answer is a check on activity — a listing, a finished call —
 * which is correct for a connection in use and says nothing at all to one
 * that is idle. A timer would cover the idle case and was tried twice; both
 * times it came out again, for a good reason: two seconds per idle connection
 * is a load that scales with laptops, and a deployment with fifty of them
 * would answer that question forever for nobody.
 *
 * A subscription settles it. This process opens ONE request the deployment
 * holds open and writes the caller's catalog fingerprint into whenever it
 * moves. An idle laptop asks nothing — it parks a socket — and still learns
 * of a commit in the same moment it lands, which is both cheaper than the
 * timer and faster than the check it replaces. The stream is OUTBOUND, so the
 * "nobody can push to this process" constraint in `catalog-watch.ts` still
 * holds: we are not being called, we are being answered slowly.
 *
 * THE CHECK STAYS. This is a shortcut, never the only road. A deployment too
 * old to serve the route, a proxy that will not carry an event stream, a
 * corporate middlebox that buffers it into uselessness — in every one of those
 * the activity checks are exactly what they were before, and the connection
 * behaves as it did. Nothing here is load-bearing for correctness; it is
 * load-bearing for latency.
 */
import { printable } from '@bevel-software/platform-mcp-core';
import type { HexisMcpConfig } from './config.js';

/**
 * How long to wait before reopening a stream that ended, doubling to
 * {@link RECONNECT_MAX_MS}. A deployment redeploying, a laptop waking from
 * sleep and a VPN reconnecting all look identical from here, and all three
 * resolve on their own in seconds — so start impatient.
 */
const RECONNECT_BASE_MS = 1_000;
/**
 * The ceiling. Thirty seconds is the cost of being wrong about a deployment
 * that is down for an hour: two requests a minute, refused cheaply. Lower
 * would be a poll by another name; higher would leave a laptop whose network
 * came back holding a stale toolset for minutes.
 */
const RECONNECT_MAX_MS = 30_000;

/**
 * A stream that is being read normally ends only when something went wrong,
 * but "normally" includes a proxy that closes every response after N seconds.
 * A reconnect that lasted at least this long is treated as a HEALTHY
 * connection that ended, so the backoff resets rather than climbing to thirty
 * seconds on a deployment that is perfectly fine.
 */
const HEALTHY_STREAM_MS = 20_000;

/** A running subscription. `stop()` is idempotent and never throws. */
export interface CatalogEventsSubscription {
  stop(): void;
}

export interface CatalogEventsOptions {
  config: HexisMcpConfig;
  /**
   * Called with every revision the deployment announces, including the one it
   * sends when the stream opens — which is what closes the gap between this
   * process's startup discovery and its subscription. Not deduplicated here:
   * the caller already knows which revision its toolset was built from, and
   * that is the only comparison that means anything.
   *
   * A rejection is swallowed (the caller logs its own failures) and the
   * subscription continues; the next announcement tries again.
   */
  onRevision: (revision: string) => void | Promise<void>;
  /** Where a notice goes. Defaults to stderr — the only stream this process may write. */
  log?: (message: string) => void;
  /** Overridable so a test does not wait a second to see a reconnect. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

/**
 * Open the subscription and keep it open. Returns immediately; everything
 * happens on the background loop.
 */
export function subscribeCatalogEvents(options: CatalogEventsOptions): CatalogEventsSubscription {
  const {
    config,
    onRevision,
    log = (message: string) => console.error(message),
    reconnectBaseMs = RECONNECT_BASE_MS,
    reconnectMaxMs = RECONNECT_MAX_MS,
  } = options;

  let stopped = false;
  let abort: AbortController | null = null;
  /** So a deployment that is down for an hour writes one line, not one per attempt. */
  let failing = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    // Aborting is what ends the read below; without it the loop would sit in
    // `reader.read()` until the deployment or the OS decided otherwise, and a
    // stdio server whose client hung up would not exit.
    abort?.abort();
    abort = null;
  };

  const reason = (err: unknown): string =>
    printable(err instanceof Error ? err.message : String(err));

  /**
   * Hand a revision to the caller, swallowing whatever it does with it.
   *
   * Inside a `try`, not behind a `.catch`: the handler may be an ordinary
   * function that throws before any promise exists, and that throw would
   * otherwise tear down the read — making ONE failed refresh cost this
   * connection every LATER change too. The caller reports its own failures
   * and keeps the change owed; nothing here needs to know.
   */
  const deliver = async (revision: string): Promise<void> => {
    try {
      await onRevision(revision);
    } catch {
      // Deliberately silent: see above.
    }
  };

  /**
   * One connection, read to its end. Returns when the stream closes for any
   * reason; throws only for a failure worth backing off from.
   */
  const readStream = async (): Promise<void> => {
    const controller = new AbortController();
    abort = controller;
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/api/agent/catalog-events`, {
        headers: {
          // Read FRESH, not captured: a renewal may have replaced the key
          // since the last attempt, and reopening with the retired one is how
          // a subscription would 401 forever on a perfectly good deployment.
          Authorization: `Bearer ${config.connectionKey}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      });
    } catch (err) {
      // An abort during teardown is not a failure to report.
      if (stopped) return;
      throw err;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`the workspace answered ${res.status} for the catalog event stream`);
    }
    if (!res.body) throw new Error('the catalog event stream carried no body');
    if (failing) {
      failing = false;
      log('[hexis-mcp] the workspace is streaming catalog changes again.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) return;
        buffer += decoder.decode(value, { stream: true });
        // Frames are separated by a blank line. Anything after the last one
        // is a partial frame and stays in the buffer — a fingerprint split
        // across two TCP reads is ordinary, not an error.
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const revision = revisionOfFrame(frame);
          // Awaited, so two announcements in quick succession cannot have
          // their refreshes overlap: the caller serialises, but only if we
          // give it the chance to.
          if (revision !== null && !stopped) await deliver(revision);
          boundary = buffer.indexOf('\n\n');
        }
        // A deployment (or something in front of it) that streams without
        // ever ending a frame must not grow this without bound. Far above any
        // real frame — a fingerprint is 32 hex characters — so reaching it
        // means the other end is not speaking SSE at all.
        if (buffer.length > 64 * 1024) throw new Error('the catalog event stream sent an oversized frame');
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };

  const loop = async (): Promise<void> => {
    let backoff = reconnectBaseMs;
    while (!stopped) {
      const startedAt = Date.now();
      try {
        await readStream();
        // A clean end is still an end: a proxy's idle timeout, a deployment
        // restarting gracefully. Reopen on the same ladder as a failure.
      } catch (err) {
        if (stopped) return;
        if (!failing) {
          failing = true;
          log(
            `[hexis-mcp] the workspace's catalog change stream dropped: ${reason(err)} ` +
              'Reconnecting; tools added meanwhile appear at this connection\'s next use until it is back.',
          );
        }
      }
      if (stopped) return;
      // A stream that lived a while was HEALTHY — it ended because something
      // between here and the deployment caps connection lifetimes, not
      // because the deployment is unwell — so the next attempt starts
      // impatient again instead of inheriting an old failure's backoff.
      if (Date.now() - startedAt >= HEALTHY_STREAM_MS) backoff = reconnectBaseMs;
      await unrefSleep(backoff);
      backoff = Math.min(backoff * 2, reconnectMaxMs);
    }
  };

  void loop();

  return { stop };
}

/**
 * The revision inside one SSE frame, or `null` for a frame that carries none —
 * a keep-alive comment, an event of a kind this version does not know, a body
 * whose shape drifted. Unknown is NOT a change: a subscriber that read an
 * absent field as a new revision would re-register the whole toolset on every
 * heartbeat.
 */
function revisionOfFrame(frame: string): string | null {
  const data = frame
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    // Comments (`:` first) are the keep-alive, and `event:`/`id:` are not
    // ours to interpret — only `data:` carries a payload.
    .filter((line) => line.startsWith('data:'))
    // The spec strips ONE optional leading space after the colon, and joins
    // multiple data lines with a newline.
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    const revision = (JSON.parse(data) as { revision?: unknown })?.revision;
    return typeof revision === 'string' && revision.length > 0 ? revision : null;
  } catch {
    return null;
  }
}

/**
 * A sleep that cannot keep the process alive. A stdio server whose client has
 * hung up exits when its work is done, and a pending reconnect timer is not
 * work.
 */
function unrefSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
