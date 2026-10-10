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
