import { describe, expect, it } from 'vitest';
import { codeModeMetaTools } from '../meta-tools.js';
import { inputSchemaDefect, schemaDefectMarker } from '../schema-validity.js';

describe('inputSchemaDefect', () => {
  it('names the place and the reason for a `required` entry that is not a string', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: { value: { anyOf: [{ type: 'object', required: [7] }] } },
      }),
    ).toEqual({ path: '/properties/value/anyOf/0/required/0', reason: 'must be a string' });
  });

  it('names the place and the reason for an `anyOf` that is not a list', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: { socialLinks: { type: 'array', items: { anyOf: {} } } },
      }),
    ).toEqual({ path: '/properties/socialLinks/items/anyOf', reason: 'must be an array' });
  });

  it('names the place and the reason for a `type` that is not an allowed value', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: { value: { properties: { table: { type: {} } } } },
      }),
    ).toEqual({
      path: '/properties/value/properties/table/type',
      reason: 'must be equal to one of the allowed values',
    });
  });

  it('reports a schema that is not an object at all', () => {
    expect(inputSchemaDefect([{ type: 'object' }])).toEqual({ path: '/', reason: 'must be an object' });
    expect(inputSchemaDefect('object')).toEqual({ path: '/', reason: 'must be an object' });
    // `true` and `false` are legal JSON Schema — "accept anything", "accept
    // nothing" — but MCP requires an input schema to be an object, so a client
    // refuses them. Were this to regress it would be the ajv branch below that
    // answered, and ajv calls both of them valid.
    expect(inputSchemaDefect(true)).toEqual({ path: '/', reason: 'must be an object' });
    expect(inputSchemaDefect(false)).toEqual({ path: '/', reason: 'must be an object' });
    // `null` is a DECLARED schema that is not an object, not an absent one.
    expect(inputSchemaDefect(null)).toEqual({ path: '/', reason: 'must be an object' });
  });

  /**
   * The meta-schema says a `pattern` is a string and stops there. A client goes
   * on to COMPILE it (the MCP SDK's validator is `ajv.compile`), which throws —
   * and the tool is dropped exactly as silently as for any other defect.
   */
  it('reports a `pattern` that is not a compilable regular expression', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: { code: { type: 'string', pattern: '[' } },
      }),
    ).toEqual({ path: '/properties/code/pattern', reason: 'must be a valid regular expression' });
  });

  it('reports a bad regex wherever a schema stands — inside `anyOf`, `items`, `$defs`', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: { rows: { type: 'array', items: { anyOf: [{ type: 'string', pattern: 'a{2,1}' }] } } },
      }),
    ).toEqual({ path: '/properties/rows/items/anyOf/0/pattern', reason: 'must be a valid regular expression' });
    expect(inputSchemaDefect({ type: 'object', $defs: { x: { pattern: '(' } }, properties: {} })).toEqual({
      path: '/$defs/x/pattern',
      reason: 'must be a valid regular expression',
    });
  });

  it('reports a `patternProperties` KEY that is not a compilable regular expression', () => {
    expect(inputSchemaDefect({ type: 'object', patternProperties: { 'a/[': { type: 'string' } } })).toEqual({
      // `/` inside a name is `~1` in a JSON Pointer, so the path still points
      // at one place.
      path: '/patternProperties/a~1[',
      reason: 'must be a valid regular expression',
    });
  });

  it('accepts the regexes real schemas carry, including the ones only the `u` flag judges', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: {
          slug: { type: 'string', pattern: '^[a-zA-Z0-9_\\-]+$' },
          phone: { type: 'string', pattern: '\\d{3}-\\d{2}' },
          word: { type: 'string', pattern: '\\p{L}+' },
          named: { type: 'string', pattern: '^(?<year>\\d{4})$' },
        },
        patternProperties: { '^x-': { type: 'string' } },
      }),
    ).toBeNull();
  });

  it('does not read a `pattern` that is a tool\'s own field, or one inside a `const`', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        // A field NAMED pattern, whose value happens to be the string `[`.
        properties: { pattern: { type: 'string', const: '[' } },
        default: { pattern: '[' },
      }),
    ).toBeNull();
  });

  /**
   * FAIL-OPEN, the one branch where being wrong costs a working tool. A schema
   * naming a dialect this validator has never heard of makes ajv throw, and a
   * validator fault is not evidence against the server's tool.
   */
  it('reports no defect when the validator itself cannot process the schema', () => {
    expect(
      inputSchemaDefect({
        $schema: 'https://example.invalid/draft/2029-13/schema',
        type: 'object',
        properties: {},
      }),
    ).toBeNull();
  });

  it('accepts a rich but valid schema — `anyOf` lists, `required` lists, nested `items`', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: {
          filter: {
            anyOf: [
              { type: 'object', required: ['property'], properties: { property: { type: 'string' } } },
              { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              { type: 'null' },
            ],
          },
        },
        required: ['filter'],
        additionalProperties: false,
      }),
    ).toBeNull();
  });

  it('accepts an absent schema — the listing supplies `{}` for one', () => {
    expect(inputSchemaDefect(undefined)).toBeNull();
    expect(inputSchemaDefect({})).toBeNull();
  });

  it('does not object to a keyword it does not know, which no client refuses', () => {
    expect(inputSchemaDefect({ type: 'object', properties: {}, 'x-hubspot-widget': true })).toBeNull();
  });

  it('quotes the place and the reason in the marker the owner reads', () => {
    expect(schemaDefectMarker({ path: '/required/0', reason: 'must be a string' })).toBe(
      'Hidden from agents: its schema is invalid at /required/0 (must be a string).',
    );
  });
});

/**
 * Hexis's own tools, so Hexis never ships what it hides other servers' tools
 * for. These are the meta-tools every surface advertises; the REST tool defs
 * are checked where they are built, in `platform-core-backend`.
 *
 * `codeModeMetaTools` is a FUNCTION of the namespace, the catalog it writes
 * its worked example against and the shared-rules pointer, so the defs are
 * built per mount rather than being one constant. Both ends of that range are
 * measured: a bare mount (no namespace, no catalog) and a mount with both. The
 * arguments shape DESCRIPTIONS rather than schemas, which is exactly the claim
 * worth pinning — a future argument that reached a schema would fail here.
 */
describe("Hexis's own meta-tool schemas", () => {
  const mounts = [
    ['bare', codeModeMetaTools('', [])],
    [
      'as mounted',
      codeModeMetaTools('hexis', [{ utcpName: 'hexis.read_file', inputSchema: { type: 'object', properties: {} } }], {
        sharedRulesPointer: 'The shared rules are in AGENTS.md.',
      }),
    ],
  ] as const;

  it.each(mounts.flatMap(([mount, tools]) => tools.map((t) => [`${t.name} (${mount})`, t] as const)))(
    '%s declares valid JSON Schema',
    (_label, tool) => {
      expect(inputSchemaDefect(tool.inputSchema)).toBeNull();
    },
  );

  it('measures every meta-tool a mount advertises, not a subset', () => {
    // A new meta-tool must arrive in this suite by being advertised, not by
    // being added to a list here — so the count is read off the mount.
    for (const [mount, tools] of mounts) {
      expect(tools.length, mount).toBeGreaterThanOrEqual(3);
      expect(tools.map((t) => t.name), mount).toContain('list_tools');
    }
  });
});
