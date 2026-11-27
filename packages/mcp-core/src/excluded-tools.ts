import type { CallTemplate } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';

/**
 * The key an MCP server entry carries the tools its manual leaves out under.
 * The platform writes it from `plugin.json`'s `excludeTools`; UTCP keeps a
 * server entry as given (`mcpServers` is a record of anything) and drops keys
 * it does not know when it connects, so the MCP client never sees it.
 */
export const EXCLUDE_TOOLS_KEY = 'exclude_tools';

/** One tool a manual leaves out: the server entry it is declared on, and the name that server lists it under. */
export type ExcludedTool = readonly [server: string, tool: string];

/**
 * The tool names a declared exclude list holds, each once; an absent
 * declaration is an empty list. Null when it is not a list of non-empty
 * strings. The one reading of a declared list: discovery reads
 * `plugin.json`'s with it, and registration reads the server entry's.
 */
export function excludeListOf(declared: unknown): string[] | null {
  if (declared === undefined) return [];
  if (!Array.isArray(declared) || !declared.every((tool) => typeof tool === 'string' && tool.length > 0)) return null;
  return [...new Set(declared as string[])];
}

/**
 * The tools an `mcp` manual leaves out, per server entry. Null when a server
 * entry's list is not a list of tool names ({@link excludeListOf}). It reads
 * nothing but the lists, so it says the same before and after registration.
 */
export function excludedTools(template: CallTemplate): ExcludedTool[] | null {
  if (template.call_template_type !== 'mcp') return [];
  const servers = (template as { config?: { mcpServers?: unknown } }).config?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const excluded: ExcludedTool[] = [];
  for (const [server, entry] of Object.entries(servers as Record<string, unknown>)) {
    const list = excludeListOf(entry && typeof entry === 'object' ? (entry as Record<string, unknown>)[EXCLUDE_TOOLS_KEY] : undefined);
    if (list === null) return null;
    for (const tool of list) excluded.push([server, tool]);
  }
  return excluded;
}

/**
 * Take `excluded` ({@link excludedTools} of the manual just registered) OFF
 * the client's tool repository: gone from `tools/list`,
 * `list_tools`/`tools_info` and the interfaces `call_tool_chain` generates,
 * which are all built from it, and a call by name finds no tool. Run by
 * `registerManual`, the one point every registration passes through (a first
 * discovery, a session recovery, a catalog refresh), so no surface can
 * register a manual and keep one. `registeredManual` is the name UTCP
 * registered the manual under, read from UTCP after the registration and not
 * worked out here: a tool is `<manual>.<server>.<tool>` under that name. A
 * name the server does not list removes nothing.
 */
export async function removeExcludedTools(
  client: CodeModeUtcpClient,
  registeredManual: string,
  excluded: readonly ExcludedTool[],
): Promise<void> {
  for (const [server, tool] of excluded) await client.config.tool_repository.removeTool(`${registeredManual}.${server}.${tool}`);
}
