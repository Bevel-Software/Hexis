import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, act, waitFor, screen, within, fireEvent } from '@testing-library/react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { VersionControlEvent } from '@bevel-software/platform-shared';
import { ConfirmProvider } from '../../../../shared/components';

// One error class shared by the mock module and the tests, hoisted so
// `vi.mock` can reach it before the real `workspace.api` would load.
const apiMocks = vi.hoisted(() => {
  class FakeWorkspaceApiError extends Error {
    status: number;
    constructor(status: number, message?: string) {
      super(message ?? `HTTP ${status}`);
      this.status = status;
      this.name = 'WorkspaceApiError';
    }
  }
  return {
    getOrCreateWorkspace: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    createDirectory: vi.fn(),
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    moveEntry: vi.fn(),
    deleteWorkspace: vi.fn(),
    WorkspaceApiError: FakeWorkspaceApiError,
  };
});
vi.mock('../../services/workspace.api', () => apiMocks);

import { EventBusProvider } from '../../../version-control';
import { stubServerEventStream } from '../../../../__tests__/server-event-stream';
import { useWorkspaceState } from '../useWorkspaceState';
const WorkspaceApiError = apiMocks.WorkspaceApiError;

/**
 * The branch as the server holds it. Reads answer from here and a missing
 * path answers 404, so "someone else deleted it" is just a `disk.delete`.
 */
let disk: Map<string, string>;

function treeOf(paths: string[]) {
  return {
    name: '.',
    relativePath: '.',
    type: 'directory' as const,
    children: paths.map((p) => ({ name: p.split('/').pop()!, relativePath: p, type: 'file' as const })),
  };
}

function fileChanged(path: string, by: { id: string; name: string } = { id: 'u-sam', name: 'Sam Rivera' }): VersionControlEvent {
  return {
    ...envelope(),
    kind: 'file-changed',
    workspaceId: 'ws-1',
    branch: 'main',
    path,
    newSha: 'abc123',
    byUserId: by.id,
    byUserName: by.name,
  };
}
const GIT_SYNC = { id: 'system', name: 'Git sync' };
const treeChanged = (): VersionControlEvent => ({ ...envelope(), kind: 'fs-tree-changed', workspaceId: 'ws-1', branch: 'main' });

let eventId = 0;
function envelope() {
  return { id: ++eventId, ts: new Date().toISOString() };
}

let bus: ReturnType<typeof stubServerEventStream>;

async function mountReady() {
  const { result } = renderHook(() => useWorkspaceState(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <EventBusProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </EventBusProvider>
    ),
  });
  await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));
  return result;
}
type Hook = Awaited<ReturnType<typeof mountReady>>;

async function open(result: Hook, ...paths: string[]) {
  for (const p of paths) {
    await act(async () => { await result.current.addTab(p); });
  }
}

/** Type into the active tab as the editor does: the buffer, then the dirty bridge. */
async function typeInto(result: Hook, value: string) {
  await act(async () => {
    result.current.setActiveTabContent(value);
    result.current.setHasUnsavedFileChanges?.(true);
  });
}

const tabAt = (result: Hook, path: string) => result.current.openTabs.find((t) => t.path === path);

/** Let pending reads and their state updates settle. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  // Every mock starts each test bare, and the defaults are installed again
  // below. Call history is per test (`not.toHaveBeenCalled` must see only
  // its own), and so are the held answers a test queues with
  // `mockImplementationOnce`. `clearAllMocks` drops the calls but keeps that
  // queue; the reset drops both here, so a hold a test queued and never used
  // cannot answer a later test, whatever `restoreAllMocks` in `afterEach`
  // does to a `vi.fn`.
  vi.resetAllMocks();
  disk = new Map([
    ['KB/Keep.md', 'keep'],
    ['KB/Gone.md', 'gone'],
    ['KB/Solo.md', 'solo'],
    ['KB/Other.md', 'other'],
    ['KB/Dir/a.md', 'a'],
    ['KB/Draft.md', '# Draft\n\nA page to delete.'],
  ]);
  bus = stubServerEventStream();
  apiMocks.getOrCreateWorkspace.mockResolvedValue({
    workspace: { id: 'ws-1', name: 'Workspace', absolutePath: '/tmp/ws-1', createdAt: '2026-10-09T00:00:00.000Z' },
    fileTree: treeOf([...disk.keys()]),
  });
  apiMocks.listFiles.mockImplementation(async () => treeOf([...disk.keys()]));
  apiMocks.readFile.mockImplementation(async (_ws: string, path: string) => {
    const bytes = disk.get(path);
    if (bytes === undefined) throw new WorkspaceApiError(404, 'Not found');
    return bytes;
  });
  // As the server answers: a write with `ifMatch` lands only while the file
  // holds those bytes, a missing file reading as empty; otherwise 409.
  apiMocks.writeFile.mockImplementation(async (_ws: string, path: string, content: string, options?: { ifMatch?: string }) => {
    if (options?.ifMatch !== undefined && (disk.get(path) ?? '') !== options.ifMatch) {
      throw new WorkspaceApiError(409, `"${path}" changed since you opened it.`);
    }
    disk.set(path, content);
  });
  apiMocks.deleteFile.mockImplementation(async (_ws: string, path: string) => {
    for (const p of [...disk.keys()]) if (p === path || p.startsWith(path + '/')) disk.delete(p);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('deleteEntry: the delete says where the page lands', () => {
  it('the only tab deleted: nothing is left, so the caller lands on Knowledge home', async () => {
    const result = await mountReady();
    await open(result, 'KB/Solo.md');

    let outcome: unknown;
    await act(async () => { outcome = await result.current.deleteEntry('KB/Solo.md'); });

    expect(outcome).toEqual({ closedActive: true, newActivePath: null });
    expect(result.current.openTabs).toEqual([]);
    expect(result.current.activeTab).toBeNull();
  });

  it('the active tab deleted with others open: the tab that is left becomes active', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Gone.md');

    let outcome: unknown;
    await act(async () => { outcome = await result.current.deleteEntry('KB/Gone.md'); });

    expect(outcome).toEqual({ closedActive: true, newActivePath: 'KB/Keep.md' });
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md']);
    expect(result.current.activeTab?.path).toBe('KB/Keep.md');
  });

  it('picks the neighbour on the left, as closing the tab does', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Gone.md', 'KB/Other.md');
    await act(async () => { result.current.activateTab(tabAt(result, 'KB/Gone.md')!); });

    let outcome: unknown;
    await act(async () => { outcome = await result.current.deleteEntry('KB/Gone.md'); });

    expect(outcome).toEqual({ closedActive: true, newActivePath: 'KB/Keep.md' });
    expect(result.current.activeTab?.path).toBe('KB/Keep.md');
  });

  it('a folder delete holding the open file lands on the tab that is left', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Dir/a.md');

    let outcome: unknown;
    await act(async () => { outcome = await result.current.deleteEntry('KB/Dir'); });

    expect(outcome).toEqual({ closedActive: true, newActivePath: 'KB/Keep.md' });
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md']);
  });

  it('a non-active tab deleted: its tab closes and the page stays where it is', async () => {
    const result = await mountReady();
    await open(result, 'KB/Gone.md', 'KB/Keep.md');

    let outcome: unknown;
    await act(async () => { outcome = await result.current.deleteEntry('KB/Gone.md'); });

    expect(outcome).toEqual({ closedActive: false, newActivePath: 'KB/Keep.md' });
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md']);
    expect(result.current.activeTab?.path).toBe('KB/Keep.md');
  });

  it('a cancelled delete closes nothing', async () => {
    const result = await mountReady();
    await open(result, 'KB/Gone.md');
    await typeInto(result, 'gone, edited');

    let deleting!: Promise<unknown>;
    act(() => { deleting = result.current.deleteEntry('KB/Gone.md'); });
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await act(async () => { expect(await deleting).toBe(false); });

    expect(apiMocks.deleteFile).not.toHaveBeenCalled();
    expect(result.current.activeTab?.path).toBe('KB/Gone.md');
    expect(result.current.activeTab?.content).toBe('gone, edited');
  });

  it('a refused or failed delete throws and closes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMocks.deleteFile.mockRejectedValueOnce(new WorkspaceApiError(403, 'Forbidden'));
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Gone.md');

    await act(async () => {
      await expect(result.current.deleteEntry('KB/Gone.md')).rejects.toThrow('Forbidden');
    });

    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md', 'KB/Gone.md']);
    expect(result.current.activeTab?.path).toBe('KB/Gone.md');
  });

  it('our own delete never marks the tab as deleted by someone else', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Gone.md');
    // The server echoes the delete back while the request is still in flight.
    apiMocks.deleteFile.mockImplementationOnce(async (_ws: string, path: string) => {
      disk.delete(path);
      bus.emit(fileChanged(path, { id: 'u-me', name: 'Me' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(result.current.openTabs.find((t) => t.path === path)?.deletedBy ?? null).toBeNull();
    });

    await act(async () => { await result.current.deleteEntry('KB/Gone.md'); });
    await settle();

    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md']);
    expect(result.current.openTabs.some((t) => t.deletedBy)).toBe(false);
  });

  // A page with no tab (a skill's, a tool's) learns of the delete from the
  // change events it causes, and those can trail the request's answer: the
  // delete stays this session's own after the request, not only during it.
  it('counts as our own after the request answers, for the path and what was under it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const result = await mountReady();
      await open(result, 'KB/Keep.md');
      expect(result.current.isOwnDelete?.('KB/Dir/In.md')).toBe(false);

      await act(async () => { await result.current.deleteEntry('KB/Dir'); });

      expect(result.current.isOwnDelete?.('KB/Dir')).toBe(true);
      expect(result.current.isOwnDelete?.('KB/Dir/In.md')).toBe(true);
      expect(result.current.isOwnDelete?.('KB/Dir-2/In.md')).toBe(false);
      expect(result.current.isOwnDelete?.('KB/Keep.md')).toBe(false);

      // Not for good: a later delete of the same path is someone else's.
      vi.advanceTimersByTime(61_000);
      expect(result.current.isOwnDelete?.('KB/Dir/In.md')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // Restored within the minute, then deleted again: the second delete is not
  // ours, so a read that found the path back ends the marker covering it.
  it('stops counting a path as our own once it was read back', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md');
    await act(async () => { await result.current.deleteEntry('KB/Dir'); });
    expect(result.current.isOwnDelete?.('KB/Dir/In.md')).toBe(true);

    act(() => { result.current.forgetOwnDelete?.('KB/Dir/In.md'); });

    expect(result.current.isOwnDelete?.('KB/Dir/In.md')).toBe(false);
  });
});

/**
 * The hook with an editor for its active tab whose unmount writes the buffer
 * back through `saveFile`, as the file lock's cleanup does.
 */
function mountWithEditor() {
  const hook: { current: ReturnType<typeof useWorkspaceState> } = { current: null! };
  function Editor({ path, content, save }: { path: string; content: string; save: (p: string, c: string) => Promise<void> }) {
    const latest = useRef(content);
    latest.current = content;
    useEffect(() => () => { void save(path, latest.current).catch(() => {}); }, [path, save]);
    return null;
  }
  function Harness() {
    hook.current = useWorkspaceState();
    const tab = hook.current.activeTab;
    return tab ? <Editor key={tab.path} path={tab.path} content={tab.content ?? ''} save={hook.current.saveFile} /> : null;
  }
  render(
    <EventBusProvider>
      <ConfirmProvider><Harness /></ConfirmProvider>
    </EventBusProvider>,
  );
  return hook;
}

describe('the editor writing back as its tab closes', () => {
  it('cannot re-create a file our own delete just removed', async () => {
    const result = mountWithEditor();
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));
    await open(result as Hook, 'KB/Keep.md', 'KB/Gone.md');
    apiMocks.writeFile.mockClear();

    await act(async () => { await result.current.deleteEntry('KB/Gone.md'); });
    await settle();

    expect(apiMocks.writeFile).not.toHaveBeenCalledWith('ws-1', 'KB/Gone.md', expect.anything());
    expect(disk.has('KB/Gone.md')).toBe(false);
    expect(result.current.activeTab?.path).toBe('KB/Keep.md');
  });

  it('waits for a read deciding whether the file exists, and is refused when it is gone', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    // The refetch is slow; the save (a tab switch unmounting the editor)
    // lands before it answers.
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      answer = () => reject(new WorkspaceApiError(404, 'Not found'));
    }));
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });
    await act(async () => {
      answer();
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
  });
  it('a read that finds the file lets the waiting save through', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');

    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited'); });

    expect(disk.get('KB/Draft.md')).toBe('edited');
  });
});

