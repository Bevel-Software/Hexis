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
   * The plugin's identity everywhere a person or a URL names it — the folder
   * name for a native plugin; the bundle's `name` (or its leaf folder) for a
   * dialect plugin. Unique per source.
   */
  name: string;
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
}

export interface PluginSource {
  /** A short name for logs and the settings screen. */
  readonly dialect: string;
  /** Enumerate the plugins in a KB checkout. Never throws: a broken tree yields warnings. */
  discover(kbRoot: string): Promise<Discovery>;
}
