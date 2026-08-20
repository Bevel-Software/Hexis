import type { HexisMcpConfig } from './config.js';

/**
 * The ONE renewal mechanism for an OAuth-mode bearer. Three problems, one
 * design, because they are the same problem — "who may run the refresh, and
 * who learns its result":
 *
 *  1. SINGLE-FLIGHT. The refresh token ROTATES on every grant, so two
 *     concurrent renewals are not merely wasteful — the loser presents a
 *     refresh token the winner just retired and gets `invalid_grant`, killing
 *     a perfectly healthy sign-in. Startup does exactly this (`Promise.all`
 *     over two REST reads, both 401ing at once), and mid-run tool calls can
 *     race the same way. So there is ONE in-flight renewal per config; every
 *     caller awaits the same promise and shares its outcome, failure included.
 *
 *  2. PROACTIVE. The REST reads recover from an expired bearer reactively
 *     (401 → renew → retry), but the remote manual's MCP transport does NOT
 *     go through that path — its session captured the bearer as a header at
 *     registration, and when the token expires every remote tool dies until
 *     restart. So each successful exchange schedules the next renewal at
 *     ~80% of the granted lifetime, on an `unref()`d timer that never holds
 *     the process open.
 *
 *  3. NOTIFICATION. A fresh bearer is useless to the remote manual unless
 *     someone re-registers it. `config.onConnectionKeyRenewed` (set by the
 *     server once it exists) is called on EVERY successful renewal — timer- or
 *     401-triggered alike — so the transport swap has exactly one trigger.
 *
 * Key mode never arrives here: `config.renewConnectionKey` is unset, the
 * schedule call refuses to arm, and `renewConnectionKeyNow` is never consulted
 * (deployment.ts's `renewer` returns undefined first).
 */

/** Renew when this fraction of the granted lifetime has elapsed. */
export const RENEWAL_FRACTION = 0.8;

/**
 * A failed proactive renewal retries on this cadence. Deliberately short of
 * any plausible token lifetime: the reactive 401 path also keeps trying, but
 * only REST reads travel that path — the remote manual's transport depends on
 * this timer alone.
 */
export const RETRY_AFTER_FAILURE_MS = 60_000;

// WeakMaps rather than fields on the config: HexisMcpConfig is a public shape
// assembled by callers (and tests) as object literals, and the renewal state
// is this module's private business, not part of that contract.
const inflight = new WeakMap<HexisMcpConfig, Promise<string>>();
const timers = new WeakMap<HexisMcpConfig, NodeJS.Timeout>();

/**
 * Run one renewal — or join the one already running. On success the config's
 * `connectionKey` is swapped, the next proactive renewal is armed from the
 * grant's own lifetime, and the credential listener is notified. On failure
 * every joined caller sees the same rejection, and a retry is armed so the
 * remote manual is not left to die quietly.
 */
export function renewConnectionKeyNow(config: HexisMcpConfig): Promise<string> {
  const existing = inflight.get(config);
  if (existing) return existing;
  const renew = config.renewConnectionKey;
  if (!renew) {
    return Promise.reject(new Error('This configuration has no renewal (key mode).'));
  }
  const run = (async (): Promise<string> => {
    const grant = await renew();
    config.connectionKey = grant.token;
    scheduleProactiveRenewal(config, grant.expiresInMs);
    // The swap listener runs INSIDE the single flight, so a renewal is not
    // "done" until the remote manual had its chance to pick the token up —
    // but its failure must not fail the renewal: the fresh bearer is real and
    // every REST caller can use it regardless.
    try {
      await config.onConnectionKeyRenewed?.(grant.token);
    } catch (err) {
      console.error(
        `[hexis-mcp] applying the renewed credential failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return grant.token;
  })();
  const shared = run.finally(() => {
    if (inflight.get(config) === shared) inflight.delete(config);
  });
  inflight.set(config, shared);
  return shared;
}

/**
 * Arm (or re-arm) the proactive renewal at ~80% of the granted lifetime.
 * Called with the initial exchange's `expiresInMs` at startup and with each
 * renewal's thereafter. No lifetime reported = no timer: the deployment is too
 * old to say, and reactive renewal still covers the REST surface.
 */
export function scheduleProactiveRenewal(config: HexisMcpConfig, expiresInMs?: number): void {
  cancelProactiveRenewal(config);
  if (!config.renewConnectionKey) return;
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0) return;
  armTimer(config, Math.max(1_000, Math.round(expiresInMs * RENEWAL_FRACTION)));
}

/** Disarm the timer — shutdown hygiene; it is unref()d and never holds the process anyway. */
export function cancelProactiveRenewal(config: HexisMcpConfig): void {
  const timer = timers.get(config);
  if (timer) clearTimeout(timer);
  timers.delete(config);
}

function armTimer(config: HexisMcpConfig, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(config);
    renewConnectionKeyNow(config).catch((err: unknown) => {
      console.error(
        `[hexis-mcp] proactive credential renewal failed: ${err instanceof Error ? err.message : String(err)} — ` +
          `retrying in ${Math.round(RETRY_AFTER_FAILURE_MS / 1000)}s (a 401 on the REST surface also retries).`,
      );
      // A success inside the failed attempt could not have re-armed (it did
      // not happen), so this retry is the only next attempt — unless a 401
      // path renews first, whose success re-arms from the fresh grant and
      // cancels this retry via scheduleProactiveRenewal.
      armTimer(config, RETRY_AFTER_FAILURE_MS);
    });
  }, delayMs);
  timer.unref?.();
  timers.set(config, timer);
}
