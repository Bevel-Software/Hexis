import { describe, expect, it, vi } from 'vitest';
import { CodeModeUtcpClient } from '@utcp/code-mode';

/**
 * `tools_info` containment of a THROWING name lookup. `findToolByName`
 * (mcp-core) throws on an ambiguous sanitized name — sanitization is lossy
 * (`a-b` and `a+b` both become `a_b`) — and one ambiguous entry in a batch
 * must cost that entry an error message, never the whole response. The
 * lookup is mocked at the module seam so the test pins THIS module's
 * per-name containment, not mcp-core's collision detection.
 */

vi.mock('../code-mode-names.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../code-mode-names.js')>();
  return {
    ...actual,
    findToolByName: vi.fn(async (_client: unknown, name: string) => {
      if (name === 'a_b.fetch') {
        // The REAL sentinel class — the containment branches on instanceof,
        // and a lookalike Error would test the wrong contract.
        throw new actual.AmbiguousToolNameError(
          'Tool name "a_b.fetch" is ambiguous: "a-b.fetch", "a+b.fetch" all sanitize to it. ' +
            'Call the tool by its exact UTCP name instead.',
        );
      }
      if (name === 'down.run') throw new Error('repository unavailable: ECONNREFUSED');
      if (name === 'solo.run') return { tool: { name: 'solo.run' }, utcpName: 'solo.run' };
      return null;
    }),
  };
});

const { createToolsInfoTool } = await import('../code-mode.tool.js');

const client = {
  toolToTypeScriptInterface: (tool: { name: string }) => `interface ${tool.name}`,
} as unknown as CodeModeUtcpClient;

type ToolsInfoResult = { interfaces: string; not_found: string[]; errors?: string[] };

async function run(toolNames: string[]): Promise<ToolsInfoResult> {
  const tool = createToolsInfoTool(client) as unknown as {
    execute: (input: { tool_names: string[] }) => Promise<ToolsInfoResult>;
  };
  return tool.execute({ tool_names: toolNames });
}

describe('tools_info', () => {
  it('answers every resolvable name even when one in the batch throws as ambiguous', async () => {
    const result = await run(['a_b.fetch', 'solo.run', 'nope']);
    expect(result.interfaces).toContain('interface solo.run');
    expect(result.not_found).toEqual(['nope']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors?.[0]).toMatch(/^a_b\.fetch: .*ambiguous/);
  });

  it('omits the errors field entirely when every name resolves or misses cleanly', async () => {
    const result = await run(['solo.run', 'nope']);
    expect(result.interfaces).toBe('interface solo.run');
    expect(result.not_found).toEqual(['nope']);
    expect(result.errors).toBeUndefined();
  });

  it('contains ONLY ambiguity — an outage rethrows instead of posing as partial success', async () => {
    await expect(run(['solo.run', 'down.run'])).rejects.toThrow(/repository unavailable/);
  });
});

/**
 * The in-process agent's `call_tool_chain` shares the MCP surfaces' image
 * policy: a chain result is stringified into the transcript, so an image read
 * inside it must come back as an omitted-image note — never inline base64.
 */
describe('call_tool_chain image scrub', () => {
  it('replaces a chained image sentinel with a note before serialization', async () => {
    const { createCallToolChainTool } = await import('../code-mode.tool.js');
    const sentinel = {
      kind: 'bevel/mcp-image@v1',
      data: 'QUJDREVG',
      mimeType: 'image/png',
      note: '[image: Files/logo.png — image/png, 6 bytes]',
    };
    const chainClient = {
      callToolChain: vi.fn(async () => ({ result: { pic: sentinel, ok: true }, logs: [] as string[] })),
    } as unknown as CodeModeUtcpClient;
    const spill = { write: vi.fn(async () => ({ ref: '__tool_chain_spill__/x.json', bytes: 1 })) };
    const tool = createCallToolChainTool(chainClient, spill as never) as unknown as {
      execute: (input: { code: string }) => Promise<unknown>;
    };
    const out = JSON.stringify(await tool.execute({ code: 'return 1' }));
    expect(out).not.toContain('QUJDREVG');
    expect(out).toContain('image_omitted');
    expect(out).toContain('Files/logo.png');
    expect(out).toContain('"ok":true');
    expect(spill.write).not.toHaveBeenCalled();
  });
});

/**
 * `merge_change_request` is retired from every agent tool set, the in-app
 * chat's included. A chain still calling it gets who merges now, not the
 * runtime's "is not a function".
 */
describe('call_tool_chain and a retired tool', () => {
  const RETIRED_CALL = 'return KNOWLEDGE_BASE.merge_change_request({ body: { number: 4 } })';

  async function runWith(chainClient: CodeModeUtcpClient, code: string) {
    const { createCallToolChainTool } = await import('../code-mode.tool.js');
    const tool = createCallToolChainTool(chainClient, { write: vi.fn() } as never) as unknown as {
      execute: (input: { code: string }) => Promise<{ success: boolean; error?: string; result?: unknown }>;
    };
    return tool.execute({ code });
  }

  // The runner resolves a failed chain as `{ result: null, logs: ['[ERROR] Code
  // execution failed: …'] }` — it does not throw.
  it('answers a failed call to merge_change_request with the plain message, as the runner reports it', async () => {
    const chainClient = {
      callToolChain: vi.fn(async () => ({
        result: null,
        logs: ['[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.merge_change_request is not a function'],
      })),
    } as unknown as CodeModeUtcpClient;
    const out = await runWith(chainClient, RETIRED_CALL);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/a change request is merged by a person in the app/);
  });

  it('answers it through a real code-mode runner, not a mock', async () => {
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    try {
      const out = await runWith(client, RETIRED_CALL);
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/a change request is merged by a person in the app/);
    } finally {
      await client.close();
    }
  });

  it('answers a thrown failure the same way', async () => {
    const chainClient = {
      callToolChain: vi.fn(async () => {
        throw new TypeError('KNOWLEDGE_BASE.merge_change_request is not a function');
      }),
    } as unknown as CodeModeUtcpClient;
    expect((await runWith(chainClient, RETIRED_CALL)).error).toMatch(/merged by a person in the app/);
  });

  it('leaves an unrelated failure as it was', async () => {
    const chainClient = { callToolChain: vi.fn(async () => { throw new Error('boom'); }) } as unknown as CodeModeUtcpClient;
    expect((await runWith(chainClient, 'return KNOWLEDGE_BASE.read_file({})')).error).toBe('boom');
  });
});
