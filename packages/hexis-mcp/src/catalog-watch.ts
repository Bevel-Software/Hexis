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
   * known. When absent the FIRST poll establishes the baseline and reports no
   * change — a startup that could not read the revision must not be answered
   * with a refresh of a catalog that was already current.
   */
  initialRevision?: string | null;
  /** Milliseconds between polls; `0` or less disables the watch entirely. */
  intervalMs?: number;
  /**
   * Called once per observed change, never concurrently with itself: the next
   * poll is scheduled only after it settles. A rejection is logged and the
   * watch continues — the revision is still recorded as seen, because a
   * refresh that failed will not succeed by being retried against an
   * unchanged catalog.
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
  let seen: string | null = initialRevision;
  /** So a deployment that is down for an hour writes one line, not 1200. */
  let failing = false;

  const stop = (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  if (intervalMs <= 0) return { stop };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let revision: string;
    try {
      revision = await fetchCatalogRevision(config);
    } catch (err) {
      if (err instanceof CatalogRevisionUnsupportedError) {
        stop();
        log(`[hexis-mcp] ${err.message}`);
        return;
      }
      if (!failing) {
        failing = true;
        log(
          `[hexis-mcp] could not check whether the workspace's tools changed: ${err instanceof Error ? err.message : String(err)} ` +
            'Still trying; tools added meanwhile appear once it answers again.',
        );
      }
      schedule();
      return;
    }
    if (failing) {
      failing = false;
      log('[hexis-mcp] the workspace is answering again; watching its tools for changes.');
    }
    // Recorded BEFORE the callback runs, so a handler that throws — or one
    // that takes longer than an interval — cannot make the same change fire
    // twice.
    const changed = seen !== null && seen !== revision;
    seen = revision;
    // `stop()` can land while the fetch above is in flight — teardown is
    // exactly when it does. A handler called then would run against a server
    // that is already closing.
    if (changed && !stopped) {
      try {
        await onChanged(revision);
      } catch (err) {
        log(
          `[hexis-mcp] refreshing the toolset after a workspace change failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    schedule();
  };

  schedule();
  return { stop };
}
