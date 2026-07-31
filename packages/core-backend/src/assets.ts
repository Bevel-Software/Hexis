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
