import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
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

  it('reports a bad regex wherever a schema stands — inside `anyOf`, `items`, and a `$defs` entry a `$ref` reaches', () => {
    expect(
      inputSchemaDefect({
        type: 'object',
        properties: { rows: { type: 'array', items: { anyOf: [{ type: 'string', pattern: 'a{2,1}' }] } } },
      }),
    ).toEqual({ path: '/properties/rows/items/anyOf/0/pattern', reason: 'must be a valid regular expression' });
    // Reported at the entry's OWN path — where the server's owner edits it —
    // whichever reference reached it.
    for (const keyword of ['$ref', '$dynamicRef']) {
      expect(
        inputSchemaDefect({ type: 'object', $defs: { x: { pattern: '(' } }, properties: { v: { [keyword]: '#/$defs/x' } } }),
      ).toEqual({ path: '/$defs/x/pattern', reason: 'must be a valid regular expression' });
    }
  });

  it('does not report a `$defs` entry nothing references: no client compiles it and the listing never carries it', () => {
    // ajv is lazy on `$defs`, and the proxy drops the block, inlining only
    // what a `$ref` reaches — so a bad regex there hides no tool anywhere, and
    // flagging it would hide one for a place the offered schema does not have.
    expect(inputSchemaDefect({ type: 'object', $defs: { x: { pattern: '(' } }, properties: {} })).toBeNull();
    expect(inputSchemaDefect({ type: 'object', definitions: { x: { pattern: '(' } }, properties: {} })).toBeNull();
    // A reference that does not resolve reaches nothing, and two references
    // to one entry are one entry.
    expect(
      inputSchemaDefect({
        type: 'object',
        $defs: { x: { pattern: '(' }, ok: { type: 'string' } },
        properties: { a: { $ref: '#/$defs/missing' }, b: { $ref: '#/$defs/ok' }, c: { $ref: '#/$defs/ok' } },
      }),
    ).toBeNull();
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
  /**
   * The guard does not assert the meta-schema's own `format` annotations
   * (`$id` and `$ref` as `uri-reference`), and this is where that decision is
   * a check rather than a comment. Two things hold, and either alone settles
   * it:
   *
   *  - a client COMPILES these. Run as the MCP SDK runs it
   *    (`{ strict: false, validateFormats: true, validateSchema: false }` —
   *    `validation/ajv-provider.js`), ajv accepts both schemas below, so
   *    flagging them would hide a tool that works.
   *  - asserting the formats would not catch them anyway: ajv-formats'
   *    `uri-reference` accepts `http://[bad` and `http:// not a uri`, so
   *    `validateFormats: true` changes no verdict in this family.
   *
   * What a client really refuses in this family is a `$ref` it cannot RESOLVE,
   * and no such `$ref` is ever offered: `sanitizeInputSchema` replaces an
   * unresolvable or non-local one with `{}` before the listing goes out — see
   * `schema-pass-through.test.ts`.
   */
  it('does not flag a malformed `$id` or `$ref` URI, which no client refuses either', () => {
    expect(inputSchemaDefect({ $id: 'http://[bad', type: 'object', properties: { a: { type: 'string' } } })).toBeNull();
    expect(inputSchemaDefect({ $id: 'http:// not a uri', type: 'object', properties: {} })).toBeNull();
    // An unresolvable `$ref` is not flagged HERE because it never reaches a
    // client as a reference; the proxy's own test pins that half.
    expect(
      inputSchemaDefect({ type: 'object', properties: { a: { $ref: '#/$defs/not here' } }, $defs: {} }),
    ).toBeNull();
  });

  /**
   * The other side of the same line: `$anchor` is constrained by a PATTERN in
   * the meta-schema rather than by a `format`, so the guard already catches a
   * malformed one with formats switched off. Pinned so that a future
   * `validateFormats` change shows up as a change in behaviour rather than in
   * configuration.
   */
  it('still catches a malformed `$anchor`, which the meta-schema constrains by pattern', () => {
    expect(inputSchemaDefect({ type: 'object', $anchor: '9 not an anchor' })).toEqual({
      path: '/$anchor',
      reason: 'must match pattern "^[A-Za-z_][-A-Za-z0-9._]*$"',
    });
  });

  /**
   * The remedy a reader naturally reaches for here — "register the draft
   * formats and switch assertions on instead of disabling them" — is INERT,
   * and this pins that instead of leaving it an argument in a comment.
   *
   * `ajv.validateSchema` does not assert the meta-schema's own `format`
   * annotations at all, even though the bundled 2020-12 meta-schemas carry
   * them: `uri-reference` on `$id`/`$ref`, `regex` on `pattern`. So every one
   * of these passes the meta-check with `validateFormats: true` exactly as it
   * does with it off.
   *
   * Which is also why the dedicated regex walk is not redundant with the
   * meta-check. `pattern: "["` is the one schema in this corpus a client
   * really refuses — `ajv.compile` throws `Invalid regular expression` on it —
   * the meta-check misses it under EITHER setting, and only the dedicated walk
   * catches it. A future change to `validateFormats` therefore has to justify
   * itself by behaviour, because by itself it has none.
   */
  it('would flag nothing more with format assertions on, which is why `pattern` is checked directly', () => {
    const badPattern = { type: 'object', properties: { x: { type: 'string', pattern: '[' } } };
    const corpus: Record<string, unknown>[] = [
      badPattern,
      { $id: 'http://[bad', type: 'object' },
      { $id: 'http:// not a uri', type: 'object' },
      { type: 'object', properties: { x: { $ref: 'http://[bad' } } },
    ];
    const asserting = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
    const offAndOn = corpus.map((schema) => ({
      withFormatsOn: asserting.validateSchema(schema) === true,
      guardVerdict: inputSchemaDefect(schema),
    }));
    // Formats on: the meta-schema accepts every one of them.
    expect(offAndOn.map((entry) => entry.withFormatsOn)).toEqual([true, true, true, true]);
    // The guard's own verdicts are unchanged by that — only the `pattern` is
    // flagged, and by the regex walk rather than by any format.
    expect(offAndOn.map((entry) => entry.guardVerdict)).toEqual([
      { path: '/properties/x/pattern', reason: 'must be a valid regular expression' },
      null,
      null,
      null,
    ]);
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
