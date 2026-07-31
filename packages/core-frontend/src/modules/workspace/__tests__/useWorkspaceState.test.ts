import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the workspace API before importing the hook — the hook's top-level import
// binds to the mocked module.
vi.mock('../services/workspace.api', () => ({
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
