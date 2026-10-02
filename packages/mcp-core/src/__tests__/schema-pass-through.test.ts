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

  /**
   * The cap is a STACK guard, and a schema no server sends is the only thing
   * that reaches it. What matters is that reaching it cannot produce an invalid
   * schema — which is exactly what the old cap did, and what cost three real
   * tools. 150 levels of nesting costs 300 of the walk's depth, so everything
   * in the leaf below is past a cap of 200.
   */
  describe('a schema deep enough to reach the depth cap', () => {
    const deepLeaf = {
      type: 'object',
      properties: {
        socialLinks: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        value: { anyOf: [{ type: 'object', required: ['id'] }] },
        thing: { $ref: '#/$defs/thing' },
        count: { type: 'integer', format: 'int32' },
      },
      required: ['value'],
    };
    const deep = { ...nest(150, deepLeaf), $defs: { thing: { type: 'string' } } };
    const shallow = { ...nest(5, deepLeaf), $defs: { thing: { type: 'string' } } };

    it('still offers a schema a client accepts', () => {
      // The old cap failed exactly here: `{}` at the position it stopped at
      // made `anyOf`, a `required` entry or a `type` invalid, and the client
      // refused the tool.
      expect(inputSchemaDefect(sanitizeInputSchema(deep))).toBeNull();
    });

    it('strips the subtree past the cap, and nothing before it', () => {
      const past = JSON.stringify(sanitizeInputSchema(deep));
      const within = JSON.stringify(sanitizeInputSchema(shallow));
      // The leaf's own content is what says the strip HAPPENED. `$ref` and
      // `int32` alone would not: the ordinary rules remove both wherever the
      // walk reaches them, so a cap that never fired — or one that went back to
      // returning `{}` — would pass on those two assertions alike.
      expect(past).not.toContain('socialLinks');
      expect(within).toContain('socialLinks');
      // And the consequence that matters: a `$ref` past the cap would DANGLE,
      // since the `$defs` block it points into is dropped at the root, and an
      // unsupported `format` past it is what the Anthropic validator refuses
      // the whole listing over.
      expect(past).not.toContain('$ref');
      expect(past).not.toContain('int32');
    });
  });

  it('bounds a schema whose `$ref`s branch instead of nesting', () => {
    // Each entry points TWICE at the next. Nothing is recursive, so the
    // recursion guard has nothing to catch, and an expansion that doubles per
    // level is 2^40 nodes from 40 short lines — a few hundred bytes on the wire
    // asking `tools/list` for a reply no memory holds.
    const $defs: Record<string, unknown> = { d40: { type: 'string' } };
    for (let i = 39; i >= 0; i -= 1) {
      $defs[`d${i}`] = { allOf: [{ $ref: `#/$defs/d${i + 1}` }, { $ref: `#/$defs/d${i + 1}` }] };
    }
    const listed = sanitizeInputSchema({ type: 'object', properties: { a: { $ref: '#/$defs/d0' } }, $defs });
    expect(JSON.stringify(listed).length).toBeLessThan(2_000_000);
    // Bounded, and still a schema: past the budget a `$ref` degrades to the
    // same permissive `{}` a recursive one does.
    expect(inputSchemaDefect(listed)).toBeNull();
  });

  it('sanitizes the siblings it keeps in place of a `$ref` it cannot inline', () => {
    // JSON Schema allows keywords beside a `$ref`, and when the reference
    // cannot be inlined those keywords are what stands there instead. They are
    // schema keywords like any others, so an unsupported `format` in them has
    // to go and a `$ref` nested in them has to be resolved — otherwise a large
    // but perfectly valid schema smuggles both past the sanitizer.
    const listed = sanitizeInputSchema({
      type: 'object',
      properties: { node: { $ref: '#/$defs/node' } },
      $defs: {
        node: {
          type: 'object',
          properties: {
            // Recursive, so the siblings are returned in its place.
            child: { $ref: '#/$defs/node', format: 'int32', items: { $ref: '#/$defs/leaf' } },
          },
        },
        leaf: { type: 'string' },
      },
    });
    expect(listed).toEqual({
      type: 'object',
      properties: { node: { type: 'object', properties: { child: { items: { type: 'string' } } } } },
    });
    expect(inputSchemaDefect(listed)).toBeNull();
  });

  describe('instance data, which is not a schema at any depth', () => {
    // `default`, `enum`, `const` and `examples` carry VALUES. A key named
    // `format`, `$ref` or `$defs` inside one is part of what the tool expects,
    // and rewriting it would change the tool's meaning rather than protect it.
    const data = {
      default: { format: 'int32', $ref: '#/$defs/thing', nested: { definitions: 1 } },
      enum: [{ format: 'byte' }, { $defs: {} }],
      const: { format: 'byte' },
      examples: [{ $ref: 'anything' }],
    };

    it('is handed back exactly as it came', () => {
      const sent = {
        type: 'object',
        properties: { mode: { type: 'object', ...data } },
        $defs: { thing: { type: 'string' } },
      };
      const listed = sanitizeInputSchema(sent) as { properties: { mode: unknown } };
      expect(listed.properties.mode).toEqual({ type: 'object', ...data });
    });

    it('is not stripped past the depth cap either', () => {
      // The cap replaces an object with `{}` where a SCHEMA stands, and `{}`
      // there means "any value". Under `default` it would silently change what
      // the tool is told to default to.
      let value: Record<string, unknown> = { leaf: true };
      for (let i = 0; i < 150; i += 1) value = { level: value };
      const sent = { type: 'object', properties: { deep: { type: 'object', default: value } } };
      expect(sanitizeInputSchema(sent)).toEqual(sent);
    });
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
