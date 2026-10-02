import { describe, expect, it } from 'vitest';
import {
  BODY_AT_TOP_LEVEL_LINE,
  argumentsDoNotMatchMessage,
  callExample,
  callLine,
  compileCheck,
  describeInterface,
  splitCallLine,
  withCallExample,
} from '../tool-interface.js';

/**
 * The call example and the interface text, against the schemas the three kinds
 * of tool really declare: a platform tool (arguments under `body`), a
 * deployment's flat tool, and a connected server's schema the checker cannot
 * reason about.
 */

/** The shape `toolDef` produces: the flat inputs wrapped in a required `body`. */
function platformTool(inputs: Record<string, unknown>) {
  return { type: 'object', properties: { body: inputs }, required: ['body'], additionalProperties: false };
}

const READ_FILE_INPUTS = {
  type: 'object',
  properties: {
    branch: { type: 'string', description: 'The branch (draft) whose workspace this operates on.' },
    path: { type: 'string', description: 'Path to read.' },
    offset: { type: 'integer', description: 'Start character index (default 0).' },
    limit: { type: 'integer', description: 'Max characters to return from `offset`.' },
  },
  required: ['branch', 'path'],
  additionalProperties: false,
};

const SEARCH_INPUTS = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'The search text.' },
    limit: { type: 'integer', description: 'How many results.' },
  },
  required: ['query'],
  additionalProperties: false,
};

describe('callExample', () => {
  it('shows a platform tool with its arguments under `body`', () => {
    expect(callLine('KNOWLEDGE_BASE.read_file', platformTool(READ_FILE_INPUTS))).toBe(
      'Call: KNOWLEDGE_BASE.read_file({ body: { branch: "...", path: "..." } })',
    );
  });

  it('shows a flat tool with its arguments at the top level', () => {
    expect(callLine('NS.search', SEARCH_INPUTS)).toBe('Call: NS.search({ query: "..." })');
  });

  it('leaves optional arguments out', () => {
    expect(callExample('NS.search', SEARCH_INPUTS)).not.toContain('limit');
  });

  it('uses a placeholder per type', () => {
    const inputs = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
        ratio: { type: 'number' },
        force: { type: 'boolean' },
        items: { type: 'array' },
        extra: { type: 'object' },
        untyped: {},
      },
      required: ['name', 'count', 'ratio', 'force', 'items', 'extra', 'untyped'],
    };
    expect(callExample('NS.t', inputs)).toBe(
      'NS.t({ name: "...", count: 0, ratio: 0, force: true, items: [], extra: {}, untyped: "..." })',
    );
  });

  it('shows a tool with no required arguments as an empty object', () => {
    expect(callExample('NS.list', { type: 'object', properties: { q: { type: 'string' } } })).toBe('NS.list({})');
  });

  it('names the tool with no namespace when it is not registered under a manual', () => {
    expect(callLine('call_tool_chain', { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] })).toBe(
      'Call: call_tool_chain({ code: "..." })',
    );
  });

  it('is the first line of a description, and is never stacked twice', () => {
    const once = withCallExample('What it does.', 'NS.search', SEARCH_INPUTS);
    expect(once.split('\n')[0]).toBe('Call: NS.search({ query: "..." })');
    expect(withCallExample(once, 'NS.search', SEARCH_INPUTS)).toBe(once);
  });

  it('splits back into the call line and the rest', () => {
    const described = withCallExample('What it does.', 'NS.search', SEARCH_INPUTS);
    expect(splitCallLine(described)).toEqual({
      call: 'Call: NS.search({ query: "..." })',
      rest: 'What it does.',
    });
    expect(splitCallLine('no call line here')).toEqual({ call: null, rest: 'no call line here' });
  });
});

describe('describeInterface', () => {
  it('gives every argument its type, whether it is required, and its description', () => {
    expect(describeInterface(SEARCH_INPUTS)).toEqual([
      'query (string, required) — The search text.',
      'limit (integer, optional) — How many results.',
    ]);
  });

  it('goes one level below the top, and no further', () => {
    const deep = platformTool({
      type: 'object',
      properties: {
        files: {
          type: 'object',
          properties: { nested: { type: 'object', properties: { deeper: { type: 'string' } } } },
        },
      },
      required: ['files'],
    });
    const lines = describeInterface(deep);
    expect(lines).toContain('body (object, required)');
    expect(lines.some((l) => l.includes('files'))).toBe(true);
    expect(lines.some((l) => l.includes('deeper'))).toBe(false);
  });
});

