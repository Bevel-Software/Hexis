import { describe, expect, it } from 'vitest';
import { hexisCatalog } from '../../../__tests__/hexis-catalog.js';
import type { UtcpTool } from '../../tool-registry/index.js';

/**
 * The platform's tools as an agent can call them: each tool's name, where it
 * is served, and every argument it takes (nested ones by their dotted path),
 * which are required, and the values an enum allows. Kept as a committed file,
 * `tool-surface.json` beside this test.
 *
 * Why: the guide teaches these calls, and a change to them is the change most
 * likely to leave the guide wrong without failing anything else. The guide
 * check (`guide-matches-code.test.ts`) catches a name the guide uses that the
 * code lost; it cannot catch an argument the code GAINED, or one that became
 * required, that the guide should now mention. This file does: a pull request
 * that changes the surface fails here until it updates the file, and the
 * updated file shows the change in the diff where reviewers see it. That is
 * the moment to update the guide, or to say in the pull request that no guide
 * change is needed. Accept with
 * `pnpm --filter @bevel-software/platform-core-backend exec vitest run src/modules/agent-guide -u`.
 */

const ACCEPT =
  'The tool surface changed (a tool, an argument, a required flag or an enum value). If agents need to know, ' +
  'update the guide in packages/core-backend/agent-guide/ in this pull request; then accept the new surface with ' +
  '`pnpm --filter @bevel-software/platform-core-backend exec vitest run src/modules/agent-guide -u`. See AGENTS.md.';

type Schema = { type?: unknown; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] };

/** Every argument under `schema`, by dotted path (`files[].path`), with its required flag and enum. */
function argumentsOf(schema: Schema | undefined, prefix = '', depth = 0): string[] {
  if (!schema?.properties || depth > 3) return [];
  return Object.entries(schema.properties)
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, sub]) => {
      const path = `${prefix}${name}`;
      const required = schema.required?.includes(name) ? ' (required)' : '';
      const allowed = sub.enum ?? sub.items?.enum;
      const line = `${path}${required}${allowed ? `: ${allowed.join(' | ')}` : ''}`;
      const nested = sub.items?.properties ? argumentsOf(sub.items, `${path}[].`, depth + 1) : argumentsOf(sub, `${path}.`, depth + 1);
      return [line, ...nested];
    });
}

/** A platform tool's own arguments: under `body` when it takes them there, flat otherwise. */
function ownArguments(tool: UtcpTool): string[] {
  const inputs = (tool.inputs ?? (tool as { inputSchema?: unknown }).inputSchema) as Schema | undefined;
  const body = inputs?.properties?.body;
  return body ? argumentsOf(body).map((a) => `body.${a}`) : argumentsOf(inputs);
}

describe('the tool surface agents are taught', () => {
  it('matches the surface the guide was last checked against', async () => {
    const { internal, external, metaTools } = await hexisCatalog();
    const surfaces = new Map<string, Set<string>>();
    const tools = new Map<string, UtcpTool>();
    for (const [surface, list] of [
      ['in-app agent', internal],
      ['MCP', external],
      ['MCP', metaTools as unknown as UtcpTool[]],
    ] as const) {
      for (const tool of list) {
        tools.set(tool.name, tool);
        surfaces.set(tool.name, (surfaces.get(tool.name) ?? new Set()).add(surface));
      }
    }
    const surface = Object.fromEntries(
      [...tools.keys()].sort().map((name) => [
        name,
        { servedTo: [...surfaces.get(name)!].sort(), arguments: ownArguments(tools.get(name)!) },
      ]),
    );
    await expect(`${JSON.stringify(surface, null, 2)}\n`).toMatchFileSnapshot('./tool-surface.json', ACCEPT);
  });
});
