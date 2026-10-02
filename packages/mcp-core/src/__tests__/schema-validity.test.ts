import { describe, expect, it } from 'vitest';
import { CODE_MODE_META_TOOLS } from '../meta-tools.js';
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
 */
describe("Hexis's own meta-tool schemas", () => {
  it.each(CODE_MODE_META_TOOLS.map((t) => [t.name, t] as const))('%s declares valid JSON Schema', (_name, tool) => {
    expect(inputSchemaDefect(tool.inputSchema)).toBeNull();
  });
});
