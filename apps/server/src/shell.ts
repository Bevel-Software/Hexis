import type { Server as HttpServer } from 'node:http';
import { createShutdown, logger, type ShutdownDeps } from '@bevel-software/platform-core-backend';

const log = logger('server');

/** One knowledge base's graph, as the shell lets go of it: exactly what the shutdown needs. */
export interface ShellGraph {
  commitWorker: ShutdownDeps['commitWorker'];
  db: ShutdownDeps['db'];
  pluginJoinRequestJobs?: ShutdownDeps['backgroundJobs'];
  /** The startup phase's retry, when the boot left one asking. */
  startupRetry?: ShutdownDeps['startupRetry'];
}

/**
 * A host of many graphs (see `createTenantHost`): stopping it stops every
 * tenant it activated, each letting go of its own pool and lease.
 */
export interface ShellHost {
  stop(): Promise<void>;
}

/** What the shell boots: a single knowledge base's graph, or a host of many. */
export type ShellCore = ShellGraph | ShellHost;

/** The single graph the shell booted, or null when it booted a host (or nothing yet). */
function asGraph(core: ShellCore | null): ShellGraph | null {
  return core && 'db' in core ? core : null;
}

/** The host the shell booted, or null when it booted a single graph (or nothing yet). */
function asHost(core: ShellCore | null): ShellHost | null {
  return core && !('db' in core) ? core : null;
}

/** The process, as the shell touches it — a seam so a test can stand in for it. */
export interface ShellProcess {
  on(event: 'SIGTERM' | 'SIGINT' | 'unhandledRejection' | 'uncaughtException', handler: (arg: unknown) => void): unknown;
  exit(code: number): void;
}

export interface ShellIo<Core extends ShellCore> {
  /** Build the services: the pool, the lease loop — everything the shutdown lets go of. */
  services(): Promise<Core>;
  /** Build the HTTP app over the services and start it listening. */
  listen(core: Core): Promise<HttpServer> | HttpServer;
  process: ShellProcess;
}

/**
 * Boot the shell and own how the process stops. The sequence itself is the
 * core's (it owns the things being let go of); the shell's job is to run it
 * on every way the process can be asked to end, and then actually end.
 *
 * SIGTERM is what Docker sends first on `stop` and on every redeploy; SIGINT
 * is Ctrl-C in development. Before this the process simply died on either:
 * an in-flight push killed mid-write, SSE streams cut without a word, the
 * commit-worker lease held until the server noticed the session was gone.
 *
 * Registered BEFORE boot, over what exists at the time: a stop that lands
 * during boot — a redeploy cancelled, a Ctrl-C on a slow first clone — finds
 * the services built so far and lets go of those; what is not built yet is
 * nothing to let go of.
 *
 * A boot that fails partway ends through the same sequence, with the exit
 * code saying it was not a clean stop. What that can release is what
 * `services()` RETURNED: a failure inside it — a migration that could not
 * take its lock, a fatal validation — leaves nothing the shell can reach,
 * and the process's exit is what lets go of those (the pool dies with it;
 * the lease has a term the next process waits out). A failure after it —
 * the server refusing to build or to listen — releases the lease and the
 * pool first.
 *
 * An unhandled rejection or uncaught exception is a bug, and Node 22's
 * default is to die on the spot for it. The default is right about ending
 * the process — continuing on unknown state is worse — and wrong about
 * skipping the shutdown, so the same sequence runs first.
 *
 * A HOST of many graphs stops where a single graph's commit worker would:
 * after the server has closed, before anything else, since each tenant it
 * stops lets go of its own pool and lease in the core's own order.
 */
export async function runShell<Core extends ShellCore>(io: ShellIo<Core>): Promise<void> {
  let core: Core | null = null;
  let server: HttpServer | null = null;
  let exiting = false;
  const exitAfter = (reason: string, code: number): void => {
    if (exiting) return;
    exiting = true;
    // What is not built yet is stood in for by a no-op of the same shape.
    const notListening: ShutdownDeps['server'] = {
      close: (cb?: (err?: Error) => void) => void cb?.(),
      closeAllConnections: () => undefined,
    } as unknown as ShutdownDeps['server'];
    const noPool = { $client: { end: async () => undefined } } as unknown as ShutdownDeps['db'];
    const graph = asGraph(core);
    const host = asHost(core);
    const shutdown = createShutdown({
      server: server ?? notListening,
      commitWorker: graph?.commitWorker ?? { stop: () => host?.stop() ?? Promise.resolve() },
      backgroundJobs: graph?.pluginJoinRequestJobs,
      startupRetry: graph?.startupRetry,
      db: graph?.db ?? noPool,
    });
    shutdown(reason)
      .catch((err: unknown) => log.error('shutdown itself failed', { err }))
      .finally(() => io.process.exit(code));
  };
  io.process.on('SIGTERM', () => exitAfter('SIGTERM', 0));
  io.process.on('SIGINT', () => exitAfter('SIGINT', 0));
  io.process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { err: reason });
    exitAfter('unhandled promise rejection', 1);
  });
  io.process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    exitAfter('uncaught exception', 1);
  });

  try {
    core = await io.services();
    // A stop that landed while the services were being built has already
    // let go of what there was and asked the process to exit: nothing
    // starts listening on its way out.
    if (exiting) return;
    server = await io.listen(core);
  } catch (err) {
    log.error('fatal boot error', { err });
    exitAfter('fatal boot error', 1);
  }
}
