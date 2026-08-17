import { describe, expect, it, vi } from 'vitest';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import type { ProxiedTool } from '../proxied-tool.js';
import { dispatchToolCall } from '../dispatch.js';

const tool: ProxiedTool = {
  utcpName: 'KNOWLEDGE_BASE.read_file',
  mcpName: 'read_file',
  description: 'the read_file tool',
  inputSchema: { type: 'object', properties: {} },
  manualName: 'KNOWLEDGE_BASE',
};

function clientYielding(chunks: unknown[], error?: Error): CodeModeUtcpClient {
  return {
    callToolStreaming: async function* () {
      yield* chunks;
      if (error) throw error;
    },
  } as unknown as CodeModeUtcpClient;
}

describe('dispatchToolCall', () => {
  it('emits the single chunk of a plain http tool as the result, with no progress', async () => {
    const onProgress = vi.fn(async () => {});
    const result = await dispatchToolCall(clientYielding([{ ok: true }]), tool, {}, onProgress);
    expect(result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('turns every chunk but the last into a progress notification', async () => {
    const onProgress = vi.fn(async () => {});
    const result = await dispatchToolCall(clientYielding(['one', 'two', 'three']), tool, {}, onProgress);
    expect(result).toEqual({ content: [{ type: 'text', text: 'three' }] });
    expect(onProgress.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['one', 'two']);
  });

  it('reports a stream that ends without a chunk as a tool error, not a "null" result', async () => {
    const result = await dispatchToolCall(clientYielding([]), tool, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/read_file.*produced no output/);
  });

  it('reports a mid-stream failure as a tool error naming the tool', async () => {
    const result = await dispatchToolCall(clientYielding(['partial'], new Error('boom')), tool, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/read_file.*failed.*boom/);
  });
});
