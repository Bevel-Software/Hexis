import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoreConfig,
  createCoreServices,
  createCoreServer,
  setLogger,
  logger,
} from '@bevel-software/platform-core-backend';
import { createPinoLogger } from './logging.js';
import { runShell } from './shell.js';

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
 *
 * How the process boots and stops — the signal handlers, the shutdown on a
 * failed boot — is `runShell`'s (./shell.ts), where it can be tested; this
 * file supplies the real pieces.
 */
let config: CoreConfig;

runShell({
  services: async () => {
    config = new CoreConfig();
    return createCoreServices(config, {});
  },
  listen: async (core) => {
    const staticDir =
      process.env.STATIC_DIR ||
      (config.nodeEnv === 'production'
        ? path.resolve(__dirname, '..', '..', 'web', 'dist')
        : undefined);
    const app = await createCoreServer(core, {}, { staticDir });
    return app.listen(config.port, () => {
      log.info(`Bevel core server listening on http://localhost:${config.port}`, { port: config.port });
    });
  },
  process,
}).catch((err) => {
  // Nothing above reaches here: the shell ends itself on every failure. This
  // is the last resort for a bug in the shutdown wiring itself.
  log.error('fatal boot error, and the shutdown sequence could not run', { err });
  process.exit(1);
});
