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
 *    by the client's eventual hang-up.
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
      // down rather than exit 1 out of a cleanup that is merely thorough.
      forceExit ??= setTimeout(() => {
        if (!holder.exiting) process.exit(process.exitCode || 1);
      }, STARTUP_LETGO_GRACE_MS);
      forceExit.unref?.();
      return;
    }
    holder.exiting = true;
    void holder.shutdown().finally(() => process.exit(process.exitCode ?? 0));
  };
}
