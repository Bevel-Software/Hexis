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
});
