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

/**
 * Sanitized TS name → every UTCP tool that claims it, from ONE catalog fetch.
 * Collisions are kept, not collapsed: sanitization is lossy (`a-b` and `a_b`
 * both become `a_b`), and a lookup that silently picked one would describe —
 * or dispatch — the wrong tool.
 */
async function tsNameIndex(client: CodeModeUtcpClient): Promise<Map<string, Tool[]>> {
  const index = new Map<string, Tool[]>();
  for (const tool of await client.config.tool_repository.getTools()) {
    const tsName = utcpNameToTsInterfaceName(tool.name);
    const bucket = index.get(tsName);
    if (bucket) bucket.push(tool);
    else index.set(tsName, [tool]);
  }
  return index;
}

function resolveSanitized(
  index: Map<string, Tool[]>,
  name: string,
): { tool: Tool; utcpName: string } | null {
  const bucket = index.get(name);
  if (!bucket || bucket.length === 0) return null;
  if (bucket.length > 1) {
    throw new Error(
      `Tool name "${name}" is ambiguous: ${bucket.map((t) => `"${t.name}"`).join(', ')} ` +
        'all sanitize to it. Call the tool by its exact UTCP name instead.',
    );
  }
  return { tool: bucket[0]!, utcpName: bucket[0]!.name };
}

/**
 * Resolve a tool by its raw UTCP name or its sanitized TS-accessible name.
 * Throws when the sanitized name is claimed by more than one tool (an exact
 * UTCP name always wins and can't be ambiguous).
 */
export async function findToolByName(
  client: CodeModeUtcpClient,
  name: string,
): Promise<{ tool: Tool; utcpName: string } | null> {
  const direct = await client.config.tool_repository.getTool(name);
  if (direct) return { tool: direct, utcpName: name };
  return resolveSanitized(await tsNameIndex(client), name);
}

/**
 * Resolve a batch of names against ONE catalog fetch (`tools_info` takes a
 * list, and a per-name `getTools()` re-fetch scales with the list). Names that
 * resolve are in the map; missing ones are simply absent; an ambiguous
 * sanitized name throws, as in {@link findToolByName}.
 */
export async function findToolsByNames(
  client: CodeModeUtcpClient,
  names: string[],
): Promise<Map<string, { tool: Tool; utcpName: string }>> {
  const out = new Map<string, { tool: Tool; utcpName: string }>();
  let index: Map<string, Tool[]> | undefined;
  for (const name of names) {
    if (out.has(name)) continue;
    const direct = await client.config.tool_repository.getTool(name);
    if (direct) {
      out.set(name, { tool: direct, utcpName: name });
      continue;
    }
    index ??= await tsNameIndex(client);
    const resolved = resolveSanitized(index, name);
    if (resolved) out.set(name, resolved);
  }
  return out;
}
