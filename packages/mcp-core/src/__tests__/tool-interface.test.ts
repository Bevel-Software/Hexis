import { describe, expect, it, vi } from 'vitest';
import {
  BODY_AT_TOP_LEVEL_LINE,
  argumentsDoNotMatchMessage,
  callExample,
  callLine,
  compileCheck,
  describeInterface,
  patternMayBacktrack,
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

describe('callExample, for keys and arrays a bare placeholder would get wrong', () => {
  it('quotes a required key that is not an identifier', () => {
    const inputs = { type: 'object', properties: { 'odd-key': { type: 'string' } }, required: ['odd-key'] };
    expect(callLine('NS.odd', inputs)).toBe('Call: NS.odd({ "odd-key": "..." })');
  });

  it('shows an array that must not be empty with one element, so the example satisfies its schema', () => {
    const inputs = {
      type: 'object',
      properties: { tool_names: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['tool_names'],
    };
    expect(callLine('tools_info', inputs)).toBe('Call: tools_info({ tool_names: ["..."] })');
    const compiled = compileCheck(inputs);
    if (!compiled.checkable) throw new Error(compiled.reason);
    expect(compiled.check({ tool_names: ['...'] })).toEqual([]);
  });

  it('caps the placeholders an array example holds, whatever `minItems` a connected schema declares', () => {
    const inputs = {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer' }, minItems: 1_000_000_000 } },
      required: ['ids'],
    };
    const started = Date.now();
    expect(callLine('NS.bulk', inputs)).toBe('Call: NS.bulk({ ids: [0, 0, 0, 0, 0, 0, 0, 0] })');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('shows a value that must be null as `null`, which the check accepts', () => {
    const inputs = { type: 'object', properties: { nothing: { type: 'null' } }, required: ['nothing'] };
    expect(callLine('NS.void', inputs)).toBe('Call: NS.void({ nothing: null })');
    const compiled = compileCheck(inputs);
    if (!compiled.checkable) throw new Error(compiled.reason);
    expect(compiled.check({ nothing: null })).toEqual([]);
  });

  it('keeps a required `__proto__` argument as an own property, rendered as a computed key', () => {
    const inputs = { type: 'object', properties: { __proto__: { type: 'string' } }, required: ['__proto__'] };
    expect(callLine('NS.odd', inputs)).toBe('Call: NS.odd({ ["__proto__"]: "..." })');
  });

  it('cuts the example off where the check stops looking, so the two agree on a deep schema', () => {
    const inputs = platformTool({
      type: 'object',
      properties: {
        deep: { type: 'object', properties: { deeper: { type: 'string' } }, required: ['deeper'] },
      },
      required: ['deep'],
    });
    expect(callLine('NS.deep', inputs)).toBe('Call: NS.deep({ body: { deep: {} } })');
    const compiled = compileCheck(inputs);
    if (!compiled.checkable) throw new Error(compiled.reason);
    expect(compiled.check({ body: { deep: {} } })).toEqual([]);
  });

  it('shows a value the schema fixes as that value', () => {
    const inputs = {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['fast', 'slow'] }, kind: { const: 'x' } },
      required: ['mode', 'kind'],
    };
    expect(callLine('NS.run', inputs)).toBe('Call: NS.run({ mode: "fast", kind: "x" })');
  });

  it('picks the first enum member the rest of the schema admits', () => {
    const inputs = {
      type: 'object',
      properties: { v: { type: 'string', enum: ['', 'ok'], minLength: 1 } },
      required: ['v'],
    };
    expect(callLine('NS.run', inputs)).toBe('Call: NS.run({ v: "ok" })');
  });

  it('picks a number every bound admits, between the bounds when it must', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'number', exclusiveMinimum: 1, maximum: 1.5 }, '1.5'],
      [{ type: 'number', exclusiveMinimum: 1, exclusiveMaximum: 1.5 }, '1.25'],
      [{ type: 'integer', minimum: 1 }, '1'],
      [{ type: 'integer', exclusiveMinimum: 0 }, '1'],
      [{ type: 'number', maximum: -2 }, '-2'],
      [{ type: 'integer', minimum: 0, maximum: 10 }, '0'],
    ];
    for (const [prop, shown] of cases) {
      const inputs = { type: 'object', properties: { v: prop }, required: ['v'] };
      expect(callLine('NS.n', inputs), JSON.stringify(prop)).toBe(`Call: NS.n({ v: ${shown} })`);
      const compiled = compileCheck(inputs);
      if (!compiled.checkable) throw new Error(compiled.reason);
      expect(compiled.check({ v: Number(shown) }), JSON.stringify(prop)).toEqual([]);
    }
  });
});

