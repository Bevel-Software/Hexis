import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  CHAIN_RUNTIME_PRELUDE,
  CHAIN_TIMEOUT_MAX_MS,
  chainNamespaces,
  describeChainFailure,
  runToolChain,
  withChainRuntime,
} from '../chain-runtime.js';
import { codeModeMetaTools } from '../meta-tools.js';
import type { ChainExampleTool } from '../chain-example.js';
import { kbToolSchema } from './kb-tool-schema.js';

/**
 * The chain runtime, at the level where it can be pinned exactly.
 *
 * The browser globals are plain JavaScript, so they are exercised here against
 * Node's OWN `atob`/`btoa`/`TextEncoder`/`TextDecoder` — the only authority on
 * "behaves as in a browser" that does not consist of restating this file's
 * arithmetic. That they are actually REACHABLE from a chain is a different
 * claim, and it is tested against a real isolate in core-backend's
 * `chain-runtime.e2e.test.ts`.
 */

/** The prelude, run the way the isolate runs it: against a bare global object. */
function sandbox(): Record<string, never> & {
  atob: (s: string) => string;
  btoa: (s: string) => string;
  TextEncoder: new () => { encode(s?: string): Uint8Array; encoding: string };
  TextDecoder: new (label?: string, options?: { ignoreBOM?: boolean }) => { decode(b?: unknown): string; encoding: string };
} {
  const g = {} as never;
  new Function('globalThis', CHAIN_RUNTIME_PRELUDE)(g);
  return g;
}

function utcpTool(name: string): Tool {
  return {
    name,
    description: `the ${name} tool`,
    inputs: { type: 'object', properties: {} },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: { call_template_type: 'http' } as never,
  } as Tool;
}

function clientWith(tools: Tool[], outcome?: { result: unknown; logs: string[] }) {
  const callToolChain = vi.fn(async () => outcome ?? { result: 'ok', logs: [] as string[] });
  const client = {
    config: { tool_repository: { getTools: vi.fn(async () => tools), getTool: vi.fn(async () => null) } },
    callToolChain,
  } as unknown as CodeModeUtcpClient;
  return { client, callToolChain };
}

const KB = [utcpTool('KNOWLEDGE_BASE.read_file'), utcpTool('KNOWLEDGE_BASE.ask')];

describe('the chain runtime is one physical line', () => {
  // The whole point of the single line: a chain's stack must keep naming the
  // chain's own line numbers. A prelude spread over 60 lines would report a
  // failure on line 3 of the agent's code as line 63 of something it cannot see.
  it('adds no line to the chain, so a stack still names the chain\'s own lines', () => {
    expect(CHAIN_RUNTIME_PRELUDE).not.toContain('\n');
    const code = 'const a = 1;\nconst b = 2;\nreturn WRONG.go();';
    expect(withChainRuntime(code).split('\n')).toHaveLength(code.split('\n').length);
    expect(withChainRuntime(code).endsWith(code)).toBe(true);
  });

  it('leaves the chain\'s own source intact, byte for byte', () => {
    expect(withChainRuntime('return 1')).toBe(`${CHAIN_RUNTIME_PRELUDE}return 1`);
  });
});

