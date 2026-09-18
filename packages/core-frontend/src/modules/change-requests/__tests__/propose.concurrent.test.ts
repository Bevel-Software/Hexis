import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Proposing again while the first proposal is still loading.
 *
 * REPRODUCED against a running instance (ticket log, 2026-09-18): a business
 * user dropped two files back to back and the second proposal died on
 * `POST /api/workflow/change-requests` 409 — "An open change request already
 * exists from …" — shown to them as "Couldn't add change request". Both
 * flows had read `existingCr: null` from the fresh list, and both went on to
 * open the request. The window is exactly how long that list read takes, and
 * that grows with the number of open requests, which is why "propose more
 * while one loads" hit it reliably.
 *
 * Note what did NOT happen and is therefore not defended here: the
 * branch-reset path (delete + recreate) never fired, and all four files
 * survived in the one request. The damage was the 409 alone.
 */

const gitApi = vi.hoisted(() => ({ createBranch: vi.fn(), deleteBranch: vi.fn() }));
// The REAL module, with only the two verbs replaced: `propose.api` narrows the
// refusal with `err instanceof GitApiError`, so the class has to be the real one.
vi.mock('../../git/services/git.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../git/services/git.api')>()),
  createBranch: gitApi.createBranch,
  deleteBranch: gitApi.deleteBranch,
}));

const wsApi = vi.hoisted(() => ({
  getOrCreateWorkspace: vi.fn(async () => ({
    workspace: { id: 'sugg-ws', kbDirName: 'knowledge-base' },
  })),
  writeFile: vi.fn(async () => {}),
}));
vi.mock('../../workspace/services/workspace.api', () => wsApi);

const openApi = vi.hoisted(() => ({ openChangeRequest: vi.fn() }));
vi.mock('../../pr/services/pr-open.api', () => openApi);

const detailApi = vi.hoisted(() => ({ fetchPrDetail: vi.fn() }));
vi.mock('../../pr/services/pr-detail.api', () => detailApi);

const listMine = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock('../services/change-requests.api', () => ({ listMyChangeRequests: listMine }));

import { GitApiError } from '../../git/services/git.api';
import {
  ensureKnowledgeChangeRequest,
  ensureKnowledgeSuggestionWorkspace,
  type KnowledgeSuggestionTarget,
} from '../services/propose.api';

const BRANCH = 'suggestions/biz2-05a2cfde/knowledge';
const rae = { email: 'biz2@bevel.software', id: '05a2cfde-1111-2222-3333' };

/** What both racing flows hold: no request of their own yet. */
const target = (): KnowledgeSuggestionTarget => ({
  branch: BRANCH,
  workspaceId: 'sugg-ws',
  kbDirName: 'knowledge-base',
  existingCr: null,
});

/** The server's refusal, body and all — see `DuplicateChangeRequestError`. */
const duplicate409 = (existingNumber: number) =>
  new GitApiError(
    409,
    `An open change request already exists from "${BRANCH}" to "main" (#${existingNumber}).`,
    {
      kind: 'duplicate-change-request',
      sourceBranch: BRANCH,
      targetBranch: 'main',
      existingNumber,
    },
  );

beforeEach(() => {
  gitApi.createBranch.mockReset().mockResolvedValue(undefined);
  gitApi.deleteBranch.mockReset().mockResolvedValue(undefined);
  openApi.openChangeRequest.mockReset();
  detailApi.fetchPrDetail.mockReset();
  listMine.mockReset().mockResolvedValue([]);
});

describe('a second proposal started while the first is still loading', () => {
  it('opens ONE request for two concurrent proposals, and both get it', async () => {
    let release: (v: unknown) => void = () => {};
    openApi.openChangeRequest.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = ensureKnowledgeChangeRequest(target(), 'Biz Two');
    const second = ensureKnowledgeChangeRequest(target(), 'Biz Two');
    release({ number: 2, branch: BRANCH, state: 'open', touchedNodePaths: [] });

    const [a, b] = await Promise.all([first, second]);
    expect(openApi.openChangeRequest).toHaveBeenCalledTimes(1);
    expect(a?.number).toBe(2);
    expect(b).toBe(a);
  });

  it('adopts the request the server names instead of failing the proposal', async () => {
    // Sequential, not concurrent: the first flow finished and opened #2 while
    // the second was still uploading. No client-side coordination can see
    // that — nor can another tab — so the refusal itself has to be read.
    openApi.openChangeRequest.mockRejectedValue(duplicate409(2));
    detailApi.fetchPrDetail.mockResolvedValue({
      number: 2,
      branch: BRANCH,
      state: 'open',
      touchedNodePaths: ['Shared/one.pdf'],
    });

    const adopted = await ensureKnowledgeChangeRequest(target(), 'Biz Two');

    expect(adopted?.number).toBe(2);
    expect(adopted?.touchedNodePaths).toEqual(['Shared/one.pdf']);
    // Fresh: the request was opened seconds ago, and a cached list answer is
    // exactly the one that would not have it.
    expect(detailApi.fetchPrDetail).toHaveBeenCalledWith(2, { fresh: true });
  });

  it('still announces nothing rather than failing when the adopted request cannot be read', async () => {
    openApi.openChangeRequest.mockRejectedValue(duplicate409(7));
    detailApi.fetchPrDetail.mockRejectedValue(new Error('offline'));
    // The bytes are committed and the request is open either way; the only
    // loss is the optimistic rows, which the next list load brings anyway.
    await expect(ensureKnowledgeChangeRequest(target(), 'Biz Two')).resolves.toBeNull();
  });

  it('leaves every other refusal a failure', async () => {
    openApi.openChangeRequest.mockRejectedValue(new GitApiError(403, 'You may not write here'));
    await expect(ensureKnowledgeChangeRequest(target(), 'Biz Two')).rejects.toThrow(
      'You may not write here',
    );
    expect(detailApi.fetchPrDetail).not.toHaveBeenCalled();
  });

  it('does not adopt a 409 that is about something else', async () => {
    openApi.openChangeRequest.mockRejectedValue(
      new GitApiError(409, 'Conflicts merging', { kind: 'change-request-conflicts' }),
    );
    await expect(ensureKnowledgeChangeRequest(target(), 'Biz Two')).rejects.toThrow(
      'Conflicts merging',
    );
  });

  it('asks the slow list ONCE for two proposals started together', async () => {
    let release: (v: unknown[]) => void = () => {};
    listMine.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = ensureKnowledgeSuggestionWorkspace(rae);
    const second = ensureKnowledgeSuggestionWorkspace(rae);
    release([]);

    const [a, b] = await Promise.all([first, second]);
    expect(listMine).toHaveBeenCalledTimes(1);
    expect(gitApi.createBranch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('re-reads the list for a proposal made after the last one settled', async () => {
    // In-flight only, never a cache: a request withdrawn between two
    // proposals must not be remembered as still open.
    await ensureKnowledgeSuggestionWorkspace(rae);
    listMine.mockResolvedValue([{ number: 5, state: 'open', branch: BRANCH }]);
    const later = await ensureKnowledgeSuggestionWorkspace(rae);
    expect(listMine).toHaveBeenCalledTimes(2);
    expect(later.existingCr).toMatchObject({ number: 5 });
  });
});