describe('a file deleted by someone else', () => {
  it('marks the open tab with who deleted it, keeping its content', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');

    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    // Still the active tab — the page shows the notice, it does not move.
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.');
  });

  it('keeps unsaved edits on the marked tab', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nA page to delete.\n\nA paragraph I added.');

    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.\n\nA paragraph I added.');
  });

  it('names nobody when the delete came from a pull from the git host', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');

    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md', GIT_SYNC)));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
  });

  it('names nobody when only a tree refresh shows the file gone', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');

    disk.delete('KB/Draft.md');
    act(() => bus.emit(treeChanged()));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
  });

  it('does not mark a tab the tree omits but the server still reads', async () => {
    apiMocks.listFiles.mockImplementation(async () => treeOf([]));
    const result = await mountReady();
    await open(result, 'KB/Draft.md');

    act(() => bus.emit(treeChanged()));
    await settle();

    expect(result.current.activeTab?.deletedBy ?? null).toBeNull();
  });

  it('reads a file the tree omits once, not again on every refresh', async () => {
    apiMocks.listFiles.mockImplementation(async () => treeOf([]));
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const reads = () => apiMocks.readFile.mock.calls.filter(([, p]) => p === 'KB/Draft.md').length;
    const before = reads();

    act(() => bus.emit(treeChanged()));
    await settle();
    expect(reads()).toBe(before + 1);
    act(() => bus.emit(treeChanged()));
    act(() => bus.emit(treeChanged()));
    await settle();
    expect(reads()).toBe(before + 1);

    // A while later the next refresh checks again — and learns of a delete.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31_000);
    try {
      disk.delete('KB/Draft.md');
      act(() => bus.emit(treeChanged()));
      await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
      expect(reads()).toBe(before + 2);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not skip the read on another branch because the branch just left found the file", async () => {
    apiMocks.listFiles.mockImplementation(async () => treeOf([]));
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    act(() => bus.emit(treeChanged()));
    await settle();

    // Within the recheck window, on `feature` (ws-2), the same path is deleted.
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      workspace: { id: 'ws-2', name: 'Workspace', absolutePath: '/tmp/ws-2', createdAt: '2026-10-09T00:00:00.000Z' },
      fileTree: treeOf([]),
    });
    act(() => { result.current.setPersistenceBranch('feature'); });
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-2'));
    await open(result, 'KB/Draft.md');
    disk.delete('KB/Draft.md');
    act(() => bus.emit({ ...treeChanged(), workspaceId: 'ws-2', branch: 'feature' } as VersionControlEvent));

    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toMatchObject({ name: null }));
  });

  it("keeps an agent's change awaiting review on a tab someone else deleted", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });
    expect(result.current.activeTab?.pendingFileContent).toBe('# Draft\n\nThe agent rewrote this.');

    disk.delete('KB/Draft.md');
    act(() => bus.emit(treeChanged()));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.pendingFileContent).toBe('# Draft\n\nThe agent rewrote this.');
  });

  it("rejecting an agent's change while a read deciding whether the file exists is out waits for it, and writes nothing back when it is gone", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    // The tree refresh no longer lists the file; its read is slow, and Reject
    // is clicked before it answers.
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      answer = () => reject(new WorkspaceApiError(404, 'Not found'));
    }));
    act(() => bus.emit(treeChanged()));
    await waitFor(() => expect(answer).toBeDefined());
    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await act(async () => {
      answer();
      await expect(rejecting).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.pendingFileContent).toBe('# Draft\n\nThe agent rewrote this.');
  });

  it("rejecting an agent's change on a tab already marked deleted writes nothing back", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toBeTruthy());
    apiMocks.writeFile.mockClear();

    await act(async () => {
      await expect(result.current.rejectPendingContent()).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(result.current.activeTab?.pendingFileContent).toBe('# Draft\n\nThe agent rewrote this.');
  });

  it("rejecting an agent's change on a file still there writes the baseline back, as before", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const baseline = result.current.activeTab?.savedContent;
    // The agent's tool call wrote its version to disk before the preview.
    disk.set('KB/Draft.md', '# Draft\n\nThe agent rewrote this.');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });

    await act(async () => { await result.current.rejectPendingContent(); });

    expect(disk.get('KB/Draft.md')).toBe(baseline);
    expect(result.current.activeTab?.pendingFileContent).toBeNull();
  });

  describe('an agent\'s change awaiting review on a background tab, after another file changed', () => {
    const AGENT = '# Draft\n\nThe agent rewrote this.';

    // Open an agent preview, switch tabs, another file changes.
    async function previewInBackground() {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      const baseline = result.current.activeTab?.savedContent;
      await act(async () => { result.current.setPendingContent(AGENT); });
      await open(result, 'KB/Other.md');
      await act(async () => { result.current.bumpFsRevision(); });
      return { result, baseline };
    }

    it('comes back with the preview and its baseline, never stalled on Opening', async () => {
      const { result, baseline } = await previewInBackground();

      await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
      await settle();

      const tab = result.current.activeTab;
      expect(tab?.path).toBe('KB/Draft.md');
      expect(tab?.content).toBe(baseline);
      expect(tab?.savedContent).toBe(baseline);
      expect(tab?.pendingFileContent).toBe(AGENT);
    });

    it('Accept takes the agent\'s text', async () => {
      const { result } = await previewInBackground();
      await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });

      await act(async () => { await result.current.acceptPendingContent(); });

      expect(result.current.activeTab?.content).toBe(AGENT);
      expect(result.current.activeTab?.pendingFileContent).toBeNull();
    });

    it('Reject writes the original baseline back', async () => {
      const { result, baseline } = await previewInBackground();
      await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
      disk.set('KB/Draft.md', AGENT);

      await act(async () => { await result.current.rejectPendingContent(); });

      expect(disk.get('KB/Draft.md')).toBe(baseline);
      expect(result.current.activeTab?.content).toBe(baseline);
      expect(result.current.activeTab?.pendingFileContent).toBeNull();
    });

    it('still learns on the switch that someone else deleted the file', async () => {
      const { result, baseline } = await previewInBackground();
      disk.delete('KB/Draft.md');

      await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });

      await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
      expect(result.current.activeTab?.content).toBe(baseline);
      expect(result.current.activeTab?.pendingFileContent).toBe(AGENT);
    });
  });

  it('dates the delete when the tab learns of it, and keeps that time', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const before = Date.now();

    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    const at = result.current.activeTab!.deletedBy!.at;
    expect(at).toBeGreaterThanOrEqual(before);

    act(() => bus.emit(treeChanged()));
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await settle();
    expect(result.current.activeTab?.deletedBy?.at).toBe(at);
  });

  it('a background tab deleted meanwhile shows as deleted once switched to', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    // A write elsewhere invalidates the background tab's bytes.
    await act(async () => { result.current.bumpFsRevision(); });
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.content).toBeNull();

    disk.delete('KB/Draft.md');
    await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Draft.md', 'KB/Keep.md']);
  });

  it('a background tab marked by an event keeps its name and bytes across later writes', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');

    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    await act(async () => { result.current.bumpFsRevision(); });
    await settle();
    await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    await settle();

    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.');
  });

  // The editor holding the edits unmounts when the notice replaces it, and
  // its file-lock cleanup (like the autosave and idle-release timers) writes
  // the buffer back through `saveFile`. That write re-created the deleted
  // file and took the notice away (Local Testing, mock screen 08).
  it('refuses to write a deleted file back, so the edits stay on the notice and the file stays deleted', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nA page to delete.\n\nA paragraph I added.');
    apiMocks.writeFile.mockClear();

    disk.delete('KB/Draft.md');
    let writeBack: Promise<void> | undefined;
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    await act(async () => {
      writeBack = result.current.saveFile('KB/Draft.md', '# Draft\n\nA page to delete.\n\nA paragraph I added.');
      await expect(writeBack).rejects.toThrow('Draft.md was deleted from this branch');
    });
    // An echo after the refused write finds nothing on disk either.
    act(() => bus.emit(fileChanged('KB/Draft.md', { id: 'u-me', name: 'Me' })));
    await settle();

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.\n\nA paragraph I added.');
  });

  // The viewer's unmount, as it runs when the notice replaces it: it reports
  // "not dirty" (FileViewer's cleanup) and its lock cleanup writes the buffer
  // back. Neither may reach the deleted tab — the notice shows the edits only
  // while the tab is dirty (Local Testing attempt 2, mock screen 08).
  it("keeps the deleted tab's unsaved edits through the viewer's unmount", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const edited = '# Draft\n\nA page to delete.\n\nA paragraph I added and had not saved yet.';
    await typeInto(result, edited);

    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    await act(async () => {
      result.current.setHasUnsavedFileChanges?.(false);
      await result.current.saveFile('KB/Draft.md', edited).catch(() => {});
    });

    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe(edited);
    expect(result.current.hasUnsavedFileChanges).toBe(true);
    expect(disk.has('KB/Draft.md')).toBe(false);
  });
  it('clears the dirty flag as before on a tab nobody deleted', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');

    await act(async () => { result.current.setHasUnsavedFileChanges?.(false); });

    expect(result.current.activeTab?.isDirty).toBe(false);
  });

  it('refuses the write the moment the delete is learned, before the marked tab renders', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    // The read's 404 marks the tab; a write issued in that same turn — as
    // the editor's unmount cleanup is — must already be refused.
    let refused: unknown = null;
    apiMocks.readFile.mockImplementationOnce(async () => {
      throw new WorkspaceApiError(404, 'Not found');
    });
    await act(async () => {
      bus.emit(fileChanged('KB/Draft.md'));
      await Promise.resolve();
      await Promise.resolve();
      await result.current.saveFile('KB/Draft.md', 'edited').catch((err: unknown) => { refused = err; });
    });

    expect(refused).toBeInstanceOf(Error);
    expect(apiMocks.writeFile).not.toHaveBeenCalled();
  });

  it('writes again once the file is back on the branch', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toBeTruthy());

    disk.set('KB/Draft.md', 'restored');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy ?? null).toBeNull());
    await act(async () => { await result.current.saveFile('KB/Draft.md', 'restored, edited'); });

    expect(disk.get('KB/Draft.md')).toBe('restored, edited');
  });

  it('an Edit click whose reload finds the file gone marks the tab; it stays open and active', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    disk.delete('KB/Draft.md');

    // The Edit click's take-ownership re-read answers 404.
    await act(async () => { await result.current.reloadTabFromDisk('KB/Draft.md'); });

    // The address still names Draft.md and the active tab is still it, now
    // marked: the file page shows the notice, not "Opening Draft.md…".
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null });
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.');
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md', 'KB/Draft.md']);
  });

  it('a reload after a sent proposal that finds the file gone keeps the unsaved edits on the marked tab', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nA page to delete.\n\nA paragraph I added.');
    disk.delete('KB/Draft.md');

    await act(async () => { await result.current.reloadTabFromDisk('KB/Draft.md'); });

    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null });
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.\n\nA paragraph I added.');
  });

  it('a save while that reload is in flight waits for it and is refused when the file is gone', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      answer = () => reject(new WorkspaceApiError(404, 'Not found'));
    }));
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reloadTabFromDisk('KB/Draft.md'); });
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });
    await act(async () => {
      answer();
      await reloading;
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(result.current.activeTab?.deletedBy).toBeTruthy();
  });

  it("a save while a switched-to tab's re-read is in flight waits for it and is refused when the file is gone", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    // A write elsewhere invalidates the background tab's bytes.
    await act(async () => { result.current.bumpFsRevision(); });
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.content).toBeNull();
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      answer = () => reject(new WorkspaceApiError(404, 'Not found'));
    }));
    act(() => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'written back'); });
    await act(async () => {
      answer();
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    // The page shows the notice for it, not "Opening Draft.md…".
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Draft.md', 'KB/Keep.md']);
  });

  it("a save while the active tab's re-read after a write is in flight waits for it, is refused, and keeps the edits", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      answer = () => reject(new WorkspaceApiError(404, 'Not found'));
    }));
    // A write elsewhere re-reads the clean active tab; the person types
    // meanwhile and the editor writes the buffer back as it unmounts.
    await act(async () => { result.current.bumpFsRevision(); });
    await typeInto(result, 'typed during the read');
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'typed during the read'); });
    await act(async () => {
      answer();
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('typed during the read');
  });

  it('a read that finds the file does not let a save through past an overlapping read that finds it gone', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    apiMocks.writeFile.mockClear();

    // Two reads overlap: the first is answered after the delete (404), the
    // second, answered first, still saw the file.
    let answerGone!: () => void;
    let answerFound!: () => void;
    apiMocks.readFile
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        answerGone = () => reject(new WorkspaceApiError(404, 'Not found'));
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        answerFound = () => resolve('# Draft\n\nA page to delete.');
      }));
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.reloadTabFromDisk('KB/Draft.md'); });
    act(() => { second = result.current.reloadTabFromDisk('KB/Draft.md'); });
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });
    let settled = false;
    void saving.then(() => { settled = true; }, () => { settled = true; });

    await act(async () => { answerFound(); await second; });
    // The found answer alone does not decide: the 404 is still to come.
    expect(settled).toBe(false);
    expect(apiMocks.writeFile).not.toHaveBeenCalled();

    disk.delete('KB/Draft.md');
    await act(async () => {
      answerGone();
      await first;
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null });
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('edited');
  });

  it('a save waits on a read that started while it was already waiting, and is refused when that one finds the file gone', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    apiMocks.writeFile.mockClear();

    let answerFound!: () => void;
    let answerGone!: () => void;
    apiMocks.readFile
      .mockImplementationOnce(() => new Promise((resolve) => {
        answerFound = () => resolve('# Draft\n\nA page to delete.');
      }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        answerGone = () => reject(new WorkspaceApiError(404, 'Not found'));
      }));
    let first!: Promise<void>;
    act(() => { first = result.current.reloadTabFromDisk('KB/Draft.md'); });
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });
    let second!: Promise<void>;
    act(() => { second = result.current.reloadTabFromDisk('KB/Draft.md'); });

    disk.delete('KB/Draft.md');
    await act(async () => {
      answerFound();
      await first;
      answerGone();
      await second;
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('edited');
  });

  it('an older read that found the file, answering after a newer 404, does not undo the delete', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'my unsaved edits');
    apiMocks.writeFile.mockClear();

    // A change event's read is issued while the file is still there; the
    // delete's event follows, and its read answers 404 before the first.
    let answerFound!: () => void;
    let answerGone!: () => void;
    apiMocks.readFile
      .mockImplementationOnce(() => new Promise((resolve) => {
        answerFound = () => resolve('# Draft\n\nA page to delete, changed.');
      }))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        answerGone = () => reject(new WorkspaceApiError(404, 'Not found'));
      }));
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));

    await act(async () => { answerGone(); });
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
    await act(async () => { answerFound(); });
    await settle();

    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('my unsaved edits');
    expect(result.current.activeTab?.changedOnBranch ?? null).toBeNull();
    await expect(result.current.saveFile('KB/Draft.md', 'my unsaved edits')).rejects.toThrow('Draft.md was deleted from this branch');
    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
  });
  it('a read issued after the 404 that finds the file again ends the delete, as a restore does', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toBeTruthy());

    disk.set('KB/Draft.md', 'restored');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toBeFalsy());
    expect(result.current.activeTab?.content).toBe('restored');
    await act(async () => { await result.current.saveFile('KB/Draft.md', 'restored, edited'); });
    expect(disk.get('KB/Draft.md')).toBe('restored, edited');
  });

  describe('a 404 from the branch just left', () => {
    /** Switch to `feature` (workspace ws-2), where Draft.md still exists, and open it there. */
    async function switchToFeature(result: Hook) {
      apiMocks.getOrCreateWorkspace.mockResolvedValue({
        workspace: { id: 'ws-2', name: 'Workspace', absolutePath: '/tmp/ws-2', createdAt: '2026-10-09T00:00:00.000Z' },
        fileTree: treeOf(['KB/Draft.md']),
      });
      act(() => { result.current.setPersistenceBranch('feature'); });
      await waitFor(() => expect(result.current.workspaceId).toBe('ws-2'));
      await open(result, 'KB/Draft.md');
    }
    const changedOnFeature = () => ({ ...fileChanged('KB/Draft.md'), workspaceId: 'ws-2', branch: 'feature' }) as VersionControlEvent;

    it("does not make this branch's read of the same path stale", async () => {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      const reloadOnMain = result.current.reloadTabFromDisk;
      await switchToFeature(result);

      let answerFound!: () => void;
      let answerGoneOnMain!: () => void;
      apiMocks.readFile
        .mockImplementationOnce(() => new Promise((resolve) => {
          answerFound = () => resolve('changed on feature');
        }))
        .mockImplementationOnce(() => new Promise((_resolve, reject) => {
          answerGoneOnMain = () => reject(new WorkspaceApiError(404, 'Not found'));
        }));
      // This branch's change read is issued first; a read pinned to the
      // branch just left is issued after it and answers 404 first.
      act(() => bus.emit(changedOnFeature()));
      let mainReload!: Promise<void>;
      act(() => { mainReload = reloadOnMain('KB/Draft.md'); });
      await act(async () => { answerGoneOnMain(); await mainReload; });
      await act(async () => { answerFound(); });

      await waitFor(() => expect(result.current.activeTab?.content).toBe('changed on feature'));
      expect(result.current.activeTab?.deletedBy).toBeFalsy();
    });

    it("does not hold up or refuse a save on this branch", async () => {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      const reloadOnMain = result.current.reloadTabFromDisk;
      await switchToFeature(result);

      let answerGoneOnMain!: () => void;
      apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
        answerGoneOnMain = () => reject(new WorkspaceApiError(404, 'Not found'));
      }));
      let mainReload!: Promise<void>;
      act(() => { mainReload = reloadOnMain('KB/Draft.md'); });
      // Saved on feature while main's read is still out: not waited on.
      await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited on feature'); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-2', 'KB/Draft.md', 'edited on feature', { ifMatch: '# Draft\n\nA page to delete.' });

      await act(async () => { answerGoneOnMain(); await mainReload; });
      await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited again'); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-2', 'KB/Draft.md', 'edited again', { ifMatch: 'edited on feature' });
    });
  });

  it('a lock released by a delete shows the open file as deleted, keeping its content', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    disk.delete('KB/Draft.md');

    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.');
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md', 'KB/Draft.md']);
    await expect(result.current.saveFile('KB/Draft.md', 'written back')).rejects.toThrow('Draft.md was deleted from this branch');
    expect(disk.has('KB/Draft.md')).toBe(false);
  });
  it('a lock released by a delete shows the notice over unsaved edits too, keeping them', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    await typeInto(result, 'my unsaved edits');
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');

    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));

    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: null }));
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('my unsaved edits');
    await expect(result.current.saveFile('KB/Draft.md', 'my unsaved edits')).rejects.toThrow('Draft.md was deleted from this branch');
    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
  });
  it("a lock released on a file that is still there leaves a dirty tab's edits alone", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'my unsaved edits');
    disk.set('KB/Draft.md', 'changed meanwhile');

    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));
    await settle();

    expect(apiMocks.readFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md');
    expect(result.current.activeTab?.deletedBy).toBeFalsy();
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('my unsaved edits');
    expect(result.current.activeTab?.savedContent).toBe('# Draft\n\nA page to delete.');
  });

  describe('a lock released while the tab is clean, whose read answers late', () => {
    /** The lock-released read is held until `answer` is called; later reads answer from `disk`. */
    function holdLockReleasedRead() {
      // Answering a read that was never issued would exercise nothing.
      const held: { answer: () => void } = { answer: () => { throw new Error('Lock-released read was not started'); } };
      apiMocks.readFile.mockClear();
      apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
        held.answer = () => resolve('# Draft\n\nA page to delete, changed.');
      }));
      act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));
      expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');
      return held;
    }

    it('does not replace edits typed while it was out, after a newer read found the file gone', async () => {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      const held = holdLockReleasedRead();
      await typeInto(result, 'my unsaved edits');
      apiMocks.writeFile.mockClear();
      disk.delete('KB/Draft.md');
      act(() => bus.emit(fileChanged('KB/Draft.md')));
      await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));

      await act(async () => { held.answer(); });
      await settle();

      // The notice stays, and Copy edits still holds what was typed.
      expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
      expect(result.current.activeTab?.isDirty).toBe(true);
      expect(result.current.activeTab?.content).toBe('my unsaved edits');
      await expect(result.current.saveFile('KB/Draft.md', 'my unsaved edits')).rejects.toThrow('Draft.md was deleted from this branch');
      expect(apiMocks.writeFile).not.toHaveBeenCalled();
    });

    it('does not replace edits typed while it was out on a file that is still there', async () => {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      const held = holdLockReleasedRead();
      await typeInto(result, 'my unsaved edits');

      await act(async () => { held.answer(); });
      await settle();

      expect(result.current.activeTab?.isDirty).toBe(true);
      expect(result.current.activeTab?.content).toBe('my unsaved edits');
    });
  });

  it("a switched-to tab's late read does not replace edits typed after a newer read loaded it and a later one found it gone", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    // A write elsewhere invalidates the background tab's bytes.
    await act(async () => { result.current.bumpFsRevision(); });
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.content).toBeNull();

    // The switch's read is held; the ones after it answer from `disk`.
    const held: { answer: () => void } = { answer: () => { throw new Error('Activation read was not started'); } };
    apiMocks.readFile.mockClear();
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      held.answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    act(() => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    // A newer read loads the tab, and the person types into it.
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));
    await waitFor(() => expect(result.current.activeTab?.content).toBe('# Draft\n\nA page to delete.'));
    await typeInto(result, 'my unsaved edits');
    // A newer read still finds the file gone.
    apiMocks.writeFile.mockClear();
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));

    await act(async () => { held.answer(); });
    await settle();

    // The notice stays, and Copy edits still holds what was typed.
    expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
    expect(result.current.activeTab?.isDirty).toBe(true);
    expect(result.current.activeTab?.content).toBe('my unsaved edits');
    await expect(result.current.saveFile('KB/Draft.md', 'my unsaved edits')).rejects.toThrow('Draft.md was deleted from this branch');
    expect(apiMocks.writeFile).not.toHaveBeenCalled();
  });

  it("a switched-to tab's late read does not replace the newer bytes a later read already brought", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    await act(async () => { result.current.bumpFsRevision(); });
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.content).toBeNull();

    // The switch's read is held, answering with the bytes it saw then.
    const held: { answer: () => void } = { answer: () => { throw new Error('Activation read was not started'); } };
    apiMocks.readFile.mockClear();
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      held.answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    act(() => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    // The file changes, and a newer read brings the new bytes.
    disk.set('KB/Draft.md', '# Draft\n\nChanged since.');
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));
    await waitFor(() => expect(result.current.activeTab?.content).toBe('# Draft\n\nChanged since.'));

    await act(async () => { held.answer(); });
    await settle();

    expect(result.current.activeTab?.content).toBe('# Draft\n\nChanged since.');
    expect(result.current.activeTab?.savedContent).toBe('# Draft\n\nChanged since.');
  });

  it('a reload issued while a save was out does not replace the saved text with the bytes it read before the save', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'my saved text');

    // The save's write is held; the reload issued meanwhile reads the old bytes.
    const write: { finish: () => void } = { finish: () => { throw new Error('Write was not started'); } };
    apiMocks.writeFile.mockImplementationOnce((_ws: string, path: string, content: string) => new Promise<void>((resolve) => {
      write.finish = () => { disk.set(path, content); resolve(); };
    }));
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'my saved text'); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

    const read: { answer: () => void } = { answer: () => { throw new Error('Reload read was not started'); } };
    apiMocks.readFile.mockClear();
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      read.answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reloadTabFromDisk('KB/Draft.md'); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');
    // The re-read the save's revision bump starts is slow: it has not answered
    // by the time the reload does, so only the save itself orders the two.
    apiMocks.readFile.mockImplementationOnce(() => new Promise(() => {}));

    // The save finishes first, then the reload answers with what it read before it.
    await act(async () => { write.finish(); await saving; });
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledTimes(2));
    expect(result.current.activeTab?.savedContent).toBe('my saved text');
    await act(async () => { read.answer(); await reloading; });
    await settle();

    expect(result.current.activeTab?.content).toBe('my saved text');
    expect(result.current.activeTab?.savedContent).toBe('my saved text');
    expect(result.current.activeTab?.isDirty).toBe(false);
  });

  /** Hold the next read of the path; `answer` resolves it with the bytes the disk had when it was issued. */
  function holdNextRead() {
    const read: { answer: () => void } = { answer: () => { throw new Error('Held read was not started'); } };
    apiMocks.readFile.mockClear();
    apiMocks.readFile.mockImplementationOnce((_ws: string, path: string) => {
      const before = disk.get(path);
      return new Promise((resolve) => { read.answer = () => resolve(before); });
    });
    return read;
  }

  it("a reload issued before an agent's change was accepted does not replace the accepted text with the bytes it read before", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');

    const read = holdNextRead();
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reloadTabFromDisk('KB/Draft.md'); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    // The agent's tool call writes the file; the person accepts its change.
    disk.set('KB/Draft.md', '# Draft\n\nThe agent rewrote this.');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });
    await act(async () => { await result.current.acceptPendingContent(); });
    expect(result.current.activeTab?.savedContent).toBe('# Draft\n\nThe agent rewrote this.');

    await act(async () => { read.answer(); await reloading; });
    await settle();

    expect(result.current.activeTab?.content).toBe('# Draft\n\nThe agent rewrote this.');
    expect(result.current.activeTab?.savedContent).toBe('# Draft\n\nThe agent rewrote this.');
    expect(result.current.activeTab?.isDirty).toBe(false);
  });

  it('a reload issued before the tab was closed and opened again does not replace the bytes the new open read', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');

    const read = holdNextRead();
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reloadTabFromDisk('KB/Draft.md'); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    await act(async () => { await result.current.closeTab(result.current.activeTab!, { skipConfirm: true }); });
    disk.set('KB/Draft.md', '# Draft\n\nChanged since.');
    await open(result, 'KB/Draft.md');
    expect(result.current.activeTab?.content).toBe('# Draft\n\nChanged since.');

    await act(async () => { read.answer(); await reloading; });
    await settle();

    expect(result.current.activeTab?.content).toBe('# Draft\n\nChanged since.');
    expect(result.current.activeTab?.savedContent).toBe('# Draft\n\nChanged since.');
  });

  it('Close (closeTab without asking) removes the marked tab and names the tab that is left', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    await typeInto(result, 'edited');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toBeTruthy());

    let closed: unknown;
    await act(async () => { closed = await result.current.closeTab(result.current.activeTab!, { skipConfirm: true }); });

    expect(closed).toEqual({ closed: true, newActivePath: 'KB/Keep.md' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md']);
  });
});

