import type {
  IToolRegistry,
  ToolListProvider,
  ToolManualContext,
  ToolProvider,
  UtcpTool,
} from './tool.contract.js';

/**
 * The tool catalog. Modules call `registerExternalTool` / `registerInternalTool`
 * (both, for a `both` tool) with a self-describing UTCP `Tool` def, or a
 * `ToolProvider` callable for a tool whose def is built lazily at list time. The
 * catalog only aggregates and lists them — the two manual endpoints serialize
 * each list per request. Insertion order is preserved (static tools first, then
 * provider-built ones); a duplicate static name within a surface throws.
 */
export class ToolRegistry implements IToolRegistry {
  private readonly external = new Map<string, UtcpTool>();
  private readonly internal = new Map<string, UtcpTool>();
  private readonly externalProviders: ToolProvider[] = [];
  private readonly internalProviders: ToolProvider[] = [];
  private readonly internalListProviders: ToolListProvider[] = [];

  registerExternalTool(tool: UtcpTool | ToolProvider): void {
    if (typeof tool === 'function') this.externalProviders.push(tool);
    else this.add(this.external, tool, 'external');
  }

  registerInternalTool(tool: UtcpTool | ToolProvider): void {
    if (typeof tool === 'function') this.internalProviders.push(tool);
    else this.add(this.internal, tool, 'internal');
  }

  registerInternalTools(provider: ToolListProvider): void {
    this.internalListProviders.push(provider);
  }

  async listExternal(ctx: ToolManualContext = {}): Promise<UtcpTool[]> {
    const dynamic = await Promise.all(this.externalProviders.map((p) => p(ctx)));
    return [...this.external.values(), ...dynamic];
  }

  async listInternal(ctx: ToolManualContext = {}): Promise<UtcpTool[]> {
    const dynamic = await Promise.all(this.internalProviders.map((p) => p(ctx)));
    const lists = await Promise.all(this.internalListProviders.map((p) => p(ctx)));
    return [...this.internal.values(), ...dynamic, ...lists.flat()];
  }

  private add(into: Map<string, UtcpTool>, tool: UtcpTool, surface: string): void {
    if (into.has(tool.name)) {
      throw new Error(`Duplicate ${surface} tool name: "${tool.name}"`);
    }
    into.set(tool.name, tool);
  }
}
