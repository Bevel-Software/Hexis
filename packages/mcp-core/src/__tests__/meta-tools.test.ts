import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { dispatchMetaTool } from '../meta-tools.js';
import { withChainRuntime } from '../chain-runtime.js';

/**
 * The code the runner is handed is the chain's own source behind the runtime
 * prelude (the browser globals every chain is promised). These tests are about
 * the TIMEOUT and about the chain source being carried through intact, so they
 * compose the expectation with the SAME exported function the runner uses —
 * re-deriving the prelude here would let the two drift and still pass.
 */

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

function clientWith(tools: Tool[]) {
  const getTools = vi.fn(async () => tools);
  const getTool = vi.fn(async (name: string) => tools.find((t) => t.name === name) ?? null);
  // `result` is deliberately `unknown`: the runner resolves a DEAD chain as
  // `{ result: null, logs: ['[ERROR] …'] }`, and the failure cases below need
  // to be able to hand back that shape.
  const callToolChain = vi.fn(
    async (): Promise<{ result: unknown; logs: string[] }> => ({ result: 'ok', logs: [] }),
  );
  const client = {
    config: { tool_repository: { getTool, getTools } },
    toolToTypeScriptInterface: (tool: Tool) => `interface ${tool.name}`,
    callToolChain,
  } as unknown as CodeModeUtcpClient;
  return { client, getTools, getTool, callToolChain };
}

function resultText(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe('dispatchMetaTool call_tool_chain', () => {
  it('clamps an oversized timeout to the documented 120000ms cap', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: 999_999_999 });
    expect(callToolChain).toHaveBeenCalledWith(withChainRuntime('return 1'), 120_000);
  });

  it('clamps an undersized timeout up to 1000ms', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: 1 });
    expect(callToolChain).toHaveBeenCalledWith(withChainRuntime('return 1'), 1_000);
  });

  it('falls back to the 30000ms default on a non-numeric or non-finite timeout', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: '9999999' });
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: Number.NaN });
    expect(callToolChain).toHaveBeenNthCalledWith(1, withChainRuntime('return 1'), 30_000);
    expect(callToolChain).toHaveBeenNthCalledWith(2, withChainRuntime('return 1'), 30_000);
  });

  it('truncates a fractional timeout to an integer', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: 5000.9 });
    expect(callToolChain).toHaveBeenCalledWith(withChainRuntime('return 1'), 5_000);
  });

  it('refuses a missing or non-string code instead of executing an empty program', async () => {
    const { client, callToolChain } = clientWith([]);
    for (const args of [{}, { code: 42 }, { code: '' }]) {
      const result = await dispatchMetaTool(client, 'call_tool_chain', args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/"code"/);
    }
    expect(callToolChain).not.toHaveBeenCalled();
  });

  it('reports result_bytes in UTF-8 bytes on the no-spill truncation path — parity with the spill store', async () => {
    const { client, callToolChain } = clientWith([]);
    const value = 'é'.repeat(1200); // 2 UTF-8 bytes per char
    callToolChain.mockResolvedValueOnce({ result: value, logs: [] });
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', max_output_size: 1000 });
    const payload = JSON.parse(resultText(res)) as { truncated: boolean; result_bytes: number };
    const fullJson = JSON.stringify({ result: value, logs: [] }, null, 2);
    expect(payload.truncated).toBe(true);
    expect(payload.result_bytes).toBe(fullJson.length + 1200);
  });
});

describe('dispatchMetaTool tools_info', () => {
  it('resolves a batch with one catalog fetch and reports the missing names', async () => {
    const { client, getTools } = clientWith([utcpTool('m.read-file'), utcpTool('m.write-file')]);
    const result = await dispatchMetaTool(client, 'tools_info', {
      tool_names: ['m.read_file', 'm.write_file', 'm.missing'],
    });
    const payload = JSON.parse(resultText(result)) as { interfaces: string; not_found: string[] };
    expect(payload.interfaces).toBe('interface m.read-file\n\ninterface m.write-file');
    expect(payload.not_found).toEqual(['m.missing']);
    expect(getTools).toHaveBeenCalledTimes(1);
  });

  it('surfaces an ambiguous sanitized name as a tool error naming the colliders', async () => {
    const { client } = clientWith([utcpTool('m.read-file'), utcpTool('m.read.file')]);
    const result = await dispatchMetaTool(client, 'tools_info', { tool_names: ['m.read_file'] });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(/ambiguous.*"m\.read-file".*"m\.read\.file"/);
  });

  it('refuses a missing tool_names array or non-string entries with a named validation error', async () => {
    const { client, getTool } = clientWith([]);
    // Empty included: the schema's minItems is 1, and an empty success
    // payload for invalid input would read as "no tools exist".
    for (const args of [{}, { tool_names: 'm.read_file' }, { tool_names: ['ok', 42] }, { tool_names: [] }]) {
      const result = await dispatchMetaTool(client, 'tools_info', args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/tool_names/);
    }
    expect(getTool).not.toHaveBeenCalled();
  });
});

