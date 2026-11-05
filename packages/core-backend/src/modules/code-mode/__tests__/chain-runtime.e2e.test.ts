import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import '@utcp/direct-call';
import { addFunctionToUtcpDirectCall } from '@utcp/direct-call';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { codeModeMetaTools, dispatchMetaTool } from '@bevel-software/platform-mcp-core';
import { createCallToolChainTool } from '../code-mode.tool.js';

/**
 * Every Scenario of the Specification, against a REAL `isolated-vm` isolate.
 *
 * mcp-core pins the runtime's pieces one by one, which is where the arithmetic
 * belongs. What it cannot show is that a chain can actually REACH `atob`, that
 * `while(true){}` really is answered rather than dropped, and that the
 * connection survives it — all three are properties of the isolate and of the
 * runner's own resolved shape, and a mock of `callToolChain` would be asserting
 * our belief about `@utcp/code-mode` rather than its behaviour. So this file
 * registers a live manual and runs real chains through the shipping tool.
 */

const NAMESPACE = 'KNOWLEDGE_BASE';
let client: CodeModeUtcpClient;

/**
 * The manual is shaped exactly as `toolDef` shapes a real knowledge-base tool:
 * flat arguments wrapped under one required `body`, `branch` required inside it
 * with no `default` and no `enum`, and a handler that REFUSES a call without it
 * the way the route does. That refusal is the point — it is what turned a
 * plausible-looking example into `400 … \`branch\` is required`, and a fixture
 * that accepted anything would have let the example through again.
 */
function kbTool(name: string, required: string[], callable: string) {
  const properties: Record<string, unknown> = {
    branch: { type: 'string', minLength: 1, description: 'The branch this operates on.' },
    path: { type: 'string', description: 'The path to read.' },
  };
  return {
    name,
    description: `A live ${name}, so the namespace is a real object.`,
    inputs: {
      type: 'object',
      properties: {
        body:
          required.length === 0
            ? { type: 'object', properties: {}, additionalProperties: false }
            : {
                type: 'object',
                properties: Object.fromEntries(required.map((k) => [k, properties[k]])),
                required,
                additionalProperties: false,
              },
      },
      required: ['body'],
      additionalProperties: false,
    },
    outputs: { type: 'object', properties: {} },
    tool_call_template: { call_template_type: 'direct-call', callable_name: callable },
  };
}

/**
 * The real `read_file` handler, as a named installer rather than an inline
 * closure, because a test that swaps it has to put THIS back. Restoring a
 * permissive stand-in instead silently disarmed the branch check for every
 * test that ran afterwards — which is how a test for the missing-argument
 * failure passed while asserting the opposite.
 *
 * Note the unwrapping: the direct-call protocol hands the callable the inner
 * `body` object, so what arrives is `{ branch, path }`, not `{ body: … }`.
 */
function installReadFile(): void {
  addFunctionToUtcpDirectCall('e2e_read_file', async (args: unknown) => {
    const given = (args ?? {}) as Record<string, unknown>;
    const body = (given.body as Record<string, unknown> | undefined) ?? given;
    // The server's own refusal, reproduced: identity never implies a
    // workspace, so `branch` always comes from the argument.
    if (!body.branch) throw new Error('HTTP 400: `branch` is required');
    if (!body.path) throw new Error('HTTP 400: `path` is required');
    return { content: 'live' };
  });
}