describe('compileCheck: the constraints a schema declares', () => {
  const check = (inputs: unknown, args: Record<string, unknown>) => {
    const compiled = compileCheck(inputs);
    if (!compiled.checkable) throw new Error(`expected a checkable schema: ${compiled.reason}`);
    return compiled.check(args);
  };
  const one = (prop: Record<string, unknown>) => ({ type: 'object', properties: { v: prop } });

  it('refuses a string shorter or longer than declared, and one that misses its pattern', () => {
    expect(check(one({ type: 'string', minLength: 1 }), { v: '' })).toEqual([
      '"v" must be at least 1 character(s) long, but 0 was given.',
    ]);
    expect(check(one({ type: 'string', maxLength: 2 }), { v: 'abc' })).toEqual([
      '"v" must be at most 2 character(s) long, but 3 was given.',
    ]);
    expect(check(one({ type: 'string', pattern: '^[a-z]+$' }), { v: 'A1' })).toEqual([
      '"v" must match the pattern ^[a-z]+$, but "A1" was given.',
    ]);
    expect(check(one({ type: 'string', minLength: 1, maxLength: 3, pattern: '^[a-z]+$' }), { v: 'ab' })).toEqual([]);
  });

  it('refuses a value outside its enum or const', () => {
    expect(check(one({ type: 'string', enum: ['a', 'b'] }), { v: 'c' })).toEqual([
      '"v" must be one of "a", "b", but "c" was given.',
    ]);
    expect(check(one({ const: 3 }), { v: 4 })).toEqual(['"v" must be 3, but 4 was given.']);
    expect(check(one({ type: 'string', enum: ['a', 'b'] }), { v: 'b' })).toEqual([]);
  });

  it('refuses a number outside its range', () => {
    expect(check(one({ type: 'integer', minimum: 1 }), { v: 0 })).toEqual(['"v" must be at least 1, but 0 was given.']);
    expect(check(one({ type: 'number', maximum: 1 }), { v: 1.5 })).toEqual(['"v" must be at most 1, but 1.5 was given.']);
    expect(check(one({ type: 'number', exclusiveMinimum: 0 }), { v: 0 })).toEqual([
      '"v" must be greater than 0, but 0 was given.',
    ]);
    expect(check(one({ type: 'integer', minimum: 1, maximum: 10 }), { v: 10 })).toEqual([]);
  });

  it('refuses an array of the wrong length, and an item that does not match its schema', () => {
    expect(check(one({ type: 'array', minItems: 1 }), { v: [] })).toEqual([
      '"v" must hold at least 1 item(s), but 0 was given.',
    ]);
    expect(check(one({ type: 'array', maxItems: 1 }), { v: [1, 2] })).toEqual([
      '"v" must hold at most 1 item(s), but 2 was given.',
    ]);
    expect(check(one({ type: 'array', items: { type: 'string' } }), { v: ['a', 2] })).toEqual([
      '"v[1]" must be string, but integer was given.',
    ]);
    expect(check(one({ type: 'array', items: { type: 'string', minLength: 1 } }), { v: ['a', ''] })).toEqual([
      '"v[1]" must be at least 1 character(s) long, but 0 was given.',
    ]);
    expect(check(one({ type: 'array', items: { type: 'string' }, minItems: 1 }), { v: ['a'] })).toEqual([]);
  });

  it('names a nested constraint by its path', () => {
    const inputs = platformTool({ type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] });
    expect(check(inputs, { body: { name: '' } })).toEqual(['"body.name" must be at least 1 character(s) long, but 0 was given.']);
  });

  it('matches an object in an enum or const whatever order its keys were written in', () => {
    expect(check(one({ type: 'object', enum: [{ a: 1, b: [1, 2] }] }), { v: { b: [1, 2], a: 1 } })).toEqual([]);
    expect(check(one({ const: { a: 1, b: 2 } }), { v: { b: 2, a: 1 } })).toEqual([]);
    expect(check(one({ const: { a: [1, 2] } }), { v: { a: [2, 1] } })).toHaveLength(1);
    expect(check(one({ const: { a: 1 } }), { v: { a: 1, b: 2 } })).toHaveLength(1);
  });

  it('does not run a pattern that could backtrack catastrophically, and returns at once', () => {
    for (const pattern of ['^(a+)+$', '^(a|a)*$', '^(\\w+\\s?)*$', '^((ab)*)+$', '^(a+){2,}$', '^(a)\\1$']) {
      expect(patternMayBacktrack(pattern), pattern).toBe(true);
    }
    for (const pattern of ['^[a-z]+$', '^(?:ab)+$', '^(a+)?$', '^[(+)]*$', '^\\(a+\\)+$', '^a{1,3}b*$']) {
      expect(patternMayBacktrack(pattern), pattern).toBe(false);
    }
    // Never run, rather than run fast: no RegExp built from it ever sees the
    // value (a short one, so a regression fails here instead of hanging).
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    const test = vi.spyOn(RegExp.prototype, 'test');
    try {
      expect(check(one({ type: 'string', pattern: '^(a+)+$' }), { v: `${'a'.repeat(12)}!` })).toEqual([]);
      const ran = [...exec.mock.contexts, ...test.mock.contexts].filter((re) => (re as RegExp).source === '^(a+)+$');
      expect(ran).toEqual([]);
    } finally {
      exec.mockRestore();
      test.mockRestore();
    }
  });

  it('does not assert `format`, which JSON Schema treats as an annotation', () => {
    expect(check(one({ type: 'string', format: 'email' }), { v: 'not an email' })).toEqual([]);
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

  it('says nothing about `body` when an open schema with nothing required accepts it as any extra key', () => {
    const open = { type: 'object', properties: { query: { type: 'string' } } };
    expect(check(open, { body: {} })).toEqual([]);
    expect(check({ ...open, additionalProperties: false }, { body: {} })).toEqual([
      BODY_AT_TOP_LEVEL_LINE,
      '"body" is not an argument of this tool.',
    ]);
  });

  it('switches checking off for a boolean subschema rather than reading it as `{}`', () => {
    for (const inputs of [
      { type: 'object', properties: { never: false }, required: ['never'] },
      { type: 'object', properties: { list: { type: 'array', items: false } } },
      { type: 'object', properties: { body: { type: 'object', properties: { any: true } } } },
    ]) {
      const compiled = compileCheck(inputs);
      expect(compiled.checkable).toBe(false);
      if (!compiled.checkable) expect(compiled.reason).toContain('boolean subschema');
    }
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

  it('treats an argument named `branch` like any other: a connected tool declares its own', () => {
    // The platform's `branch-required` refusal is applied by the platform's
    // routes (`route-argument-check.ts`), not here: a connected server whose
    // tool happens to name an argument `branch` gets its declaration enforced.
    expect(check(platformTool(READ_FILE_INPUTS), { body: { path: 'a.md' } })).toEqual([
      '"body.branch" is required, and was not given.',
    ]);
    expect(check(platformTool(READ_FILE_INPUTS), { body: { path: 'a.md', branch: 42 } })).toEqual([
      '"body.branch" must be string, but integer was given.',
    ]);
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

  it('takes the example from another schema when the call is checked flat', () => {
    // What a route-hosted tool needs: its handler receives the FLAT arguments,
    // so the mismatches and the interface name those — while the example has to
    // show the envelope an agent types.
    const message = argumentsDoNotMatchMessage(
      'read_file',
      'KNOWLEDGE_BASE.read_file',
      READ_FILE_INPUTS,
      ['"path" is required, and was not given.'],
      { exampleInputs: platformTool(READ_FILE_INPUTS) },
    );
    const lines = message.split('\n');
    expect(lines[2]).toBe('Interface of "read_file":');
    // The interface is the FLAT arguments, named as the handler receives them.
    expect(lines).toContain('path (string, required) — Path to read.');
    expect(lines).toContain('offset (integer, optional) — Start character index (default 0).');
    // The example is the envelope, which is what an agent types.
    expect(lines[lines.length - 1]).toBe('Call: KNOWLEDGE_BASE.read_file({ body: { branch: "...", path: "..." } })');
  });

  it('says so when the tool takes no arguments at all', () => {
    expect(argumentsDoNotMatchMessage('ping', 'NS.ping', { type: 'object', properties: {} }, ['x'])).toContain(
      '(this tool takes no arguments)',
    );
  });
});
