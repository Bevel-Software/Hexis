import { describe, expect, it } from 'vitest';
import { chainExample, type ChainExampleTool } from '../chain-example.js';
import { codeModeMetaTools } from '../meta-tools.js';
import { kbToolSchema } from './kb-tool-schema.js';

/**
 * The example call in `call_tool_chain`'s description.
 *
 * The Acceptance Criterion is that an agent copying the example gets a WORKING
 * call, and the first attempt at this read the tool NAME off the live catalog
 * while leaving its ARGUMENTS as fixed text — `{ body: { path: '…' } }`. Every
 * knowledge-base tool declares `branch` required, so the copied example
 * answered `400 … \`branch\` is required`. These tests pin both halves, and the
 * central one checks the arguments against the tool's own schema rather than
 * against a string, so the next hardcoded argument cannot slip past either.
 */

const READ_FILE = kbToolSchema(['branch', 'path']);
const NO_ARGS = kbToolSchema([]);

/** The hosted endpoint: the KB manual is http, so names are two segments. */
const HOSTED: ChainExampleTool[] = [
  { utcpName: 'KNOWLEDGE_BASE.read_file', inputSchema: READ_FILE },
  { utcpName: 'KNOWLEDGE_BASE.write_file', inputSchema: kbToolSchema(['branch', 'path', 'content']) },
  { utcpName: 'KNOWLEDGE_BASE.start_session', inputSchema: NO_ARGS },
];

/** The local server: one MCP manual whose single server shares its name. */
const LOCAL: ChainExampleTool[] = [
  { utcpName: 'hexis.hexis.read_file', inputSchema: READ_FILE },
  { utcpName: 'hexis.hexis.start_session', inputSchema: NO_ARGS },
];

/**
 * Does `call` satisfy the schema of the tool it names? This is the check whose
 * absence let the broken example through: the old tests compared the example to
 * a string, so nothing noticed that the string omitted a required argument.
 */
function satisfiesSchema(call: string, tools: readonly ChainExampleTool[]): true | string {
  const match = /^([\w.$]+)\((.*)\)$/s.exec(call);
  if (!match) return `"${call}" is not a call expression`;
  const [, name, args] = match;
  const tool = tools.find((t) => callableName(t.utcpName) === name);
  if (!tool) return `"${name}" is not a tool in the catalog`;
  let value: unknown;
  try {
    // The example is JavaScript source destined for a chain, so the only
    // faithful way to read it back is to evaluate it as JavaScript.
    value = new Function(`return (${args || 'undefined'});`)() as unknown;
  } catch (err) {
    return `arguments are not valid JavaScript: ${err instanceof Error ? err.message : String(err)}`;
  }
  return missingRequired(tool.inputSchema, value, name) ?? true;
}

/** `MANUAL.a.b` → `MANUAL.a_b`, the way the chain runtime binds it. */
function callableName(utcpName: string): string {
  const dot = utcpName.indexOf('.');
  if (dot < 0) return utcpName;
  return `${utcpName.slice(0, dot)}.${utcpName.slice(dot + 1).replace(/\./g, '_')}`;
}

/** The first required property `value` is missing, as a message, or null. */
function missingRequired(schema: unknown, value: unknown, path: string): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as { required?: unknown; properties?: unknown; type?: unknown };
  if (s.type !== 'object' && !s.properties) return null;
  if (value === null || typeof value !== 'object') return `${path} is not an object`;
  const required = Array.isArray(s.required) ? s.required : [];
  const properties = (s.properties ?? {}) as Record<string, unknown>;
  for (const key of required) {
    if (typeof key !== 'string') continue;
    if (!(key in (value as Record<string, unknown>))) return `${path} is missing required "${key}"`;
    const deeper = missingRequired(
      properties[key],
      (value as Record<string, unknown>)[key],
      `${path}.${key}`,
    );
    if (deeper) return deeper;
  }
  return null;
}

