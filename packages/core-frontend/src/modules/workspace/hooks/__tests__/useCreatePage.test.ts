import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

/**
 * New page across a branch switch: a create that was started on one branch
 * and is still waiting when the person switches stops rather than write to
 * the workspace it started on, and a page it had already made is not opened
 * over the branch they moved to.
 */

const { state, createFile, openWorkspacePath, recheck } = vi.hoisted(() => ({
  state: {
    workspaceBranch: 'alice/draft' as string | null,
    urlBranch: 'alice/draft' as string | null,
    target: { folder: 'kb/KnowledgeBase' as string | null, settled: true, current: true },
  },
  createFile: vi.fn<(path: string, content: string, opts?: { ifAbsent?: boolean }) => Promise<void>>(),
  openWorkspacePath: vi.fn(),
  recheck: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useLocation: () => ({ pathname: '/anything' }),
}));
vi.mock('../../routing/kb-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../routing/kb-routes')>()),
  branchFromPathname: () => state.urlBranch,
  useFileNav: () => ({ openWorkspacePath }),
}));
vi.mock('../../state/workspace.context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state/workspace.context')>()),
  useWorkspace: () => ({ kbDirName: 'kb', createFile, workspaceBranch: state.workspaceBranch }),
}));
vi.mock('../useMergedWorkspaceTree', () => ({
  useMergedWorkspaceTree: () => ({ tree: null, suggestionOnlyPaths: new Map(), withheld: 0 }),
}));
vi.mock('../useKnowledgeWriteTarget', () => ({
  useKnowledgeWriteTarget: () => ({ ...state.target, recheck, withdraw: vi.fn() }),
}));

import { useCreatePage } from '../useCreatePage';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The person switches to another branch: the workspace on screen and the URL follow. */
function switchBranch(rerender: () => void) {
  state.workspaceBranch = 'bob/draft';
  state.urlBranch = 'bob/draft';
  act(() => rerender());
}

beforeEach(() => {
  state.workspaceBranch = 'alice/draft';
  state.urlBranch = 'alice/draft';
  state.target = { folder: 'kb/KnowledgeBase', settled: true, current: true };
  createFile.mockReset().mockResolvedValue(undefined);
  openWorkspacePath.mockReset();
  recheck.mockReset();
});

describe('useCreatePage across a branch switch', () => {
  it('stops after its first recheck when the branch changed meanwhile: nothing is written', async () => {
    // The last answer is from before a page change, so the create asks again first.
    state.target = { folder: 'kb/KnowledgeBase', settled: true, current: false };
    const answer = deferred<string | null>();
    recheck.mockReturnValue(answer.promise);
    const { result, rerender } = renderHook(() => useCreatePage());

    let created!: Promise<string | null>;
    act(() => {
      created = result.current.createPage();
    });
    switchBranch(rerender);
    answer.resolve('kb/KnowledgeBase');

    expect(await created).toBeNull();
    expect(createFile).not.toHaveBeenCalled();
    expect(openWorkspacePath).not.toHaveBeenCalled();
  });

  it('does not open a page it made after the person switched away', async () => {
    const write = deferred<void>();
    createFile.mockReturnValue(write.promise);
    const { result, rerender } = renderHook(() => useCreatePage());

    let created!: Promise<string | null>;
    act(() => {
      created = result.current.createPage();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(createFile).toHaveBeenCalledWith('kb/KnowledgeBase/Untitled.md', expect.any(String), { ifAbsent: true });
    switchBranch(rerender);
    write.resolve();

    // Made, and its path answered, but not opened over the branch on screen now.
    expect(await created).toBe('kb/KnowledgeBase/Untitled.md');
    expect(openWorkspacePath).not.toHaveBeenCalled();
  });

  it('opens the page as before when nothing changed', async () => {
    const { result } = renderHook(() => useCreatePage());
    let created!: Promise<string | null>;
    act(() => {
      created = result.current.createPage();
    });
    expect(await created).toBe('kb/KnowledgeBase/Untitled.md');
    expect(openWorkspacePath).toHaveBeenCalledWith('kb/KnowledgeBase/Untitled.md', { edit: true });
  });
});