describe('compileCheck', () => {
  const check = (inputs: unknown, args: Record<string, unknown>) => {
    const compiled = compileCheck(inputs);
    if (!compiled.checkable) throw new Error(`expected a checkable schema: ${compiled.reason}`);
    return compiled.check(args);
  };

  it('passes a call that matches', () => {
    expect(check(SEARCH_INPUTS, { query: 'x' })).toEqual([]);
    expect(check(platformTool(READ_FILE_INPUTS), { body: { branch: 'main', path: 'a.md' } })).toEqual([]);
  });

  it('says the arguments go at the top level when a flat tool is called with a `body`', () => {
    const mismatches = check(SEARCH_INPUTS, { body: { query: 'x' } });
    expect(mismatches[0]).toBe(BODY_AT_TOP_LEVEL_LINE);
    expect(mismatches).toContain('"query" is required, and was not given.');
    expect(mismatches).toContain('"body" is not an argument of this tool.');
  });

  it('names a required argument that is missing, one level down', () => {
    const writeFile = platformTool({
      type: 'object',
      properties: { branch: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } },
      required: ['branch', 'path', 'content'],
      additionalProperties: false,
    });
    expect(check(writeFile, { body: { branch: 'b', path: 'a.md' } })).toEqual([
      '"body.content" is required, and was not given.',
    ]);
  });

  it('leaves a missing `branch` to the refusal that names it', () => {
    expect(check(platformTool(READ_FILE_INPUTS), { body: { path: 'a.md' } })).toEqual([]);
  });

  it('names the argument, the type expected and the type given', () => {
    expect(check(SEARCH_INPUTS, { query: 'x', limit: 'ten' })).toEqual([
      '"limit" must be integer, but string was given.',
    ]);
  });

  it('accepts an integer where a number is declared, and refuses a fraction where an integer is', () => {
    expect(check({ type: 'object', properties: { n: { type: 'number' } } }, { n: 3 })).toEqual([]);
    expect(check({ type: 'object', properties: { n: { type: 'integer' } } }, { n: 3.5 })).toEqual([
      '"n" must be integer, but number was given.',
    ]);
  });

  it('names an argument the tool does not have when the schema forbids extras', () => {
    expect(check(SEARCH_INPUTS, { query: 'x', nope: 1 })).toEqual(['"nope" is not an argument of this tool.']);
  });

  it('lets an extra argument through when the schema allows extras', () => {
    const open = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] };
    expect(check(open, { query: 'x', nope: 1 })).toEqual([]);
  });

  it('switches checking off for a schema it cannot reason about, with a reason', () => {
    for (const inputs of [
      { anyOf: [{ type: 'object' }, { type: 'string' }] },
      { type: 'object', properties: { a: { type: 'string' } }, $ref: '#/$defs/x' },
      { type: 'string' },
      'not a schema at all',
      { type: 'object', properties: 'nonsense' },
    ]) {
      const compiled = compileCheck(inputs);
      expect(compiled.checkable, JSON.stringify(inputs)).toBe(false);
      if (!compiled.checkable) expect(compiled.reason.length).toBeGreaterThan(0);
    }
  });

  it('checks the rest of a schema whose ONE property it cannot judge', () => {
    const mixed = {
      type: 'object',
      properties: { query: { type: 'string' }, filter: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
      required: ['query'],
      additionalProperties: false,
    };
    expect(check(mixed, { query: 'x', filter: { any: 'shape' } })).toEqual([]);
    expect(check(mixed, { filter: 'whatever' })).toEqual(['"query" is required, and was not given.']);
  });
});

describe('argumentsDoNotMatchMessage', () => {
  it('holds the sentence, the mismatches, the interface and the example, in that order', () => {
    const message = argumentsDoNotMatchMessage('search', 'NS.search', SEARCH_INPUTS, [
      BODY_AT_TOP_LEVEL_LINE,
      '"query" is required, and was not given.',
    ]);
    const lines = message.split('\n');
    expect(lines[0]).toBe('The arguments do not match the "search" tool.');
    expect(lines[1]).toBe(BODY_AT_TOP_LEVEL_LINE);
    expect(lines[2]).toBe('"query" is required, and was not given.');
    expect(lines[3]).toBe('Interface of "search":');
    expect(lines[4]).toBe('query (string, required) — The search text.');
    expect(lines[lines.length - 1]).toBe('Call: NS.search({ query: "..." })');
  });

  it('says so when the tool takes no arguments at all', () => {
    expect(argumentsDoNotMatchMessage('ping', 'NS.ping', { type: 'object', properties: {} }, ['x'])).toContain(
      '(this tool takes no arguments)',
    );
  });
});
