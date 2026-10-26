import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, render, act, waitFor, screen, within, fireEvent } from '@testing-library/react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
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

import { EventBusContext, type EventBusContextValue } from '../../../workflow/state/event-bus.context';
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

function makeFakeBus() {
  const handlers: Record<string, ((e: WorkflowEvent) => void)[]> = {};
  const bus: EventBusContextValue & { emit(e: WorkflowEvent): void } = {
    subscribe(kind, handler) {
      (handlers[kind] ??= []).push(handler as (e: WorkflowEvent) => void);
      return () => {
        handlers[kind] = (handlers[kind] ?? []).filter((h) => h !== handler);
      };
    },
    setFocus() {},
    watchWorkspace() {
      return () => {};
    },
    emit(e) {
      (handlers[e.kind] ?? []).forEach((h) => h(e));
    },
  };
  return bus;
}

function fileChanged(path: string, by: { id: string; name: string } = { id: 'u-sam', name: 'Sam Rivera' }): WorkflowEvent {
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
const treeChanged = (): WorkflowEvent => ({ ...envelope(), kind: 'fs-tree-changed', workspaceId: 'ws-1', branch: 'main' });

let eventId = 0;
function envelope() {
  return { id: ++eventId, ts: new Date().toISOString() };
}

let bus: ReturnType<typeof makeFakeBus>;

async function mountReady() {
  const { result } = renderHook(() => useWorkspaceState(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={bus}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </EventBusContext.Provider>
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
  // Call history is per test: `not.toHaveBeenCalled` must see only its own.
  vi.clearAllMocks();
  disk = new Map([
    ['KB/Keep.md', 'keep'],
    ['KB/Gone.md', 'gone'],
    ['KB/Solo.md', 'solo'],
    ['KB/Other.md', 'other'],
    ['KB/Dir/a.md', 'a'],
    ['KB/Draft.md', '# Draft\n\nA page to delete.'],
  ]);
  bus = makeFakeBus();
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
  apiMocks.writeFile.mockImplementation(async (_ws: string, path: string, content: string) => {
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
    <EventBusContext.Provider value={bus}>
      <ConfirmProvider><Harness /></ConfirmProvider>
    </EventBusContext.Provider>,
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
    act(() => bus.emit({ ...treeChanged(), workspaceId: 'ws-2', branch: 'feature' } as WorkflowEvent));

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
    await act(async () => { result.current.setPendingContent('# Draft\n\nThe agent rewrote this.'); });

    await act(async () => { await result.current.rejectPendingContent(); });

    expect(disk.get('KB/Draft.md')).toBe(baseline);
    expect(result.current.activeTab?.pendingFileContent).toBeNull();
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
    const changedOnFeature = () => ({ ...fileChanged('KB/Draft.md'), workspaceId: 'ws-2', branch: 'feature' }) as WorkflowEvent;

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
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-2', 'KB/Draft.md', 'edited on feature');

      await act(async () => { answerGoneOnMain(); await mainReload; });
      await act(async () => { await result.current.saveFile('KB/Draft.md', 'edited again'); });
      expect(apiMocks.writeFile).toHaveBeenLastCalledWith('ws-2', 'KB/Draft.md', 'edited again');
    });
  });

  it('a lock released by a delete shows the open file as deleted, keeping its content', async () => {
    const result = await mountReady();
    await open(result, 'KB/Keep.md', 'KB/Draft.md');
    disk.delete('KB/Draft.md');

    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));

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

    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));

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

    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));
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
      act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));
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
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));
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
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));
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
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Notes.md' } as WorkflowEvent));
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
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md', 'edited on main'));

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
    await waitFor(() => expect(apiMocks.writeFile).toHaveBeenCalledWith('ws-1', 'KB/Draft.md', expect.any(String)));

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
    act(() => bus.emit({ ...envelope(), kind: 'lock-released', workspaceId: 'ws-1', branch: 'main', path: 'KB/Draft.md' } as WorkflowEvent));
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