describe('the example call satisfies the schema of the tool it names', () => {
  it('does on the hosted endpoint', () => {
    const { call } = chainExample('KNOWLEDGE_BASE', HOSTED);
    expect(call).not.toBeNull();
    expect(satisfiesSchema(call!, HOSTED)).toBe(true);
  });

  it('does through the local server', () => {
    const { call } = chainExample('hexis', LOCAL);
    expect(call).not.toBeNull();
    expect(satisfiesSchema(call!, LOCAL)).toBe(true);
  });

  it('does for the call printed in the description itself, not just the builder', () => {
    for (const [ns, tools] of [['KNOWLEDGE_BASE', HOSTED], ['hexis', LOCAL]] as const) {
      const description = codeModeMetaTools(ns, tools).find((t) => t.name === 'call_tool_chain')!.description!;
      const printed = /works exactly as written: `return ([^`]+);`/.exec(description);
      expect(printed, `no example call in the ${ns} description`).not.toBeNull();
      expect(satisfiesSchema(printed![1]!, tools)).toBe(true);
    }
  });

  /**
   * The regression itself. A catalog where the ONLY tool requires a free-form
   * `branch` is one where no example can be written truthfully — and the
   * failure mode to avoid is printing `read_file({ body: { path: '…' } })`
   * anyway, which is what shipped.
   */
  it('prints no call at all rather than one missing a required argument', () => {
    const branchOnly: ChainExampleTool[] = [{ utcpName: 'KNOWLEDGE_BASE.read_file', inputSchema: READ_FILE }];
    expect(chainExample('KNOWLEDGE_BASE', branchOnly).call).toBeNull();
    const description = codeModeMetaTools('KNOWLEDGE_BASE', branchOnly).find(
      (t) => t.name === 'call_tool_chain',
    )!.description!;
    expect(description).not.toContain('works exactly as written');
    // The shape and the pointer at `tools_info` are still there, and so is the
    // warning that made this a bug in the first place.
    expect(description).toContain('`KNOWLEDGE_BASE.<tool>({ body: { ...args } })`');
    expect(description).toContain('branch');
    expect(description).toContain('tools_info');
  });

  it('never invents a value for a required argument the schema leaves open', () => {
    // A free-form string, number or boolean names a type, not a value.
    for (const schema of [
      kbToolSchema(['branch']),
      { type: 'object', properties: { body: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }, required: ['body'] },
      { type: 'object', properties: { body: { type: 'object', properties: { f: { type: 'boolean' } }, required: ['f'] } }, required: ['body'] },
    ]) {
      expect(chainExample('X', [{ utcpName: 'X.t', inputSchema: schema }]).call).toBeNull();
    }
  });

  it('uses a value the schema itself names — a default or a closed enum', () => {
    const withDefault = {
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: { mode: { type: 'string', enum: ['fast', 'slow'] }, depth: { type: 'integer', default: 3 } },
          required: ['mode', 'depth'],
        },
      },
      required: ['body'],
    };
    expect(chainExample('X', [{ utcpName: 'X.scan', inputSchema: withDefault }]).call).toBe(
      "X.scan({ body: { mode: 'fast', depth: 3 } })",
    );
  });

  it('writes the no-argument call as the empty body the schema asks for', () => {
    expect(chainExample('hexis', LOCAL).call).toBe('hexis.hexis_start_session({ body: {} })');
  });

  it('omits every optional argument — an example asks for nothing it was not asked for', () => {
    // A schema whose REQUIRED argument is determined (a closed enum) and which
    // also declares optional ones, each with a value the schema names. Those
    // are the arguments an example could be tempted to write — over the hosted
    // fixture the call is `start_session({ body: {} })`, which carries no
    // argument either way and so could not have failed.
    const withOptionals = {
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['fast', 'full'] },
            limit: { type: 'integer', default: 30 },
            verbose: { type: 'boolean', default: false },
            format: { type: 'string', enum: ['json'] },
          },
          required: ['mode'],
        },
      },
      required: ['body'],
    };
    const { call } = chainExample('X', [{ utcpName: 'X.scan', inputSchema: withOptionals }]);
    expect(call).toBe("X.scan({ body: { mode: 'fast' } })");
    for (const optional of ['limit', 'verbose', 'format']) expect(call).not.toContain(optional);
  });

  /**
   * `__proto__` is a property name a schema may require, and written bare in
   * an object literal it sets the prototype instead of creating the property.
   * The example is read back as JavaScript, which is the only reading that
   * shows the difference.
   */
  it('writes a required argument named __proto__ as an own property, not as the prototype', () => {
    const schema = {
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: { ['__proto__']: { type: 'string', enum: ['x'] } },
          required: ['__proto__'],
        },
      },
      required: ['body'],
    };
    const { call } = chainExample('X', [{ utcpName: 'X.odd', inputSchema: schema }]);
    expect(call).not.toBeNull();
    const args = new Function(`return (${call!.slice('X.odd('.length, -1)});`)() as { body: object };
    expect(Object.prototype.hasOwnProperty.call(args.body, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(args.body)).toBe(Object.prototype);
  });
});

describe('the example name', () => {
  it('is read off the catalog, in the form the runtime binds', () => {
    expect(chainExample('KNOWLEDGE_BASE', HOSTED).name).toBe('KNOWLEDGE_BASE.read_file');
    expect(chainExample('hexis', LOCAL).name).toBe('hexis.hexis_read_file');
  });

  it('prefers this connection\'s own namespace over another manual\'s', () => {
    const mixed: ChainExampleTool[] = [
      { utcpName: 'localbox.read_file', inputSchema: READ_FILE },
      { utcpName: 'hexis.hexis.ask', inputSchema: kbToolSchema(['prompt']) },
    ];
    expect(chainExample('hexis', mixed).name).toBe('hexis.hexis_ask');
  });

  it('falls back to any tool when the connection\'s own namespace has none', () => {
    expect(chainExample('hexis', [{ utcpName: 'localbox.local_echo' }]).name).toBe('localbox.local_echo');
  });

  it('names no tool for an empty catalog, rather than one it would have to invent', () => {
    expect(chainExample('hexis', [])).toEqual({ namespace: 'hexis', name: null, call: null });
    // And the descriptions say nothing they cannot back: no `e.g.` at all.
    const tools = codeModeMetaTools('hexis', []);
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toContain('read_file`)');
      expect(tool.description, tool.name).not.toContain('e.g. `null`');
      expect(tool.description, tool.name).not.toContain('(e.g. `hexis.');
    }
    expect(tools.find((t) => t.name === 'list_tools')!.description).toBe(
      'List every UTCP tool currently registered, in TypeScript-accessible form for use inside `call_tool_chain`.',
    );
  });

  it('names no tool when every name in the catalog is shared by two tools', () => {
    const colliding: ChainExampleTool[] = [
      { utcpName: 'M.s.a', inputSchema: NO_ARGS },
      { utcpName: 'M.s_a', inputSchema: NO_ARGS },
    ];
    expect(chainExample('M', colliding)).toEqual({ namespace: 'M', name: null, call: null });
  });

  it('sanitizes the namespace the way the runtime does', () => {
    expect(chainExample('my-deployment', [{ utcpName: 'my-deployment.read_file' }]).name).toBe(
      'my_deployment.read_file',
    );
  });
});

