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
});