describe('a change pulled from the git host onto the open file', () => {
  const BASE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

  async function editedTab() {
    disk.set('KB/Notes.md', BASE);
    const result = await mountReady();
    await open(result, 'KB/Notes.md');
    return result;
  }

  it('merges unsaved edits onto it: the merged text stays unsaved, and the tab says so', async () => {
    const result = await editedTab();
    await typeInto(result, `${BASE}\n\nMy new closing line.`);

    const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
    disk.set('KB/Notes.md', pulled);
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));

    await waitFor(() => expect(result.current.activeTab?.changedOnBranch).toBe('merged'));
    const tab = result.current.activeTab!;
    expect(tab.content).toBe(`${pulled}\n\nMy new closing line.`);
    expect(tab.savedContent).toBe(pulled);
    expect(tab.isDirty).toBe(true);
    expect(tab.remoteRevision).toBe(1);
  });

  it('discards edits that collide with it, and the tab says so', async () => {
    const result = await editedTab();
    await typeInto(result, BASE.replace('Second paragraph.', 'Second paragraph, my way.'));

    const pulled = BASE.replace('Second paragraph.', 'Second paragraph, their way.');
    disk.set('KB/Notes.md', pulled);
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));

    await waitFor(() => expect(result.current.activeTab?.changedOnBranch).toBe('discarded'));
    const tab = result.current.activeTab!;
    expect(tab.content).toBe(pulled);
    expect(tab.savedContent).toBe(pulled);
    expect(tab.isDirty).toBe(false);
  });

  it('a clean tab takes the new content silently, as before', async () => {
    const result = await editedTab();

    const pulled = BASE.replace('Third paragraph.', 'Third paragraph, updated.');
    disk.set('KB/Notes.md', pulled);
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));

    await waitFor(() => expect(result.current.activeTab?.content).toBe(pulled));
    expect(result.current.activeTab?.savedContent).toBe(pulled);
    expect(result.current.activeTab?.isDirty).toBe(false);
    expect(result.current.activeTab?.changedOnBranch ?? null).toBeNull();
    // Open in the editor with nothing typed yet, it reloads the new bytes:
    // keeping the old ones, its next save would write them over the pull.
    expect(result.current.activeTab?.remoteRevision).toBe(1);
  });

  it('a clean tab re-read from disk with new bytes reloads the editor too', async () => {
    const result = await editedTab();
    const pulled = BASE.replace('Third paragraph.', 'Third paragraph, updated.');
    disk.set('KB/Notes.md', pulled);

    await act(async () => { await result.current.reloadTabFromDisk('KB/Notes.md'); });

    expect(result.current.activeTab?.content).toBe(pulled);
    expect(result.current.activeTab?.remoteRevision).toBe(1);
  });

  it('a clean tab re-read from disk with the same bytes keeps the editor as it is', async () => {
    const result = await editedTab();

    await act(async () => { await result.current.reloadTabFromDisk('KB/Notes.md'); });

    expect(result.current.activeTab?.content).toBe(BASE);
    expect(result.current.activeTab?.remoteRevision ?? 0).toBe(0);
  });

  /** The next file-changed read is held until `answer` is called; later reads answer from `disk`. */
  function holdFileChangedRead(bytes: string) {
    const held: { answer: () => void } = { answer: () => { throw new Error('File-changed read was not started'); } };
    apiMocks.readFile.mockClear();
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      held.answer = () => resolve(bytes);
    }));
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Notes.md');
    return held;
  }

  it("a change's late read does not replace the newer bytes a later change already brought to a clean tab", async () => {
    const result = await editedTab();
    const first = BASE.replace('First paragraph.', 'First paragraph, pulled first.');
    const held = holdFileChangedRead(first);

    const second = BASE.replace('First paragraph.', 'First paragraph, pulled second.');
    disk.set('KB/Notes.md', second);
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
    await waitFor(() => expect(result.current.activeTab?.content).toBe(second));

    await act(async () => { held.answer(); });
    await settle();

    expect(result.current.activeTab?.content).toBe(second);
    expect(result.current.activeTab?.savedContent).toBe(second);
    expect(result.current.activeTab?.isDirty).toBe(false);
  });

  it("a change's late read still merges into unsaved edits that a newer read left alone", async () => {
    const result = await editedTab();
    await typeInto(result, `${BASE}\n\nMy new closing line.`);
    const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
    disk.set('KB/Notes.md', pulled);
    const held = holdFileChangedRead(pulled);

    // A newer read finds the file but keeps off the edited tab.
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Notes.md' } as VersionControlEvent));
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledTimes(2));
    await settle();
    expect(result.current.activeTab?.savedContent).toBe(BASE);

    await act(async () => { held.answer(); });
    await waitFor(() => expect(result.current.activeTab?.changedOnBranch).toBe('merged'));
    expect(result.current.activeTab?.content).toBe(`${pulled}\n\nMy new closing line.`);
    expect(result.current.activeTab?.savedContent).toBe(pulled);
    expect(result.current.activeTab?.isDirty).toBe(true);
  });

  it('the banner clears on the next save', async () => {
    const result = await editedTab();
    await typeInto(result, `${BASE}\n\nMine.`);
    disk.set('KB/Notes.md', BASE.replace('First', 'Upstream first'));
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
    await waitFor(() => expect(result.current.activeTab?.changedOnBranch).toBe('merged'));

    await act(async () => { await result.current.saveFile('KB/Notes.md', result.current.activeTab!.content!); });

    expect(result.current.activeTab?.changedOnBranch ?? null).toBeNull();
    expect(disk.get('KB/Notes.md')).toBe(`${BASE.replace('First', 'Upstream first')}\n\nMine.`);
  });

  it('a save waiting on a change read writes the edits merged onto the pulled bytes, not over them', async () => {
    const result = await editedTab();
    const edited = `${BASE}\n\nMy new closing line.`;
    await typeInto(result, edited);
    const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
    disk.set('KB/Notes.md', pulled);
    const held = holdFileChangedRead(pulled);

    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Notes.md', edited); });
    await act(async () => { held.answer(); await saving; });

    const merged = `${pulled}\n\nMy new closing line.`;
    expect(disk.get('KB/Notes.md')).toBe(merged);
    const tab = result.current.activeTab!;
    expect(tab.content).toBe(merged);
    expect(tab.savedContent).toBe(merged);
    expect(tab.isDirty).toBe(false);
    // The person has not seen the change yet: the banner still says the edits were merged.
    expect(tab.changedOnBranch).toBe('merged');
    // The change read lands nothing past the save's write, so the save is
    // what tells an editor an autosave left open to reload the merged text;
    // keeping its own, its next save would write over the pulled commit.
    expect(tab.remoteRevision).toBe(1);
  });

  it('a save waiting on a change read whose bytes collide with the edits writes nothing over them', async () => {
    const result = await editedTab();
    const edited = BASE.replace('Second paragraph.', 'Second paragraph, my way.');
    await typeInto(result, edited);
    const pulled = BASE.replace('Second paragraph.', 'Second paragraph, their way.');
    disk.set('KB/Notes.md', pulled);
    const held = holdFileChangedRead(pulled);
    apiMocks.writeFile.mockClear();

    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Notes.md', edited); });
    await act(async () => { held.answer(); await saving; });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.get('KB/Notes.md')).toBe(pulled);
    const tab = result.current.activeTab!;
    expect(tab.content).toBe(pulled);
    expect(tab.isDirty).toBe(false);
    expect(tab.changedOnBranch).toBe('discarded');
  });

  describe('two saves queued before a held change read answers', () => {
    /** Both saves are asked for before the change read answers; then it does. */
    async function queueTwoSaves(result: Hook, first: string, second: string, pulled: string) {
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);
      let one!: Promise<void>;
      let two!: Promise<void>;
      act(() => {
        one = result.current.saveFile('KB/Notes.md', first);
        two = result.current.saveFile('KB/Notes.md', second);
      });
      await act(async () => { held.answer(); await one; await two; });
    }

    it('after the first merges onto the pulled bytes, the second keeps them too', async () => {
      const result = await editedTab();
      const first = `${BASE}\n\nMy new closing line.`;
      const second = `${first}\n\nAnd one more.`;
      await typeInto(result, second);
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      await queueTwoSaves(result, first, second, pulled);

      const merged = `${pulled}\n\nMy new closing line.\n\nAnd one more.`;
      expect(disk.get('KB/Notes.md')).toBe(merged);
      // The second write expected what the first one wrote.
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith(
        'ws-1', 'KB/Notes.md', merged, { ifMatch: `${pulled}\n\nMy new closing line.` },
      );
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(merged);
      expect(tab.savedContent).toBe(merged);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('merged');
    });

    it('after the first gives its colliding edits up, the second writes nothing over the pulled bytes', async () => {
      const result = await editedTab();
      const first = BASE.replace('Second paragraph.', 'Second paragraph, my way.');
      const second = `${first}\n\nAnd one more.`;
      await typeInto(result, second);
      const pulled = BASE.replace('Second paragraph.', 'Second paragraph, their way.');
      apiMocks.writeFile.mockClear();
      await queueTwoSaves(result, first, second, pulled);

      expect(apiMocks.writeFile).not.toHaveBeenCalled();
      expect(disk.get('KB/Notes.md')).toBe(pulled);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(pulled);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('discarded');
    });

    it('when the pull already holds the first, the second still lands its own edit on it', async () => {
      const result = await editedTab();
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      const second = `${pulled}\n\nAnd one more.`;
      await typeInto(result, second);
      await queueTwoSaves(result, pulled, second, pulled);

      expect(disk.get('KB/Notes.md')).toBe(second);
      expect(result.current.activeTab?.isDirty).toBe(false);
    });

    it('a second save with nothing new writes nothing and keeps the banner the first one set', async () => {
      const result = await editedTab();
      const edited = `${BASE}\n\nMy new closing line.`;
      await typeInto(result, edited);
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      apiMocks.writeFile.mockClear();
      await queueTwoSaves(result, edited, edited, pulled);

      expect(apiMocks.writeFile).toHaveBeenCalledOnce();
      expect(disk.get('KB/Notes.md')).toBe(`${pulled}\n\nMy new closing line.`);
      expect(result.current.activeTab?.changedOnBranch).toBe('merged');
    });
  });

  describe('typing while an autosave is on its way', () => {
    /**
     * Saves `saved`; once its PUT has started (the change read, when one is
     * held, answered first and merged onto the tab, reloading the editor) the
     * person types on the editor's text: `typed` of it; then the PUT lands.
     */
    async function typeDuringWrite(
      result: Hook, saved: string, typed: (now: string) => string, held?: { answer: () => void },
    ) {
      const write = apiMocks.writeFile.getMockImplementation()!;
      let land!: () => void;
      const landed = new Promise<void>((r) => { land = r; });
      apiMocks.writeFile.mockClear();
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        await landed;
        return write(...args);
      });
      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', saved); });
      if (held) await act(async () => { held.answer(); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      await typeInto(result, typed(result.current.activeTab!.content!));
      await act(async () => { land(); await saving; });
    }

    it('a write that merged onto a pull keeps the later typing, merged onto what it wrote, and the next save lands both', async () => {
      const result = await editedTab();
      const edited = `${BASE}\n\nMy new closing line.`;
      await typeInto(result, edited);
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);

      await typeDuringWrite(result, edited, (now) => `${now}\n\nTyped while it saved.`, held);

      const written = `${pulled}\n\nMy new closing line.`;
      expect(disk.get('KB/Notes.md')).toBe(written);
      const tab = result.current.activeTab!;
      // The editor reloads (remoteRevision) onto the pull AND the later typing.
      expect(tab.content).toBe(`${written}\n\nTyped while it saved.`);
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch).toBe('merged');
      // Once for the change read merged onto the tab, once for the write.
      expect(tab.remoteRevision).toBe(2);

      await act(async () => { await result.current.saveFile('KB/Notes.md', tab.content!); });

      expect(disk.get('KB/Notes.md')).toBe(`${written}\n\nTyped while it saved.`);
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith(
        'ws-1', 'KB/Notes.md', `${written}\n\nTyped while it saved.`, { ifMatch: written },
      );
      expect(result.current.activeTab?.isDirty).toBe(false);
    });

    it('later typing over the pulled lines the editor showed is an edit, kept unsaved', async () => {
      const result = await editedTab();
      const edited = `${BASE}\n\nMy new closing line.`;
      await typeInto(result, edited);
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);

      // The change read merged the edits onto the pull and reloaded the
      // editor with it: rewriting the pulled line is the person's choice.
      await typeDuringWrite(
        result, edited, (now) => now.replace('First paragraph, rewritten upstream.', 'First paragraph, my way.'), held,
      );

      const written = `${pulled}\n\nMy new closing line.`;
      expect(disk.get('KB/Notes.md')).toBe(written);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(written.replace('First paragraph, rewritten upstream.', 'First paragraph, my way.'));
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch).toBe('merged');
      expect(tab.remoteRevision).toBe(2);
    });

    it('typing during the change read, before it lands, is kept with the later typing', async () => {
      const result = await editedTab();
      const edited = `${BASE}\n\nMy new closing line.`;
      await typeInto(result, edited);
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);
      const early = edited.replace('Second paragraph.', 'Second paragraph, typed early.');
      const write = apiMocks.writeFile.getMockImplementation()!;
      let land!: () => void;
      const landed = new Promise<void>((r) => { land = r; });
      apiMocks.writeFile.mockClear();
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        await landed;
        return write(...args);
      });

      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', edited); });
      await typeInto(result, early);
      await act(async () => { held.answer(); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      await typeInto(result, `${result.current.activeTab!.content!}\n\nTyped while it saved.`);
      await act(async () => { land(); await saving; });

      const written = `${pulled}\n\nMy new closing line.`;
      expect(disk.get('KB/Notes.md')).toBe(written);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(
        `${written.replace('Second paragraph.', 'Second paragraph, typed early.')}\n\nTyped while it saved.`,
      );
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(true);
    });

    it('a write with no pull keeps the later typing unsaved, without reloading the editor', async () => {
      const result = await editedTab();
      const edited = `${BASE}\n\nMy new closing line.`;
      await typeInto(result, edited);
      const typed = `${edited}\n\nTyped while it saved.`;

      await typeDuringWrite(result, edited, () => typed);

      expect(disk.get('KB/Notes.md')).toBe(edited);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(typed);
      expect(tab.savedContent).toBe(edited);
      expect(tab.isDirty).toBe(true);
      expect(tab.remoteRevision ?? 0).toBe(0);
    });
  });

  it('Done during a colliding change read still says the edits were discarded', async () => {
    const result = await editedTab();
    const edited = BASE.replace('Second paragraph.', 'Second paragraph, my way.');
    await typeInto(result, edited);
    const pulled = BASE.replace('Second paragraph.', 'Second paragraph, their way.');
    disk.set('KB/Notes.md', pulled);
    const held = holdFileChangedRead(pulled);
    apiMocks.writeFile.mockClear();

    // Done: the save starts and the closing editor reports the tab clean,
    // all before the change read answers.
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.saveFile('KB/Notes.md', edited);
      result.current.setHasUnsavedFileChanges?.(false);
    });
    await act(async () => { held.answer(); await saving; });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.get('KB/Notes.md')).toBe(pulled);
    const tab = result.current.activeTab!;
    expect(tab.content).toBe(pulled);
    expect(tab.savedContent).toBe(pulled);
    expect(tab.isDirty).toBe(false);
    expect(tab.changedOnBranch).toBe('discarded');
  });

  it('Done during a change read that already holds the edits shows no banner', async () => {
    const result = await editedTab();
    const edited = BASE.replace('Second paragraph.', 'Second paragraph, agreed.');
    await typeInto(result, edited);
    disk.set('KB/Notes.md', edited);
    const held = holdFileChangedRead(edited);
    apiMocks.writeFile.mockClear();

    let saving!: Promise<void>;
    act(() => {
      saving = result.current.saveFile('KB/Notes.md', edited);
      result.current.setHasUnsavedFileChanges?.(false);
    });
    await act(async () => { held.answer(); await saving; });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    const tab = result.current.activeTab!;
    expect(tab.content).toBe(edited);
    expect(tab.savedContent).toBe(edited);
    expect(tab.changedOnBranch ?? null).toBeNull();
  });

  describe('Done during a change read the edits merge onto', () => {
    /**
     * Done on `edited` while the read of a pulled commit is held: the save
     * starts and the closing editor reports the tab clean, then the read
     * answers (onto the clean tab, so it takes the pulled bytes) and the save
     * merges onto the pull. `whileWriting` runs once the PUT has started,
     * before it lands.
     */
    async function doneDuringRead(result: Hook, edited: string, pulled: string, whileWriting?: () => Promise<void>) {
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);
      const write = apiMocks.writeFile.getMockImplementation()!;
      let land!: () => void;
      const landed = new Promise<void>((r) => { land = r; });
      apiMocks.writeFile.mockClear();
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        await landed;
        return write(...args);
      });
      let saving!: Promise<void>;
      act(() => {
        saving = result.current.saveFile('KB/Notes.md', edited);
        result.current.setHasUnsavedFileChanges?.(false);
      });
      await act(async () => { held.answer(); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      if (whileWriting) await whileWriting();
      await act(async () => { land(); await saving; });
    }

    it('the tab holds what was written, saved, with the merged banner, and a later save keeps the edit', async () => {
      const result = await editedTab();
      const edited = BASE.replace('First paragraph.', 'LOCALEDIT First paragraph.');
      await typeInto(result, edited);
      const pulled = `${BASE} HOSTAPPENDED`;

      await doneDuringRead(result, edited, pulled);

      const written = `${BASE.replace('First paragraph.', 'LOCALEDIT First paragraph.')} HOSTAPPENDED`;
      expect(disk.get('KB/Notes.md')).toBe(written);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(written);
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('merged');

      // Edit, type a line, then Done again with the editor's text: the branch
      // holds the first edit, the pulled line and the new one.
      const again = `${written}\n\nEdited after Done.`;
      await typeInto(result, again);
      await act(async () => { await result.current.saveFile('KB/Notes.md', result.current.activeTab!.content!); });
      expect(disk.get('KB/Notes.md')).toBe(again);
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', again, { ifMatch: written });
      expect(result.current.activeTab?.isDirty).toBe(false);
    });

    it('the read keeps the edits in the clean tab, and typing after it is kept with them', async () => {
      const result = await editedTab();
      const edited = BASE.replace('First paragraph.', 'LOCALEDIT First paragraph.');
      await typeInto(result, edited);
      const pulled = `${BASE} HOSTAPPENDED`;
      const written = `${BASE.replace('First paragraph.', 'LOCALEDIT First paragraph.')} HOSTAPPENDED`;

      // The read lands on the tab Done marked clean: it shows the edits on
      // the pull, still clean, never the pulled bytes alone. Edit again, type.
      await doneDuringRead(result, edited, pulled, async () => {
        const now = result.current.activeTab!;
        expect(now.content).toBe(written);
        expect(now.isDirty).toBe(false);
        await typeInto(result, `${written}\n\nTyped after Done.`);
      });

      expect(disk.get('KB/Notes.md')).toBe(written);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(`${written}\n\nTyped after Done.`);
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch).toBe('merged');
    });
  });

  describe('Done again while the save of the first Done is on its way', () => {
    /**
     * The next two writes are held, each until its `land` is called; `fail`
     * makes the first one fail instead of writing.
     */
    function holdTwoWrites(fail?: boolean) {
      const write = apiMocks.writeFile.getMockImplementation()!;
      const gates: Array<() => void> = [];
      const landed = [0, 1].map(() => new Promise<void>((r) => { gates.push(r); }));
      apiMocks.writeFile.mockClear();
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        await landed[0];
        if (fail) throw new WorkspaceApiError(500, 'The write failed.');
        return write(...args);
      });
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        await landed[1];
        return write(...args);
      });
      return { landFirst: gates[0], landSecond: gates[1] };
    }

    /** Edit to `text`, then Done: the save starts and the closing editor reports the tab clean. */
    function done(result: Hook, text: string): Promise<void> {
      let saving!: Promise<void>;
      act(() => {
        result.current.setActiveTabContent(text);
        saving = result.current.saveFile('KB/Notes.md', text);
        result.current.setHasUnsavedFileChanges?.(false);
      });
      return saving;
    }

    it('the first landing keeps the second Done\'s text, and an Edit before the second lands keeps it too', async () => {
      const result = await editedTab();
      const first = `${BASE}\n\nFIRSTDONE`;
      const second = `${first}\n\nSECONDDONE`;
      const writes = holdTwoWrites();
      const one = done(result, first);
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const two = done(result, second);

      await act(async () => { writes.landFirst(); await one; });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledTimes(2));

      expect(disk.get('KB/Notes.md')).toBe(first);
      let tab = result.current.activeTab!;
      // The second Done's text, not the first one's: its save writes it.
      expect(tab.content).toBe(second);
      expect(tab.savedContent).toBe(first);
      expect(tab.isDirty).toBe(false);

      // Edit again and type before the second save lands.
      const typed = `${second}\n\nTYPED`;
      await typeInto(result, typed);
      await act(async () => { writes.landSecond(); await two; });

      expect(disk.get('KB/Notes.md')).toBe(second);
      tab = result.current.activeTab!;
      expect(tab.content).toBe(typed);
      expect(tab.isDirty).toBe(true);
      await act(async () => { await result.current.saveFile('KB/Notes.md', tab.content!); });
      expect(disk.get('KB/Notes.md')).toBe(typed);
    });

    it('a first save that merged onto a pull shows the second Done\'s text merged onto it, and an Edit keeps all three', async () => {
      const result = await editedTab();
      const first = BASE.replace('First paragraph.', 'FIRSTDONE First paragraph.');
      const second = first.replace('Second paragraph.', 'SECONDDONE Second paragraph.');
      const pulled = `${BASE} HOSTAPPENDED`;
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);
      const writes = holdTwoWrites();
      const one = done(result, first);
      const two = done(result, second);
      await act(async () => { held.answer(); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

      await act(async () => { writes.landFirst(); await one; });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledTimes(2));

      const wroteFirst = `${first} HOSTAPPENDED`;
      const both = `${second} HOSTAPPENDED`;
      expect(disk.get('KB/Notes.md')).toBe(wroteFirst);
      let tab = result.current.activeTab!;
      expect(tab.content).toBe(both);
      expect(tab.savedContent).toBe(wroteFirst);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('merged');

      const typed = `TYPED\n\n${both}`;
      await typeInto(result, typed);
      await act(async () => { writes.landSecond(); await two; });

      expect(disk.get('KB/Notes.md')).toBe(both);
      tab = result.current.activeTab!;
      expect(tab.content).toBe(typed);
      expect(tab.isDirty).toBe(true);
      await act(async () => { await result.current.saveFile('KB/Notes.md', tab.content!); });
      expect(disk.get('KB/Notes.md')).toBe(typed);
    });

    it('a first save that fails leaves the second Done\'s text, which its own save writes', async () => {
      const result = await editedTab();
      const first = `${BASE}\n\nFIRSTDONE`;
      const second = `${first}\n\nSECONDDONE`;
      const writes = holdTwoWrites(true);
      const one = done(result, first);
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const two = done(result, second);

      await act(async () => { writes.landFirst(); await one.catch(() => {}); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledTimes(2));

      let tab = result.current.activeTab!;
      // Not the failed save's older text put back as unsaved edits.
      expect(tab.content).toBe(second);
      expect(tab.isDirty).toBe(false);

      await act(async () => { writes.landSecond(); await two; });

      expect(disk.get('KB/Notes.md')).toBe(second);
      tab = result.current.activeTab!;
      expect(tab.content).toBe(second);
      expect(tab.savedContent).toBe(second);
      expect(tab.isDirty).toBe(false);
    });

    it('a first save the pull already holds leaves the second Done\'s text on the pull', async () => {
      const result = await editedTab();
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      const second = `${pulled}\n\nSECONDDONE`;
      disk.set('KB/Notes.md', pulled);
      const held = holdFileChangedRead(pulled);
      const writes = holdTwoWrites();
      const one = done(result, pulled);
      const two = done(result, second);

      await act(async () => { held.answer(); await one; });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

      // The first save wrote nothing: the pull holds its text.
      let tab = result.current.activeTab!;
      expect(tab.content).toBe(second);
      expect(tab.savedContent).toBe(pulled);
      expect(tab.isDirty).toBe(false);

      await act(async () => { writes.landFirst(); await two; });

      expect(disk.get('KB/Notes.md')).toBe(second);
      tab = result.current.activeTab!;
      expect(tab.content).toBe(second);
      expect(tab.isDirty).toBe(false);
    });
  });

  describe('a save merged onto a pull the tab never took, and later text that collides with it', () => {
    /**
     * A refresh read of the open file (`reloadTabFromDisk`), held until
     * `answer`. It answers `bytes`; the save waits on it and finds them on
     * disk, but the read lands nothing in a tab holding edits or Done's text
     * whose save is on its way, so the tab's saved bytes stay the ones the
     * edits began from. The write then merges onto bytes the tab never held,
     * and the text that came after it is measured from the save's own text.
     */
    function holdReloadRead(result: Hook, bytes: string) {
      let answer!: () => void;
      apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
        answer = () => resolve(bytes);
      }));
      let reloading!: Promise<void>;
      act(() => { reloading = result.current.reloadTabFromDisk('KB/Notes.md'); });
      return { answer: async () => { await act(async () => { answer(); await reloading; }); } };
    }

    /** The next write waits until `land` is called. */
    function holdWrite() {
      const write = apiMocks.writeFile.getMockImplementation()!;
      let land!: () => void;
      const landed = new Promise<void>((r) => { land = r; });
      apiMocks.writeFile.mockClear();
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        await landed;
        return write(...args);
      });
      return { land: () => land() };
    }

    const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');

    it('typing during the write that collides with the pull is discarded: the tab holds what was written, and the next save keeps it', async () => {
      const result = await editedTab();
      const edited = `${BASE}\n\nMy new closing line.`;
      await typeInto(result, edited);
      disk.set('KB/Notes.md', pulled);
      const read = holdReloadRead(result, pulled);
      const write = holdWrite();

      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', edited); });
      await read.answer();
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const written = `${pulled}\n\nMy new closing line.`;
      // The write merged onto the pull, expecting it on disk; the read left
      // the tab holding edits alone, on the bytes they began from.
      expect(apiMocks.writeFile).toHaveBeenCalledWith('ws-1', 'KB/Notes.md', written, { ifMatch: pulled });
      expect(result.current.activeTab?.savedContent).toBe(BASE);
      const revisionBefore = result.current.activeTab?.remoteRevision ?? 0;

      // Typed while the write was out, on the line the pull rewrote.
      await typeInto(result, edited.replace('First paragraph.', 'First paragraph, my way.'));
      await act(async () => { write.land(); await saving; });

      expect(disk.get('KB/Notes.md')).toBe(written);
      let tab = result.current.activeTab!;
      // The typing collides with the pull: given up, and the banner says so.
      // The tab holds the written bytes as its baseline, and the editor
      // reloads them (remoteRevision), so nothing of the typing is left in it.
      expect(tab.content).toBe(written);
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('discarded');
      expect(tab.remoteRevision).toBe(revisionBefore + 1);

      // The next save is measured from the written bytes, and expects them.
      const again = `${written}\n\nAfter the discard.`;
      await typeInto(result, again);
      await act(async () => { await result.current.saveFile('KB/Notes.md', result.current.activeTab!.content!); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', again, { ifMatch: written });
      expect(disk.get('KB/Notes.md')).toBe(again);
      tab = result.current.activeTab!;
      expect(tab.content).toBe(again);
      expect(tab.savedContent).toBe(again);
      expect(tab.isDirty).toBe(false);
    });

    it('a later Done whose text collides with the pull is discarded at the first landing, and its own save writes nothing over the pull', async () => {
      const result = await editedTab();
      const first = BASE.replace('Second paragraph.', 'FIRSTDONE Second paragraph.');
      // The second Done rewrites the line the pull rewrote.
      const second = first.replace('First paragraph.', 'First paragraph, my way.');
      disk.set('KB/Notes.md', pulled);
      const read = holdReloadRead(result, pulled);
      const write = holdWrite();
      const done = (text: string) => {
        let saving!: Promise<void>;
        act(() => {
          result.current.setActiveTabContent(text);
          saving = result.current.saveFile('KB/Notes.md', text);
          result.current.setHasUnsavedFileChanges?.(false);
        });
        return saving;
      };

      const one = done(first);
      const two = done(second);
      await read.answer();
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const written = pulled.replace('Second paragraph.', 'FIRSTDONE Second paragraph.');
      expect(apiMocks.writeFile).toHaveBeenCalledWith('ws-1', 'KB/Notes.md', written, { ifMatch: pulled });
      // The read landed nothing in the tab holding the second Done's text.
      let tab = result.current.activeTab!;
      expect(tab.content).toBe(second);
      expect(tab.savedContent).toBe(BASE);

      await act(async () => { write.land(); await one; });
      tab = result.current.activeTab!;
      expect(tab.content).toBe(written);
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('discarded');

      // The queued save measures the same text from the same base onto the
      // same bytes, so it collides too and writes nothing.
      await act(async () => { await two; });
      expect(apiMocks.writeFile).toHaveBeenCalledOnce();
      expect(disk.get('KB/Notes.md')).toBe(written);
      tab = result.current.activeTab!;
      expect(tab.content).toBe(written);
      expect(tab.savedContent).toBe(written);
      expect(tab.changedOnBranch).toBe('discarded');

      const again = `${written}\n\nAfter the discard.`;
      await typeInto(result, again);
      await act(async () => { await result.current.saveFile('KB/Notes.md', result.current.activeTab!.content!); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', again, { ifMatch: written });
      expect(disk.get('KB/Notes.md')).toBe(again);
    });

    it('a first save that collides writes nothing, and a later Done that collides too is discarded with it, never shown without the pull', async () => {
      const result = await editedTab();
      // Both Dones rewrite the line the pull rewrote.
      const first = BASE.replace('First paragraph.', 'First paragraph, my way.');
      const second = `${first}\n\nSECONDDONE`;
      disk.set('KB/Notes.md', pulled);
      const read = holdReloadRead(result, pulled);
      apiMocks.writeFile.mockClear();
      const done = (text: string) => {
        let saving!: Promise<void>;
        act(() => {
          result.current.setActiveTabContent(text);
          saving = result.current.saveFile('KB/Notes.md', text);
          result.current.setHasUnsavedFileChanges?.(false);
        });
        return saving;
      };

      const one = done(first);
      const two = done(second);
      await read.answer();
      await act(async () => { await one; await two; });

      // The first save gave its edits up to the pull and wrote nothing. The
      // second Done's text is merged onto the pull from the first one's base
      // by the queued save: it collides as well, so nothing is written over
      // the pull, and the tab holds the pull with the discarded banner.
      expect(apiMocks.writeFile).not.toHaveBeenCalled();
      expect(disk.get('KB/Notes.md')).toBe(pulled);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(pulled);
      expect(tab.savedContent).toBe(pulled);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('discarded');

      const again = `${pulled}\n\nAfter the discard.`;
      await typeInto(result, again);
      await act(async () => { await result.current.saveFile('KB/Notes.md', result.current.activeTab!.content!); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', again, { ifMatch: pulled });
      expect(disk.get('KB/Notes.md')).toBe(again);
    });
  });

  describe("a pull that lands on disk while a save's answer is still out", () => {
    /**
     * The next write lands on disk at once, but its answer waits until
     * `answer` is called: a commit pulled from the git host can land on top
     * of it, and its `file-changed` read answer, first. That read lands on
     * nothing; the file is read again once the write settles.
     */
    function holdWriteAnswer() {
      const write = apiMocks.writeFile.getMockImplementation()!;
      let answer!: () => void;
      const answered = new Promise<void>((r) => { answer = r; });
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        const wrote = await write(...args);
        await answered;
        return wrote;
      });
      return { answer: () => answer() };
    }

    /** Done: the editor closes, the tab is marked clean, the save is sent. */
    function done(result: Hook, text: string): Promise<void> {
      let saving!: Promise<void>;
      act(() => {
        result.current.setActiveTabContent(text);
        saving = result.current.saveFile('KB/Notes.md', text);
        result.current.setHasUnsavedFileChanges?.(false);
      });
      return saving;
    }

    const SAVED = BASE.replace('Second paragraph.', 'Second paragraph, saved.');
    const upstream = (text: string) => text.replace('First paragraph.', 'First paragraph, rewritten upstream.');

    it("takes the newer bytes over Done's text once the write settles, and the next save expects them", async () => {
      const result = await editedTab();
      const write = holdWriteAnswer();
      const saving = done(result, SAVED);
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));

      // Pulled on top of the write, before its answer arrived.
      const pulled = upstream(SAVED);
      disk.set('KB/Notes.md', pulled);
      const readsBefore = apiMocks.readFile.mock.calls.length;
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBe(readsBefore + 1));
      await settle();
      // No read lands while the write is on its way.
      expect(result.current.activeTab?.savedContent).toBe(BASE);
      expect(result.current.activeTab?.content).toBe(SAVED);

      await act(async () => { write.answer(); await saving; });
      // Read again after the write, the pull reaches the tab.
      await waitFor(() => expect(result.current.activeTab?.savedContent).toBe(pulled));
      await settle();

      const tab = result.current.activeTab!;
      expect(tab.content).toBe(pulled);
      expect(tab.isDirty).toBe(false);
      // A clean tab takes a pull silently.
      expect(tab.changedOnBranch ?? null).toBe(null);

      const again = `${pulled}\n\nAfter the pull.`;
      await typeInto(result, again);
      await act(async () => { await result.current.saveFile('KB/Notes.md', result.current.activeTab!.content!); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', again, { ifMatch: pulled });
      expect(disk.get('KB/Notes.md')).toBe(again);
    });

    it('keeps typing merged onto the newer bytes, with its banner, and the next save writes it over them', async () => {
      const result = await editedTab();
      await typeInto(result, SAVED);
      const write = holdWriteAnswer();
      // An autosave: the editor stays open, and the person types on.
      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', SAVED); });
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      const typed = `${SAVED}\n\nTyped while the save was out.`;
      await typeInto(result, typed);

      const pulled = upstream(SAVED);
      disk.set('KB/Notes.md', pulled);
      const readsBefore = apiMocks.readFile.mock.calls.length;
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBe(readsBefore + 1));
      await settle();
      // No read lands while the write is on its way.
      expect(result.current.activeTab?.content).toBe(typed);
      expect(result.current.activeTab?.changedOnBranch ?? null).toBe(null);

      await act(async () => { write.answer(); await saving; });
      const merged = upstream(typed);
      await waitFor(() => expect(result.current.activeTab?.changedOnBranch).toBe('merged'));
      await settle();

      const tab = result.current.activeTab!;
      expect(tab.content).toBe(merged);
      expect(tab.savedContent).toBe(pulled);
      expect(tab.isDirty).toBe(true);

      await act(async () => { await result.current.saveFile('KB/Notes.md', merged); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', merged, { ifMatch: pulled });
      expect(disk.get('KB/Notes.md')).toBe(merged);
      expect(result.current.activeTab?.isDirty).toBe(false);
    });

    // The save landed (the disk held the bytes it expected) and the tab is
    // clean with them; a commit that replaced it afterwards reaches the tab
    // as any pull reaches a clean tab, silently. Before, a read that answered
    // while the write was out was taken as newer, which a pull reverted
    // before the write could not tell apart (the architecture review on
    // 9fb160cf).
    it('newer bytes that replaced the landed write reach the clean tab once the write settles, as any pull does', async () => {
      const result = await editedTab();
      const write = holdWriteAnswer();
      const saving = done(result, SAVED);
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));

      // A commit from the git host that replaced the write instead of building on it.
      const pulled = upstream(BASE);
      disk.set('KB/Notes.md', pulled);
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await settle();
      expect(result.current.activeTab?.savedContent).toBe(BASE);

      await act(async () => { write.answer(); await saving; });
      await waitFor(() => expect(result.current.activeTab?.savedContent).toBe(pulled));
      await settle();

      const tab = result.current.activeTab!;
      expect(tab.content).toBe(pulled);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch ?? null).toBe(null);

      const again = upstream(SAVED);
      await typeInto(result, again);
      await act(async () => { await result.current.saveFile('KB/Notes.md', again); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', again, { ifMatch: pulled });
      expect(disk.get('KB/Notes.md')).toBe(again);
    });

    it('a save queued behind it writes onto the newer bytes rather than being refused', async () => {
      const result = await editedTab();
      const write = holdWriteAnswer();
      const one = done(result, SAVED);
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      const second = `${SAVED}\n\nSECONDDONE`;
      const two = done(result, second);

      const pulled = upstream(SAVED);
      disk.set('KB/Notes.md', pulled);
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await settle();
      expect(result.current.activeTab?.savedContent).toBe(BASE);

      await act(async () => { write.answer(); await one; await two; });
      await settle();

      // The queued save measured its text from the first one's onto the pull,
      // and expected the pull on disk.
      const written = upstream(second);
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', written, { ifMatch: pulled });
      expect(disk.get('KB/Notes.md')).toBe(written);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(written);
      expect(tab.savedContent).toBe(written);
      expect(tab.isDirty).toBe(false);
    });
  });

  describe("a read sent while a save was on its way that answers after the save's answer", () => {
    const SAVED = BASE.replace('Second paragraph.', 'Second paragraph, saved.');
    // Typed while the save is out (the tab is dirty when its answer arrives,
    // so the refetch after it leaves the tab alone), and on after the answer.
    const TYPED_DURING = `${SAVED}\n\nTyped while the save was out.`;
    const TYPED = `${TYPED_DURING}\nAnd on after it landed.`;
    const upstream = (text: string) => text.replace('First paragraph.', 'First paragraph, rewritten upstream.');

    /**
     * The next write reaches the disk when `land` is called (a read sent
     * before that is served before it), and its answer arrives when
     * `answer` is called.
     */
    function holdWrite() {
      const write = apiMocks.writeFile.getMockImplementation()!;
      let land!: () => void;
      const landing = new Promise<void>((r) => { land = r; });
      let answer!: () => void;
      const answered = new Promise<void>((r) => { answer = r; });
      let sent!: () => void;
      const wasSent = new Promise<void>((r) => { sent = r; });
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
        sent();
        await landing;
        const wrote = await write(...args);
        await answered;
        return wrote;
      });
      return { wasSent, land: () => land(), answer: () => answer() };
    }

    /**
     * The next read is served at once, from the disk as it is when it is
     * sent, but its answer waits for `answer`.
     */
    function holdRead() {
      let answer!: () => void;
      const answered = new Promise<void>((r) => { answer = r; });
      apiMocks.readFile.mockImplementationOnce(async (_ws: string, path: string) => {
        const bytes = disk.get(path);
        await answered;
        if (bytes === undefined) throw new WorkspaceApiError(404, 'Not found');
        return bytes;
      });
      return { answer: () => answer() };
    }

    /** The person types while the save is out, its answer arrives, and they type on. */
    async function answerThenType(result: Hook, write: ReturnType<typeof holdWrite>, saving: Promise<void>) {
      await typeInto(result, TYPED_DURING);
      await act(async () => { write.answer(); await saving; });
      const landed = result.current.activeTab!;
      expect(landed.savedContent).toBe(SAVED);
      expect(landed.content).toBe(TYPED_DURING);
      expect(landed.isDirty).toBe(true);
      await typeInto(result, TYPED);
    }

    /** An autosave of SAVED: the editor stays open. Resolves once the write is sent. */
    async function autosave(result: Hook) {
      await typeInto(result, SAVED);
      const write = holdWrite();
      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', SAVED); });
      await act(async () => { await write.wasSent; });
      return { write, saving };
    }

    it('a commit it found pulled on top of the write is merged onto the later typing, and the next save writes over it', async () => {
      const result = await editedTab();
      const { write, saving } = await autosave(result);
      write.land();
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      // The answer is not back yet when a commit lands on top and its read is sent.
      const pulled = upstream(SAVED);
      disk.set('KB/Notes.md', pulled);
      const read = holdRead();
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await answerThenType(result, write, saving);

      await act(async () => { read.answer(); });
      await settle();

      const merged = upstream(TYPED);
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(merged);
      expect(tab.savedContent).toBe(pulled);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch).toBe('merged');

      await act(async () => { await result.current.saveFile('KB/Notes.md', merged); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', merged, { ifMatch: pulled });
      expect(disk.get('KB/Notes.md')).toBe(merged);
    });

    it('a 404 it found after the write marks the tab deleted, keeps the later typing, and the next save writes nothing', async () => {
      const result = await editedTab();
      const { write, saving } = await autosave(result);
      write.land();
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      disk.delete('KB/Notes.md');
      const read = holdRead();
      act(() => bus.emit(fileChanged('KB/Notes.md')));
      await answerThenType(result, write, saving);

      await act(async () => { read.answer(); });
      await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));

      const tab = result.current.activeTab!;
      expect(tab.content).toBe(TYPED);
      expect(tab.isDirty).toBe(true);

      apiMocks.writeFile.mockClear();
      await act(async () => {
        await expect(result.current.saveFile('KB/Notes.md', TYPED)).rejects.toThrow('Notes.md was deleted from this branch');
      });
      expect(apiMocks.writeFile).not.toHaveBeenCalled();
      expect(disk.has('KB/Notes.md')).toBe(false);
    });

    it('the bytes the write replaced, which the server answered it with before the write, put nothing back', async () => {
      const result = await editedTab();
      const { write, saving } = await autosave(result);
      // Sent after the write, served before it reached the disk: it finds BASE.
      const read = holdRead();
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      write.land();
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      await answerThenType(result, write, saving);
      expect(disk.get('KB/Notes.md')).toBe(SAVED);

      await act(async () => { read.answer(); });
      await settle();

      const tab = result.current.activeTab!;
      expect(tab.content).toBe(TYPED);
      expect(tab.savedContent).toBe(SAVED);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch ?? null).toBeNull();

      await act(async () => { await result.current.saveFile('KB/Notes.md', TYPED); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', TYPED, { ifMatch: SAVED });
      expect(disk.get('KB/Notes.md')).toBe(TYPED);
    });

    it('a commit that put back the bytes the write replaced is read again, and merged onto the later typing', async () => {
      const result = await editedTab();
      const { write, saving } = await autosave(result);
      write.land();
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      // A commit pulled on top reverts the save: the disk holds BASE again,
      // which is also what a read served before the write would have found.
      disk.set('KB/Notes.md', BASE);
      const read = holdRead();
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await answerThenType(result, write, saving);
      const readsBefore = apiMocks.readFile.mock.calls.length;

      await act(async () => { read.answer(); });
      await settle();

      // The answer, sent while the write was on its way, was dropped and the file read once more.
      expect(apiMocks.readFile.mock.calls.length).toBe(readsBefore + 1);
      const merged = TYPED.replace('Second paragraph, saved.', 'Second paragraph.');
      const tab = result.current.activeTab!;
      expect(tab.content).toBe(merged);
      expect(tab.savedContent).toBe(BASE);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch).toBe('merged');

      await act(async () => { await result.current.saveFile('KB/Notes.md', merged); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', merged, { ifMatch: BASE });
      expect(disk.get('KB/Notes.md')).toBe(merged);
    });

    it('a 404 after a write over an empty file is read again, and shows the notice when the file is gone', async () => {
      disk.set('KB/Notes.md', '');
      const result = await mountReady();
      await open(result, 'KB/Notes.md');
      const { write, saving } = await autosave(result);
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', SAVED, { ifMatch: '' });
      write.land();
      await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
      disk.delete('KB/Notes.md');
      const read = holdRead();
      act(() => bus.emit(fileChanged('KB/Notes.md')));
      await answerThenType(result, write, saving);

      await act(async () => { read.answer(); });
      // The read that found the file gone again names whom the held event named.
      await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));

      const tab = result.current.activeTab!;
      expect(tab.content).toBe(TYPED);
      expect(tab.isDirty).toBe(true);

      apiMocks.writeFile.mockClear();
      await act(async () => {
        await expect(result.current.saveFile('KB/Notes.md', TYPED)).rejects.toThrow('Notes.md was deleted from this branch');
      });
      expect(apiMocks.writeFile).not.toHaveBeenCalled();
      expect(disk.has('KB/Notes.md')).toBe(false);
    });

    describe("answered before the save's answer", () => {
      /** The person types while the save is out, then its answer arrives. */
      async function typeThenAnswer(result: Hook, write: ReturnType<typeof holdWrite>, saving: Promise<void>) {
        await typeInto(result, TYPED_DURING);
        await act(async () => { write.answer(); await saving; });
        await settle();
      }

      it('a commit that put back the bytes the write replaced is read again, and merged onto the typing', async () => {
        const result = await editedTab();
        const { write, saving } = await autosave(result);
        write.land();
        await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
        // Reverted on the git host; the read finds BASE and answers before
        // the write does, which a read served before the write would too.
        disk.set('KB/Notes.md', BASE);
        act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
        await settle();
        const readsBefore = apiMocks.readFile.mock.calls.length;

        await typeThenAnswer(result, write, saving);

        // That answer came while the write was on its way: the file is read once more after it.
        expect(apiMocks.readFile.mock.calls.length).toBe(readsBefore + 1);
        const merged = TYPED_DURING.replace('Second paragraph, saved.', 'Second paragraph.');
        const tab = result.current.activeTab!;
        expect(tab.content).toBe(merged);
        expect(tab.savedContent).toBe(BASE);
        expect(tab.isDirty).toBe(true);
        expect(tab.changedOnBranch).toBe('merged');

        await act(async () => { await result.current.saveFile('KB/Notes.md', merged); });
        expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', merged, { ifMatch: BASE });
        expect(disk.get('KB/Notes.md')).toBe(merged);
      });

      it('the write\'s own bytes found again change nothing', async () => {
        const result = await editedTab();
        const { write, saving } = await autosave(result);
        // Served before the write landed: it finds BASE, the bytes the write replaces.
        act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
        await settle();
        write.land();
        await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
        const readsBefore = apiMocks.readFile.mock.calls.length;

        await typeThenAnswer(result, write, saving);

        expect(apiMocks.readFile.mock.calls.length).toBe(readsBefore + 1);
        const tab = result.current.activeTab!;
        expect(tab.content).toBe(TYPED_DURING);
        expect(tab.savedContent).toBe(SAVED);
        expect(tab.isDirty).toBe(true);
        expect(tab.changedOnBranch ?? null).toBeNull();
      });

      it('a delete after the write shows the notice over the saved text once the write settles, and the next save writes nothing', async () => {
        const result = await editedTab();
        const { write, saving } = await autosave(result);
        write.land();
        await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));
        // Nothing typed since: the save lands, so the tab holds nothing unsaved.
        disk.delete('KB/Notes.md');
        act(() => bus.emit(fileChanged('KB/Notes.md')));
        await settle();
        // No read lands while the write is on its way.
        expect(result.current.activeTab?.deletedBy ?? null).toBeNull();

        await act(async () => { write.answer(); await saving; });
        // Read again after the write: the notice names whom the event named.
        await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
        await settle();

        const tab = result.current.activeTab!;
        expect(tab.deletedBy).toMatchObject({ name: 'Sam Rivera' });
        expect(tab.content).toBe(SAVED);
        expect(tab.savedContent).toBe(SAVED);
        expect(tab.isDirty).toBe(false);

        apiMocks.writeFile.mockClear();
        await act(async () => {
          await expect(result.current.saveFile('KB/Notes.md', SAVED)).rejects.toThrow('Notes.md was deleted from this branch');
        });
        expect(apiMocks.writeFile).not.toHaveBeenCalled();
        expect(disk.has('KB/Notes.md')).toBe(false);
      });

      it('a 404 over an empty file is read again, and the file the write put back clears the notice', async () => {
        disk.set('KB/Notes.md', '');
        const result = await mountReady();
        await open(result, 'KB/Notes.md');
        const { write, saving } = await autosave(result);
        // Served before the write: the file is missing, and the write over
        // empty bytes (the server reads a missing file as empty) puts it back.
        disk.delete('KB/Notes.md');
        act(() => bus.emit(fileChanged('KB/Notes.md')));
        await settle();
        // The 404 answered while the write was on its way: no notice.
        expect(result.current.activeTab?.deletedBy ?? null).toBeNull();
        write.land();
        await waitFor(() => expect(disk.get('KB/Notes.md')).toBe(SAVED));

        await typeThenAnswer(result, write, saving);

        const tab = result.current.activeTab!;
        expect(tab.deletedBy ?? null).toBeNull();
        expect(tab.content).toBe(TYPED_DURING);
        expect(tab.savedContent).toBe(SAVED);
        expect(tab.isDirty).toBe(true);
        await act(async () => { await result.current.saveFile('KB/Notes.md', TYPED_DURING); });
        expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', TYPED_DURING, { ifMatch: SAVED });
        expect(disk.get('KB/Notes.md')).toBe(TYPED_DURING);
      });
    });
  });

  it('an echo of our own save does not touch edits typed after it', async () => {
    const result = await editedTab();
    await typeInto(result, `${BASE}\n\nTyped after the save.`);

    // The disk still holds what the tab last saved: nothing changed underneath.
    act(() => bus.emit(fileChanged('KB/Notes.md', { id: 'u-me', name: 'Me' })));
    await settle();

    const tab = result.current.activeTab!;
    expect(tab.content).toBe(`${BASE}\n\nTyped after the save.`);
    expect(tab.isDirty).toBe(true);
    expect(tab.changedOnBranch ?? null).toBeNull();
  });
});

