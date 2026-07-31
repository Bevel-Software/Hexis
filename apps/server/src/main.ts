import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoreConfig,
  createCoreServices,
  createCoreServer,
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

  app.listen(config.port, () => {
    console.log(`Bevel core server listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
