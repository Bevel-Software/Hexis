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
    const { call } = chainExample('KNOWLEDGE_BASE', HOSTED);
    for (const optional of ['offset', 'limit', 'sessionId']) expect(call).not.toContain(optional);
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

  it('falls back to the namespace shape only for an empty catalog', () => {
    expect(chainExample('hexis', [])).toEqual({ namespace: 'hexis', name: 'hexis.read_file', call: null });
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

  it('survives a tool with no schema, a malformed one, and a self-referential one', () => {
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
});