/**
 * A write started on one branch that answers after the person switched to
 * another and opened the same path there: the tab at that path is the other
 * branch's file now. Its text, baseline and agent preview stay as they are.
 */
describe('a write that answers after a branch switch', () => {
  /** Switch to `feature` (workspace ws-2), where Draft.md holds `bytes`, and open it there. */
  async function switchToFeatureAndOpen(result: Hook, path: string, bytes: string) {
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      workspace: { id: 'ws-2', name: 'Workspace', absolutePath: '/tmp/ws-2', createdAt: '2026-10-09T00:00:00.000Z' },
      fileTree: treeOf([path]),
    });
    act(() => { result.current.setPersistenceBranch('feature'); });
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-2'));
    disk.set(path, bytes);
    await open(result, path);
    expect(result.current.activeTab?.content).toBe(bytes);
  }
  /** The next write is held until `answer` is called. */
  function holdNextWrite() {
    const held: { answer: () => void } = { answer: () => { throw new Error('No write was started'); } };
    apiMocks.writeFile.mockImplementationOnce(() => new Promise<void>((resolve) => {
      held.answer = () => resolve();
    }));
    return held;
  }

  it("a save on the branch just left does not put its text on this branch's tab", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited on main');
    const held = holdNextWrite();
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited on main'); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md', 'edited on main', { ifMatch: '# Draft\n\nA page to delete.' }));

    await switchToFeatureAndOpen(result, 'KB/Draft.md', 'as on feature');
    await act(async () => { result.current.setPendingContent('the agent, on feature'); });
    await act(async () => { held.answer(); await saving; });

    const tab = result.current.activeTab!;
    expect(tab.content).toBe('as on feature');
    expect(tab.savedContent).toBe('as on feature');
    expect(tab.pendingFileContent).toBe('the agent, on feature');
    expect(tab.changedOnBranch ?? null).toBeNull();
  });

  it("a save on the branch just left, waiting on a change read, does not put the pulled bytes on this branch's tab", async () => {
    const base = 'First.\n\nSecond.';
    disk.set('KB/Notes.md', base);
    const result = await mountReady();
    await open(result, 'KB/Notes.md');
    await typeInto(result, 'First.\n\nSecond, my way.');
    const pulled = 'First.\n\nSecond, their way.';
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve(pulled);
    }));
    act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
    await waitFor(() => expect(answer).toBeDefined());
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Notes.md', 'First.\n\nSecond, my way.'); });

    await switchToFeatureAndOpen(result, 'KB/Notes.md', 'as on feature');
    await act(async () => { answer(); await saving; });

    const tab = result.current.activeTab!;
    expect(tab.content).toBe('as on feature');
    expect(tab.savedContent).toBe('as on feature');
    expect(tab.changedOnBranch ?? null).toBeNull();
    expect(tab.remoteRevision ?? 0).toBe(0);
  });

  it("rejecting an agent's change on the branch just left does not put the old baseline on this branch's tab", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { result.current.setPendingContent('the agent, on main'); });
    const held = holdNextWrite();
    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md', expect.any(String), { ifMatch: 'the agent, on main' }));

    await switchToFeatureAndOpen(result, 'KB/Draft.md', 'as on feature');
    await act(async () => { result.current.setPendingContent('the agent, on feature'); });
    await act(async () => { held.answer(); await rejecting; });

    const tab = result.current.activeTab!;
    expect(tab.content).toBe('as on feature');
    expect(tab.savedContent).toBe('as on feature');
    expect(tab.pendingFileContent).toBe('the agent, on feature');
  });

  /**
   * On main, a change read of Draft.md is held and `start` begins a write
   * that waits on it; our delete of Draft.md is confirmed, then the person
   * switches to feature and opens its Draft.md. Answers the held read with
   * main's bytes from before the delete.
   */
  async function deleteThenSwitchWhileWriteWaits(result: Hook, start: () => Promise<void>) {
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    act(() => bus.emit(fileChanged('KB/Draft.md', GIT_SYNC)));
    await waitFor(() => expect(answer).toBeDefined());
    let writing!: Promise<void>;
    act(() => { writing = start(); });

    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    await switchToFeatureAndOpen(result, 'KB/Draft.md', 'as on feature');
    apiMocks.writeFile.mockClear();
    return { answer, writing };
  }

  it('a save waiting on the branch just left cannot re-create the file our delete removed there', async () => {
    const result = await mountReady();
    const { answer, writing } = await deleteThenSwitchWhileWriteWaits(
      result, () => result.current.saveFile('KB/Draft.md', 'edited on main'));
    await act(async () => {
      answer();
      await expect(writing).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    const tab = result.current.activeTab!;
    expect(tab.content).toBe('as on feature');
    expect(tab.savedContent).toBe('as on feature');
    expect(tab.isDirty).toBe(false);
  });

  it("rejecting an agent's change, waiting on the branch just left, cannot re-create the file our delete removed there", async () => {
    const result = await mountReady();
    const { answer, writing } = await deleteThenSwitchWhileWriteWaits(result, () => {
      result.current.setPendingContent('the agent, on main');
      return result.current.rejectPendingContent();
    });
    await act(async () => { result.current.setPendingContent('the agent, on feature'); });
    await act(async () => {
      answer();
      await expect(writing).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    const tab = result.current.activeTab!;
    expect(tab.content).toBe('as on feature');
    expect(tab.savedContent).toBe('as on feature');
    expect(tab.pendingFileContent).toBe('the agent, on feature');
  });

  it('a save waiting on the branch just left is refused while our delete there is still running', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    act(() => bus.emit(fileChanged('KB/Draft.md', GIT_SYNC)));
    await waitFor(() => expect(answer).toBeDefined());
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited on main'); });
    // The delete is still running on main when the person switches.
    let finishDelete!: () => void;
    apiMocks.deleteFile.mockImplementationOnce((_ws: string, path: string) => new Promise<void>((resolve) => {
      finishDelete = () => { disk.delete(path); resolve(); };
    }));
    let deleting!: Promise<unknown>;
    act(() => { deleting = result.current.deleteEntry('KB/Draft.md'); });
    await waitFor(() => expect(finishDelete).toBeDefined());
    await switchToFeatureAndOpen(result, 'KB/Draft.md', 'as on feature');
    apiMocks.writeFile.mockClear();

    await act(async () => {
      answer();
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });
    await act(async () => { finishDelete(); await deleting; });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(result.current.activeTab?.content).toBe('as on feature');
  });

  it("a move on the branch just left does not rename this branch's tab", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    let answer!: () => void;
    apiMocks.moveEntry.mockImplementationOnce(() => new Promise<void>((resolve) => { answer = resolve; }));
    let moving!: Promise<void>;
    act(() => { moving = result.current.moveEntry('KB/Draft.md', 'KB/Renamed.md'); });
    await waitFor(() => expect(apiMocks.moveEntry).toHaveBeenCalledWith('ws-1', 'KB/Draft.md', 'KB/Renamed.md'));

    await switchToFeatureAndOpen(result, 'KB/Draft.md', 'as on feature');
    await act(async () => { answer(); await moving; });

    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Draft.md']);
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.activeTab?.content).toBe('as on feature');
  });
});

