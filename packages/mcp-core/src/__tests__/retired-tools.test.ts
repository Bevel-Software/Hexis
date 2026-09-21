import { afterEach, describe, expect, it, vi } from 'vitest';
import '@utcp/mcp'; // side effect: registers the 'mcp' UTCP communication protocol
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { CallTemplateSerializer } from '@utcp/sdk';
import { retiredToolChainFailure, retiredToolInFailure, retiredToolMessage } from '../retired-tools.js';
import { registerManual } from '../dispatch.js';
import { dispatchMetaTool } from '../meta-tools.js';
import { startFakeMcpServer } from './fake-mcp-server.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => {});
});

/**
 * A real runner with a real `KNOWLEDGE_BASE` namespace that serves live tools
 * and NOT the retired one — the shape a deployment actually has.
 *
 * A client with no manuals at all would be the wrong fixture: there
 * `KNOWLEDGE_BASE` is not defined either, so the chain dies of
 * `ReferenceError: KNOWLEDGE_BASE is not defined` and never names the tool.
 * That failure would pass a test that scans the chain's SOURCE while proving
 * nothing about a call to a removed tool.
 */
async function realRunnerWithKnowledgeBase(): Promise<CodeModeUtcpClient> {
  const server = await startFakeMcpServer('KNOWLEDGE_BASE');
  cleanups.push(() => server.stop());
  const client = await CodeModeUtcpClient.create(process.cwd(), null);
  cleanups.push(() => client.close());
  const template = new CallTemplateSerializer().validateDict({
    name: 'KNOWLEDGE_BASE',
    call_template_type: 'mcp',
    config: { mcpServers: { srv: { transport: 'http', url: server.url, timeout: 10, terminate_on_close: true } } },
  });
  expect(await registerManual(client, template)).toEqual({ ok: true });
  return client;
}

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
    expect(retiredToolInFailure('knowledge_base.merge_branch is not a function')).toBeUndefined();
  });

  it('recognises a chain failure only in the shape the runner reports it', () => {
    const failed = { result: null, logs: ['[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.merge_change_request is not a function'] };
    expect(retiredToolChainFailure(failed)).toMatch(PERSON_MERGES);
    // A chain that succeeded is never rewritten, whatever it mentions.
    expect(retiredToolChainFailure({ result: 'ok', logs: [] })).toBeUndefined();
    // A null result without the runner's failure line is not a failed chain.
    expect(retiredToolChainFailure({ result: null, logs: ['merge_change_request'] })).toBeUndefined();
  });

  it('keeps the real reason a chain died when the retired name is only in its source', () => {
    // The chain mentions the name in a comment and dies of something else
    // entirely: replacing that with the migration notice would hide the only
    // clue the agent has.
    const unrelated = {
      result: null,
      logs: ['[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.read_file is not a function'],
    };
    expect(retiredToolChainFailure(unrelated)).toBeUndefined();
    expect(retiredToolInFailure('Request failed with status code 500')).toBeUndefined();
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
    const client = await realRunnerWithKnowledgeBase();
    const result = await dispatchMetaTool(client, 'call_tool_chain', { code: RETIRED_CALL });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toMatch(PERSON_MERGES);
  });

  it('leaves a real runner\'s unrelated failure alone, name in the source or not', async () => {
    // A chain that dies of anything else keeps reporting what killed it, even
    // with the retired name sitting in a comment. (An ordinary failed chain is
    // not an `isError` result — the runner's own message rides in `logs` —
    // and that is exactly what must not be overwritten.)
    const client = await realRunnerWithKnowledgeBase();
    const result = await dispatchMetaTool(client, 'call_tool_chain', {
      code: '// merge_change_request is gone\nreturn KNOWLEDGE_BASE.srv.no_such_tool({})',
    });
    expect(resultText(result)).not.toMatch(PERSON_MERGES);
    expect(resultText(result)).toContain('no_such_tool');
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

  // The chain names the retired tool in a comment but dies of something else:
  // the agent must get the reason it actually died, not the migration notice.
  const MENTIONS_ONLY = '// merge_change_request is gone\nreturn KNOWLEDGE_BASE.read_file({ body: { path: "a.md" } })';

  it('does not hide an unrelated returned failure behind the retirement message', async () => {
    const client = {
      callToolChain: vi.fn(async () => ({
        result: null,
        logs: ['[ERROR] Code execution failed: TypeError: KNOWLEDGE_BASE.read_file is not a function'],
      })),
    } as unknown as CodeModeUtcpClient;
    const result = await dispatchMetaTool(client, 'call_tool_chain', { code: MENTIONS_ONLY });
    expect(resultText(result)).not.toMatch(PERSON_MERGES);
    expect(resultText(result)).toContain('read_file is not a function');
  });

  it('does not hide an unrelated thrown failure behind the retirement message', async () => {
    const client = {
      callToolChain: vi.fn(async () => {
        throw new Error('Request failed with status code 500');
      }),
    } as unknown as CodeModeUtcpClient;
    const result = await dispatchMetaTool(client, 'call_tool_chain', { code: MENTIONS_ONLY });
    expect(result.isError).toBe(true);
    expect(resultText(result)).not.toMatch(PERSON_MERGES);
    expect(resultText(result)).toContain('status code 500');
  });
});
