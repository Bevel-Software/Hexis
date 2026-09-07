import type { KbWalkListener } from '../../../shared/kb-walk.js';

/**
 * Plugin DISCOVERY as an interface — the one seam between "what a plugin is
 * on disk" and everything that consumes plugins (the plugin index, the link
 * index, the tool-manual scanner, the compiler).
 *
 * Two providers implement it:
 *
 *   - `native.source.ts`  — the Agent Plugins layout this platform writes:
 *                           `Plugins/<Name>/plugin.json` (+ `mcp.json`,
 *                           `access.md`, the hexis extension block).
 *   - `bundle-dialect/`   — a customer's source layout: `plugin.bundle.json`
 *                           files at any depth, pointing at skill roots and at
 *                           an MCP profile in a registry. Read-only, and
 *                           deletable as a unit once that customer migrates.
 *
 * Consumers see only {@link DiscoveredPlugin}: parsed objects, never files.
 * A provider that reads a different file shape changes nothing downstream.
 */
export interface DiscoveredPlugin {
  /**
   * The plugin's IDENTITY everywhere a URL, a grant or a marketplace names
   * it: the manifest's `name` — an Agent Plugins identifier — or the folder
   * name folded into one when the manifest declares none it can be. A bundle
   * plugin's is the bundle's `name`. Unique per source.
   */
  name: string;
  /** What a person sees it called: the manifest's `displayName`, else the folder name. */
  displayName: string;
  /** Repo-relative folder holding the plugin, e.g. `Plugins/GTM`. */
  folder: string;
  /** The same folder relative to the plugins root, e.g. `GTM` or `functional/x/y`. */
  relFolder: string;
  /** A personal folder (`Plugins/personal-<id>`): a place, not a plugin. */
  personal: boolean;
  /**
   * Whether the plugin EXISTS by the index's rule. Native: its folder carries
   * an `access.md` (a bare directory is a ghost git left behind). Dialect:
   * always — the bundle file is the existence.
   */
  exists: boolean;
  /** The Agent Plugins manifest, parsed (a dialect synthesises one). Null when absent or unparsable. */
  manifest: Record<string, unknown> | null;
  /** The manifest's raw text, for readers that want the extension block verbatim (native only). */
  manifestText: string | null;
  /** Repo-relative roots the plugin LINKS skills from — a skill folder or a folder of skills. */
  linkedRoots: string[];
  /** The `mcpServers` map of the plugin's `mcp.json`, parsed; null when it has none. */
  mcpServers: Record<string, unknown> | null;
  /** The raw `mcp.json` text, when it exists on disk (native only). */
  mcpJsonText: string | null;
  /**
   * Whether hexis manages this plugin's links — writes them, grants the
   * plugin's principal on the skill, reports a missing grant as needing
   * repair. False for a dialect, whose links are plain references and whose
   * skills' own scopes decide readability.
   */
  linksAreManaged: boolean;
}

export interface Discovery {
  plugins: DiscoveredPlugin[];
  /** What was skipped and why — unparsable files, unknown profiles. */
  warnings: string[];
  /**
   * HOLES: identity-bearing things that exist but could NOT be read
   * (permissions, I/O), repo-relative — a folder that could not be listed,
   * a manifest or bundle that could not be opened. Nothing behind a hole is
   * in `plugins`: not absent, unseen, and never listed under a guessed name.
   * A file that carries no identity (an `mcp.json`) is never a hole; its
   * failure is a warning. A reader that only shows what it can carries on
   * (the catalog does); a WRITER that keys a change on the set of plugins
   * (a rename claiming a name) must refuse while this is not empty, or it
   * may take an identity it could not see.
   */
  unreadable: string[];
}

/** What one walk yields when discovery shares it: the plugins, and every hole the walk met anywhere. */
export interface PluginSourceWalk {
  discovery: Discovery;
  /** Every folder the walk could not list, repo-relative — under the plugins root or anywhere else. */
  holes: string[];
}

export interface PluginSource {
  /** A short name for logs and the settings screen. */
  readonly dialect: string;
  /** Enumerate the plugins in a KB checkout. Never throws: a broken tree yields warnings. */
  discover(kbRoot: string): Promise<Discovery>;
  /**
   * Discover while driving other listeners from the SAME walk — a writer
   * that needs plugins and grant files alike reads the tree once, and sees
   * one set of holes. Optional: a source that cannot share its walk is
   * discovered on its own and the caller walks separately.
   */
  walkWith?(kbRoot: string, listeners: readonly KbWalkListener[]): Promise<PluginSourceWalk>;
}