describe('the editor writing back after our own delete', () => {
  it('a save that was waiting when the tab closed cannot re-create the file', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    // A change read deciding whether Draft.md exists is out; the save waits on it.
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve('edited');
    }));
    act(() => bus.emit(fileChanged('KB/Draft.md', GIT_SYNC)));
    await waitFor(() => expect(answer).toBeDefined());
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });

    // Our own delete closes the tab meanwhile, and the tab's marker with it.
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    apiMocks.writeFile.mockClear();
    await act(async () => {
      answer();
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  it('a save that was waiting when the tab closed cannot re-create the file however long the wait', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const result = await mountReady();
      await open(result, 'KB/Draft.md', 'KB/Keep.md');
      await act(async () => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
      let answer!: () => void;
      apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
        answer = () => resolve('# Draft\n\nA page to delete.');
      }));
      act(() => bus.emit(fileChanged('KB/Draft.md', GIT_SYNC)));
      await waitFor(() => expect(answer).toBeDefined());
      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });

      await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
      expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
      // The read answers long after the delete, past the own-delete window,
      // with the bytes from before it.
      vi.advanceTimersByTime(61_000);
      expect(result.current.isOwnDelete?.('KB/Draft.md')).toBe(false);
      apiMocks.writeFile.mockClear();
      await act(async () => {
        answer();
        await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
      });

      expect(apiMocks.writeFile).not.toHaveBeenCalled();
      expect(disk.has('KB/Draft.md')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save started after our delete, of a file restored since, is not refused by that delete', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    await new Promise((r) => setTimeout(r, 2));
    disk.set('KB/Draft.md', 'restored');
    await open(result, 'KB/Draft.md');
    // A change read is out when the save starts; the save waits on it.
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve('restored');
    }));
    act(() => bus.emit(fileChanged('KB/Draft.md', GIT_SYNC)));
    await waitFor(() => expect(answer).toBeDefined());
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'restored, edited'); });
    await act(async () => { answer(); await saving; });

    expect(disk.get('KB/Draft.md')).toBe('restored, edited');
  });

  it('a file restored on the branch and opened again saves at once', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    // Someone restores it on the branch a moment later (a read sent in the
    // delete's own millisecond counts as sent before it); nothing in this
    // session re-created it.
    await new Promise((r) => setTimeout(r, 2));
    disk.set('KB/Draft.md', 'restored');
    await open(result, 'KB/Draft.md');

    await act(async () => { await result.current.saveFile('KB/Draft.md', 'restored, edited'); });
    expect(disk.get('KB/Draft.md')).toBe('restored, edited');
  });

  it('a file restored on the branch and brought back by a tab restore saves at once', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    await new Promise((r) => setTimeout(r, 2));
    disk.set('KB/Draft.md', 'restored');
    await act(async () => { await result.current.hydrateTabs(['KB/Draft.md'], 'KB/Draft.md'); });
    expect(tabAt(result, 'KB/Draft.md')?.content).toBe('restored');

    await act(async () => { await result.current.saveFile('KB/Draft.md', 'restored, edited'); });
    expect(disk.get('KB/Draft.md')).toBe('restored, edited');
  });

  it('an opening read sent before our delete answered keeps the delete', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    let answer!: () => void;
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    // A tab restore reads the file, then our delete answers before that read does.
    let hydrating!: Promise<unknown>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    await act(async () => { answer(); await hydrating; });

    expect(result.current.isOwnDelete?.('KB/Draft.md')).toBe(true);
  });
  /** Hold the next read of the file, answering with its bytes from before the delete. */
  function holdNextRead() {
    const held: { answer?: () => void } = {};
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      held.answer = () => resolve('# Draft\n\nA page to delete.');
    }));
    return held;
  }

  it('an open whose read our delete overtook opens nothing, and answers as the file being gone', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md');
    const held = holdNextRead();
    let opening!: Promise<boolean>;
    act(() => { opening = result.current.addTab('KB/Draft.md'); });
    await waitFor(() => expect(held.answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });

    await act(async () => {
      held.answer!();
      await expect(opening).rejects.toMatchObject({ status: 404 });
    });

    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    expect(result.current.openFilePath).toBe('KB/Keep.md');
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  it('a tab restore whose read our delete overtook does not open the deleted file', async () => {
    const result = await mountReady();
    // Keep.md answers at once; Draft.md's read is held past our delete.
    apiMocks.readFile.mockImplementationOnce(async () => 'keep');
    const held = holdNextRead();
    let hydrating!: Promise<{ surviving: string[]; dropped: string[] }>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(held.answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });

    let restored!: { surviving: string[]; dropped: string[] };
    await act(async () => { held.answer!(); restored = await hydrating; });

    expect(restored.surviving).toEqual(['KB/Keep.md']);
    expect(restored.dropped).toEqual(['KB/Draft.md']);
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    expect(result.current.openFilePath).toBe('KB/Keep.md');
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  it('a remount whose read our delete overtook does not reopen the tab the delete closed', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    expect(tabAt(result, 'KB/Draft.md')).toBeDefined();
    // The route mounts again: it restores the same tabs while they are open.
    apiMocks.readFile.mockImplementationOnce(async () => 'keep');
    const held = holdNextRead();
    let hydrating!: Promise<{ surviving: string[]; dropped: string[] }>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(held.answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    let deleted!: unknown;
    await act(async () => { deleted = await result.current.deleteEntry('KB/Draft.md'); });
    expect(deleted).toEqual({ closedActive: true, newActivePath: 'KB/Keep.md' });

    let restored!: { surviving: string[]; dropped: string[] };
    await act(async () => { held.answer!(); restored = await hydrating; });

    expect(restored.surviving).toEqual(['KB/Keep.md']);
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    expect(result.current.openFilePath).toBe('KB/Keep.md');
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  /** Hold the next read, answering with Dir/a.md's bytes from before the folder delete. */
  function holdNextReadOfA() {
    const held: { answer?: () => void } = {};
    apiMocks.readFile.mockImplementationOnce(() => new Promise((resolve) => {
      held.answer = () => resolve('a');
    }));
    return held;
  }

  // The folder is deleted, a sibling is created back in it, then a read of
  // the other child sent before the delete answers: the child stays gone.
  it('an open whose read a folder delete overtook opens nothing, though a sibling was created since', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md');
    const held = holdNextReadOfA();
    let opening!: Promise<boolean>;
    act(() => { opening = result.current.addTab('KB/Dir/a.md'); });
    await waitFor(() => expect(held.answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    await act(async () => { await result.current.deleteEntry('KB/Dir'); });
    await act(async () => { await result.current.createFile('KB/Dir/b.md', 'b'); });

    await act(async () => {
      held.answer!();
      await expect(opening).rejects.toMatchObject({ status: 404 });
    });

    expect(tabAt(result, 'KB/Dir/a.md')).toBeUndefined();
    expect(result.current.openFilePath).toBe('KB/Keep.md');
    expect(result.current.isOwnDelete?.('KB/Dir/a.md')).toBe(true);
    expect(result.current.isOwnDelete?.('KB/Dir/b.md')).toBe(false);
    expect(disk.has('KB/Dir/a.md')).toBe(false);
  });

  it('a tab restore whose read a folder delete overtook does not reopen the child, though a sibling was restored since', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.hydrateTabs(['KB/Keep.md', 'KB/Dir/a.md'], 'KB/Dir/a.md'); });
    // The route mounts again while both tabs are open.
    apiMocks.readFile.mockImplementationOnce(async () => 'keep');
    const held = holdNextReadOfA();
    let hydrating!: Promise<{ surviving: string[]; dropped: string[] }>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Dir/a.md'], 'KB/Dir/a.md'); });
    await waitFor(() => expect(held.answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    await act(async () => { await result.current.deleteEntry('KB/Dir'); });
    // Someone restores the sibling, and a tab restore of ours finds it.
    await new Promise((r) => setTimeout(r, 2));
    disk.set('KB/Dir/b.md', 'b');
    await act(async () => { await result.current.hydrateTabs(['KB/Keep.md', 'KB/Dir/b.md'], 'KB/Keep.md'); });
    expect(tabAt(result, 'KB/Dir/b.md')?.content).toBe('b');

    let restored!: { surviving: string[]; dropped: string[] };
    await act(async () => { held.answer!(); restored = await hydrating; });

    expect(restored.surviving).not.toContain('KB/Dir/a.md');
    expect(tabAt(result, 'KB/Dir/a.md')).toBeUndefined();
    expect(result.current.isOwnDelete?.('KB/Dir/a.md')).toBe(true);
    // Nothing can write the child back: a late write-back is refused.
    await expect(result.current.saveFile('KB/Dir/a.md', 'a')).rejects.toThrow('a.md was deleted from this branch');
    expect(disk.has('KB/Dir/a.md')).toBe(false);
  });

  it('a file created where our own delete was saves as any other', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    await act(async () => { await result.current.createFile('KB/Draft.md', 'new'); });
    await open(result, 'KB/Draft.md');

    await act(async () => { await result.current.saveFile('KB/Draft.md', 'new, edited'); });
    expect(disk.get('KB/Draft.md')).toBe('new, edited');
  });
});

describe('the Knowledge page mounted again while a deleted tab is open', () => {
  // The workspace state lives in the app shell; the file route does not. Going
  // to Settings or Skills & Tools and back mounts the route again, and it
  // restores the strip with the same call it opens the branch with.
  const remount = (result: Hook, paths: string[], active: string) =>
    act(async () => { await result.current.hydrateTabs(paths, active); });

  it('keeps the deleted tab, its notice and its unsaved edits until Close', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nA page to delete.\n\nA paragraph I added.');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));

    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');

    const tab = tabAt(result, 'KB/Draft.md');
    expect(tab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
    expect(tab?.isDirty).toBe(true);
    expect(tab?.content).toBe('# Draft\n\nA page to delete.\n\nA paragraph I added.');
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['KB/Keep.md', 'KB/Draft.md']);

    await act(async () => { await result.current.closeTab(tab!, { skipConfirm: true }); });
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
  });

  it('keeps a deleted tab the saved tab list has not caught up with', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');
    await open(result, 'KB/Draft.md');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());

    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');

    expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy();
  });

  it('keeps unsaved edits on a tab whose file is still there', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');
    await typeInto(result, 'keep, edited');

    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');

    expect(tabAt(result, 'KB/Keep.md')?.content).toBe('keep, edited');
    expect(tabAt(result, 'KB/Keep.md')?.isDirty).toBe(true);
  });

  it("keeps Done's text whose save is still on its way, and the save's landing leaves it saved", async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');
    const before = disk.get('KB/Keep.md');
    const write = apiMocks.writeFile.getMockImplementation()!;
    let land!: () => void;
    const landed = new Promise<void>((r) => { land = r; });
    apiMocks.writeFile.mockClear();
    apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof write>) => {
      await landed;
      return write(...args);
    });
    // Done: the save starts and the closing editor reports the tab clean.
    let saving!: Promise<void>;
    act(() => {
      result.current.setActiveTabContent('keep, done');
      saving = result.current.saveFile('KB/Keep.md', 'keep, done');
      result.current.setHasUnsavedFileChanges?.(false);
    });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

    // The remount reads the bytes from before the save.
    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');
    expect(disk.get('KB/Keep.md')).toBe(before);
    expect(tabAt(result, 'KB/Keep.md')?.content).toBe('keep, done');

    await act(async () => { land(); await saving; });
    expect(disk.get('KB/Keep.md')).toBe('keep, done');
    expect(tabAt(result, 'KB/Keep.md')?.content).toBe('keep, done');
    expect(tabAt(result, 'KB/Keep.md')?.savedContent).toBe('keep, done');
    expect(tabAt(result, 'KB/Keep.md')?.isDirty).toBe(false);
  });

  it('keeps a deleted, edited tab when the saved tab list is empty', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Draft.md'], 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nMy edit.');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());

    await remount(result, [], 'KB/Draft.md');

    const tab = tabAt(result, 'KB/Draft.md');
    expect(tab?.deletedBy).toMatchObject({ name: 'Sam Rivera' });
    expect(tab?.content).toBe('# Draft\n\nMy edit.');
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    await act(async () => { await result.current.closeTab(tab!, { skipConfirm: true }); });
    expect(result.current.openTabs).toEqual([]);
  });

  it.each([
    ['in the saved tab list', ['KB/Keep.md', 'KB/Draft.md']],
    ['missing from the saved tab list', ['KB/Keep.md']],
  ])('closes a deleted, edited tab that is no longer readable (%s) and reports it denied', async (_label, paths) => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nMy edit.');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());
    const read = apiMocks.readFile.getMockImplementation()!;
    apiMocks.readFile.mockImplementation(async (ws: string, path: string) => {
      if (path === 'KB/Draft.md') throw new WorkspaceApiError(403, 'Forbidden');
      return read(ws, path);
    });

    let outcome!: { denied: string[]; surviving: string[] };
    await act(async () => { outcome = await result.current.hydrateTabs(paths, 'KB/Keep.md'); });

    expect(outcome.denied).toEqual(['KB/Draft.md']);
    expect(outcome.surviving).toEqual(['KB/Keep.md']);
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    expect(result.current.openTabs.map((t) => t.content)).not.toContain('# Draft\n\nMy edit.');
  });

  it('closes a dirty tab whose file is no longer readable', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md'], 'KB/Keep.md');
    await typeInto(result, 'keep, edited');
    apiMocks.readFile.mockImplementation(async () => { throw new WorkspaceApiError(403, 'Forbidden'); });

    let outcome!: { denied: string[] };
    await act(async () => { outcome = await result.current.hydrateTabs(['KB/Keep.md'], 'KB/Keep.md'); });

    expect(outcome.denied).toEqual(['KB/Keep.md']);
    expect(result.current.openTabs).toEqual([]);
  });

  /** Hold the next read of `path`; `answer` settles it with `err`, as the server would have. */
  function holdRead(path: string, err: Error) {
    const held: { answer: () => void } = { answer: () => { throw new Error(`No read of ${path} was held`); } };
    const read = apiMocks.readFile.getMockImplementation()!;
    let taken = false;
    apiMocks.readFile.mockImplementation((ws: string, p: string) => {
      if (p !== path || taken) return read(ws, p);
      taken = true;
      return new Promise((_resolve, reject) => { held.answer = () => reject(err); });
    });
    return held;
  }

  it('a save while the remount read is out waits for it, and writes nothing when it finds the file gone', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nMy edit.');
    disk.delete('KB/Draft.md');
    const held = holdRead('KB/Draft.md', new WorkspaceApiError(404, 'Not found'));
    let hydrating!: Promise<unknown>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md'));
    apiMocks.writeFile.mockClear();

    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', '# Draft\n\nMy edit.'); });
    await act(async () => {
      held.answer();
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
      await hydrating;
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    // Kept, and now says it was deleted, edits and all.
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toMatchObject({ name: null });
    expect(tabAt(result, 'KB/Draft.md')?.content).toBe('# Draft\n\nMy edit.');
  });

  it("Reject while the remount read is out waits for it, writes nothing, and keeps the agent's change", async () => {
    const result = await mountReady();
    await remount(result, ['KB/Draft.md'], 'KB/Draft.md');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });
    disk.delete('KB/Draft.md');
    const held = holdRead('KB/Draft.md', new WorkspaceApiError(404, 'Not found'));
    let hydrating!: Promise<unknown>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md'));
    apiMocks.writeFile.mockClear();

    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await act(async () => {
      held.answer();
      await expect(rejecting).rejects.toThrow('Draft.md was deleted from this branch');
      await hydrating;
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy();
    expect(tabAt(result, 'KB/Draft.md')?.pendingFileContent).toBe('# Draft\n\nThe agent rewrote this.');
  });

  it('a 403 on the remount read closes the tab even when an open overtook the restore', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nMy edit.');
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());
    const held = holdRead('KB/Draft.md', new WorkspaceApiError(403, 'Forbidden'));
    let hydrating!: Promise<{ denied: string[] }>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md'));

    // A tree click on the deleted tab itself while the restore's reads are out.
    await act(async () => { await result.current.addTab('KB/Draft.md'); });
    let outcome!: { denied: string[] };
    await act(async () => { held.answer(); outcome = await hydrating; });

    expect(outcome.denied).toEqual(['KB/Draft.md']);
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
    expect(result.current.openTabs.map((t) => t.content)).not.toContain('# Draft\n\nMy edit.');
    expect(result.current.activeTab?.path).toBe('KB/Keep.md');
  });

  it('keeps a clean open tab whose file is gone and marks it deleted, rather than dropping it', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    // Deleted while the route was away: no event reached this tab.
    disk.delete('KB/Draft.md');

    let outcome!: { surviving: string[]; dropped: string[] };
    await act(async () => { outcome = await result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });

    expect(outcome.dropped).toEqual([]);
    expect(outcome.surviving).toEqual(['KB/Keep.md', 'KB/Draft.md']);
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toMatchObject({ name: null });
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
  });

  it('a remount read that answers after newer bytes landed keeps the newer bytes', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    const older = disk.get('KB/Draft.md')!;
    // The remount's read of the open tab is held with the bytes it read then.
    const read = apiMocks.readFile.getMockImplementation()!;
    let answer!: () => void;
    let taken = false;
    apiMocks.readFile.mockImplementation((ws: string, p: string) => {
      if (p !== 'KB/Draft.md' || taken) return read(ws, p);
      taken = true;
      return new Promise<string>((resolve) => { answer = () => resolve(older); });
    });
    let hydrating!: Promise<unknown>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(taken).toBe(true));

    // A change lands on the branch, and its read lands first.
    disk.set('KB/Draft.md', '# Draft\n\nChanged on the branch.');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.content).toBe('# Draft\n\nChanged on the branch.'));
    await act(async () => { answer(); await hydrating; });

    expect(tabAt(result, 'KB/Draft.md')?.content).toBe('# Draft\n\nChanged on the branch.');
    expect(tabAt(result, 'KB/Draft.md')?.savedContent).toBe('# Draft\n\nChanged on the branch.');
  });

  /**
   * A remount whose read of KB/Keep.md is held while its read of KB/Draft.md,
   * deleted while the route was away, answers 404 at once. Resolves the held
   * read; the hydration's promise is returned with it.
   */
  async function remountWithKeepHeld(result: Hook) {
    const read = apiMocks.readFile.getMockImplementation()!;
    let releaseKeep!: () => void;
    let taken = false;
    apiMocks.readFile.mockImplementation((ws: string, p: string) => {
      if (p !== 'KB/Keep.md' || taken) return read(ws, p);
      taken = true;
      return new Promise<string>((resolve) => { releaseKeep = () => resolve(disk.get('KB/Keep.md')!); });
    });
    disk.delete('KB/Draft.md');
    let hydrating!: Promise<unknown>;
    act(() => { hydrating = result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });
    await waitFor(() => expect(taken).toBe(true));
    // KB/Draft.md's 404 has answered; the hydration still waits on KB/Keep.md.
    await settle();
    apiMocks.writeFile.mockClear();
    return { releaseKeep, hydrating };
  }

  it('a save while another remount read is still out writes nothing back to a file its read found gone', async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    await typeInto(result, '# Draft\n\nA paragraph I added.');
    const { releaseKeep, hydrating } = await remountWithKeepHeld(result);

    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', '# Draft\n\nA paragraph I added.'); });
    await act(async () => {
      releaseKeep();
      await hydrating;
      await expect(saving).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    const tab = tabAt(result, 'KB/Draft.md');
    expect(tab?.deletedBy).toMatchObject({ name: null });
    expect(tab?.isDirty).toBe(true);
    expect(tab?.content).toBe('# Draft\n\nA paragraph I added.');
  });

  it("rejecting an agent's change while another remount read is still out writes nothing back to a file its read found gone", async () => {
    const result = await mountReady();
    await remount(result, ['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md');
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });
    const { releaseKeep, hydrating } = await remountWithKeepHeld(result);

    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await act(async () => {
      releaseKeep();
      await hydrating;
      await expect(rejecting).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
    const tab = tabAt(result, 'KB/Draft.md');
    expect(tab?.deletedBy).toMatchObject({ name: null });
    expect(tab?.pendingFileContent).toBe('# Draft\n\nThe agent rewrote this.');
  });

  it('still drops a persisted tab whose file is gone when the branch is first opened', async () => {
    const result = await mountReady();
    disk.delete('KB/Draft.md');
    let outcome!: { dropped: string[] };
    await act(async () => { outcome = await result.current.hydrateTabs(['KB/Keep.md', 'KB/Draft.md'], 'KB/Draft.md'); });

    expect(outcome.dropped).toEqual(['KB/Draft.md']);
    expect(tabAt(result, 'KB/Draft.md')).toBeUndefined();
  });
});

