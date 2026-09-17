import { describe, expect, it, vi } from 'vitest';
import type { CodeModeUtcpClient } from '@utcp/code-mode';
import { retiredToolInCode, retiredToolMessage } from '../retired-tools.js';
import { dispatchMetaTool } from '../meta-tools.js';

describe('retired tools', () => {
  it('answers merge_change_request, in every spelling a surface uses, with who merges now', () => {
    for (const name of ['merge_change_request', 'knowledge_base.merge_change_request', 'hexis__merge_change_request']) {
      expect(retiredToolMessage(name), name).toMatch(/a change request is merged by a person in the app/);
    }
  });

  it('leaves live tools and look-alikes alone', () => {
    expect(retiredToolMessage('merge_branch')).toBeUndefined();
    expect(retiredToolMessage('not_merge_change_request_x')).toBeUndefined();
    expect(retiredToolInCode('return knowledge_base.merge_branch({})')).toBeUndefined();
  });

  it('call_tool_chain answers a chain that failed on the retired tool with the message', async () => {
    const client = {
      callToolChain: vi.fn(async () => {
        throw new TypeError('knowledge_base.merge_change_request is not a function');
      }),
    } as unknown as CodeModeUtcpClient;
    const result = await dispatchMetaTool(client, 'call_tool_chain', {
      code: 'return knowledge_base.merge_change_request({ body: { number: 4 } })',
    });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/merged by a person in the app/);
  });
});
