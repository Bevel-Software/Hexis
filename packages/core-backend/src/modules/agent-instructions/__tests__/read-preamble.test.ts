import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { readAgentPreamble, type PreambleWorkspace } from '../read-preamble.js';

function workspace(readFile: PreambleWorkspace['readFile']): PreambleWorkspace & { getOrCreateForBranch: ReturnType<typeof vi.fn> } {
  return {
    getOrCreateForBranch: vi.fn(async () => ({ id: workspaceIdForBranch(DEFAULT_BRANCH) })) as never,
    readFile,
  };
}

const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

describe('readAgentPreamble', () => {
  it('reads the default branch copy at <kbDirName>/mcp-description.md, creating the workspace first', async () => {
    const readFile = vi.fn(async () => 'Acme.\n');
    const ws = workspace(readFile);
    expect(await readAgentPreamble(ws, 'knowledge-base')).toBe('Acme.\n');
    expect(ws.getOrCreateForBranch).toHaveBeenCalledWith(DEFAULT_BRANCH);
    expect(readFile).toHaveBeenCalledWith(workspaceIdForBranch(DEFAULT_BRANCH), 'knowledge-base/mcp-description.md');
  });

  it('spells the path with the deployment\'s own KB dir name', async () => {
    const readFile = vi.fn(async () => '');
    await readAgentPreamble(workspace(readFile), 'kb');
    expect(readFile).toHaveBeenCalledWith(expect.any(String), 'kb/mcp-description.md');
  });

  it('only ENOENT is an absence', async () => {
    expect(await readAgentPreamble(workspace(vi.fn(async () => { throw enoent(); })), 'knowledge-base')).toBeNull();
  });

  it('any other read error throws, never an empty preamble', async () => {
    const eio = Object.assign(new Error('disk'), { code: 'EIO' });
    await expect(readAgentPreamble(workspace(vi.fn(async () => { throw eio; })), 'knowledge-base')).rejects.toBe(eio);
  });
});
