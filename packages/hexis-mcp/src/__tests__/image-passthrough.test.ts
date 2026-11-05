import { describe, expect, it } from 'vitest';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import {
  dispatchToolCall,
  dispatchMetaTool,
  mcpImageResult,
  type ProxiedTool,
} from '@bevel-software/platform-mcp-core';

/**
 * Image results must cross the local stdio server UNMANGLED. This server
 * reaches the deployment through @utcp/mcp, whose result processing unwraps a
 * remote CallToolResult's `content`: text blocks are JSON-parsed (the image
 * note comes back as a bare string), image blocks pass through verbatim, and a
 * single-entry list collapses to the entry itself. These tests pin that the
 * shared dispatch (this server's exact call path) re-emits spec-shaped image
 * content for every form that hop can hand it — never a text block holding
 * stringified base64.
 */

const readFileTool: ProxiedTool = {
  utcpName: 'KNOWLEDGE_BASE.KNOWLEDGE_BASE.read_file',
  mcpName: 'read_file',
  description: 'the read_file tool',
  inputSchema: { type: 'object', properties: {} },
  manualName: 'KNOWLEDGE_BASE',
};

function clientYielding(chunk: unknown): CodeModeUtcpClient {
  return {
    callToolStreaming: async function* () {
      yield chunk;
    },
  } as unknown as CodeModeUtcpClient;
}

const B64 = 'aVZCT1J3MEtHZ28='; // stands in for real image bytes

describe('hexis-mcp forwards image results as native MCP image content', () => {
  it('re-emits the remote hop\'s [imageBlock, "note"] form as spec-shaped content blocks', async () => {
    const chunk = [
      { type: 'image', data: B64, mimeType: 'image/png' },
      '[image: Files/logo.png — image/png, 12 bytes, 1×1 px]',
    ];
    const result = await dispatchToolCall(clientYielding(chunk), readFileTool, {});
    expect(result).toEqual({
      content: [
        { type: 'image', data: B64, mimeType: 'image/png' },
        { type: 'text', text: '[image: Files/logo.png — image/png, 12 bytes, 1×1 px]' },
      ],
    });
  });

  it('re-emits a bare image block (noteless single-entry collapse) as spec-shaped content', async () => {
    const block = { type: 'image', data: B64, mimeType: 'image/webp' };
    const result = await dispatchToolCall(clientYielding(block), readFileTool, {});
    expect(result).toEqual({ content: [block] });
  });

  it('shapes a raw image sentinel (http-transport form) the same way', async () => {
    const sentinel = mcpImageResult(B64, 'image/jpeg', '[image: a.jpg — image/jpeg, 12 bytes]');
    const result = await dispatchToolCall(clientYielding(sentinel), readFileTool, {});
    expect(result).toEqual({
      content: [
        { type: 'image', data: B64, mimeType: 'image/jpeg' },
        { type: 'text', text: '[image: a.jpg — image/jpeg, 12 bytes]' },
      ],
    });
  });

  it('still forwards an ordinary JSON result as one stringified text block', async () => {
    const result = await dispatchToolCall(clientYielding({ path: 'a.md', content: 'hi' }), readFileTool, {});
    expect(result).toEqual({ content: [{ type: 'text', text: '{"path":"a.md","content":"hi"}' }] });
  });

  it("this server's call_tool_chain omits a chained image (no spill store here to hide it in)", async () => {
    const chainChunk = [
      { type: 'image', data: B64, mimeType: 'image/png' },
      '[image: Files/logo.png — image/png, 12 bytes]',
    ];
    const client = {
      callToolChain: async () => ({ result: { pic: chainChunk }, logs: [] as string[] }),
    } as unknown as CodeModeUtcpClient;
    const result = await dispatchMetaTool(client, 'call_tool_chain', { code: 'return 1' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain(B64);
    expect(text).toContain('image_omitted');
    expect(text).toContain('read_file');
  });
});
