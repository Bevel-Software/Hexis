import { describe, expect, it } from 'vitest';
import { inputSchemaDefect } from '../schema-validity.js';
import { toListedTool, sanitizeInputSchema, type ProxiedTool } from '../proxied-tool.js';

/**
 * The proxy passes a connected server's input schema through UNCHANGED, and
 * this file is what pins it. It exists because it did not: three tools from
 * Notion and HubSpot were silently dropped by an AI client, each with a reason
 * naming a place in the schema that Hexis had ruined on the way out.
 *
 * The cause was the depth cap in `sanitizeInputSchema`, which replaced
 * whatever node it stopped at with `{}`. At the eighth level of nesting a
 * schema came out with `anyOf: {}`, `required: [{}]` and `type: {}` in it, and
 * none of those is valid JSON Schema, so the client refused the tool and
 * blamed the server. `anyOf` lists, `required` lists and nested `items` are
 * exactly the constructs that broke, so they are what the fixture carries.
 */

/** `levels` of `properties` nesting around `leaf`, as a real tool's schema nests. */
function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let i = levels; i > 0; i -= 1) {
    node = { type: 'object', properties: { [`level${i}`]: node }, required: [`level${i}`] };
  }
  return node;
}

/**
 * The three constructs the dropped tools were refused over, in one leaf: a
 * HubSpot-shaped `socialLinks` array of a union, a Notion-shaped `value` whose
 * `anyOf` branch carries a `required` list, and a plain `type`.
 */
const LEAF = {
  type: 'object',
  properties: {
    socialLinks: {
      type: 'array',
      items: { anyOf: [{ type: 'string' }, { type: 'null' }, { type: 'object' }] },
    },
    value: {
      anyOf: [
        { type: 'object', required: ['id', 'name'], properties: { id: { type: 'string' } } },
        { type: 'null' },
      ],
    },
    table: { type: 'object', properties: { rows: { type: 'array', items: { type: 'string' } } } },
  },
  required: ['socialLinks', 'value'],
} as const;

const proxied = (inputSchema: unknown): ProxiedTool => ({
  utcpName: 'notion.notion.notion-query-data-sources',
  mcpName: 'notion_notion_query_data_sources',
  description: 'query a data source',
  inputSchema: inputSchema as ProxiedTool['inputSchema'],
  manualName: 'notion',
});

describe('a connected tool\'s input schema reaches clients as the server sent it', () => {
  // 1 and 5 passed before the fix; 8 is where the cap used to bite, and 30 is
  // past any depth a real server reaches.
  for (const levels of [1, 5, 8, 12, 30]) {
    it(`is identical at ${levels} levels of nesting`, () => {
      const sent = nest(levels, LEAF as unknown as Record<string, unknown>);
      expect(toListedTool(proxied(sent))?.inputSchema).toEqual(sent);
    });
  }

  it('offers a schema a client accepts, at the depth that used to break it', () => {
    const sent = nest(12, LEAF as unknown as Record<string, unknown>);
    expect(inputSchemaDefect(toListedTool(proxied(sent))?.inputSchema)).toBeNull();
  });

  it('keeps `items` as a LIST of schemas, which is not a property map', () => {
    const sent = {
      type: 'object',
      properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'number' }] } },
    };
    expect(sanitizeInputSchema(sent)).toEqual(sent);
  });

  it('inlines a RECURSIVE $ref as a permissive `{}` rather than a dangling reference', () => {
    // A self-referential schema has no finite inlined form. `{}` stands at a
    // schema position, so what comes out is still valid JSON Schema — which is
    // the whole point, and what `{}` at any other position destroyed.
    const listed = sanitizeInputSchema({
      type: 'object',
      properties: { node: { $ref: '#/$defs/node' } },
      $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
    });
    expect(listed).toEqual({
      type: 'object',
      properties: { node: { type: 'object', properties: { child: {} } } },
    });
    expect(inputSchemaDefect(listed)).toBeNull();
  });
});
