import type { UtcpTool } from './tool.contract.js';

/** One tool's read-only hint as the Tools page shows it. */
export interface ToolReadOnlyEntry {
  name: string;
  /** `platform`: an endpoint of this deployment. `meta`: a feature of the MCP servers. */
  kind: 'platform' | 'meta';
  /** What the tool's own declaration makes it. */
  builtIn: boolean;
  /** The admin's override, or null when there is none. */
  override: boolean | null;
  /** What clients are told: the override when set, else the built-in value. */
  readOnly: boolean;
}

/**
 * What MCP clients are told about each platform tool's and code-mode
 * meta-tool's effect, and an admin's per-deployment overrides of it. The
 * routes, the agent manual and the core services depend on this, not on the
 * implementation (`ToolReadOnlyHints` in `read-only-hints.ts`).
 */
export interface IToolReadOnlyHints {
  /** The overrides in effect, as the database has them now. */
  overrides(): Promise<Record<string, boolean>>;
  /** The given manual tools, each tagged `read-only` exactly when its effective hint is true. */
  apply(tools: UtcpTool[]): Promise<UtcpTool[]>;
  /** Every platform tool, then every meta-tool, with its built-in, override and effective value. */
  describe(): Promise<ToolReadOnlyEntry[]>;
  /** Every tool's effective hint, by name. */
  hints(): Promise<Record<string, boolean>>;
  /**
   * Set one tool's override, or remove it (`null`). `updatedBy` is the admin's
   * user id. Throws `UnknownToolError` for a name that is neither kind of tool.
   */
  set(name: string, readOnly: boolean | null, updatedBy: string | null): Promise<ToolReadOnlyEntry>;
}
