import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the workspace API before importing the hook — the hook's top-level import
// binds to the mocked module.
vi.mock('../services/workspace.api', async (importOriginal) => ({
  // The real error class, so a test can reject with the shape callers read.
  WorkspaceApiError: (await importOriginal<typeof import('../services/workspace.api')>()).WorkspaceApiError,
  getOrCreateWorkspace: vi.fn().mockResolvedValue({
    workspace: { id: 'ws-1' },
    fileTree: { name: '.', relativePath: '.', type: 'directory', children: [] },
  }),
  listFiles: vi.fn().mockResolvedValue({
    name: '.', relativePath: '.', type: 'directory', children: [],
  }),
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(undefined),
  createDirectory: vi.fn().mockResolvedValue(undefined),
  uploadFile: vi.fn().mockResolvedValue(undefined),
  deleteFile: vi.fn().mockResolvedValue(undefined),
  moveEntry: vi.fn().mockResolvedValue(undefined),
  deleteWorkspace: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceState } from '../hooks/useWorkspaceState';
import * as api from '../services/workspace.api';

describe('useWorkspaceState fsRevision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mountReady() {
    const { result } = renderHook(() => useWorkspaceState());
    // Wait for the initial getOrCreateWorkspace effect to settle and the workspaceId
    // to populate — mutations early-return without it.
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));
    return result;
  }

  it('starts at 0 and does not bump on read-only ops', async () => {
    const result = await mountReady();
    expect(result.current.fsRevision).toBe(0);
    await act(async () => {
      await result.current.refreshFileTree();
      await expect(result.current.addTab('a.md')).resolves.toBe(true);
    });
    expect(result.current.fsRevision).toBe(0);
  });

  it('bumps on each mutating call', async () => {
    const result = await mountReady();
    const start = result.current.fsRevision;

    await act(async () => { await result.current.createFile('a.md'); });
    expect(result.current.fsRevision).toBe(start + 1);

    await act(async () => { await result.current.createDirectory('d'); });
    expect(result.current.fsRevision).toBe(start + 2);

    await act(async () => { await result.current.saveFile('a.md', 'x'); });
    expect(result.current.fsRevision).toBe(start + 3);

    await act(async () => { await result.current.moveEntry('a.md', 'b.md'); });
    expect(result.current.fsRevision).toBe(start + 4);

    await act(async () => { await result.current.deleteEntry('b.md'); });
    expect(result.current.fsRevision).toBe(start + 5);

    await act(async () => {
      await result.current.uploadFiles([new File(['hi'], 'c.md')], '');
    });
    expect(result.current.fsRevision).toBe(start + 6);
  });

  // `deleteEntry` uses optimistic UI: it prunes the local tree before
  // awaiting the server, then rolls back on failure. Both transitions
  // are real state changes watchers (memoised tree derivations,
  // explorer re-renders) need to see, so `fsRevision` legitimately
  // bumps twice on the failure path — that's the cost of the folder
  // vanishing instantly on click. The old "no bump on failure" test
  // assumed the pre-optimistic synchronous flow.
  it('bumps optimistically and again on rollback when a mutation fails', async () => {
    const result = await mountReady();
    const start = result.current.fsRevision;

    vi.mocked(api.deleteFile).mockRejectedValueOnce(new Error('boom'));
    await act(async () => {
      await expect(result.current.deleteEntry('a.md')).rejects.toThrow('boom');
    });
    expect(result.current.fsRevision).toBeGreaterThan(start);
  });
});

/**
 * `createFile` writes unconditionally unless asked for an exclusive create —
 * the explorer's New file keeps its old call, and a caller that picked a name
 * from a possibly stale tree can have the backend refuse an existing file.
 */
describe('useWorkspaceState createFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function mountReady() {
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));
    return result;
  }

  it('writes unconditionally by default', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.createFile('a.md', '# A'); });
    expect(api.writeFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.writeFile).mock.calls[0]![3]?.ifAbsent).toBeUndefined();
  });

  it('passes ifAbsent through to the write', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.createFile('a.md', '# A', { ifAbsent: true }); });
    expect(api.writeFile).toHaveBeenCalledWith('ws-1', 'a.md', '# A', { ifAbsent: true });
  });

  it('rejects with the refusal, and leaves the tree and revision alone', async () => {
    const result = await mountReady();
    const start = result.current.fsRevision;
    const tree = result.current.fileTree;
    const listCalls = vi.mocked(api.listFiles).mock.calls.length;
    vi.mocked(api.writeFile).mockRejectedValueOnce(new api.WorkspaceApiError(409, '"a.md" already exists.'));
    await act(async () => {
      await expect(result.current.createFile('a.md', '', { ifAbsent: true })).rejects.toMatchObject({ status: 409 });
    });
    expect(result.current.fsRevision).toBe(start);
    // No refresh (the list count) AND no local edit (the same tree object):
    // the refused file was never added to the tree on screen.
    expect(vi.mocked(api.listFiles).mock.calls.length).toBe(listCalls);
    expect(result.current.fileTree).toBe(tree);
  });
});
