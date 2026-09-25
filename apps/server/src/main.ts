import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoreConfig,
  StaticTenantSource,
  createCoreServices,
  createCoreServer,
  createTenantHost,
  setLogger,
  logger,
  tenantHostEnv,
} from '@bevel-software/platform-core-backend';
import { createPinoLogger } from './logging.js';
import { runShell } from './shell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Installed before anything else runs, so the first line the process writes
// is already in the shape the rest will be. See ./logging.ts for why pino
// lives here and not in the package.
setLogger(createPinoLogger());
const log = logger('server');

/** The built SPA (apps/web) in production; in dev the Vite dev server proxies `/api` here. */
function staticDirFor(nodeEnv: string): string | undefined {
  return (
    process.env.STATIC_DIR ||
    (nodeEnv === 'production' ? path.resolve(__dirname, '..', '..', 'web', 'dist') : undefined)
  );
}

/**
 * Standalone CORE deployment: no enterprise extensions — empty ports, empty
 * server extensions. Everything the server mounts (auth, MCP + its OAuth AS,
 * the unified tool surface, workspace/workflow/diff/access/skills/tool-manuals/
 * secrets routes, SSE) comes from `createCoreServer`'s fixed mount order.
 *
 * With `TENANTS_FILE` set the same process serves several knowledge bases,
 * one per host name, each built by the same composition root on its first
 * request — see docs/multi-tenant.md. Without it, one knowledge base from
 * the environment, as before.
 *
 * How the process boots and stops — the signal handlers, the shutdown on a
 * failed boot — is `runShell`'s (./shell.ts), where it can be tested; this
 * file supplies the real pieces.
 */
const hostEnv = tenantHostEnv();

const boot = hostEnv.tenantsFile
  ? runShell({
      services: async () => {
        const source = await StaticTenantSource.fromFile(hostEnv.tenantsFile!, hostEnv);
        const host = createTenantHost({
          source,
          process: hostEnv,
          staticDir: staticDirFor(hostEnv.nodeEnv),
          idleMinutes: hostEnv.idleMinutes,
        });
        log.info(`serving ${source.slugs.length} tenant(s) from ${hostEnv.tenantsFile}`, { tenants: source.slugs });
        return { host, stop: () => host.stop() };
      },
      listen: (core) =>
        core.host.app.listen(hostEnv.port, () => {
          log.info(`Bevel core tenant host listening on http://localhost:${hostEnv.port}`, { port: hostEnv.port });
        }),
      process,
    })
  : runShell({
      services: async () => {
        const config = new CoreConfig();
        const core = await createCoreServices(config, {});
        return { ...core, config };
      },
      listen: async (core) => {
        const app = await createCoreServer(core, {}, { staticDir: staticDirFor(core.config.nodeEnv) });
        return app.listen(core.config.port, () => {
          log.info(`Bevel core server listening on http://localhost:${core.config.port}`, { port: core.config.port });
        });
      },
      process,
    });

boot.catch((err) => {
  // Nothing above reaches here: the shell ends itself on every failure. This
  // is the last resort for a bug in the shutdown wiring itself.
  log.error('fatal boot error, and the shutdown sequence could not run', { err });
  process.exit(1);
});
