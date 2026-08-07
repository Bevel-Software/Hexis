import { describe, it, expect, vi, beforeEach } from 'vitest';

const gitApi = vi.hoisted(() => ({
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
}));
vi.mock('../../git/services/git.api', () => gitApi);
const wsApi = vi.hoisted(() => ({
  getOrCreateWorkspace: vi.fn(async () => ({
    workspace: { id: 'sugg-ws', kbDirName: 'knowledge-base' },
  })),
  writeFile: vi.fn(async () => {}),
}));
vi.mock('../../workspace/services/workspace.api', () => wsApi);
vi.mock('../../pr/services/pr-open.api', () => ({ openChangeRequest: vi.fn(async () => null) }));
const listMine = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock('../services/change-requests.api', () => ({ listMyChangeRequests: listMine }));

import { ensureKnowledgeSuggestionWorkspace } from '../services/propose.api';

const rae = { email: 'reader@example.com', id: 'u9-1234-abcd' };

describe('ensureKnowledgeSuggestionWorkspace: branch reuse', () => {
  beforeEach(() => {
    gitApi.createBranch.mockReset();
    gitApi.deleteBranch.mockReset();
    listMine.mockReset().mockResolvedValue([]);
  });

  it('creates the branch fresh when nothing is in the way', async () => {
    gitApi.createBranch.mockResolvedValue(undefined);
    const target = await ensureKnowledgeSuggestionWorkspace(rae);
    // The id slice keeps two users with colliding email localparts apart.
    expect(target.branch).toBe('suggestions/reader-u9-1234-/knowledge');
    expect(gitApi.deleteBranch).not.toHaveBeenCalled();
  });

  /**
   * A leftover branch (a withdrawn round, a merge whose retirement failed)
   * still carries its commits, and reusing it re-proposes them. So the flow
   * TRIES a reset — delete (the server also retires the stale workspace
   * clone) and recreate from the default branch.
   */
  it('resets a leftover branch: delete, then recreate fresh', async () => {
    gitApi.createBranch
      .mockRejectedValueOnce(new Error("a branch named 'x' already exists"))
      .mockResolvedValueOnce(undefined);
    gitApi.deleteBranch.mockResolvedValue(undefined);

    const target = await ensureKnowledgeSuggestionWorkspace(rae);

    expect(gitApi.deleteBranch).toHaveBeenCalledWith(
      expect.any(String),
      'suggestions/reader-u9-1234-/knowledge',
    );
    expect(gitApi.createBranch).toHaveBeenCalledTimes(2);
    expect(target.branch).toBe('suggestions/reader-u9-1234-/knowledge');
  });

  it('falls back to plain reuse when the reset itself is refused', async () => {
    gitApi.createBranch.mockRejectedValue(new Error("a branch named 'x' already exists"));
    gitApi.deleteBranch.mockRejectedValue(new Error('403'));

    // No throw: the change request is what makes the branch reviewable, so a
    // refused reset degrades to the pre-existing reuse behaviour.
    const target = await ensureKnowledgeSuggestionWorkspace(rae);
    expect(target.workspaceId).toBe('sugg-ws');
  });

  /**
   * Only an already-exists refusal is evidence of a leftover worth
   * resetting. A transient failure says nothing about the branch, and
   * "delete on any error" could tear down a branch the error never
   * implicated.
   */
  it('does not attempt a reset on a transient createBranch failure', async () => {
    gitApi.createBranch.mockRejectedValue(new Error('network down'));
    const target = await ensureKnowledgeSuggestionWorkspace(rae);
    expect(gitApi.deleteBranch).not.toHaveBeenCalled();
    // The flow still proceeds — the write path surfaces anything real.
    expect(target.workspaceId).toBe('sugg-ws');
  });

  it('never touches the branch when the caller already has an open request on it', async () => {
    listMine.mockResolvedValue([
      { number: 12, state: 'open', branch: 'suggestions/reader-u9-1234-/knowledge' },
    ]);
    const target = await ensureKnowledgeSuggestionWorkspace(rae);
    expect(target.existingCr).not.toBeNull();
    expect(gitApi.createBranch).not.toHaveBeenCalled();
    expect(gitApi.deleteBranch).not.toHaveBeenCalled();
  });
});