describe('a late 404 about a file that came back since', () => {
  const RESTORED = '# Draft\n\nRestored since.';

  /** Hold the next read; `answer` rejects it with the 404 it would have had when it was issued. */
  function holdNext404() {
    const read: { answer: () => void } = { answer: () => { throw new Error('Held read was not started'); } };
    apiMocks.readFile.mockClear();
    apiMocks.readFile.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      read.answer = () => reject(new WorkspaceApiError(404, 'Not found'));
    }));
    return read;
  }

  /** The file is back on the branch, and the tab is closed and opened again with its bytes. */
  async function closeAndReopen(result: Hook) {
    disk.set('KB/Draft.md', RESTORED);
    await act(async () => { await result.current.closeTab(tabAt(result, 'KB/Draft.md')!, { skipConfirm: true }); });
    await open(result, 'KB/Draft.md');
    expect(result.current.activeTab?.content).toBe(RESTORED);
  }

  /** The file is back on the branch, and a newer reload brings its bytes into the tab. */
  async function reloadLands(result: Hook) {
    disk.set('KB/Draft.md', RESTORED);
    await act(async () => { await result.current.reloadTabFromDisk('KB/Draft.md'); });
    expect(result.current.activeTab?.content).toBe(RESTORED);
  }

  async function expectStillOpenAndSaves(result: Hook) {
    await settle();
    const tab = tabAt(result, 'KB/Draft.md');
    expect(tab?.deletedBy).toBeFalsy();
    expect(tab?.content).toBe(RESTORED);
    expect(result.current.activeTab?.path).toBe('KB/Draft.md');
    await act(async () => { await result.current.saveFile('KB/Draft.md', 'saved after'); });
    expect(disk.get('KB/Draft.md')).toBe('saved after');
  }

  it("a tree refresh's late 404 does not mark a tab closed and opened again since", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.delete('KB/Draft.md');
    const read = holdNext404();
    act(() => bus.emit(treeChanged()));
    await waitFor(() => expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md'));

    await closeAndReopen(result);
    await act(async () => { read.answer(); });

    await expectStillOpenAndSaves(result);
  });

  it("a switched-to tab's late 404 does not mark it once it was closed and opened again", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md', 'KB/Keep.md');
    await act(async () => { result.current.bumpFsRevision(); });
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.content).toBeNull();

    const read = holdNext404();
    act(() => { result.current.activateTab(tabAt(result, 'KB/Draft.md')!); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    await closeAndReopen(result);
    await act(async () => { read.answer(); });

    await expectStillOpenAndSaves(result);
  });

  it("a reload's late 404 does not mark a tab closed and opened again since", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const read = holdNext404();
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reloadTabFromDisk('KB/Draft.md'); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    await closeAndReopen(result);
    await act(async () => { read.answer(); await reloading; });

    await expectStillOpenAndSaves(result);
  });

  it("the eager refetch's late 404 does not mark a tab whose newer bytes already landed", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const read = holdNext404();
    await act(async () => { result.current.bumpFsRevision(); });
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    await reloadLands(result);
    await act(async () => { read.answer(); });

    await expectStillOpenAndSaves(result);
  });

  it("a change's late 404 does not mark a tab whose newer bytes already landed, nor name anyone", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const read = holdNext404();
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    await reloadLands(result);
    await act(async () => { read.answer(); });

    await expectStillOpenAndSaves(result);
  });

  it("a lock release's late 404 does not mark a tab closed and opened again since", async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    const read = holdNext404();
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as VersionControlEvent));
    expect(apiMocks.readFile).toHaveBeenCalledExactlyOnceWith('ws-1', 'KB/Draft.md');

    await closeAndReopen(result);
    await act(async () => { read.answer(); });

    await expectStillOpenAndSaves(result);
  });

  it('a 404 from overlapping reads refuses no save once the tab was closed and opened again before the other read answered', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.delete('KB/Draft.md');
    const reads: { gone: () => void; found: () => void } = {
      gone: () => { throw new Error('Held reload was not started'); },
      found: () => { throw new Error('Held change read was not started'); },
    };
    apiMocks.readFile.mockClear();
    apiMocks.readFile
      .mockImplementationOnce(() => new Promise((_resolve, reject) => {
        reads.gone = () => reject(new WorkspaceApiError(404, 'Not found'));
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        reads.found = () => resolve(RESTORED);
      }));
    let reloading!: Promise<void>;
    act(() => { reloading = result.current.reloadTabFromDisk('KB/Draft.md'); });
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    expect(apiMocks.readFile).toHaveBeenCalledTimes(2);

    await act(async () => { reads.gone(); await reloading; });
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());

    await closeAndReopen(result);
    // The save waits on the read still out, which then finds the file.
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'saved after'); });
    await act(async () => { reads.found(); await saving; });
    expect(disk.get('KB/Draft.md')).toBe('saved after');
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeFalsy();
  });

  it('a 404 issued after the file came back still marks the tab deleted', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await reloadLands(result);
    disk.delete('KB/Draft.md');
    act(() => bus.emit(fileChanged('KB/Draft.md')));
    await waitFor(() => expect(result.current.activeTab?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));
  });
});

