import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PullRequestSummary } from '@bevel-software/platform-shared';

// `proposeChange`'s collaborators, mocked at the module boundary: what is
// pinned here is which change-request write each round makes.
vi.mock('../../git/services/git.api', () => ({
  createBranch: vi.fn(),
  handleApiResponse: vi.fn(),
}));
vi.mock('../../workspace/services/workspace.api', () => ({
  getOrCreateWorkspace: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock('../../pr/services/pr-open.api', () => ({ openChangeRequest: vi.fn() }));
vi.mock('../../pr/services/pr-edit.api', () => ({ updateChangeRequest: vi.fn() }));
vi.mock('../services/plugins.api', () => ({ ensurePersonalPlugin: vi.fn() }));

import { proposeChange } from '../services/library.api';
import { createBranch } from '../../git/services/git.api';
import { getOrCreateWorkspace, writeFile } from '../../workspace/services/workspace.api';
import { openChangeRequest } from '../../pr/services/pr-open.api';
import { updateChangeRequest } from '../../pr/services/pr-edit.api';

const existingCr = { number: 42, branch: 'suggestions/alice/deploy' } as PullRequestSummary;

const base = {
  skillName: 'deploy',
  repoRelativePath: 'Skills/deploy/SKILL.md',
  content: 'new text',
  userEmail: 'alice@example.com',
  userName: 'Alice',
};

describe('proposeChange', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrCreateWorkspace).mockResolvedValue({
      workspace: { id: 'ws-branch', kbDirName: 'kb' },
    } as Awaited<ReturnType<typeof getOrCreateWorkspace>>);
    vi.mocked(writeFile).mockResolvedValue({} as Awaited<ReturnType<typeof writeFile>>);
  });

  it("a later round's note is APPENDED to the open request's description, never a replacement", async () => {
    const result = await proposeChange({ ...base, existingCr, note: 'Also fix the example.' });

    expect(updateChangeRequest).toHaveBeenCalledTimes(1);
    expect(updateChangeRequest).toHaveBeenCalledWith(42, { appendDescription: 'Also fix the example.' });
    // The append is the whole edit: no title, no full description to overwrite
    // a note or edit that landed meanwhile.
    expect(vi.mocked(updateChangeRequest).mock.calls[0][1]).not.toHaveProperty('description');
    expect(openChangeRequest).not.toHaveBeenCalled();
    expect(createBranch).not.toHaveBeenCalled();
    // The text is committed to the existing request's own branch.
    expect(getOrCreateWorkspace).toHaveBeenCalledWith('suggestions/alice/deploy');
    expect(writeFile).toHaveBeenCalledWith('ws-branch', 'kb/Skills/deploy/SKILL.md', 'new text');
    expect(result.branch).toBe('suggestions/alice/deploy');
  });

  it('a later round without a note leaves the description alone', async () => {
    await proposeChange({ ...base, existingCr });

    expect(updateChangeRequest).not.toHaveBeenCalled();
    expect(openChangeRequest).not.toHaveBeenCalled();
  });

  it("a first round opens a request carrying the note, and edits nothing", async () => {
    await proposeChange({ ...base, existingCr: null, note: 'Why: the old step is wrong.' });

    expect(openChangeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Why: the old step is wrong.' }),
    );
    expect(updateChangeRequest).not.toHaveBeenCalled();
  });
});
