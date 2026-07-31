import type { JsonSchema, Tool as UtcpTool } from '@utcp/sdk';

export type { JsonSchema, UtcpTool };

/**
 * Per-request context handed to a `ToolProvider` when the manual is built, so a
 * provider can tailor its def to the caller (e.g. the skill tools name only the
 * skills THIS user may read).
 */
export interface ToolManualContext {
  /** The requesting user's email, when it could be resolved. */
  userEmail?: string;
  /** The requesting user's id, when it could be resolved (for per-user gating). */
  userId?: string;
}

/**
 * A lazy tool definition: a callable that produces a UTCP `Tool` at list time.
 * Use it for a tool whose def must reflect live state when the manual is built
 * (e.g. the skill tools, whose description names the currently-available
 * skills). Resolved on every `listExternal`/`listInternal` call, so the manual
 * stays current without a restart. Static tools are passed as a plain `UtcpTool`.
 */
export type ToolProvider = (ctx: ToolManualContext) => UtcpTool | Promise<UtcpTool>;

/**
 * A lazy provider that yields ZERO OR MORE tool defs at list time. Unlike
 * {@link ToolProvider} (exactly one tool), a list provider can return `[]` to
 * contribute nothing — the mechanism a Connector uses to expose its tool family
 * only while it is enabled + configured, and hide it otherwise, with no restart.
 */
export type ToolListProvider = (ctx: ToolManualContext) => UtcpTool[] | Promise<UtcpTool[]>;

/**
 * The registry is a pure CATALOG of self-describing UTCP `Tool` defs (each
 * carries its own `tool_call_template`). It never knows how a tool executes —
 * the owning module hosts the endpoint. `external`/`internal` are two separate
 * lists; a tool that's both is registered into both. A tool is registered as a
 * plain `UtcpTool` (static) or a `ToolProvider` (resolved per list call).
 */
export interface IToolRegistry {
  registerExternalTool(tool: UtcpTool | ToolProvider): void;
  registerInternalTool(tool: UtcpTool | ToolProvider): void;
  /**
   * Register a provider that contributes zero-or-more INTERNAL tools per list
   * call. Used by the connector host to expose a connector's tool family only
   * while it is enabled + configured.
   */
  registerInternalTools(provider: ToolListProvider): void;
  listExternal(ctx?: ToolManualContext): Promise<UtcpTool[]>;
  listInternal(ctx?: ToolManualContext): Promise<UtcpTool[]>;
}
