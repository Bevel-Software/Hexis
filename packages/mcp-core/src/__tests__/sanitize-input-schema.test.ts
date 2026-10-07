import { describe, expect, it } from 'vitest';
import { sanitizeInputSchema, toListedTool, type ProxiedTool } from '../proxied-tool.js';

describe('toListedTool', () => {
  const proxied = (inputSchema: unknown): ProxiedTool => ({
    utcpName: 'm.t',
    mcpName: 't',
    description: 'the t tool',
    inputSchema: inputSchema as ProxiedTool['inputSchema'],
    manualName: 'm',
  });

  it('coerces a `properties` ARRAY to {} — an array passes typeof but is not a property map', () => {
    const listed = toListedTool(proxied({ type: 'object', properties: [{ name: 'x' }] }));
    expect(listed?.inputSchema.properties).toEqual({});
  });

  it('keeps a well-formed properties object intact', () => {
    const listed = toListedTool(proxied({ type: 'object', properties: { x: { type: 'string' } } }));
    expect(listed?.inputSchema.properties).toEqual({ x: { type: 'string' } });
  });
});

describe('sanitizeInputSchema', () => {
  it('drops a non-standard format keyword but keeps a standard one', () => {
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: {
          count: { type: 'integer', format: 'int32' },
          when: { type: 'string', format: 'date-time' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        count: { type: 'integer' },
        when: { type: 'string', format: 'date-time' },
      },
    });
  });

  it('preserves a property literally named `format` — property keys are data, not keywords', () => {
    const schema = {
      type: 'object',
      properties: {
        format: { type: 'string', description: 'output format' },
      },
      required: ['format'],
    };
    expect(sanitizeInputSchema(schema)).toEqual(schema);
  });

  it('preserves properties named `definitions`, `$defs` and `$ref` the same way', () => {
    const schema = {
      type: 'object',
      properties: {
        definitions: { type: 'array', items: { type: 'string' } },
        $defs: { type: 'object' },
        $ref: { type: 'string' },
      },
    };
    expect(sanitizeInputSchema(schema)).toEqual(schema);
  });

  it('still sanitizes the SCHEMA of a property named `format`', () => {
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: {
          format: { type: 'string', format: 'byte' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        format: { type: 'string' },
      },
    });
  });

  it('still inlines $refs and drops the $defs block at keyword position', () => {
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: { item: { $ref: '#/$defs/thing' } },
        $defs: { thing: { type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { item: { type: 'string' } },
    });
  });

  it('resolves a `$dynamicRef` like a `$ref`, and never leaves one dangling once `$defs` is gone', () => {
    // A local pointer is inlined, as a `$ref` is.
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: { item: { $dynamicRef: '#/$defs/thing' } },
        $defs: { thing: { type: 'string', $dynamicAnchor: 'thing' } },
      }),
    ).toEqual({ type: 'object', properties: { item: { type: 'string', $dynamicAnchor: 'thing' } } });
    // A plain-name fragment cannot be resolved here; it degrades to `{}`
    // ("any value") rather than reaching a client as a reference into a
    // block that is no longer there.
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: { item: { $dynamicRef: '#thing', description: 'kept' } },
        $defs: { thing: { type: 'string', $dynamicAnchor: 'thing' } },
      }),
    ).toEqual({ type: 'object', properties: { item: { description: 'kept' } } });
  });

  it('walks `dependentSchemas` and `dependencies` as maps of the tool\'s own field names', () => {
    // A dependency on a field named `default` or `enum` is still a schema to
    // sanitize — a keyword only by coincidence of its name.
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: { default: { type: 'string' }, enum: { type: 'string' } },
        dependentSchemas: {
          default: { properties: { count: { type: 'integer', format: 'int32' } } },
          enum: { properties: { item: { $ref: '#/$defs/thing' } } },
        },
        dependencies: { default: ['enum'], enum: { properties: { n: { type: 'number', format: 'double' } } } },
        $defs: { thing: { type: 'string' } },
      }),
    ).toEqual({
      type: 'object',
      properties: { default: { type: 'string' }, enum: { type: 'string' } },
      dependentSchemas: {
        default: { properties: { count: { type: 'integer' } } },
        enum: { properties: { item: { type: 'string' } } },
      },
      dependencies: { default: ['enum'], enum: { properties: { n: { type: 'number' } } } },
    });
  });

  it('inlines `$ref` and `$dynamicRef` both when a schema carries both, as the `allOf` they amount to', () => {
    expect(
      sanitizeInputSchema({
        type: 'object',
        properties: { item: { $ref: '#/$defs/a', $dynamicRef: '#/$defs/b', description: 'kept' } },
        $defs: { a: { type: 'string' }, b: { minLength: 1 } },
      }),
    ).toEqual({
      type: 'object',
      properties: { item: { description: 'kept', allOf: [{ type: 'string' }, { minLength: 1 }] } },
    });
  });

  it('charges a reference the whole size of its target, array entries and scalars included, so repeated references cannot multiply it', () => {
    // A target that is mostly a `required` list of strings — the shape a
    // per-object count never saw — referenced three times: the budget is
    // spent by the first copies, and the reference that no longer fits is
    // `{}` rather than another twelve thousand names.
    const wide = { type: 'object', required: Array.from({ length: 12_000 }, (_, i) => `f${i}`) };
    const out = sanitizeInputSchema({
      type: 'object',
      properties: { a: { $ref: '#/$defs/wide' }, b: { $ref: '#/$defs/wide' }, c: { $ref: '#/$defs/wide' } },
      $defs: { wide },
    }) as { properties: Record<string, { required?: string[] }> };
    const copies = Object.values(out.properties).filter((p) => (p.required?.length ?? 0) === 12_000).length;
    expect(copies).toBeGreaterThan(0);
    expect(copies).toBeLessThan(3);
    // What did not fit is `{}` whole: a valid schema, never a dangling reference or a cut list.
    expect(Object.values(out.properties).every((p) => p.required === undefined || p.required.length === 12_000)).toBe(true);
    expect(JSON.stringify(out)).not.toContain('$ref');
  });

  it('answers `{}` for a single target larger than the whole budget, keeping the siblings', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 25_000; i += 1) wide[`f${i}`] = { type: 'string' };
    const out = sanitizeInputSchema({
      type: 'object',
      properties: { item: { $ref: '#/$defs/wide', description: 'kept' } },
      $defs: { wide: { type: 'object', properties: wide } },
    });
    expect(out).toEqual({ type: 'object', properties: { item: { description: 'kept' } } });
  });
});
