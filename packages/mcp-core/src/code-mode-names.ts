import type { Tool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';

/**
 * Pure helpers for mapping UTCP tool names to their code-mode (TypeScript)
 * accessible form. Kept Mastra-free so the agent's Mastra tools
 * (`code-mode.tool.ts`), the hosted MCP proxy and the local MCP server can all
 * share them.
 */

export function sanitizeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');
}

/** `MANUAL.tool` → the `manual.tool` form the code-mode runtime exposes. */
export function utcpNameToTsInterfaceName(utcpName: string): string {
  if (utcpName.includes('.')) {
    const [manualName, ...toolParts] = utcpName.split('.');
    return `${sanitizeIdentifier(manualName!)}.${toolParts.map(sanitizeIdentifier).join('_')}`;
  }
  return sanitizeIdentifier(utcpName);
}

/** Resolve a tool by its raw UTCP name or its sanitized TS-accessible name. */
export async function findToolByName(
  client: CodeModeUtcpClient,
  name: string,
): Promise<{ tool: Tool; utcpName: string } | null> {
  const direct = await client.config.tool_repository.getTool(name);
  if (direct) return { tool: direct, utcpName: name };

  const all = await client.config.tool_repository.getTools();
  for (const tool of all) {
    if (utcpNameToTsInterfaceName(tool.name) === name) {
      return { tool, utcpName: tool.name };
    }
  }
  return null;
}