/**
 * The checks before a write decide on what the client knows; a delete it
 * learns of only after they answered is stopped at the write itself, where
 * the server compares `ifMatch` inside the path's turn. Each test holds the
 * write past every check (the server has it), deletes the file, and only
 * then lets the server answer it.
 */
describe('a write already on its way when the file is deleted', () => {
  /** The next write reaches the server and waits there until `deliver`. */
  function holdWriteAtServer() {
    const server = apiMocks.writeFile.getMockImplementation()!;
    const held: { deliver: () => void } = { deliver: () => { throw new Error('No write was started'); } };
    apiMocks.writeFile.mockImplementationOnce((...args: unknown[]) => new Promise((resolve, reject) => {
      held.deliver = () => { Promise.resolve(server(...args)).then(resolve, reject); };
    }));
    return held;
  }
  const someoneElseDeletes = async (path: string) => {
    disk.delete(path);
    act(() => bus.emit(fileChanged(path)));
    await settle();
  };

  it('a save (Done) delivered after someone else deleted the file does not re-create it, and the edits stay', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    const held = holdWriteAtServer();
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.saveFile('KB/Draft.md', 'edited');
      // Done marks the tab clean as the editor closes.
      result.current.setHasUnsavedFileChanges?.(false);
    });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

    await someoneElseDeletes('KB/Draft.md');
    // No read lands while the write is on its way.
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    await act(async () => {
      held.deliver();
      await expect(saving).rejects.toThrow('changed since you opened it');
    });
    // Read again once the write settled: the notice, naming whom the event named.
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toMatchObject({ name: 'Sam Rivera' }));

    expect(disk.has('KB/Draft.md')).toBe(false);
    const tab = tabAt(result, 'KB/Draft.md')!;
    expect(tab.isDirty).toBe(true);
    expect(tab.content).toBe('edited');
  });

  it('a save delivered after our own delete does not re-create the file', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    const held = holdWriteAtServer();
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    await act(async () => {
      held.deliver();
      // Refused at the write itself: the delete landed after the client's checks.
      await expect(saving).rejects.toThrow('changed since you opened it');
    });

    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(result.current.activeTab?.path).toBe('KB/Keep.md');
  });

  it('a save queued behind another, when our delete is confirmed while it queues, writes nothing, even past the own-delete window', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    const held = holdWriteAtServer();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.saveFile('KB/Draft.md', 'edited');
      second = result.current.saveFile('KB/Draft.md', 'edited more');
    });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

    await act(async () => { await result.current.deleteEntry('KB/Draft.md'); });
    // The tab has closed and the marker of our delete has run out.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await act(async () => {
      held.deliver();
      await expect(first).rejects.toThrow('changed since you opened it');
      await expect(second).rejects.toThrow('Draft.md was deleted from this branch');
    });

    expect(apiMocks.writeFile).toHaveBeenCalledOnce();
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  it("a Reject delivered after someone else deleted the file does not re-create it, and the agent's version stays", async () => {
    const AGENT = '# Draft\n\nThe agent rewrote this.';
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.set('KB/Draft.md', AGENT);
    await act(async () => { result.current.setPendingContent(AGENT); });
    const held = holdWriteAtServer();
    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());

    await someoneElseDeletes('KB/Draft.md');
    await act(async () => {
      held.deliver();
      await expect(rejecting).rejects.toThrow('changed since you opened it');
    });

    expect(disk.has('KB/Draft.md')).toBe(false);
    expect(tabAt(result, 'KB/Draft.md')?.pendingFileContent).toBe(AGENT);
  });

  it('a Reject that landed before someone else deleted the file, answering after the 404, lands, and the read after it shows the notice', async () => {
    const AGENT = '# Draft\n\nThe agent rewrote this.';
    const BASELINE = '# Draft\n\nA page to delete.';
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.set('KB/Draft.md', AGENT);
    await act(async () => { result.current.setPendingContent(AGENT); });
    // The write reaches the disk at once; its answer waits.
    const server = apiMocks.writeFile.getMockImplementation()!;
    let answer!: () => void;
    const answered = new Promise<void>((r) => { answer = r; });
    apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof server>) => {
      const wrote = await server(...args);
      await answered;
      return wrote;
    });
    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await waitFor(() => expect(disk.get('KB/Draft.md')).toBe(BASELINE));

    await someoneElseDeletes('KB/Draft.md');
    // No read lands while the write is on its way.
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    await act(async () => { answer(); await rejecting; });
    // The change event read nothing under the agent's preview; the tree
    // refresh's check found the file gone, and names nobody.
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());
    await settle();

    // The Reject landed: the agent's version went with it, and the tab
    // holds the baseline it wrote, under the notice.
    const tab = tabAt(result, 'KB/Draft.md')!;
    expect(tab.pendingFileContent).toBeNull();
    expect(tab.content).toBe(BASELINE);
    expect(disk.has('KB/Draft.md')).toBe(false);

    apiMocks.writeFile.mockClear();
    await act(async () => {
      await expect(result.current.saveFile('KB/Draft.md', 'edited')).rejects.toThrow('Draft.md was deleted from this branch');
    });
    expect(apiMocks.writeFile).not.toHaveBeenCalled();
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  it("a Reject over an empty agent version, whose 404 answered before the write put the file back, never shows the notice, and the file is read again", async () => {
    const BASELINE = '# Draft\n\nA page to delete.';
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    // The agent emptied the file.
    disk.set('KB/Draft.md', '');
    await act(async () => { result.current.setPendingContent(''); });
    const held = holdWriteAtServer();
    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
    // Served before the write: the file is missing, and the write over empty
    // bytes (the server reads a missing file as empty) puts the baseline back.
    await someoneElseDeletes('KB/Draft.md');
    // The 404 answered while the write was on its way: it lands on nothing.
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    const readsBefore = apiMocks.readFile.mock.calls.length;
    await act(async () => { held.deliver(); await rejecting; });
    expect(disk.get('KB/Draft.md')).toBe(BASELINE);

    await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    const tab = tabAt(result, 'KB/Draft.md')!;
    expect(tab.content).toBe(BASELINE);
    expect(tab.savedContent).toBe(BASELINE);
    expect(tab.pendingFileContent).toBeNull();
    expect(tab.isDirty).toBe(false);

    // The next Save and Reject work on the file that is there.
    await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited'); });
    expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited', { ifMatch: BASELINE });
    expect(disk.get('KB/Draft.md')).toBe('edited');
    disk.set('KB/Draft.md', 'the agent again');
    await act(async () => { result.current.setPendingContent('the agent again'); });
    await act(async () => { await result.current.rejectPendingContent(); });
    expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited', { ifMatch: 'the agent again' });
    expect(disk.get('KB/Draft.md')).toBe('edited');
    expect(tabAt(result, 'KB/Draft.md')?.pendingFileContent).toBeNull();
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
  });

  it('a Reject over an empty agent version whose re-read finds the file gone lands, and shows the notice over the baseline', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    disk.set('KB/Draft.md', '');
    await act(async () => { result.current.setPendingContent(''); });
    // The write puts the baseline back on the server, then someone deletes
    // the file again before the write's answer resolves, so the re-read that
    // follows the write finds the file missing.
    const server = apiMocks.writeFile.getMockImplementation()!;
    let deliver!: () => void;
    apiMocks.writeFile.mockImplementationOnce((...args: Parameters<typeof server>) => new Promise<void>((resolve, reject) => {
      deliver = () => {
        Promise.resolve(server(...args)).then(() => { disk.delete('KB/Draft.md'); resolve(); }, reject);
      };
    }));
    let rejecting!: Promise<void>;
    act(() => { rejecting = result.current.rejectPendingContent(); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
    await someoneElseDeletes('KB/Draft.md');
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    const readsBefore = apiMocks.readFile.mock.calls.length;
    await act(async () => { deliver(); await rejecting; });
    await waitFor(() => expect(tabAt(result, 'KB/Draft.md')?.deletedBy).toBeTruthy());
    await settle();

    expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore);

    // The Reject landed, so the agent's version went with it.
    const tab = tabAt(result, 'KB/Draft.md')!;
    expect(tab.pendingFileContent).toBeNull();
    expect(tab.content).toBe('# Draft\n\nA page to delete.');
    expect(disk.has('KB/Draft.md')).toBe(false);
  });

  it("a save under the agent's preview, whose 404 over an empty file answered before the write, shows no notice and keeps the preview", async () => {
    disk.set('KB/Draft.md', '');
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited');
    await act(async () => { result.current.setPendingContent('the agent'); });
    const held = holdWriteAtServer();
    let saving!: Promise<void>;
    act(() => { saving = result.current.saveFile('KB/Draft.md', 'edited'); });
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
    await someoneElseDeletes('KB/Draft.md');
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    const readsBefore = apiMocks.readFile.mock.calls.length;
    await act(async () => { held.deliver(); await saving; });
    expect(disk.get('KB/Draft.md')).toBe('edited');

    await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
    await settle();
    expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    const tab = tabAt(result, 'KB/Draft.md')!;
    expect(tab.pendingFileContent).toBe('the agent');
    expect(tab.content).toBe('edited');
  });

  /**
   * The disk holds something else for a moment while a write is on its way
   * (other bytes, or no file), a read sees that, and the disk holds the bytes
   * the write expects again by the time the server takes it, so it lands.
   * What the read saw says nothing about which side of the write the server
   * answered it on: it lands on nothing, and the read after the write
   * decides (the architecture review on 9fb160cf).
   */
  describe('a read that saw a moment the write never saw', () => {
    const BASE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const EDITED = `${BASE}\n\nMy closing line.`;
    const TYPED = `${EDITED}\nTyped while the save was out.`;

    /** An autosave of EDITED held at the server; `moment` changes the disk, and BASE is put back. */
    async function autosaveThrough(moment: () => void) {
      disk.set('KB/Notes.md', BASE);
      const result = await mountReady();
      await open(result, 'KB/Notes.md');
      await typeInto(result, EDITED);
      const held = holdWriteAtServer();
      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', EDITED); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const readsBefore = apiMocks.readFile.mock.calls.length;
      moment();
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
      await settle();
      disk.set('KB/Notes.md', BASE);
      await typeInto(result, TYPED);
      await act(async () => { held.deliver(); await saving; });
      await settle();
      return result;
    }

    /** The save landed: the written bytes are the baseline, the typing stays unsaved, and the next save lands on them. */
    async function expectLandedAndNextSaveLands(result: Hook) {
      expect(disk.get('KB/Notes.md')).toBe(EDITED);
      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.deletedBy ?? null).toBeNull();
      expect(tab.savedContent).toBe(EDITED);
      expect(tab.content).toBe(TYPED);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch ?? null).toBeNull();
      await act(async () => { await result.current.saveFile('KB/Notes.md', TYPED); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', TYPED, { ifMatch: EDITED });
      expect(disk.get('KB/Notes.md')).toBe(TYPED);
      expect(tabAt(result, 'KB/Notes.md')?.isDirty).toBe(false);
    }

    it('other bytes seen while a save was on its way, put back before it landed, leave the written bytes as the baseline', async () => {
      const result = await autosaveThrough(() => { disk.set('KB/Notes.md', 'For a moment, other bytes.'); });
      await expectLandedAndNextSaveLands(result);
    });

    it('a 404 seen while a save was on its way, the file put back before it landed, shows no notice', async () => {
      const result = await autosaveThrough(() => { disk.delete('KB/Notes.md'); });
      await expectLandedAndNextSaveLands(result);
    });

    it('a 404 seen while a Reject was on its way, the file put back before it landed, shows no notice, and the next Save and Reject land', async () => {
      const AGENT = '# Draft\n\nThe agent rewrote this.';
      const BASELINE = '# Draft\n\nA page to delete.';
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      disk.set('KB/Draft.md', AGENT);
      await act(async () => { result.current.setPendingContent(AGENT); });
      const held = holdWriteAtServer();
      let rejecting!: Promise<void>;
      act(() => { rejecting = result.current.rejectPendingContent(); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const readsBefore = apiMocks.readFile.mock.calls.length;
      // The file is gone for a moment; the tree refresh's check reads it.
      disk.delete('KB/Draft.md');
      act(() => bus.emit(fileChanged('KB/Draft.md')));
      await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
      await settle();
      disk.set('KB/Draft.md', AGENT);
      await act(async () => { held.deliver(); await rejecting; });
      await settle();

      expect(disk.get('KB/Draft.md')).toBe(BASELINE);
      const tab = tabAt(result, 'KB/Draft.md')!;
      expect(tab.deletedBy ?? null).toBeNull();
      expect(tab.pendingFileContent).toBeNull();
      expect(tab.content).toBe(BASELINE);
      expect(tab.savedContent).toBe(BASELINE);
      expect(tab.isDirty).toBe(false);

      await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited'); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited', { ifMatch: BASELINE });
      disk.set('KB/Draft.md', 'the agent again');
      await act(async () => { result.current.setPendingContent('the agent again'); });
      await act(async () => { await result.current.rejectPendingContent(); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited', { ifMatch: 'the agent again' });
      expect(disk.get('KB/Draft.md')).toBe('edited');
      expect(tabAt(result, 'KB/Draft.md')?.deletedBy ?? null).toBeNull();
    });
  });

  describe('a read sent while a write was on its way, answered after the server refused the write', () => {
    const BASE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const EDITED = `${BASE}\n\nMy closing line.`;
    const AGENT = '# Draft\n\nThe agent rewrote this.';
    const BASELINE = '# Draft\n\nA page to delete.';

    /**
     * Every read sent from now on is served from the disk as it is when it
     * is sent, and answers when `answer` is called. `stopHolding`: reads sent
     * after it answer at once again.
     */
    function holdReadsSentNow() {
      let answer!: () => void;
      const answered = new Promise<void>((r) => { answer = r; });
      const held = async (_ws: string, path: string) => {
        const bytes = disk.get(path);
        await answered;
        if (bytes === undefined) throw new WorkspaceApiError(404, 'Not found');
        return bytes;
      };
      apiMocks.readFile.mockImplementation(held);
      return {
        stopHolding: () => apiMocks.readFile.mockImplementation(async (_ws: string, path: string) => {
          const bytes = disk.get(path);
          if (bytes === undefined) throw new WorkspaceApiError(404, 'Not found');
          return bytes;
        }),
        answer: () => answer(),
      };
    }

    /**
     * A save of EDITED held at the server; `moment` changes the disk and a
     * change event's read is sent, held; the write is refused (the disk is
     * not what it expected); BASE is put back; then the read answers.
     */
    async function refusedSaveThrough(moment: () => void) {
      disk.set('KB/Notes.md', BASE);
      const result = await mountReady();
      await open(result, 'KB/Notes.md');
      await typeInto(result, EDITED);
      const write = holdWriteAtServer();
      let saving!: Promise<void>;
      act(() => { saving = result.current.saveFile('KB/Notes.md', EDITED); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const readsBefore = apiMocks.readFile.mock.calls.length;
      const reads = holdReadsSentNow();
      moment();
      act(() => bus.emit(fileChanged('KB/Notes.md')));
      await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
      await settle();
      reads.stopHolding();
      await act(async () => {
        write.deliver();
        await expect(saving).rejects.toThrow('changed since you opened it');
      });
      disk.set('KB/Notes.md', BASE);
      await act(async () => { reads.answer(); });
      await settle();
      return result;
    }

    /** Nothing was written: the baseline is BASE, no notice or banner, the edits unsaved, and the next save lands on BASE. */
    async function expectRefusedAndNextSaveLands(result: Hook) {
      expect(disk.get('KB/Notes.md')).toBe(BASE);
      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.deletedBy ?? null).toBeNull();
      expect(tab.savedContent).toBe(BASE);
      expect(tab.content).toBe(EDITED);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch ?? null).toBeNull();
      await act(async () => { await result.current.saveFile('KB/Notes.md', EDITED); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', EDITED, { ifMatch: BASE });
      expect(disk.get('KB/Notes.md')).toBe(EDITED);
      expect(tabAt(result, 'KB/Notes.md')?.isDirty).toBe(false);
    }

    it('other bytes seen during a refused save, put back before the read answered, leave BASE as the baseline', async () => {
      const result = await refusedSaveThrough(() => { disk.set('KB/Notes.md', 'For a moment, other bytes.'); });
      await expectRefusedAndNextSaveLands(result);
    });

    it('a 404 seen during a refused save, the file put back before the read answered, shows no notice', async () => {
      const result = await refusedSaveThrough(() => { disk.delete('KB/Notes.md'); });
      await expectRefusedAndNextSaveLands(result);
    });

    it('a 404 seen during a refused Reject, the agent version put back before the read answered, shows no notice; the preview stays and the next Reject lands', async () => {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      disk.set('KB/Draft.md', AGENT);
      await act(async () => { result.current.setPendingContent(AGENT); });
      const write = holdWriteAtServer();
      let rejecting!: Promise<void>;
      act(() => { rejecting = result.current.rejectPendingContent(); });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      const readsBefore = apiMocks.readFile.mock.calls.length;
      const reads = holdReadsSentNow();
      // The file is gone for a moment; the tree refresh's check reads it.
      disk.delete('KB/Draft.md');
      act(() => bus.emit(fileChanged('KB/Draft.md')));
      await waitFor(() => expect(apiMocks.readFile.mock.calls.length).toBeGreaterThan(readsBefore));
      await settle();
      reads.stopHolding();
      await act(async () => {
        write.deliver();
        await expect(rejecting).rejects.toThrow('changed since you opened it');
      });
      disk.set('KB/Draft.md', AGENT);
      await act(async () => { reads.answer(); });
      await settle();

      const tab = tabAt(result, 'KB/Draft.md')!;
      expect(tab.deletedBy ?? null).toBeNull();
      expect(tab.pendingFileContent).toBe(AGENT);
      expect(tab.savedContent).toBe(BASELINE);

      await act(async () => { await result.current.rejectPendingContent(); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', BASELINE, { ifMatch: AGENT });
      expect(disk.get('KB/Draft.md')).toBe(BASELINE);
      expect(tabAt(result, 'KB/Draft.md')?.pendingFileContent).toBeNull();
      await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited'); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited', { ifMatch: BASELINE });
    });
  });

  describe('a write whose answer never came: the read after it says what the disk holds', () => {
    const BASE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const EDITED = `${BASE}\n\nMy closing line.`;
    const AGENT = '# Draft\n\nThe agent rewrote this.';
    const BASELINE = '# Draft\n\nA page to delete.';
    // No answer says whether the server took the write: the connection
    // dropped, or the server failed after its turn.
    const DROPPED = () => new TypeError('Failed to fetch');
    const SERVER_ERROR = () => new WorkspaceApiError(502, 'Bad gateway');

    /** The next write is served (`commit`: or not), and then its answer is `err`. */
    function answerNextWriteWith(err: () => Error, commit: boolean) {
      const server = apiMocks.writeFile.getMockImplementation()!;
      apiMocks.writeFile.mockImplementationOnce(async (...args: Parameters<typeof server>) => {
        if (commit) await server(...args);
        throw err();
      });
    }

    async function draftUnderReview() {
      const result = await mountReady();
      await open(result, 'KB/Draft.md');
      disk.set('KB/Draft.md', AGENT);
      await act(async () => { result.current.setPendingContent(AGENT); });
      return result;
    }

    it.each([
      ['the connection dropped', DROPPED],
      ['the server answered 502', SERVER_ERROR],
    ])('a Reject the server took, %s before the answer: the preview ends on the baseline, and the next save expects it', async (_how, err) => {
      const result = await draftUnderReview();
      answerNextWriteWith(err, true);
      await act(async () => { await expect(result.current.rejectPendingContent()).rejects.toThrow(); });
      await settle();

      expect(disk.get('KB/Draft.md')).toBe(BASELINE);
      const tab = tabAt(result, 'KB/Draft.md')!;
      expect(tab.pendingFileContent).toBeNull();
      expect(tab.content).toBe(BASELINE);
      expect(tab.savedContent).toBe(BASELINE);
      expect(tab.isDirty).toBe(false);
      expect(tab.deletedBy ?? null).toBeNull();
      expect(tab.changedOnBranch ?? null).toBeNull();

      await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited'); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited', { ifMatch: BASELINE });
      expect(disk.get('KB/Draft.md')).toBe('edited');
    });

    it('a Reject the server never took, the connection dropped: the preview stays, and the next Reject lands', async () => {
      const result = await draftUnderReview();
      answerNextWriteWith(DROPPED, false);
      await act(async () => { await expect(result.current.rejectPendingContent()).rejects.toThrow('Failed to fetch'); });
      await settle();

      expect(disk.get('KB/Draft.md')).toBe(AGENT);
      const tab = tabAt(result, 'KB/Draft.md')!;
      expect(tab.pendingFileContent).toBe(AGENT);
      expect(tab.savedContent).toBe(BASELINE);
      expect(tab.deletedBy ?? null).toBeNull();

      await act(async () => { await result.current.rejectPendingContent(); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', BASELINE, { ifMatch: AGENT });
      expect(disk.get('KB/Draft.md')).toBe(BASELINE);
      expect(tabAt(result, 'KB/Draft.md')?.pendingFileContent).toBeNull();
    });

    it('a Reject the server refused (409) is not read as one that may have landed: the preview stays', async () => {
      const result = await draftUnderReview();
      // Someone else wrote the file meanwhile: it no longer holds AGENT.
      disk.set('KB/Draft.md', 'Someone else\'s version.');
      await act(async () => { await expect(result.current.rejectPendingContent()).rejects.toThrow('changed since you opened it'); });
      await settle();

      const tab = tabAt(result, 'KB/Draft.md')!;
      expect(tab.pendingFileContent).toBe(AGENT);
      expect(tab.savedContent).toBe(BASELINE);
    });

    async function savedThroughUnanswered(commit: boolean) {
      disk.set('KB/Notes.md', BASE);
      const result = await mountReady();
      await open(result, 'KB/Notes.md');
      await typeInto(result, EDITED);
      answerNextWriteWith(DROPPED, commit);
      await act(async () => {
        const saving = result.current.saveFile('KB/Notes.md', EDITED);
        // Done marks the tab clean as the editor closes.
        result.current.setHasUnsavedFileChanges?.(false);
        await expect(saving).rejects.toThrow('Failed to fetch');
      });
      await settle();
      return result;
    }

    it('a save the server took, the connection dropped before the answer: the edits are saved, and the next save expects them', async () => {
      const result = await savedThroughUnanswered(true);

      expect(disk.get('KB/Notes.md')).toBe(EDITED);
      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.content).toBe(EDITED);
      expect(tab.savedContent).toBe(EDITED);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch ?? null).toBeNull();

      const more = `${EDITED}\n\nOne more line.`;
      await act(async () => { await result.current.saveFile('KB/Notes.md', more); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', more, { ifMatch: EDITED });
      expect(disk.get('KB/Notes.md')).toBe(more);
    });

    it('a save the server never took, the connection dropped: the edits stay unsaved on BASE, and the next save lands', async () => {
      const result = await savedThroughUnanswered(false);

      expect(disk.get('KB/Notes.md')).toBe(BASE);
      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.content).toBe(EDITED);
      expect(tab.savedContent).toBe(BASE);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch ?? null).toBeNull();

      await act(async () => { await result.current.saveFile('KB/Notes.md', EDITED); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Notes.md', EDITED, { ifMatch: BASE });
      expect(disk.get('KB/Notes.md')).toBe(EDITED);
      expect(tabAt(result, 'KB/Notes.md')?.isDirty).toBe(false);
    });
  });

  describe('refused after a change pulled from the git host while it was on its way', () => {
    const BASE = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';

    /**
     * Done on `edited`, the write held at the server, then `pulled` arrives
     * on the clean tab: its read lands on nothing until the write is refused,
     * and the file is read again.
     */
    async function doneThenPulled(edited: string, pulled: string) {
      disk.set('KB/Notes.md', BASE);
      const result = await mountReady();
      await open(result, 'KB/Notes.md');
      await typeInto(result, edited);
      const held = holdWriteAtServer();
      let saving!: Promise<void>;
      act(() => {
        saving = result.current.saveFile('KB/Notes.md', edited);
        result.current.setHasUnsavedFileChanges?.(false);
      });
      await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledOnce());
      disk.set('KB/Notes.md', pulled);
      act(() => bus.emit(fileChanged('KB/Notes.md', GIT_SYNC)));
      await settle();
      expect(tabAt(result, 'KB/Notes.md')?.savedContent).toBe(BASE);
      await act(async () => {
        held.deliver();
        await expect(saving).rejects.toThrow('changed since you opened it');
      });
      await waitFor(() => expect(tabAt(result, 'KB/Notes.md')?.savedContent).toBe(pulled));
      await settle();
      return result;
    }

    it('merges the edits onto the pulled bytes, so the next save does not write them over the pull', async () => {
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      const result = await doneThenPulled(`${BASE}\n\nMy new closing line.`, pulled);

      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.savedContent).toBe(pulled);
      expect(tab.content).toBe(`${pulled}\n\nMy new closing line.`);
      expect(tab.isDirty).toBe(true);
      expect(tab.changedOnBranch).toBe('merged');
      expect(disk.get('KB/Notes.md')).toBe(pulled);

      await act(async () => { await result.current.saveFile('KB/Notes.md', tab.content ?? ''); });
      expect(disk.get('KB/Notes.md')).toBe(`${pulled}\n\nMy new closing line.`);
    });

    it('keeps the pulled bytes and says the edits were discarded when they collide', async () => {
      const pulled = BASE.replace('Second paragraph.', 'Second paragraph, their way.');
      const result = await doneThenPulled(BASE.replace('Second paragraph.', 'Second paragraph, my way.'), pulled);

      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.content).toBe(pulled);
      expect(tab.savedContent).toBe(pulled);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBe('discarded');
      expect(disk.get('KB/Notes.md')).toBe(pulled);
    });

    it('shows no banner and leaves the tab clean when the pulled bytes already hold the edits', async () => {
      const pulled = BASE.replace('First paragraph.', 'First paragraph, rewritten upstream.');
      const result = await doneThenPulled(pulled, pulled);

      const tab = tabAt(result, 'KB/Notes.md')!;
      expect(tab.content).toBe(pulled);
      expect(tab.savedContent).toBe(pulled);
      expect(tab.isDirty).toBe(false);
      expect(tab.changedOnBranch).toBeNull();
      expect(disk.get('KB/Notes.md')).toBe(pulled);
    });
  });

  it('two saves of one file sent together both land, each over what the one before wrote', async () => {
    const result = await mountReady();
    await open(result, 'KB/Draft.md');
    await typeInto(result, 'edited more');
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.saveFile('KB/Draft.md', 'edited');
      second = result.current.saveFile('KB/Draft.md', 'edited more');
    });
    await act(async () => { await first; await second; });

    expect(disk.get('KB/Draft.md')).toBe('edited more');
    expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-1', 'KB/Draft.md', 'edited more', { ifMatch: 'edited' });
    expect(tabAt(result, 'KB/Draft.md')?.isDirty).toBe(false);
  });
});

// The two run in order: the first queues a held answer it never uses, and
// the second must not get it.
describe('a held answer a test never used stays in that test', () => {
  it('queues a write refusal and makes no write', () => {
    apiMocks.writeFile.mockImplementationOnce(async () => {
      throw new WorkspaceApiError(500, 'A hold left over from an earlier test.');
    });
    expect(apiMocks.writeFile).not.toHaveBeenCalled();
  });

  it('writes to the branch as the server would', async () => {
    await apiMocks.writeFile('ws-1', 'KB/Keep.md', 'kept', { ifMatch: 'keep' });
    expect(disk.get('KB/Keep.md')).toBe('kept');
  });
});
