/**
 * Notice when the deployment's catalog changes, under a connection nobody can
 * push to.
 *
 * The hosted endpoint is stateless — every request there rebuilds its tool
 * surface from the live registry, so a manual committed a second ago is in the
 * next request's answer. This process is the opposite: it registered the
 * deployment's manual ONCE, at startup, and the MCP session it holds is what
 * its `tools/list` is built from. Without something watching, a `.tool` or a
 * `SKILL.md` added on the default branch is invisible here until someone
 * restarts the server.
 *
 * So: poll a fingerprint, and when it moves, tell the caller. The deployment
 * cannot call us (this is a stdio process behind whatever NAT its user is
 * on) and the MCP protocol has no upstream subscription, which leaves polling
 * as the only mechanism available — hence the cheapest possible request, one
 * digest, rather than re-fetching the manual list every few seconds.
 *
 * Errors are survivable by design. A deployment that restarts, a laptop that
 * sleeps, a VPN that drops: the poll fails, says so ONCE, and keeps asking.
 * The one unrecoverable answer is a deployment too old to serve the route,
 * which stops the watcher for good.
 */
import { printable } from '@bevel-software/platform-mcp-core';
import {
  CatalogRevisionUnsupportedError,
  fetchCatalogRevision,
} from './deployment.js';
import type { HexisMcpConfig } from './config.js';

/**
 * How often to ask. The contract the guide states is that a committed manual
 * is visible within five seconds, and this is the only delay between the
 * commit and a connected client being told — the rest is one HTTP round trip.
 * Three seconds leaves room for that round trip inside the budget while
 * costing a deployment one digest read per connected laptop per three
 * seconds — answered off the catalogs' own caches, except for the first poll
 * after a commit, which pays the same re-scan the next `list_tools` would
 * have paid anyway.
 */
export const CATALOG_POLL_INTERVAL_MS = 3_000;

/** A running watch. `stop()` is idempotent and never throws. */
export interface CatalogWatch {
  stop(): void;
}

export interface CatalogWatchOptions {
  config: HexisMcpConfig;
  /**
   * The revision this process's current toolset was built from, if it is
   * known. When absent — a startup whose revision read failed — the first
   * successful poll is treated as a CHANGE rather than as a baseline: nobody
   * can tell whether a commit landed between discovery and that poll, and one
   * refresh of a catalog that turns out to be unchanged is much cheaper than a
   * tool that stays invisible until someone restarts the server.
   */
  initialRevision?: string | null;
  /** Milliseconds between polls; `0` or less disables the watch entirely. */
  intervalMs?: number;
  /**
   * Called once per observed change, never concurrently with itself: the next
   * poll is scheduled only after it settles. A rejection is logged and the
   * watch continues, but the revision is NOT recorded as applied — the change
   * is still owed, so the next poll attempts it again until one succeeds.
   */
  onChanged: (revision: string) => void | Promise<void>;
  /** Where a notice goes. Defaults to stderr — the only stream this process may write. */
  log?: (message: string) => void;
}

/**
 * Start watching. Returns immediately; the first poll is one interval away.
 *
 * The timer is `unref`'d: a watch left running must never be the reason a host
 * process refuses to exit.
 */
export function watchCatalog(options: CatalogWatchOptions): CatalogWatch {
  const {
    config,
    initialRevision = null,
    intervalMs = CATALOG_POLL_INTERVAL_MS,
    onChanged,
    log = (message: string) => console.error(message),
  } = options;

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The revision the toolset this process serves was built from — advanced
   * only when a refresh has actually SUCCEEDED, so a failed one is still owed
   * and the next poll tries again.
   */
  let applied: string | null = initialRevision;
  /** False until a poll has established what `applied` means. See `initialRevision`. */
  let baselineKnown = initialRevision !== null;
  /** So a deployment that is down for an hour writes one line, not 1200. */
  let failing = false;
  /** The same restraint for a refresh that keeps failing against a live deployment. */
  let refreshFailing = false;

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  if (intervalMs <= 0) return { stop };

  /**
   * Next poll at a FIXED cadence, not one interval after this one finished.
   * The budget the guide states is five seconds from commit to visible, and
   * the poll interval already spends three of them: adding the request's own
   * latency (and a refresh's) on top would put a slow-but-healthy deployment
   * outside the window every time. Measured from the tick's start, so a round
   * trip that took longer than the interval simply polls again at once, and a
   * tick still never overlaps its predecessor — the next timer is armed only
   * after the current one has settled.
   */
  const schedule = (startedAt: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), Math.max(0, intervalMs - (Date.now() - startedAt)));
    timer.unref?.();
  };

  const reason = (err: unknown): string => printable(err instanceof Error ? err.message : String(err));

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const startedAt = Date.now();
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
            'Still trying; tools added meanwhile appear once it answers again.',
        );
      }
      schedule(startedAt);
      return;
    }
    if (failing) {
      failing = false;
      log('[hexis-mcp] the workspace is answering again; watching its tools for changes.');
    }
    // A baseline that startup could not read is not "no change": a commit
    // between discovery and this poll would be invisible forever if the first
    // reading were simply adopted. One refresh of an unchanged catalog is the
    // price of never silently dropping that commit.
    const owed = !baselineKnown || applied !== revision;
    // `stop()` can land while the fetch above is in flight — teardown is
    // exactly when it does. A handler called then would run against a server
    // that is already closing.
    if (owed && !stopped) {
      try {
        await onChanged(revision);
      } catch (err) {
        // `applied` stays where it was, so this revision is still owed and the
        // next poll attempts it again. A re-registration fails for the reasons
        // everything else here fails — a deployment mid-restart, a network
        // that dropped — and those pass; suppressing the change for good would
        // leave the toolset stale until some LATER commit happened to move the
        // catalog again.
        if (!refreshFailing) {
          refreshFailing = true;
          log(
            `[hexis-mcp] refreshing the toolset after a workspace change failed: ${reason(err)} ` +
              'Retrying on the next check.',
          );
        }
        schedule(startedAt);
        return;
      }
    }
    applied = revision;
    baselineKnown = true;
    refreshFailing = false;
    schedule(startedAt);
  };

  schedule(Date.now());
  return { stop };
}
