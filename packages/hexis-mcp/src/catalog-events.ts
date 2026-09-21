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
import { renewConnectionKeyNow } from './renewal.js';

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

/**
 * The blank line that ends an SSE frame — in every line ending the spec
 * allows, not just the one our own deployment writes.
 *
 * A line may end with CRLF, LF or CR, so a frame boundary is any TWO of those
 * in a row. Scanning for `\n\n` alone found nothing in a CRLF stream — the
 * bytes there are `\r\n\r\n`, which contains no `\n\n` — so every frame
 * stayed in the buffer until it hit the oversize cap, and the subscription
 * reconnected forever without ever delivering a revision. A proxy that
 * rewrites line endings is enough to produce that, so the parser has to read
 * what the spec permits rather than what we happen to send.
 *
 * Listed longest-first, and deliberately WITHOUT `\r\n` on its own: that is
 * one line ending, not two, and matching it would split every single line of
 * a CRLF stream into its own frame. `\r\n\r` is left out for the opposite
 * reason — it is the first three bytes of `\r\n\r\n`, and treating it as a
 * boundary would cut a frame in half whenever a read happened to end there.
 */
const FRAME_BOUNDARY = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/;

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
    const open = (bearer: string): Promise<Response> =>
      fetch(`${config.baseUrl}/api/agent/catalog-events`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
    let res: Response;
    try {
      // Read FRESH, not captured: a renewal may have replaced the key since
      // the last attempt, and reopening with the retired one is how a
      // subscription would 401 forever on a perfectly good deployment.
      res = await open(config.connectionKey);
      // OAUTH MODE'S EXPIRED BEARER. Every other request this process makes
      // recovers from a 401 by renewing and retrying (`deployment.ts`), and
      // this one has to as well — it is the ONLY request an idle connection
      // makes, so nothing else would ever trigger the renewal on its behalf.
      // Without this, a grant whose lifetime the deployment did not state
      // (no `expiresInMs`, so no proactive timer either) leaves the stream
      // reconnecting forever with a retired key, and the connection silently
      // stops hearing about changes.
      //
      // Through the SINGLE FLIGHT, never `config.renewConnectionKey`
      // directly: the refresh token rotates, and a second renewal racing a
      // tool call's would present a just-retired one and kill the sign-in.
      // ONE retry — a second 401 is an authorization that is gone, which no
      // amount of refreshing fixes, so it falls through to the backoff below
      // where it is reported once. Key mode has no renewal at all and lands
      // there directly; its 401 is a revoked key, and the REST reads say so
      // in the words that path owns.
      if (res.status === 401 && config.renewConnectionKey) {
        await res.body?.cancel().catch(() => {});
        res = await open(await renewConnectionKeyNow(config));
      }
    } catch (err) {
      // An abort during teardown is not a failure to report, and neither is a
      // renewal refused because the config is shutting down.
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
        let boundary = FRAME_BOUNDARY.exec(buffer);
        while (boundary !== null) {
          const frame = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          const revision = revisionOfFrame(frame);
          // Awaited, so two announcements in quick succession cannot have
          // their refreshes overlap: the caller serialises, but only if we
          // give it the chance to.
          if (revision !== null && !stopped) await deliver(revision);
          boundary = FRAME_BOUNDARY.exec(buffer);
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
    // Every line ending the spec allows, for the same reason the boundary
    // scan reads all three.
    .split(/\r\n|\r|\n/)
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
