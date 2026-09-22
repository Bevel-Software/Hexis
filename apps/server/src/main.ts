import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';
import {
  CoreConfig,
  createCoreServices,
  createCoreServer,
  createShutdown,
  setLogger,
  logger,
  type ShutdownDeps,
} from '@bevel-software/platform-core-backend';
import { createPinoLogger } from './logging.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Installed before anything else runs, so the first line the process writes
// is already in the shape the rest will be. See ./logging.ts for why pino
// lives here and not in the package.
setLogger(createPinoLogger());
const log = logger('server');

/**
 * Standalone CORE deployment: no enterprise extensions — empty ports, empty
 * server extensions. Everything the server mounts (auth, MCP + its OAuth AS,
 * the unified tool surface, workspace/workflow/diff/access/skills/tool-manuals/
 * secrets routes, SSE) comes from `createCoreServer`'s fixed mount order.
 *
 * In production the server also serves the built SPA (apps/web); in dev the
 * Vite dev server proxies `/api` here instead (`STATIC_DIR` overrides, e.g.
 * for the Docker image layout).
 */
async function main(): Promise<void> {
  /**
   * How this process stops. The sequence itself is the core's (it owns the
   * things being let go of); the shell's job is to run it on every way the
   * process can be asked to end, and then actually end.
   *
   * SIGTERM is what Docker sends first on `stop` and on every redeploy;
   * SIGINT is Ctrl-C in development. Before this the process simply died on
   * either: an in-flight push killed mid-write, SSE streams cut without a
   * word, the commit-worker lease held until the server noticed the session
   * was gone.
   *
   * Registered BEFORE boot, over what exists at the time: a stop that lands
   * during boot — a redeploy cancelled, a Ctrl-C on a slow first clone —
   * finds the services built so far (the lease loop starts inside
   * `createCoreServices`, so there may already be a lease to release) and
   * lets go of those; what is not built yet is nothing to let go of.
   *
   * An unhandled rejection or uncaught exception is a bug, and Node 22's
   * default is to die on the spot for it. The default is right about ending
   * the process — continuing on unknown state is worse — and wrong about
   * skipping the shutdown, so the same sequence runs first, and the exit
   * code says it was not a clean stop.
   */
  let core: Awaited<ReturnType<typeof createCoreServices>> | null = null;
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
    const shutdown = createShutdown({
      server: server ?? notListening,
      commitWorker: core?.commitWorker ?? { stop: async () => undefined },
      backgroundJobs: core?.pluginJoinRequestJobs,
      db: core?.db ?? noPool,
    });
    shutdown(reason)
      .catch((err: unknown) => log.error('shutdown itself failed', { err }))
      .finally(() => process.exit(code));
  };
  process.on('SIGTERM', () => exitAfter('SIGTERM', 0));
  process.on('SIGINT', () => exitAfter('SIGINT', 0));
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { err: reason });
    exitAfter('unhandled promise rejection', 1);
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    exitAfter('uncaught exception', 1);
  });

  // A boot that fails partway — a fatal validation in `createCoreServer`, a
  // migration that could not take its lock — leaves what was built so far:
  // the commit-worker lease loop, the pool. It ends through the same sequence
  // a signal does, so the lease is let go of and the pool closed before the
  // process exits, with the code saying it was not a clean stop.
  try {
    const config = new CoreConfig();
    core = await createCoreServices(config, {});

    const staticDir =
      process.env.STATIC_DIR ||
      (config.nodeEnv === 'production'
        ? path.resolve(__dirname, '..', '..', 'web', 'dist')
        : undefined);

    const app = await createCoreServer(core, {}, { staticDir });

    server = app.listen(config.port, () => {
      log.info(`Bevel core server listening on http://localhost:${config.port}`, { port: config.port });
    });
  } catch (err) {
    log.error('fatal boot error', { err });
    exitAfter('fatal boot error', 1);
  }
}

// Nothing above reaches here: `main` ends itself on every failure. This is
// the last resort for a bug in the shutdown wiring itself.
main().catch((err) => {
  log.error('fatal boot error, and the shutdown sequence could not run', { err });
  process.exit(1);
});
