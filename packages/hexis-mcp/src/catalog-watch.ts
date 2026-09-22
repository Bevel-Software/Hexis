/**
 * Notice when the deployment's catalog changes, under a connection nobody can
 * push to.
 *
 * The hosted endpoint is stateless — every request there rebuilds its tool
 * surface from the live registry, so a manual committed a second ago is in the
 * next request's answer. This process is the opposite: it registered the
 * deployment's manuals ONCE, at startup, and the sessions it holds are what its
 * `tools/list` is built from. Without something checking, a `.tool` or a
 * `SKILL.md` added on the default branch is invisible here until someone
 * restarts the server.
 *
 * So: compare a fingerprint, and when it moved, tell the caller. The deployment
 * cannot call us (this is a stdio process behind whatever NAT its user is on)
 * and the MCP protocol has no upstream subscription — hence a check, and the
 * cheapest one possible: a single digest read.
 *
 * ON ACTIVITY, NOT ON A TIMER. A laptop with a connected client that nobody is
 * using would otherwise ask its deployment the same question every few seconds
 * for hours, and a deployment with fifty such laptops would answer it forever
 * for no one. The check runs when the connection does something — a tool call
 * finishing, a `tools/list` arriving — because that is exactly the moment a
 * stale toolset costs anything, and a listing awaits its check, so the list
 * handed back is the current one. Between two such moments nothing is asked:
 * an idle connection learns of a change at its next use, not before. (A
 * heartbeat was tried and taken out again: two seconds per idle connection
 * is a load that scales with laptops, for a notification nobody was waiting
 * on.) `server.ts` owns the trigger; this module decides what a check does.
 *
 * What this module contributes to the cost is the THROTTLE: two checks inside
 * one window collapse onto one digest read, so a chain of twenty calls costs
 * one check, not twenty.
 *
 * Errors are survivable by design. A deployment that restarts, a laptop that
 * sleeps, a VPN that drops: the check fails, says so ONCE, and asks again on
 * the next activity. The one unrecoverable answer is a deployment too old to
 * serve the route, which stops the checker for good.
 */
import { printable } from '@bevel-software/platform-mcp-core';
import {
  CatalogRevisionUnsupportedError,
  fetchCatalogRevision,
} from './deployment.js';
import type { HexisMcpConfig } from './config.js';

/**
 * The least time between two checks. A burst of activity — a `call_tool_chain`
 * fanning out into a dozen calls, a client re-listing right after a
 * notification — collapses onto one digest read; the second and later calls in
 * the window see the answer the first one got.
 *
 * It is also a CEILING ON STALENESS for a connection in use, which is what
 * sets its size. A check that runs just before a commit reads the old catalog
 * and opens a fresh window, so the change cannot be noticed until the window
 * expires; add the digest read and the re-registration and that is the whole
 * delay a person working on that connection experiences. At five seconds this
 * alone put the first sighting at ~7.6s against a deployment that had the
 * manual in ~1s. Two seconds keeps a busy connection to one small read per
 * window while a person who commits a manual and keeps calling tools sees it
 * on the next call after the window.
 *
 * The promise this window has to fit inside is ten seconds from the commit,
 * and it is not the only term spending it: the deployment needs its own
 * 2-3.5s to land the commit and drop its registry before there is anything
 * here to notice. `catalog-watch.test.ts` keeps that arithmetic, all three
 * terms of it, so shrinking the budget is a conversation with a failing test.
 */
export const CATALOG_CHECK_MIN_INTERVAL_MS = 2_000;

/** A running checker. `stop()` is idempotent and never throws. */
export interface CatalogCheck {
  /**
   * Compare the deployment's catalog to the one this process serves, and
   * refresh when they differ. Resolves when the check — and any refresh it
   * owed — has settled, so a caller that wants a FRESH answer (a `tools/list`)
   * can await it, and a caller that does not (a finished tool call) can let it
   * run. Never rejects: every failure is logged and carried to the next check.
   *
   * Throttled from the last check's START, not its finish: a call within
   * {@link CATALOG_CHECK_MIN_INTERVAL_MS} of the last check STARTING, or while
   * one is still running, joins that check instead of asking again. Counting
   * from the start keeps the window a cadence a budget can be computed from —
   * a refresh runs inside a check, so counting from the finish would add the
   * re-registration's seconds to every window.
   */
  check(): Promise<void>;
  stop(): void;
}