beforeAll(async () => {
  addFunctionToUtcpDirectCall('e2e_manual', async () => ({
    utcp_version: '1.0.0',
    manual_version: '1.0.0',
    tools: [
      kbTool('read_file', ['branch', 'path'], 'e2e_read_file'),
      kbTool('start_session', [], 'e2e_start_session'),
    ],
  }));
  installReadFile();
  addFunctionToUtcpDirectCall('e2e_start_session', async () => ({ sessionId: 's-1' }));
  client = await CodeModeUtcpClient.create(process.cwd(), null);
  const registered = await client.registerManual({
    name: NAMESPACE,
    call_template_type: 'direct-call',
    callable_name: 'e2e_manual',
  } as never);
  expect(registered.success).toBe(true);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

type ChainResult = {
  success: boolean;
  result?: unknown;
  error?: string;
  logs?: string[];
};

/** This client's catalog, in the shape the description builder takes. */
async function catalog(): Promise<{ utcpName: string; inputSchema: unknown }[]> {
  return (await client.config.tool_repository.getTools()).map((t) => ({
    utcpName: t.name,
    inputSchema: t.inputs,
  }));
}

/** The shipping Mastra tool, run for real against the LIVE catalog. */
async function chain(code: string, timeout?: number): Promise<ChainResult> {
  const tool = createCallToolChainTool(
    client,
    { write: vi.fn() } as never,
    NAMESPACE,
    await catalog(),
  ) as unknown as {
    execute: (input: { code: string; timeout?: number }) => Promise<ChainResult>;
  };
  return tool.execute({ code, ...(timeout === undefined ? {} : { timeout }) });
}

/** The same chain through the MCP surfaces' dispatcher. */
async function mcpChain(code: string, timeout?: number): Promise<{ isError?: boolean; text: string }> {
  const res = await dispatchMetaTool(client, 'call_tool_chain', {
    code,
    ...(timeout === undefined ? {} : { timeout }),
  });
  return { isError: res.isError as boolean | undefined, text: (res.content[0] as { text: string }).text };
}

describe('the chain runtime, in a real isolate', () => {
  it('has atob, and it decodes', async () => {
    expect(await chain("return atob('SGVsbG8=')")).toMatchObject({ success: true, result: 'Hello' });
  });

  it('round-trips UTF-8 text through TextEncoder and TextDecoder', async () => {
    const out = await chain("return new TextDecoder().decode(new TextEncoder().encode('über'))");
    expect(out).toMatchObject({ success: true, result: 'über' });
  });

  it('has all four globals as functions', async () => {
    const out = await chain(
      'return [typeof atob, typeof btoa, typeof TextEncoder, typeof TextDecoder]',
    );
    expect(out.result).toEqual(['function', 'function', 'function', 'function']);
  });

  it('encodes the bytes a browser encodes, and base64s them', async () => {
    const out = await chain(
      "const b = new TextEncoder().encode('über'); return [Array.from(b), btoa(String.fromCharCode.apply(null, Array.from(b)))]",
    );
    expect(out.result).toEqual([[195, 188, 98, 101, 114], 'w7xiZXI=']);
  });

  it('decodes base64 back into UTF-8 text', async () => {
    const out = await chain(
      "const s = atob('w7xiZXI='); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new TextDecoder().decode(b)",
    );
    expect(out).toMatchObject({ success: true, result: 'über' });
  });

  it('offers them on the MCP surfaces too', async () => {
    const out = await mcpChain("return atob('SGVsbG8=')");
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.text)).toMatchObject({ success: true, result: 'Hello' });
  });
});

describe('a chain that outlives its timeout, in a real isolate', () => {
  it('is answered with a timeout error, and the connection stays usable', async () => {
    const out = await chain('while(true){}', 1_000);
    expect(out.success).toBe(false);
    expect(out.error).toContain('timed out after 1000 ms');
    expect(out.error).toContain('`timeout`');
    expect(out.error).toContain('120000');
    // The Scenario's second half: the NEXT call on the same connection works.
    expect(await chain("return KNOWLEDGE_BASE.read_file({ body: { branch: 'main', path: 'x' } })")).toMatchObject({
      success: true,
      result: { content: 'live' },
    });
  }, 30_000);

  it('is answered the same way on the MCP surfaces, which then serve the next call', async () => {
    const timedOut = await mcpChain('while(true){}', 1_000);
    expect(timedOut.isError).toBe(true);
    expect(timedOut.text).toContain('timed out after 1000 ms');
    expect(timedOut.text).toContain('120000');
    const next = await mcpChain("return KNOWLEDGE_BASE.read_file({ body: { branch: 'main', path: 'x' } })");
    expect(next.isError).toBeFalsy();
    expect(JSON.parse(next.text)).toMatchObject({ success: true });
    // And a plain tool listing still answers, so nothing about the session died.
    const listed = await dispatchMetaTool(client, 'list_tools', {});
    expect((listed.content[0] as { text: string }).text).toContain('KNOWLEDGE_BASE.read_file');
  }, 30_000);
});

