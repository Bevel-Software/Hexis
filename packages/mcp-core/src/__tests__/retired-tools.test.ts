import { describe, expect, it, vi } from 'vitest';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { retiredToolChainFailure, retiredToolInCode, retiredToolMessage } from '../retired-tools.js';
import { dispatchMetaTool } from '../meta-tools.js';

const RETIRED_CALL = 'return KNOWLEDGE_BASE.merge_change_request({ body: { number: 4 } })';
const PERSON_MERGES = /a change request is merged by a person in the app/;

function resultText(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe('retired tools', () => {
  it('answers merge_change_request, in every spelling a surface uses, with who merges now', () => {
    for (const name of ['merge_change_request', 'knowledge_base.merge_change_request', 'hexis__merge_change_request']) {
      expect(retiredToolMessage(name), name).toMatch(PERSON_MERGES);
    }
  });

  it('leaves live tools and look-alikes alone', () => {
    expect(retiredToolMessage('merge_branch')).toBeUndefined();
    expect(retiredToolMessage('not_merge_change_request_x')).toBeUndefined();
    expect(retiredToolInCode('return knowledge_base.merge_branch({})')).toBeUndefined();
  });

  it('recognises a chain failure only in the shape the runner reports it', () => {
    const failed = { result: null, logs: ['[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.merge_change_request is not a function'] };
    expect(retiredToolChainFailure(RETIRED_CALL, failed)).toMatch(PERSON_MERGES);
    // A chain that succeeded is never rewritten, whatever it mentions.
    expect(retiredToolChainFailure(RETIRED_CALL, { result: 'ok', logs: [] })).toBeUndefined();
    // A failure that has nothing to do with a retired tool stays as it was.
    expect(retiredToolChainFailure('return KNOWLEDGE_BASE.read_file({})', failed)).toBeUndefined();
  });
});

describe('call_tool_chain and a retired tool', () => {
  // `@utcp/code-mode` does NOT throw when the code fails: it resolves
  // `{ result: null, logs: ['[ERROR] Code execution failed: …'] }`.
  it('answers the failed chain with the message, in the shape the runner really returns', async () => {
    const client = {
      callToolChain: vi.fn(async () => ({
        result: null,
        logs: ['[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.merge_change_request is not a function'],
      })),
    } as unknown as CodeModeUtcpClient;
    const result = await dispatchMetaTool(client, 'call_tool_chain', { code: RETIRED_CALL });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(PERSON_MERGES);
  });

  it('answers it through a real code-mode runner, not a mock', async () => {
    const client = await CodeModeUtcpClient.create(process.cwd(), null);
    try {
      const result = await dispatchMetaTool(client, 'call_tool_chain', { code: RETIRED_CALL });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(PERSON_MERGES);
    } finally {
      await client.close();
    }
  });

  it('still answers a thrown chain failure with the message', async () => {
    const client = {
      callToolChain: vi.fn(async () => {
        throw new TypeError('KNOWLEDGE_BASE.merge_change_request is not a function');
      }),
    } as unknown as CodeModeUtcpClient;
    const result = await dispatchMetaTool(client, 'call_tool_chain', { code: RETIRED_CALL });
    expect(resultText(result)).toMatch(PERSON_MERGES);
  });
});
