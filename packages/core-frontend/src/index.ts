/**
 * @bevel-software/platform-core-frontend — the open-source core UI of the Bevel
 * platform, published as RAW TypeScript/TSX source (the consuming app's
 * bundler compiles it; react / react-dom / react-router-dom / tailwindcss are
 * peer dependencies).
 *
 * Mount `<CoreAppShell registry={makeRegistry({...})} />` and contribute
 * optional surfaces (extra panes, routes, providers, gear-menu rows, file-
 * viewer panels, the change-request port) through the {@link AppRegistry}.
 *
 * Tailwind: import `@bevel-software/platform-core-frontend/index.css` and add an
 * `@source` directive pointing at this package's `src/` so the consumer's
 * Tailwind build emits the classes used here.
 */

// Global React typings augmentation (webkitdirectory on <input>) — a real
// module (not a bare .d.ts) so consumers pick it up just by importing the
// package; emits an empty runtime module.
import './html-extensions';

export { loadServerConfig, renderConfigFailure } from './core/bootstrap';
export { CoreAppShell, AuthGate } from './core/CoreAppShell';
// The embed, mounted OUTSIDE the app: what a deployment's `embed` entry calls
// when the MCP App view loads it into a chat host's sandbox (see
// `modules/embed/mount.tsx`).
export { mountEmbed, type MountEmbedOptions } from './modules/embed/mount';
export { readEmbedHandoff, EMBED_HANDOFF_GLOBAL, type EmbedHandoff } from './modules/embed/embed-config';
export * from './core/registry';
export * from './core/events';
