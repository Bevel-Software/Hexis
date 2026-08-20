/**
 * The CLI's let-go coordination, as a unit: what happens when the MCP client
 * hangs up (stdin EOF) or the process is signalled, relative to where startup
 * is at that moment. Split from cli.ts so the states can be pinned by unit
 * tests — cli.ts runs `main()` on import and only the e2e suite can reach it.
 *
 * Three states, three answers:
 *
 *  - Startup DONE (`holder.shutdown` set): orderly teardown — close the UTCP
 *    client (which is what actually ends the spawned stdio grandchildren) and
 *    exit. The status is `process.exitCode ?? 0`: a recorded startup failure
 *    (say, `server.connect` rejecting) must not be laundered into a clean 0
 *    by the client's eventual hang-up. The teardown itself is BOUNDED by a
 *    cleanup watchdog: a `shutdown()` that hangs (a transport close that
 *    never resolves) would otherwise leave the spawned servers alive
 *    indefinitely — exactly the orphans teardown exists to prevent.
 *
 *  - Startup PENDING: only RECORD the request — there is nothing reachable to
 *    close yet — and arm a bounded force-exit. When creation resolves in time,
 *    main() sees `exitRequested` and runs the orderly path above, which exits
 *    first; when creation is WEDGED (a local stdio server that never answers
 *    initialize), the force-exit is the only exit there is, and it reports
 *    failure. unref()d, so it never holds an otherwise-finished process open.
 *
 *  - Already EXITING (main() took over, or a second 'end'/'close'/signal):
 *    nothing — teardown must not be re-entered while `shutdown()` runs.
 */

/** Shared between the handler and main(): what exists, and what was asked. */
export interface ShutdownHolder {
  shutdown: (() => Promise<void>) | null;
  exitRequested: boolean;
  /** Set by whichever path commits to exiting, so the other stands down. */
  exiting: boolean;
}

/**
 * How long a let-go waits on a still-creating startup before giving up on the
 * orderly path. Generous against a healthy create (which resolves in well
 * under a second once its downloads are done), tight against a wedged one.
 */
export const STARTUP_LETGO_GRACE_MS = 5_000;

/**
 * How long the orderly teardown gets before the cleanup watchdog gives up on
 * it. Closing the transports is milliseconds when the children are healthy;
 * a shutdown still pending after this is wedged on one of them, and a forced
 * exit (which at least collapses the stdio pipes) beats servers that outlive
 * their client indefinitely.
 */
export const SHUTDOWN_GRACE_MS = 15_000;

/**
 * The orderly exit, wherever it starts (the let-go handler once startup is
 * done, or main() finding `exitRequested` after create resolves): flips
 * `exiting` so every other path stands down, runs `shutdown()`, and exits
 * with the recorded status. Bounded — the watchdog force-exits a hung
 * shutdown, and is cleared the moment shutdown completes (in tests, where
 * `process.exit` is mocked and does not actually terminate, the cleared
 * timer is also what keeps the exit from firing twice).
 */
export function beginOrderlyExit(holder: ShutdownHolder): void {
  holder.exiting = true;
  // Deliberately REFERENCED, unlike the startup force-exit: `process.exit`
  // in the finally guarantees a completed shutdown never outlives its
  // clearTimeout, and a WEDGED one may have already closed/unref'd every
  // other handle — an unref'd watchdog would let the process drift out with
  // status 0 instead of enforcing the bound and reporting the failure.
  const watchdog = setTimeout(() => process.exit(process.exitCode || 1), SHUTDOWN_GRACE_MS);
  void holder.shutdown!().finally(() => {
    clearTimeout(watchdog);
    process.exit(process.exitCode ?? 0);
  });
}

/** Build the handler cli.ts installs for stdin 'end'/'close', SIGINT and SIGTERM. */
export function makeExitAfterShutdown(holder: ShutdownHolder): () => void {
  let forceExit: NodeJS.Timeout | null = null;
  return (): void => {
    if (holder.exiting) return; // 'end' then 'close' both fire; signals can repeat
    holder.exitRequested = true;
    if (!holder.shutdown) {
      // Still creating — main() finishes the job if create resolves in time;
      // the timer is the bound for when it never does. A forced exit is a
      // failure to come up, and the status says so. Checked at FIRE time, not
      // arming time: when create resolves within the grace and the orderly
      // path takes over (`exiting` flips true), this stale timer must stand
      // down rather than exit 1 out of a cleanup that is merely thorough —
      // the orderly path carries its own bound (see `beginOrderlyExit`).
      forceExit ??= setTimeout(() => {
        if (!holder.exiting) process.exit(process.exitCode || 1);
      }, STARTUP_LETGO_GRACE_MS);
      forceExit.unref?.();
      return;
    }
    beginOrderlyExit(holder);
  };
}