describe('the example is stable and bounded', () => {
  it('does not change between two listings of the same catalog, whatever the order', () => {
    const shuffled = [...HOSTED].reverse();
    expect(chainExample('KNOWLEDGE_BASE', shuffled)).toEqual(chainExample('KNOWLEDGE_BASE', HOSTED));
  });

  it('survives a tool with no schema, a malformed one, and one deep enough to exhaust the depth budget', () => {
    const deep: Record<string, unknown> = { type: 'object', required: ['body'] };
    // A schema deep enough to exhaust the walker's depth budget.
    let node: Record<string, unknown> = deep;
    for (let i = 0; i < 40; i += 1) {
      const child: Record<string, unknown> = { type: 'object', required: ['body'] };
      node.properties = { body: child };
      node = child;
    }
    const odd: ChainExampleTool[] = [
      { utcpName: 'X.no_schema' },
      { utcpName: 'X.null_schema', inputSchema: null },
      { utcpName: 'X.array_schema', inputSchema: [] },
      { utcpName: 'X.string_schema', inputSchema: 'nonsense' },
      { utcpName: 'X.deep', inputSchema: deep },
      { utcpName: 'X.ok', inputSchema: NO_ARGS },
    ];
    expect(chainExample('X', odd).call).toBe('X.ok({ body: {} })');
  });

  it('quotes a key or a value that is not a bare identifier', () => {
    const awkward = {
      type: 'object',
      properties: {
        'odd-key': { type: 'string', default: "it's" },
      },
      required: ['odd-key'],
    };
    const { call } = chainExample('X', [{ utcpName: 'X.t', inputSchema: awkward }]);
    expect(call).toBe("X.t({ 'odd-key': 'it\\'s' })");
    // And it is still valid JavaScript after the quoting.
    expect(new Function(`return (${/\((.*)\)$/s.exec(call!)![1]});`)()).toEqual({ 'odd-key': "it's" });
  });
  /**
   * A schema's own `default` or `enum` is the only place an example's values
   * come from — so a schema that contradicts itself must not produce a call.
   * cubic caught `enum: [1, 5]` beside `minimum: 5`: taking the first entry
   * unconditionally advertised a call the server would refuse.
   */
  it('skips a named value its own schema forbids, and takes one it allows', () => {
    const body = (inner: Record<string, unknown>) => ({
      type: 'object',
      properties: { body: { type: 'object', properties: { n: inner }, required: ['n'] } },
      required: ['body'],
    });
    // Every entry violates `minimum`, so the tool affords no example at all.
    expect(chainExample('X', [{ utcpName: 'X.t', inputSchema: body({ type: 'integer', enum: [1, 2], minimum: 5 }) }]).call).toBeNull();
    // The second entry satisfies it, so it is used rather than the first.
    expect(chainExample('X', [{ utcpName: 'X.t', inputSchema: body({ type: 'integer', enum: [1, 7], minimum: 5 }) }]).call).toBe(
      'X.t({ body: { n: 7 } })',
    );
    // A `default` gets the same treatment — including against `pattern`.
    expect(
      chainExample('X', [{ utcpName: 'X.t', inputSchema: body({ type: 'string', default: 'nope', pattern: '^ok$' }) }]).call,
    ).toBeNull();
    // And against the type it declares beside the value.
    expect(chainExample('X', [{ utcpName: 'X.t', inputSchema: body({ type: 'integer', default: 'seven' }) }]).call).toBeNull();
  });

  /**
   * `minProperties` without `required` names a count, not the properties — so
   * the object the walker builds from `required` alone can be too thin, and
   * which property would fill it is not something the schema says.
   */
  it('refuses a tool whose object demands more properties than it names required', () => {
    const schema = {
      type: 'object',
      properties: { body: { type: 'object', properties: { a: { type: 'string' } }, minProperties: 1 } },
      required: ['body'],
    };
    expect(chainExample('X', [{ utcpName: 'X.t', inputSchema: schema }]).call).toBeNull();
    // Satisfied by a required property, the same schema is usable again.
    expect(
      chainExample('X', [
        {
          utcpName: 'X.t',
          inputSchema: {
            type: 'object',
            properties: {
              body: { type: 'object', properties: { a: { type: 'string', enum: ['v'] } }, required: ['a'], minProperties: 1 },
            },
            required: ['body'],
          },
        },
      ]).call,
    ).toBe("X.t({ body: { a: 'v' } })");
  });

  /**
   * Two catalog entries can sanitize to ONE callable name (`A.b.c` and `A.b_c`
   * both become `A.b_c`). The runtime binds one of them and the description
   * cannot say which, so such a name is no example — the call might reach a
   * tool whose arguments are not the schema it was derived from.
   */
  it('never names a tool whose callable name another catalog entry shares', () => {
    const collide: ChainExampleTool[] = [
      { utcpName: 'X.a.read_file', inputSchema: NO_ARGS },
      { utcpName: 'X.a_read_file', inputSchema: NO_ARGS },
    ];
    expect(chainExample('X', collide).call).toBeNull();
    // The unambiguous entry beside them is used instead, for the name as well.
    const { name, call } = chainExample('X', [...collide, { utcpName: 'X.start_session', inputSchema: NO_ARGS }]);
    expect(name).toBe('X.start_session');
    expect(call).toBe('X.start_session({ body: {} })');
  });

  /**
   * A schema-derived string is pasted into chain source AND into a Markdown
   * code span. A raw newline makes the literal a SyntaxError; a backtick closes
   * the span and truncates the call. Both must survive the quoting.
   */
  it('escapes a value carrying a line terminator or a backtick', () => {
    const value = 'a\nb`c\u2028d\u0001';
    const schema = {
      type: 'object',
      properties: { body: { type: 'object', properties: { s: { type: 'string', default: value } }, required: ['s'] } },
      required: ['body'],
    };
    const { call } = chainExample('X', [{ utcpName: 'X.t', inputSchema: schema }]);
    expect(call).not.toMatch(/\n/);
    expect(call).not.toContain('`');
    // Still the value it came from once the chain evaluates it.
    expect(new Function(`return (${/\((.*)\)$/s.exec(call!)![1]});`)()).toEqual({ body: { s: value } });
  });
});
