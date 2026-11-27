import { describe, it, expect, vi, beforeEach } from 'vitest';

// Each module is replaced at its entry, which is where the propose flow reaches
// it; the rest of each entry, the error classes included, stays real.
const gitApi = vi.hoisted(() => ({
  createBranch: vi.fn(),
  deleteBranch: vi.fn(),
}));
vi.mock('../../git', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../git')>()),
  ...gitApi,
}));
const wsApi = vi.hoisted(() => ({
  getOrCreateWorkspace: vi.fn(async () => ({
    workspace: { id: 'sugg-ws', kbDirName: 'knowledge-base' },
  })),
  writeFile: vi.fn(async () => {}),
}));
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  ...wsApi,
}));
vi.mock('../../pr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../pr')>()),
  openChangeRequest: vi.fn(async () => null),
}));
const listMine = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock('../services/change-requests.api', () => ({ listMyChangeRequests: listMine }));

import { ensureKnowledgeSuggestionWorkspace, proposeKnowledgeChange } from '../services/propose.api';
import { WorkspaceApiError } from '../../workspace';

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

describe('proposeKnowledgeChange: the branch the proposal goes to cannot be opened', () => {
  beforeEach(() => {
    gitApi.createBranch.mockReset().mockResolvedValue(undefined);
    listMine.mockReset().mockResolvedValue([]);
    wsApi.writeFile.mockClear();
  });

  /**
   * The workspace read answers a failure with its bare status, and the file
   * page shows a failed proposal's message as it is: "HTTP 410" told the
   * person nothing about why or what to do.
   */
  const propose = () =>
    proposeKnowledgeChange({
      repoRelativePath: 'KnowledgeBase/Finance/month-end-close.md',
      content: 'four days',
      userEmail: rae.email,
      userId: rae.id,
      userName: 'Rae',
    });

  it.each([
    ['the branch is gone (410)', new WorkspaceApiError(410)],
    ['the branch is not there (404)', new WorkspaceApiError(404)],
    ['the server failed (503)', new WorkspaceApiError(503)],
    ['no answer came back', new TypeError('Failed to fetch')],
  ])('says that nothing was sent and to try again, not the bare status, when %s', async (_case, failure) => {
    wsApi.getOrCreateWorkspace.mockRejectedValueOnce(failure);

    await expect(propose()).rejects.toThrow(
      "Nothing was sent: your proposal couldn't be saved for review just now. Try again in a moment.",
    );
    expect(wsApi.writeFile).not.toHaveBeenCalled();
  });

  /**
   * "Try again in a moment" is only true where a second attempt can work. A
   * lapsed session's 401 is not one of those, and keeps its own answer.
   */
  it('passes an answer that trying again cannot fix through as it came', async () => {
    const lapsed = new WorkspaceApiError(401);
    wsApi.getOrCreateWorkspace.mockRejectedValueOnce(lapsed);

    await expect(propose()).rejects.toBe(lapsed);
    expect(wsApi.writeFile).not.toHaveBeenCalled();
  });
});
