import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoreConfig,
  createCoreServices,
  createCoreServer,
  createShutdown,
} from '@bevel-software/platform-core-backend';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  const config = new CoreConfig();
  const core = await createCoreServices(config, {});

  const staticDir =
    process.env.STATIC_DIR ||
    (config.nodeEnv === 'production'
      ? path.resolve(__dirname, '..', '..', 'web', 'dist')
      : undefined);

  const app = await createCoreServer(core, {}, { staticDir });

  const server = app.listen(config.port, () => {
    console.log(`Bevel core server listening on http://localhost:${config.port}`);
  });

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
   * An unhandled rejection or uncaught exception is a bug, and Node 22's
   * default is to die on the spot for it. The default is right about ending
   * the process — continuing on unknown state is worse — and wrong about
   * skipping the shutdown, so the same sequence runs first, and the exit
   * code says it was not a clean stop.
   */
  const shutdown = createShutdown({ server, commitWorker: core.commitWorker, db: core.db });
  let exiting = false;
  const exitAfter = (reason: string, code: number): void => {
    if (exiting) return;
    exiting = true;
    shutdown(reason)
      .catch((err: unknown) => console.error('[lifecycle] shutdown itself failed:', err))
      .finally(() => process.exit(code));
  };
  process.on('SIGTERM', () => exitAfter('SIGTERM', 0));
  process.on('SIGINT', () => exitAfter('SIGINT', 0));
  process.on('unhandledRejection', (reason) => {
    console.error('[lifecycle] unhandled promise rejection:', reason);
    exitAfter('unhandled promise rejection', 1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[lifecycle] uncaught exception:', err);
    exitAfter('uncaught exception', 1);
  });
}

main().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