export interface CatalogCheckOptions {
  config: HexisMcpConfig;
  /**
   * The revision this process's current toolset was built from, if it is
   * known. When absent — a startup whose revision read failed — the first
   * successful check is treated as a CHANGE rather than as a baseline: nobody
   * can tell whether a commit landed between discovery and that check, and
   * one refresh of a catalog that turns out to be unchanged is much cheaper
   * than a tool that stays invisible until someone restarts the server.
   */
  initialRevision?: string | null;
  /** The least time between two checks; `0` means every call checks. */
  minIntervalMs?: number;
  /**
   * Called once per observed change, never concurrently with itself. A
   * rejection is logged and the checker continues, but the revision is NOT
   * recorded as applied — the change is still owed, so the next check attempts
   * it again until one succeeds.
   */
  onChanged: (revision: string) => void | Promise<void>;
  /** Where a notice goes. Defaults to stderr — the only stream this process may write. */
  log?: (message: string) => void;
  /**
   * The clock the throttle reads. Monotonic by default (`performance.now`):
   * the wall clock can be set back — a sleep, an NTP correction, a VM
   * migration — and a throttle stamped from it would then refuse every check
   * until the wall caught up with a timestamp from the future. Tests pass
   * their own.
   */
  now?: () => number;
}

/**
 * Create the checker. Nothing is asked until the first `check()`.
 */
export function createCatalogCheck(options: CatalogCheckOptions): CatalogCheck {
  const {
    config,
    initialRevision = null,
    minIntervalMs = CATALOG_CHECK_MIN_INTERVAL_MS,
    onChanged,
    log = (message: string) => console.error(message),
    now = () => performance.now(),
  } = options;

  let stopped = false;
  /**
   * The revision the toolset this process serves was built from — advanced
   * only when a refresh has actually SUCCEEDED, so a failed one is still owed
   * and the next check tries again.
   */
  let applied: string | null = initialRevision;
  /** False until a check has established what `applied` means. See `initialRevision`. */
  let baselineKnown = initialRevision !== null;
  /**
   * When the last check STARTED — the throttle counts from there, not from
   * when it settled.
   *
   * From the start, because the window has to be a cadence a delay can be
   * computed from. Counting from the settle adds the check's own duration to
   * every window, and a refresh runs INSIDE a check: one that re-registers
   * costs a couple of seconds, so a two-second window becomes four or more,
   * and a person calling tools right after a commit waits that much longer
   * for a throttle that has silently grown. `inFlight` already stops two
   * checks overlapping, so nothing here needs the settle to serialise them.
   */
  let lastStartedAt: number | null = null;
  /** The check in flight, so concurrent callers join it rather than stacking. */
  let inFlight: Promise<void> | null = null;
  /** So a deployment that is down for an hour writes one line, not one per call. */
  let failing = false;
  /** The same restraint for a refresh that keeps failing against a live deployment. */
  let refreshFailing = false;

  const stop = (): void => {
    stopped = true;
  };

  const reason = (err: unknown): string => printable(err instanceof Error ? err.message : String(err));

  const run = async (): Promise<void> => {
    let revision: string;
    try {
      revision = await fetchCatalogRevision(config);
    } catch (err) {
      if (err instanceof CatalogRevisionUnsupportedError) {
        stop();
        log(`[hexis-mcp] ${printable(err.message)}`);
        return;
      }
      if (!failing) {
        failing = true;
        log(
          `[hexis-mcp] could not check whether the workspace's tools changed: ${reason(err)} ` +
            'Will try again on the next call; tools added meanwhile appear once it answers.',
        );
      }
      return;
    }
    if (failing) {
      failing = false;
      log('[hexis-mcp] the workspace is answering again; its tools are being checked for changes.');
    }
    // A baseline that startup could not read is not "no change": a commit
    // between discovery and this check would be invisible forever if the
    // first reading were simply adopted. One refresh of an unchanged catalog
    // is the price of never silently dropping that commit.
    const owed = !baselineKnown || applied !== revision;
    // `stop()` can land while the fetch above is in flight — teardown is
    // exactly when it does. A handler called then would run against a server
    // that is already closing.
    if (owed && !stopped) {
      try {
        await onChanged(revision);
      } catch (err) {
        // `applied` stays where it was, so this revision is still owed and the
        // next check attempts it again. A re-registration fails for the
        // reasons everything else here fails — a deployment mid-restart, a
        // network that dropped — and those pass; suppressing the change for
        // good would leave the toolset stale until some LATER commit happened
        // to move the catalog again.
        if (!refreshFailing) {
          refreshFailing = true;
          log(
            `[hexis-mcp] refreshing the toolset after a workspace change failed: ${reason(err)} ` +
              'Retrying on the next call.',
          );
        }
        return;
      }
    }
    applied = revision;
    baselineKnown = true;
    refreshFailing = false;
  };

  const check = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    // A clock that went BACKWARD reads as an expired throttle, not a check
    // owed in the future: whatever the caller's clock is, a negative gap can
    // only mean it was adjusted, and refusing checks until it catches up would
    // hold the toolset stale for exactly the size of the adjustment.
    if (lastStartedAt !== null) {
      const sinceLast = now() - lastStartedAt;
      if (sinceLast >= 0 && sinceLast < minIntervalMs) return Promise.resolve();
    }
    lastStartedAt = now();
    inFlight = run()
      .catch((err: unknown) => {
        // `run` handles its own failures; this is the belt for a bug in it,
        // so a caller awaiting a check is never handed a rejection.
        log(`[hexis-mcp] the catalog check failed unexpectedly: ${reason(err)}`);
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return { check, stop };
}
