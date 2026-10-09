import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locations of the assets shipped INSIDE this package (`files` in
 * package.json): the squashed core migration history (`migrations/`) and the
 * KB seed template (`kb-template/`). Both live at the PACKAGE ROOT, and this
 * module is a direct child of either `src/` (in-repo / tsx) or `dist/`
 * (compiled) — so one `..` hop from the module URL reaches the package root
 * in BOTH layouts. Resolved lazily so bundlers that rewrite `import.meta.url`
 * still get a sensible answer at call time.
 */
function packageRoot(): string {
  return fileURLToPath(new URL('..', import.meta.url));
}

/** Absolute path of the packaged core Drizzle migrations folder. */
export function coreMigrationsDir(): string {
  return path.join(packageRoot(), 'migrations');
}

/** Absolute path of the packaged KB seed template (`kb-template/`). */
export function defaultKbTemplateDir(): string {
  return path.join(packageRoot(), 'kb-template');
}

/**
 * The sections of the platform's agent guide, one markdown file each — the
 * text `get_agent_guide` and a `read_file` of the guide's name serve, composed
 * by `modules/agent-guide`. Beside `kb-template/` rather than under `src/`,
 * so a build and the published source find it at the same place.
 */
export function agentGuideDir(): string {
  return path.join(packageRoot(), 'agent-guide');
}

/**
 * The MCP App views this deployment serves over `resources/read` — one static
 * HTML file each, no build step. Beside `agent-guide/` and `kb-template/` for
 * the same reason: a build and the published source find it at the same
 * place, and `tsc` copies nothing that is not TypeScript.
 *
 * The backend serves these as BYTES and never imports frontend code — the
 * view's whole job is to load the deployment's embed bundle into its own
 * document (hosts forbid framing the deployment, see `mcp-app.ts`), where the
 * app's renderers then draw the page.
 */
export function mcpAppDir(): string {
  return path.join(packageRoot(), 'mcp-app');
}