describe('a chain that fails some other way, in a real isolate', () => {
  it('is told which namespaces exist when it names one that does not', async () => {
    const out = await chain("return WRONG.read_file({ path: 'x' })");
    expect(out.success).toBe(false);
    expect(out.error).toContain('WRONG is not defined');
    expect(out.error).toContain('KNOWLEDGE_BASE');
    expect(out.error).toContain('list_tools');
  });

  it('is answered with its own reason when the chain throws', async () => {
    const out = await chain("throw new Error('the chain said no')");
    expect(out.success).toBe(false);
    expect(out.error).toContain('the chain said no');
  });

  it('is answered with the tool\'s reason when a tool inside it throws', async () => {
    addFunctionToUtcpDirectCall('e2e_read_file', async () => {
      throw new Error("You don't have read access to \"Secret.md\"");
    });
    try {
      const out = await chain("return KNOWLEDGE_BASE.read_file({ body: { branch: 'main', path: 'Secret.md' } })");
      expect(out.success).toBe(false);
      expect(out.error).toContain('read access');
    } finally {
      // The REAL handler back, branch check included — see `installReadFile`.
      installReadFile();
    }
  });

  it('is answered with the compiler\'s own complaint rather than an empty success', async () => {
    const out = await chain('return (((');
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Unexpected token/);
  });

  it('reports a failure against the chain\'s OWN line numbers, the prelude notwithstanding', async () => {
    // The single-line prelude earns its keep here: the stack must name the
    // line of the agent's code, not a line of a runtime it cannot see.
    const out = await chain('const a = 1;\nconst b = 2;\nreturn WRONG.go();');
    expect(out.success).toBe(false);
    const noPrelude = await client.callToolChain('const a = 1;\nconst b = 2;\nreturn WRONG.go();', 10_000);
    const line = (s: string) => /<isolated-vm>:(\d+):/.exec(s)?.[1];
    expect(line(noPrelude.logs.join('\n'))).toBeDefined();
    // Same reported line with and without the prelude in front of the chain.
    const withPrelude = await client.callToolChain(
      (await import('@bevel-software/platform-mcp-core')).withChainRuntime(
        'const a = 1;\nconst b = 2;\nreturn WRONG.go();',
      ),
      10_000,
    );
    expect(line(withPrelude.logs.join('\n'))).toBe(line(noPrelude.logs.join('\n')));
  }, 30_000);
});

describe('a chain that succeeds, in a real isolate', () => {
  it('still calls its tools and returns its value', async () => {
    const out = await chain(
      "const a = KNOWLEDGE_BASE.read_file({ body: { branch: 'main', path: 'x' } }); return { seen: a.content, b64: btoa(a.content) };",
    );
    expect(out).toMatchObject({ success: true, result: { seen: 'live', b64: 'bGl2ZQ==' } });
  });

  it('can still return null without being read as a failure', async () => {
    expect(await chain('return null')).toMatchObject({ success: true, result: null });
  });
});

/**
 * The acceptance criterion itself: an agent that copies the example call out of
 * the description gets a WORKING call. Run verbatim, in a real isolate, against
 * a manual that refuses a call without `branch` exactly as the route does.
 *
 * This is the test whose absence shipped the bug. The unit tests checked that
 * the example's NAME came from the catalog; nothing executed it, so nobody
 * noticed the arguments beside the name were fixed text omitting a required
 * one. Here the example is extracted from the generated description and run.
 */
describe('the example call in the description, copied verbatim', () => {
  async function printedExample(): Promise<string> {
    const tool = createCallToolChainTool(
      client,
      { write: vi.fn() } as never,
      NAMESPACE,
      await catalog(),
    ) as unknown as { description: string };
    const printed = /works exactly as written: `return ([^`]+);`/.exec(tool.description);
    expect(printed, 'the description printed no example call').not.toBeNull();
    return printed![1]!;
  }

  it('runs, and returns a value rather than an error', async () => {
    const example = await printedExample();
    const out = await chain(`return ${example};`);
    expect(out.success).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.result).not.toBeNull();
  });

  it('runs on the MCP surfaces too, from the description THEY serve', async () => {
    const chainTool = codeModeMetaTools(NAMESPACE, await catalog()).find(
      (t) => t.name === 'call_tool_chain',
    )!;
    const printed = /works exactly as written: `return ([^`]+);`/.exec(chainTool.description!);
    expect(printed).not.toBeNull();
    const out = await mcpChain(`return ${printed![1]!};`);
    expect(out.isError).toBeFalsy();
    expect(JSON.parse(out.text)).toMatchObject({ success: true });
  });

  /**
   * The fixture has teeth. If a missing `branch` were quietly accepted, the
   * test above would pass for the wrong reason and the regression would be
   * invisible again — so prove the refusal is real.
   */
  it('fails when a required argument is dropped, which is what the old example did', async () => {
    const out = await chain("return KNOWLEDGE_BASE.read_file({ body: { path: 'x' } })");
    expect(out.success).toBe(false);
    expect(out.error).toContain('`branch` is required');
  });

  it('names a tool the catalog actually has, in the form the runtime binds', async () => {
    const example = await printedExample();
    const name = /^([\w.$]+)\(/.exec(example)![1]!;
    const bound = await chain(`return typeof ${name};`);
    expect(bound).toMatchObject({ success: true, result: 'function' });
  });
});
