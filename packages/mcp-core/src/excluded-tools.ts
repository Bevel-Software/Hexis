import type { CallTemplate } from '@utcp/sdk';

/**
 * The key an MCP server entry carries the tools its manual leaves out under.
 * The platform writes it from `plugin.json`'s `excludeTools`; UTCP keeps a
 * server entry as given (`mcpServers` is a record of anything) and drops keys
 * it does not know when it connects, so only the surfaces that build a tool
 * list read it, and the MCP client never sees it.
 */
export const EXCLUDE_TOOLS_KEY = 'exclude_tools';

/**
 * The UTCP names (`<manual>.<server>.<tool>`) of the tools an `mcp` manual
 * leaves out. Uses the manual's name as UTCP registers it (every non-word
 * character as `_`), so it reads the same before and after registration.
 */
export function excludedToolNames(template: CallTemplate): string[] {
  if (template.call_template_type !== 'mcp') return [];
  const servers = (template as { config?: { mcpServers?: unknown } }).config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const manual = String(template.name ?? '').replace(/[^\w]/g, '_');
  const names: string[] = [];
  for (const [server, entry] of Object.entries(servers as Record<string, unknown>)) {
    const list = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[EXCLUDE_TOOLS_KEY] : undefined;
    if (!Array.isArray(list)) continue;
    for (const tool of list) if (typeof tool === 'string') names.push(`${manual}.${server}.${tool}`);
  }
  return names;
}

/**
 * Take the tools `excluded` names OFF the client's tool repository and out of
 * `tools`: gone from `tools/list`, `list_tools`/`tools_info` and the interfaces
 * `call_tool_chain` generates, so a call by name is an unknown tool.
 */
export async function removeExcludedTools<T extends { name: string }>(
  client: { config: { tool_repository: { removeTool(name: string): Promise<unknown> } } },
  tools: T[],
  excluded: ReadonlySet<string>,
): Promise<T[]> {
  if (excluded.size === 0) return tools;
  const kept: T[] = [];
  for (const tool of tools) {
    if (excluded.has(tool.name)) await client.config.tool_repository.removeTool(tool.name);
    else kept.push(tool);
  }
  return kept;
}