describe('atob and btoa, as in a browser', () => {
  it('decodes the Specification\'s own example', () => {
    expect(sandbox().atob('SGVsbG8=')).toBe('Hello');
  });

  it('matches Node\'s atob/btoa on every byte length, padding included', () => {
    const g = sandbox();
    for (const text of ['', 'H', 'Hi', 'Hey', 'Hello', 'Hello, world', '\x00\xff\x80']) {
      expect(g.btoa(text)).toBe(btoa(text));
      expect(g.atob(btoa(text))).toBe(text);
    }
  });

  it('matches Node across 500 random byte strings', () => {
    const g = sandbox();
    for (let i = 0; i < 500; i += 1) {
      const bytes = Array.from({ length: Math.floor(Math.random() * 40) }, () =>
        Math.floor(Math.random() * 256),
      );
      const binary = String.fromCharCode(...bytes);
      expect(g.btoa(binary)).toBe(Buffer.from(bytes).toString('base64'));
      expect(g.atob(Buffer.from(bytes).toString('base64'))).toBe(binary);
    }
  });

  it('is forgiving about whitespace and padding, as the base64 standard is', () => {
    const g = sandbox();
    expect(g.atob('SGVs bG8=\n')).toBe('Hello');
    expect(g.atob('SGVsbG8')).toBe('Hello');
  });

  it('throws on input a browser also refuses, rather than decoding to garbage', () => {
    const g = sandbox();
    expect(() => g.atob('!!!!')).toThrow(/not valid base64/);
    expect(() => g.atob('SGVsbG8=A')).toThrow(/not valid base64/);
    // Beyond Latin-1 there is no byte to encode; the message says to go
    // through TextEncoder, which is the way to base64 text.
    expect(() => g.btoa('😀')).toThrow(/TextEncoder/);
  });

  it('encodes Latin-1 text the way a browser does, not as UTF-8', () => {
    expect(sandbox().btoa('über')).toBe(btoa('über'));
  });
});

describe('TextEncoder and TextDecoder, for UTF-8', () => {
  it('round-trips the Specification\'s own example', () => {
    const g = sandbox();
    expect(new g.TextDecoder().decode(new g.TextEncoder().encode('über'))).toBe('über');
  });

  it('encodes exactly as Node does, astral planes included', () => {
    const g = sandbox();
    const node = new TextEncoder();
    for (const text of ['', 'ascii', 'über', 'ünïcödé', 'a😀b', '日本語', '\u{10FFFF}']) {
      expect(Array.from(new g.TextEncoder().encode(text))).toEqual(Array.from(node.encode(text)));
    }
  });

  it('decodes exactly as Node does across 2000 random byte sequences, malformed ones included', () => {
    const g = sandbox();
    const node = new TextDecoder();
    const decoder = new g.TextDecoder();
    for (let i = 0; i < 2000; i += 1) {
      const bytes = new Uint8Array(
        Array.from({ length: Math.floor(Math.random() * 12) }, () => Math.floor(Math.random() * 256)),
      );
      expect(decoder.decode(bytes)).toBe(node.decode(bytes));
    }
  });

  it('round-trips 300 random strings through Node\'s encoder and back', () => {
    const g = sandbox();
    const node = new TextEncoder();
    const decoder = new g.TextDecoder();
    for (let i = 0; i < 300; i += 1) {
      let text = '';
      for (let k = 0; k < Math.floor(Math.random() * 20); k += 1) {
        text += String.fromCodePoint(Math.floor(Math.random() * 0x10000));
      }
      expect(decoder.decode(node.encode(text))).toBe(new TextDecoder().decode(node.encode(text)));
    }
  });

  it('takes the shapes a browser takes, and reports utf-8 as its encoding', () => {
    const g = sandbox();
    const enc = new g.TextEncoder();
    const dec = new g.TextDecoder();
    expect(enc.encoding).toBe('utf-8');
    expect(dec.encoding).toBe('utf-8');
    expect(dec.decode()).toBe('');
    expect(dec.decode(enc.encode('hi').buffer)).toBe('hi');
    expect(dec.decode(new Uint8Array([]))).toBe('');
    expect(g.TextEncoder.name).toBe('TextEncoder');
    expect(g.TextDecoder.name).toBe('TextDecoder');
  });

  /**
   * A browser's default `TextDecoder` drops a leading byte-order mark
   * (`ignoreBOM: false`), and so does Node's — a chain reading a UTF-8 file
   * written on Windows would otherwise find a stray `\uFEFF` at the front of it,
   * which breaks a `JSON.parse` and every exact-match comparison. It is also
   * what makes the random equivalence tests above sound: without this, a
   * generated string beginning with U+FEFF decoded one way here and another in
   * Node, and the comparison failed on whichever run happened to draw one.
   */
  it('drops a leading byte-order mark, and keeps it only when asked to', () => {
    const g = sandbox();
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    expect(new g.TextDecoder().decode(withBom)).toBe('hi');
    expect(new g.TextDecoder().decode(withBom)).toBe(new TextDecoder().decode(withBom));
    expect(new g.TextDecoder('utf-8', { ignoreBOM: true }).decode(withBom)).toBe('\uFEFFhi');
    expect(new g.TextDecoder('utf-8', { ignoreBOM: true }).decode(withBom)).toBe(
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(withBom),
    );
    // Only the FIRST one, and only a whole one: a BOM further in is content,
    // and three bytes that merely start like one are still decoded.
    const inner = new Uint8Array([0x68, 0xef, 0xbb, 0xbf, 0x69]);
    expect(new g.TextDecoder().decode(inner)).toBe(new TextDecoder().decode(inner));
    const twice = new Uint8Array([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]);
    expect(new g.TextDecoder().decode(twice)).toBe(new TextDecoder().decode(twice));
    expect(new g.TextDecoder().decode(new Uint8Array([0xef, 0xbb]))).toBe(
      new TextDecoder().decode(new Uint8Array([0xef, 0xbb])),
    );
  });

  it('refuses an encoding it does not implement instead of answering mojibake', () => {
    expect(() => new (sandbox().TextDecoder)('latin1')).toThrow(/UTF-8 only/);
  });
});

