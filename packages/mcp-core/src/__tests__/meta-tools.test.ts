import { describe, expect, it, vi } from 'vitest';
import type { Tool } from '@utcp/sdk';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { dispatchMetaTool } from '../meta-tools.js';

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
  const callToolChain = vi.fn(async () => ({ result: 'ok', logs: [] as string[] }));
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
    expect(callToolChain).toHaveBeenCalledWith('return 1', 120_000);
  });

  it('clamps an undersized timeout up to 1000ms', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: 1 });
    expect(callToolChain).toHaveBeenCalledWith('return 1', 1_000);
  });

  it('falls back to the 30000ms default on a non-numeric or non-finite timeout', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: '9999999' });
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: Number.NaN });
    expect(callToolChain).toHaveBeenNthCalledWith(1, 'return 1', 30_000);
    expect(callToolChain).toHaveBeenNthCalledWith(2, 'return 1', 30_000);
  });

  it('truncates a fractional timeout to an integer', async () => {
    const { client, callToolChain } = clientWith([]);
    await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1', timeout: 5000.9 });
    expect(callToolChain).toHaveBeenCalledWith('return 1', 5_000);
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
