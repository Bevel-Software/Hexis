/**
 * A connected tool Hexis keeps off every agent surface because its input
 * schema is not valid JSON Schema as its server sent it — and the read port
 * the surfaces that SHOW that to the server's owner use.
 *
 * Here rather than in either module because two of them meet over it: the MCP
 * proxy finds these when a server's tools are loaded (`modules/mcp`), and the
 * tool catalog reports them to the people who manage the server
 * (`modules/tool-manuals`, on the tool page and in `list_tool_setup`). Neither
 * has any business importing the other.
 */

/** One connected tool hidden from agents, and why. */
export interface HiddenTool {
  /** The manual (the `.tool` or `mcp.json` server) the tool came from, by catalog name. */
  manual: string;
  /** The name an agent would have called it by, had it been offered. */
  name: string;
  /** JSON Pointer to the place in the input schema that is not valid. */
  path: string;
  /** The violation in the validator's own words, e.g. `must be a string`. */
  reason: string;
  /** The one sentence every owner-facing surface shows, built once so they cannot drift. */
  marker: string;
}

/**
 * What the owner-facing surfaces read. A deployment that never builds an MCP
 * surface has nothing to report, so every consumer treats the port as
 * optional and an absent one as "no tool is hidden".
 */
export interface HiddenToolSource {
  /**
   * The tools of `manual` currently hidden for an invalid schema, by the
   * manual's CATALOG name — empty for a healthy server, and empty for a server
   * whose tools this process has not loaded yet.
   */
  hiddenFor(manual: string): HiddenTool[];
}