describe('a chain that runs out of time', () => {
  const TIMED_OUT = {
    result: null,
    logs: ['[ERROR] Code execution failed: Script execution timeout after 1000ms'],
  };

  it('is answered with the limit it hit and how far it may be raised', async () => {
    const { client } = clientWith(KB, TIMED_OUT);
    const outcome = await runToolChain(client, 'while(true){}', 1_000);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('timed out after 1000 ms');
    expect(outcome.error).toContain('`timeout`');
    expect(outcome.error).toContain(String(CHAIN_TIMEOUT_MAX_MS));
  });

  /**
   * The runner appends its failure line in a `catch` and THEN, in the
   * `finally`, one `[WARN] Tool call "…" abandoned` line per call still in
   * flight — into the same array the caller receives. A chain that timed out
   * mid-call therefore has its reason second from last, and reading only the
   * last line reported that chain as a success with a null result.
   */
  it('is still recognised when abandoned-tool warnings were logged after it', async () => {
    const { client } = clientWith(KB, {
      result: null,
      logs: [
        'working',
        '[ERROR] Code execution failed: Script execution timeout after 2500ms',
        '[WARN] Tool call "KNOWLEDGE_BASE.ask" abandoned: the chain ended before it settled',
      ],
    });
    const outcome = await runToolChain(client, 'KNOWLEDGE_BASE.ask({})', 2_500);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('timed out after 2500 ms');
  });

  it('reports the limit the runner names, not the one that was asked for', async () => {
    // The two agree in practice; when they do not, the figure the agent is
    // given must be the one the runtime actually enforced.
    expect(await describeChainFailure(clientWith(KB).client, 'Script execution timeout after 7000ms', 30_000))
      .toContain('timed out after 7000 ms');
  });

  it('is answered when V8 itself terminated the script instead', async () => {
    const { client } = clientWith(KB, {
      result: null,
      logs: ['[ERROR] Code execution failed: Script execution timed out.'],
    });
    const outcome = await runToolChain(client, 'while(true){}', 4_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('timed out after 4000 ms');
  });

  it('never leaves the caller waiting, even if the runner itself never settles', async () => {
    // A request that hangs is what reaches an agent as a dropped connection.
    const client = {
      config: { tool_repository: { getTools: async () => KB, getTool: async () => null } },
      callToolChain: () => new Promise(() => {}),
    } as unknown as CodeModeUtcpClient;
    vi.useFakeTimers();
    try {
      const pending = runToolChain(client, 'while(true){}', 1_000);
      await vi.advanceTimersByTimeAsync(6_500);
      const outcome = await pending;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('timed out after 1000 ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a chain that names a namespace that does not exist', () => {
  it('is told which namespaces do', async () => {
    const { client } = clientWith(KB, {
      result: null,
      logs: ['[ERROR] Code execution failed: ReferenceError: WRONG is not defined\n    at <isolated-vm>:5:2952'],
    });
    const outcome = await runToolChain(client, 'return WRONG.read_file({})', 30_000);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('WRONG is not defined');
    expect(outcome.error).toContain('KNOWLEDGE_BASE');
    expect(outcome.error).toContain('list_tools');
  });

  it('lists every namespace the catalog has, and the bare tools apart from them', async () => {
    const { client } = clientWith(
      [utcpTool('KNOWLEDGE_BASE.read_file'), utcpTool('git.push'), utcpTool('lone_tool')],
      { result: null, logs: ['[ERROR] Code execution failed: ReferenceError: WRONG is not defined'] },
    );
    const outcome = await runToolChain(client, 'return WRONG.x()', 30_000);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('KNOWLEDGE_BASE, git');
    expect(outcome.error).toContain('lone_tool');
  });

  it('keeps the ReferenceError when the catalog itself cannot be read', async () => {
    // A failing catalog must not replace the chain's reason with its own.
    const client = {
      config: {
        tool_repository: {
          getTools: async () => {
            throw new Error('repository unavailable');
          },
          getTool: async () => null,
        },
      },
      callToolChain: async () => ({
        result: null,
        logs: ['[ERROR] Code execution failed: ReferenceError: WRONG is not defined'],
      }),
    } as unknown as CodeModeUtcpClient;
    const outcome = await runToolChain(client, 'return WRONG.x()', 30_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('WRONG is not defined');
      expect(outcome.error).not.toContain('repository unavailable');
    }
  });

  it('says so plainly when there are no namespaces at all', async () => {
    const { client } = clientWith([], {
      result: null,
      logs: ['[ERROR] Code execution failed: ReferenceError: WRONG is not defined'],
    });
    const outcome = await runToolChain(client, 'return WRONG.x()', 30_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('no tool namespaces at all');
  });

  it('reads the namespaces the way the runtime spells them', async () => {
    const { client } = clientWith([utcpTool('my-tool.run'), utcpTool('KNOWLEDGE_BASE.ask')]);
    expect(await chainNamespaces(client)).toEqual({
      namespaces: ['KNOWLEDGE_BASE', 'my_tool'],
      bare: [],
    });
  });
});

describe('a chain that fails for another reason', () => {
  it('is answered with that reason, not with a guess', async () => {
    const { client } = clientWith(KB, {
      result: null,
      logs: ['[ERROR] Code execution failed: Error: You don\'t have read access to "Secret.md"'],
    });
    const outcome = await runToolChain(client, 'return KNOWLEDGE_BASE.read_file({})', 30_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain('You don\'t have read access to "Secret.md"');
  });

  it('is answered when the chain exhausted the isolate\'s heap, and is not called a timeout', async () => {
    const { client } = clientWith(KB, {
      result: null,
      logs: ['[ERROR] Code execution failed: Isolate was disposed during execution due to memory limit'],
    });
    const outcome = await runToolChain(client, 'const a=[];while(1)a.push("x".repeat(1e6));', 30_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('ran out of memory');
      expect(outcome.error).not.toContain('timed out');
    }
  });

  it('is answered when the runner throws before the chain even starts', async () => {
    const client = {
      config: { tool_repository: { getTools: async () => KB, getTool: async () => null } },
      callToolChain: async () => {
        throw Object.assign(new Error('catalog is down'), { status: 503, data: { retry: true } });
      },
    } as unknown as CodeModeUtcpClient;
    const outcome = await runToolChain(client, 'return 1', 30_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe('catalog is down');
      expect(outcome.status).toBe(503);
      expect(outcome.data).toEqual({ retry: true });
    }
  });

  /**
   * The http transport carries the provider's own reason in `response.data`, not
   * in `err.message` — the message is the generic status line. The MCP
   * dispatcher used to read that body itself (`describeToolFailure`); once this
   * catch moved here, taking `err.message` would have dropped the actionable
   * half of every transport failure, so the runner reads it instead.
   */
  it('keeps the provider\'s own reason when the transport carries it in a body', async () => {
    const client = {
      config: { tool_repository: { getTools: async () => KB, getTool: async () => null } },
      callToolChain: async () => {
        throw Object.assign(new Error('Request failed with status code 403'), {
          response: { status: 403, data: { error: 'The branch `main` is protected.', kind: 'branch-protected' } },
        });
      },
    } as unknown as CodeModeUtcpClient;
    const outcome = await runToolChain(client, 'return 1', 30_000);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain('The branch `main` is protected.');
      // The machine-readable half survives too: an MCP caller sees only this
      // string, and `kind` is what it branches on.
      expect(outcome.error).toContain('branch-protected');
      expect(outcome.status).toBe(403);
      expect(outcome.data).toEqual({ error: 'The branch `main` is protected.', kind: 'branch-protected' });
    }
  });

  /**
   * The hostile shapes, one per read the catch makes. `response` is the one
   * that mattered: it was read outside any guard, so a thrown value with a
   * getter there escaped `runToolChain` and reached the agent as exactly the
   * dropped connection this ticket forbids.
   */
  it('is still answered when reading the failure\'s own fields throws', async () => {
    const throwingGetter = (field: string) => {
      const err = new Error('the tool bridge gave up');
      Object.defineProperty(err, field, {
        get() {
          throw new Error(`a ${field} getter that throws`);
        },
      });
      return err;
    };
    for (const field of ['status', 'data', 'response']) {
      const client = {
        config: { tool_repository: { getTools: async () => KB, getTool: async () => null } },
        callToolChain: async () => {
          throw throwingGetter(field);
        },
      } as unknown as CodeModeUtcpClient;
      await expect(runToolChain(client, 'return 1', 30_000), field).resolves.toMatchObject({
        ok: false,
        error: 'the tool bridge gave up',
      });
    }
    // And one whose `response` reads fine but whose body does not.
    const nestedClient = {
      config: { tool_repository: { getTools: async () => KB, getTool: async () => null } },
      callToolChain: async () => {
        throw Object.assign(new Error('Request failed with status code 500'), {
          response: {
            get data(): never {
              throw new Error('a data getter that throws');
            },
          },
        });
      },
    } as unknown as CodeModeUtcpClient;
    await expect(runToolChain(nestedClient, 'return 1', 30_000)).resolves.toMatchObject({
      ok: false,
      error: 'Request failed with status code 500',
    });
  });

  it('never throws, whatever the runner does', async () => {
    const client = {
      config: { tool_repository: { getTools: async () => KB, getTool: async () => null } },
      callToolChain: async () => {
        throw 'a string, not an Error';
      },
    } as unknown as CodeModeUtcpClient;
    await expect(runToolChain(client, 'return 1', 30_000)).resolves.toMatchObject({ ok: false });
  });
});

describe('a chain that succeeds', () => {
  it('keeps its value and its logs', async () => {
    const { client } = clientWith(KB, { result: { ok: 1 }, logs: ['hello'] });
    expect(await runToolChain(client, 'return { ok: 1 }', 30_000)).toEqual({
      ok: true,
      result: { ok: 1 },
      logs: ['hello'],
    });
  });

  it('is not mistaken for a failure when it returns null and logged nothing', async () => {
    const { client } = clientWith(KB, { result: null, logs: [] });
    expect(await runToolChain(client, 'return null', 30_000)).toEqual({ ok: true, result: null, logs: [] });
  });

  it('is not mistaken for a failure when it returns a value AND logged an error of its own', async () => {
    const { client } = clientWith(KB, { result: 7, logs: ['[ERROR] something I handled myself'] });
    expect(await runToolChain(client, 'return 7', 30_000)).toMatchObject({ ok: true, result: 7 });
  });

  it('runs with the runtime prelude in front of the agent\'s own code', async () => {
    const { client, callToolChain } = clientWith(KB);
    await runToolChain(client, 'return 1', 30_000);
    expect(callToolChain).toHaveBeenCalledWith(`${CHAIN_RUNTIME_PRELUDE}return 1`, 30_000);
  });
});

/**
 * The namespace in the descriptions. Both Scenarios, because the two surfaces
 * register the same tools under different names and ONE fixed example was
 * necessarily wrong on one of them — which is how this was reported.
 *
 * Driven by a REALISTIC catalog, never by `codeModeMetaTools(ns)` with none. An
 * earlier version of these tests passed an empty catalog, which falls back to
 * assembling the name from the namespace — so they asserted the fallback and
 * said nothing about either surface's real shape. That is precisely the gap
 * that let a broken example through.
 */
describe('the description names the namespace this connection exposes', () => {
  /** The hosted endpoint: the KB manual is http, so names are two segments. */
  const HOSTED: ChainExampleTool[] = [
    { utcpName: 'KNOWLEDGE_BASE.read_file', inputSchema: kbToolSchema(['branch', 'path']) },
    { utcpName: 'KNOWLEDGE_BASE.start_session', inputSchema: kbToolSchema([]) },
  ];
  /** The local server: the deployment is one MCP manual whose server shares its name. */
  const LOCAL: ChainExampleTool[] = [
    { utcpName: 'hexis.hexis.read_file', inputSchema: kbToolSchema(['branch', 'path']) },
    { utcpName: 'hexis.hexis.start_session', inputSchema: kbToolSchema([]) },
  ];

  function descriptions(namespace: string, tools: ChainExampleTool[]): string {
    return codeModeMetaTools(namespace, tools)
      .map((t) => `${t.name}\n${t.description ?? ''}`)
      .join('\n');
  }

  it('reads KNOWLEDGE_BASE.read_file on a deployment whose namespace is KNOWLEDGE_BASE', () => {
    const text = descriptions('KNOWLEDGE_BASE', HOSTED);
    expect(text).toContain('KNOWLEDGE_BASE.read_file');
    expect(text).toContain('`KNOWLEDGE_BASE.<tool>({ body: { ...args } })`');
    expect(text).not.toContain('hexis.');
  });

  /**
   * Scenario 2 of the Specification reads "the example reads `hexis.read_file(...)`".
   * That name is not callable on the local server — the tool arrives as
   * `hexis.hexis.read_file` and the runtime binds `hexis.hexis_read_file` — so
   * the Scenario's literal spelling and the Acceptance Criterion that a copied
   * example WORKS cannot both hold. The criterion wins, and what the Scenario
   * is really about — the namespace is `hexis`, not `KNOWLEDGE_BASE` — holds
   * exactly. (Verified live during Local Testing: `hexis.read_file` is a
   * TypeError there.)
   */
  it('names hexis through the local server, in the form that is actually callable there', () => {
    const text = descriptions('hexis', LOCAL);
    expect(text).toContain('`hexis.<tool>({ body: { ...args } })`');
    expect(text).toContain('hexis.hexis_read_file');
    expect(text).not.toContain('KNOWLEDGE_BASE');
    // Not the Scenario's literal spelling, because that one does not run.
    expect(text).not.toMatch(/(?<!hexis[._])\bhexis\.read_file\b/);
  });

  it('spells the namespace the way the runtime spells it, so a copied call runs', () => {
    // `@utcp/code-mode` exposes `global.<sanitized manual name>`; an example
    // carrying the raw name would not be callable.
    const text = descriptions('my-deployment', [
      { utcpName: 'my-deployment.read_file', inputSchema: kbToolSchema(['branch', 'path']) },
    ]);
    expect(text).toContain('my_deployment.read_file');
  });

  it('tells the agent the runtime has the four browser globals', () => {
    const text = descriptions('KNOWLEDGE_BASE', HOSTED);
    for (const name of ['atob', 'btoa', 'TextEncoder', 'TextDecoder']) expect(text).toContain(name);
  });

  it('tells the agent a timeout is answered and how far it may be raised', () => {
    const text = descriptions('KNOWLEDGE_BASE', HOSTED);
    expect(text).toContain(String(CHAIN_TIMEOUT_MAX_MS));
    expect(text).toMatch(/timeout/);
  });

  it('is built per surface rather than shared, so one connection cannot serve another\'s name', () => {
    expect(codeModeMetaTools('hexis', LOCAL)).not.toEqual(codeModeMetaTools('KNOWLEDGE_BASE', HOSTED));
  });
});
