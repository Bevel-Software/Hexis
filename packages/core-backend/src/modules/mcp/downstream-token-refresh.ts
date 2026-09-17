/**
 * Refresh-and-retry for proxied third-party MCP servers (`mcp.json` manuals)
 * that reject the caller's OAuth token.
 *
 * The vault refreshes a token when its STORED expiry says so. A provider can
 * disagree — a token revoked early, an expiry the provider never stated, a
 * clock that drifted — and then the downstream answers 401 / `invalid_token`
 * while the vault still believes the token is good. The proxy reacts to that
 * rejection: one forced refresh for (user, manual), one retry of the call, and
 * the caller sees only the final outcome.
 *
 * Two pieces live here, both pure of the proxy so they are testable alone: the
 * rejection classifier, and the guard that allows one refresh per (user,
 * manual) per minute so a broken grant can never loop the provider.
 */

/** How far up a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 8;

/** The minimum spacing between two forced refreshes of one (user, manual). */
export const DOWNSTREAM_REFRESH_WINDOW_MS = 60_000;

/**
 * Did the downstream reject the credential itself — 401 or an `invalid_token`
 * error — as opposed to anything else that can go wrong with a call?
 *
 * Two shapes reach here. A failed CALL keeps the MCP SDK's
 * `StreamableHTTPError`, whose `code` is the HTTP status. A failed
 * REGISTRATION is flattened to prose by `@utcp/mcp`
 * (`Server 'srv': Streamable HTTP error: Error POSTing to endpoint: <body>`),
 * where the status is gone and only the response body is left to read.
 *
 * 403 is deliberately NOT a rejection: it means the token is valid but not
 * permitted, and a refreshed token carries the same permissions.
 */
export function isDownstreamTokenRejection(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current === 'string') return saysTokenRejected(current);
    if (typeof current !== 'object') return false;
    const e = current as Record<string, unknown>;
    // `code` doubles as a JSON-RPC code in the SDK (negative), so only a value
    // in the HTTP range can be read as a status.
    for (const field of ['code', 'status', 'statusCode'] as const) {
      if (e[field] === 401) return true;
    }
    const responseStatus = (e.response as { status?: unknown } | undefined)?.status;
    if (responseStatus === 401) return true;
    if (typeof e.message === 'string' && saysTokenRejected(e.message)) return true;
    current = e.cause;
  }
  return false;
}

function saysTokenRejected(message: string): boolean {
  const m = message.toLowerCase();
  // A status number inside a URL (`/v1/401/…`, a port) proves nothing.
  const scrubbed = m.replace(/\bhttps?:\/\/\S+/g, ' ');
  return (
    /\b401\b/.test(scrubbed) ||
    m.includes('invalid_token') ||
    m.includes('invalid token') ||
    m.includes('unauthorized')
  );
}

/**
 * At most one refresh per key per window, single-flight within it.
 *
 * The first rejection in a window runs the refresh; rejections that arrive
 * WHILE it runs (a burst of calls failing against the same dead token) share
 * its outcome instead of being refused, so a burst doesn't turn into one
 * success and N-1 failures. A rejection after the refresh settled but inside
 * the window gets `undefined` — no refresh, the call's own error stands —
 * which is what bounds a grant the provider keeps refreshing but the
 * downstream keeps refusing to one refresh a minute.
 */
export class DownstreamRefreshGuard<T> {
  private readonly attempts = new Map<string, { startedAt: number; outcome: Promise<T>; settled: boolean }>();

  constructor(
    private readonly windowMs: number = DOWNSTREAM_REFRESH_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Run `refresh` for `key` unless the window forbids it; `undefined` when it does. */
  run(key: string, refresh: () => Promise<T>): Promise<T> | undefined {
    const at = this.now();
    this.prune(at);
    const existing = this.attempts.get(key);
    if (existing) return existing.settled ? undefined : existing.outcome;
    const record = { startedAt: at, outcome: Promise.resolve() as Promise<unknown> as Promise<T>, settled: false };
    record.outcome = (async () => {
      try {
        return await refresh();
      } finally {
        record.settled = true;
      }
    })();
    this.attempts.set(key, record);
    return record.outcome;
  }

  /** Forget attempts whose window is over, so the map is bounded by recent (user, manual) pairs. */
  private prune(at: number): void {
    for (const [key, record] of this.attempts) {
      if (record.settled && at - record.startedAt >= this.windowMs) this.attempts.delete(key);
    }
  }
}
