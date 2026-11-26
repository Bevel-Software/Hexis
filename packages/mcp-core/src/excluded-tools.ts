import type { CallTemplate } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { utcpManualName } from './utcp-namespace.js';

/**
 * The key an MCP server entry carries the tools its manual leaves out under.
 * The platform writes it from `plugin.json`'s `excludeTools`; UTCP keeps a
 * server entry as given (`mcpServers` is a record of anything) and drops keys
 * it does not know when it connects, so the MCP client never sees it.
 */
export const EXCLUDE_TOOLS_KEY = 'exclude_tools';

/**
 * The UTCP names (`<manual>.<server>.<tool>`) of the tools an `mcp` manual
 * leaves out, with the manual's name as UTCP registers it, so it reads the
 * same before and after registration.
 */
export function excludedToolNames(template: CallTemplate): string[] {
  if (template.call_template_type !== 'mcp') return [];
  const servers = (template as { config?: { mcpServers?: unknown } }).config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const manual = utcpManualName(String(template.name ?? ''));
  const names: string[] = [];
  for (const [server, entry] of Object.entries(servers as Record<string, unknown>)) {
    const list = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[EXCLUDE_TOOLS_KEY] : undefined;
    if (!Array.isArray(list)) continue;
    for (const tool of list) if (typeof tool === 'string') names.push(`${manual}.${server}.${tool}`);
  }
  return names;
}

/**
 * Take the tools a just-registered manual leaves out OFF the client's tool
 * repository: gone from `tools/list`, `list_tools`/`tools_info` and the
 * interfaces `call_tool_chain` generates, and a call by name finds no tool.
 * Run by `registerManual`, the one point every registration passes through (a
 * first discovery, a session recovery, a catalog refresh), so no surface can
 * register a manual and keep one.
 */
export async function removeExcludedTools(client: CodeModeUtcpClient, template: CallTemplate): Promise<void> {
  for (const name of excludedToolNames(template)) await client.config.tool_repository.removeTool(name);
}
