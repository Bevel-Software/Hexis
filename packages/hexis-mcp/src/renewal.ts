import { SignInRefusedError, type HexisMcpConfig, type RenewedGrant } from './config.js';

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
 *  4. A SIGN-IN REFUSED FOR GOOD. A `SignInRefusedError` from the renewal is
 *     the workspace saying the refresh token is unknown, revoked or expired,
 *     after the store was re-read for a newer one, or rejecting a freshly
 *     granted access token at the local-token exchange (oauth.ts). Retrying the
 *     same dead token on a timer only fills the workspace's log, so the
 *     config is marked ENDED: the sentence is said once on stderr, handed to
 *     `config.onSignInEnded`, no timer is re-armed, and every later renewal
 *     (a 401 on the REST surface included) is refused here without a request.
 *     Any other failure (network, 5xx) is still retried as below.
 *
 * Key mode never arrives here: `config.renewConnectionKey` is unset, the
 * schedule call refuses to arm, and `renewConnectionKeyNow` is never consulted
 * (deployment.ts's `renewer` returns undefined first).
 */

/** Renew when this fraction of the granted lifetime has elapsed. */
export const RENEWAL_FRACTION = 0.8;

/**
 * A failed proactive renewal retries on this cadence, unless it failed with a
 * `SignInRefusedError`, which is never retried. Deliberately short of
 * any plausible token lifetime: the reactive 401 path also keeps trying, but
 * only REST reads travel that path — the remote manual's transport depends on
 * this timer alone.
 */
export const RETRY_AFTER_FAILURE_MS = 60_000;

/**
 * setTimeout's ceiling (2^31-1 ms): Node treats anything above it as 1ms, so a
 * deployment granting a lifetime past ~24.8 days would turn the proactive
 * timer into a millisecond-cadence renewal loop. Renewing far EARLIER than 80%
 * is always safe; the clamp trades precision for that safety.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// WeakMaps rather than fields on the config: HexisMcpConfig is a public shape
// assembled by callers (and tests) as object literals, and the renewal state
// is this module's private business, not part of that contract.
const inflight = new WeakMap<HexisMcpConfig, Promise<string>>();
const timers = new WeakMap<HexisMcpConfig, NodeJS.Timeout>();
// Every cancel bumps the generation (a re-arm cancels first, so arming epochs
// count too). An attempt that was IN FLIGHT when its arming was revoked can
// then tell: it neither re-arms a timer nor notifies the credential listener —
// otherwise shutdown's cancel could be re-armed out of by a renewal it could
// not see.
const generations = new WeakMap<HexisMcpConfig, number>();
// The generation only revokes attempts that were IN FLIGHT when a cancel
// landed; an attempt STARTING afterwards (a REST call's 401-retry racing
// shutdown) captures the post-cancel generation and would renew and re-arm
// into a torn-down world. `closeRenewal` marks the config closed FOR GOOD —
// one config is one process lifecycle — and closed configs refuse to start
// renewals or arm timers at all. The ordinary re-arm cancel never sets this,
// so the reactive 401 path keeps working through normal operation.
const closedConfigs = new WeakSet<HexisMcpConfig>();
// A config whose sign-in the workspace refused for good, with the refusal
// every later renewal is answered with. Final, like a close.
const endedConfigs = new WeakMap<HexisMcpConfig, SignInRefusedError>();

function generationOf(config: HexisMcpConfig): number {
  return generations.get(config) ?? 0;
}

/**
 * Run one renewal — or join the one already running. On success the config's
 * `connectionKey` is swapped, the next proactive renewal is armed from the
 * grant's own lifetime, and the credential listener is notified. On failure
 * every joined caller sees the same rejection, and a retry is armed so the
 * remote manual is not left to die quietly — except for a
 * `SignInRefusedError`, which ends renewal for good and arms nothing.
 */
export function renewConnectionKeyNow(config: HexisMcpConfig): Promise<string> {
  const existing = inflight.get(config);
  if (existing) return existing;
  const ended = endedConfigs.get(config);
  if (ended) return Promise.reject(ended);
  if (closedConfigs.has(config)) {
    // A flight that was already up when the close landed still completes (its
    // joiners can use the grant); a NEW flight after close would rotate the
    // stored refresh token and re-arm a timer for a server that is gone.
    return Promise.reject(new Error('This configuration has been shut down — no further renewals.'));
  }
  const renew = config.renewConnectionKey;
  if (!renew) {
    return Promise.reject(new Error('This configuration has no renewal (key mode).'));
  }
  // Captured BEFORE the exchange: a cancel that lands while it is in flight
  // (shutdown) revokes the re-arm and the notification below — the fresh
  // bearer itself is still swapped in and returned, because every caller
  // already awaiting this flight can legitimately use it.
  const generation = generationOf(config);
  const run = (async (): Promise<string> => {
    let grant: RenewedGrant;
    try {
      grant = await renew();
    } catch (err) {
      if (err instanceof SignInRefusedError) endSignIn(config, err, generation);
      throw err;
    }
    config.connectionKey = grant.token;
    if (generationOf(config) === generation) {
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
  if (closedConfigs.has(config) || endedConfigs.has(config)) return;
  cancelProactiveRenewal(config);
  if (!config.renewConnectionKey) return;
  if (typeof expiresInMs !== 'number' || !Number.isFinite(expiresInMs) || expiresInMs <= 0) return;
  armTimer(config, Math.max(1_000, Math.round(expiresInMs * RENEWAL_FRACTION)));
}

/**
 * Disarm the timer — re-arm hygiene (every `scheduleProactiveRenewal` cancels
 * first); it is unref()d and never holds the process anyway. Also revokes any
 * IN-FLIGHT attempt's right to re-arm or notify (see the generation note
 * above): a renewal racing shutdown must not schedule a retry, or apply a
 * credential swap, into a world that is closing. NOT final — a later renewal
 * may start and re-arm; teardown wants `closeRenewal`.
 */
export function cancelProactiveRenewal(config: HexisMcpConfig): void {
  const timer = timers.get(config);
  if (timer) clearTimeout(timer);
  timers.delete(config);
  generations.set(config, generationOf(config) + 1);
}

/**
 * The FINAL cancel — teardown's entry. Everything `cancelProactiveRenewal`
 * does, plus the config is marked closed for good: a renewal that STARTS after
 * this point (a straggling REST call's 401-retry racing shutdown) is refused
 * outright instead of renewing and re-arming the timer into a torn-down world.
 * Irreversible by design — a config is one process lifecycle, and nothing
 * legitimately renews for a server that shut down.
 */
export function closeRenewal(config: HexisMcpConfig): void {
  closedConfigs.add(config);
  cancelProactiveRenewal(config);
}

/**
 * Stop renewing for good and say why, once: on stderr, and to the server's
 * listener (unless a cancel revoked this attempt's right to notify, as for a
 * success). Only the first flight to fail this way gets here; every later one
 * is refused before it starts.
 */
function endSignIn(config: HexisMcpConfig, err: SignInRefusedError, generation: number): void {
  endedConfigs.set(config, err);
  const notify = generationOf(config) === generation;
  cancelProactiveRenewal(config);
  console.error(`[hexis-mcp] ${err.message}`);
  if (!notify) return;
  try {
    config.onSignInEnded?.(err.message);
  } catch (listenerErr) {
    console.error(
      `[hexis-mcp] reporting the refused sign-in failed: ${listenerErr instanceof Error ? listenerErr.message : String(listenerErr)}`,
    );
  }
}

function armTimer(config: HexisMcpConfig, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(config);
    const generation = generationOf(config);
    renewConnectionKeyNow(config).catch((err: unknown) => {
      // Refused for good: already said once, and never worth another request.
      if (err instanceof SignInRefusedError) return;
      console.error(
        `[hexis-mcp] proactive credential renewal failed: ${err instanceof Error ? err.message : String(err)} — ` +
          `retrying in ${Math.round(RETRY_AFTER_FAILURE_MS / 1000)}s (a 401 on the REST surface also retries).`,
      );
      // A success inside the failed attempt could not have re-armed (it did
      // not happen), so this retry is the only next attempt — unless a 401
      // path renews first, whose success re-arms from the fresh grant and
      // cancels this retry via scheduleProactiveRenewal. A cancel that landed
      // while the attempt was pending revokes the retry outright.
      if (generationOf(config) === generation) armTimer(config, RETRY_AFTER_FAILURE_MS);
    });
  }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
  timer.unref?.();
  timers.set(config, timer);
}