describe('dispatchMetaTool call_tool_chain — image results', () => {
  it('replaces a chained image read with an omitted-image note instead of stringifying base64', async () => {
    const { client, callToolChain } = clientWith([]);
    const sentinel = {
      kind: 'bevel/mcp-image@v1',
      data: 'QUJDREVG',
      mimeType: 'image/png',
      note: '[image: Files/logo.png — image/png, 6 bytes]',
    };
    callToolChain.mockResolvedValueOnce({ result: { pic: sentinel, ok: true } as unknown as string, logs: [] });
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1' });
    const text = resultText(res);
    expect(text).not.toContain('QUJDREVG');
    expect(text).toContain('image_omitted');
    expect(text).toContain('Files/logo.png');
    expect(text).toContain('"ok":true');
  });
});

/**
 * What the MCP surfaces now answer for a chain that DIED. `callToolChain`
 * resolves such a chain as `{ result: null, logs: ['[ERROR] …'] }` rather than
 * throwing, and this dispatcher used to pass that straight through as
 * `success: true` with a null result — the agent was told a chain had worked
 * and handed nothing.
 */
describe('dispatchMetaTool answers a failed chain', () => {
  it('reports a timeout as an error naming the limit and how to raise it', async () => {
    const { client, callToolChain } = clientWith([]);
    callToolChain.mockResolvedValueOnce({
      result: null,
      logs: ['[ERROR] Code execution failed: Script execution timeout after 1000ms'],
    });
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'while(true){}', timeout: 1_000 });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('timed out after 1000 ms');
    expect(resultText(res)).toContain('120000');
  });

  it('reports an unknown namespace as an error listing the namespaces that exist', async () => {
    const { client, callToolChain } = clientWith([utcpTool('KNOWLEDGE_BASE.read_file')]);
    callToolChain.mockResolvedValueOnce({
      result: null,
      logs: ['[ERROR] Code execution failed: ReferenceError: WRONG is not defined'],
    });
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return WRONG.read_file({})' });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('KNOWLEDGE_BASE');
  });

  it('reports any other failure with the reason the runner gave', async () => {
    const { client, callToolChain } = clientWith([]);
    callToolChain.mockResolvedValueOnce({
      result: null,
      logs: ['[ERROR] Code execution failed: Error: the vault refused the key'],
    });
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1' });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toContain('the vault refused the key');
  });

  /**
   * An MCP caller is answered with TEXT and nothing else. The runner carries a
   * transport failure's `status` and body beside its message, and this surface
   * used to return the message alone — so a caller got the generic transport
   * line while the actionable half, the provider's own body, was dropped.
   */
  it('folds a transport failure\'s status and body into the error an MCP caller reads', async () => {
    const { client, callToolChain } = clientWith([]);
    // The shape the UTCP http transport throws: the reason is in `data`, not in
    // an axios-style `response.data` that `describeToolFailure` would lift out.
    callToolChain.mockImplementationOnce(() => {
      throw Object.assign(new Error('Request failed with status code 400'), {
        status: 400,
        data: { error: '`branch` is required', kind: 'branch-required' },
      });
    });
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1' });
    expect(res.isError).toBe(true);
    const text = resultText(res);
    expect(text).toContain('`branch` is required');
    expect(text).toContain('branch-required');
    expect(text).toContain('400');
  });

  it('does not repeat a reason the message already carries', async () => {
    const { client, callToolChain } = clientWith([]);
    callToolChain.mockImplementationOnce(() => {
      throw Object.assign(new Error('Request failed with status code 403'), {
        response: { status: 403, data: { error: 'The branch is protected.', kind: 'branch-protected' } },
      });
    });
    const text = resultText(await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1' }));
    // `describeToolFailure` already lifted both out of `response.data`; the
    // detail must not be appended a second time.
    expect(text.match(/branch-protected/g)).toHaveLength(1);
    expect(text.match(/The branch is protected\./g)).toHaveLength(1);
  });

  it('still maps a retired tool onto its own message', async () => {
    const { client, callToolChain } = clientWith([]);
    callToolChain.mockResolvedValueOnce({
      result: null,
      logs: [
        '[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.merge_change_request is not a function',
      ],
    });
    const res = await dispatchMetaTool(client, 'call_tool_chain', {
      code: 'return KNOWLEDGE_BASE.merge_change_request({})',
    });
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/merged by a person in the app/);
  });

  it('leaves an oversized SUCCESS spilling exactly as before', async () => {
    const { client, callToolChain } = clientWith([]);
    callToolChain.mockResolvedValueOnce({ result: 'x'.repeat(5_000), logs: [] });
    const spill = { write: vi.fn(async () => ({ ref: '__tool_chain_spill__/a.json', bytes: 5_120 })) };
    const res = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', max_output_size: 1_000 }, spill);
    const payload = JSON.parse(resultText(res)) as { success: boolean; truncated: boolean; result_ref: string };
    expect(payload).toMatchObject({ success: true, truncated: true, result_ref: '__tool_chain_spill__/a.json' });
    expect(spill.write).toHaveBeenCalledOnce();
  });
});
