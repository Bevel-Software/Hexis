import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Build a single error class shared between the mock module and the tests.
// Hoisted so vi.mock can reach it during module initialization, before the
// real `workspace.api` would be imported.
const apiMocks = vi.hoisted(() => {
  class FakeWorkspaceApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`HTTP ${status}`);
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

// Access + propose plumbing behind the suggestion-routed upload. Mocked so
// the routing tests decide the ACL answer and observe the propose calls.
const accessApiMock = vi.hoisted(() => ({ fetchFileAccess: vi.fn() }));
vi.mock('../../../access/api', () => ({
  fetchFileAccess: accessApiMock.fetchFileAccess,
  fetchFileAccessBatch: vi.fn(async () => ({ results: {} })),
}));
const proposeMocks = vi.hoisted(() => ({
  ensureKnowledgeSuggestionWorkspace: vi.fn(),
  ensureKnowledgeChangeRequest: vi.fn(async (): Promise<unknown> => null),
}));
vi.mock('../../../change-requests/services/propose.api', () => proposeMocks);

import type { ReactNode } from 'react';
import { AuthContext } from '../../../auth/state/auth.context';
import { PR_STALE_EVENT, SUGGESTIONS_OPTIMISTIC_EVENT } from '../../../../core/events';
import { useWorkspaceState } from '../useWorkspaceState';
import { FILE_TRACE_STORAGE_KEY } from '../../utils/file-trace';
const WorkspaceApiError = apiMocks.WorkspaceApiError;

const WORKSPACE_FIXTURE = {
  workspace: {
    id: 'ws-1',
    name: 'Workspace',
    absolutePath: '/tmp/ws-1',
    createdAt: '2026-04-20T00:00:00.000Z',
  },
  fileTree: {
    name: '.',
    relativePath: '.',
    type: 'directory' as const,
    children: [],
  },
};

describe('useWorkspaceState multi-tab', () => {
  beforeEach(() => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue(WORKSPACE_FIXTURE);
    apiMocks.listFiles.mockResolvedValue(WORKSPACE_FIXTURE.fileTree);
    apiMocks.readFile.mockImplementation(async (_wsId: string, path: string) => `content:${path}`);
    apiMocks.writeFile.mockResolvedValue(undefined);
    apiMocks.createDirectory.mockResolvedValue(undefined);
    apiMocks.uploadFile.mockResolvedValue(undefined);
    apiMocks.deleteFile.mockResolvedValue(undefined);
    apiMocks.moveEntry.mockResolvedValue(undefined);
    apiMocks.deleteWorkspace.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function mountReady() {
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));
    return result;
  }

  it('addTab opens a new tab and activates it', async () => {
    const result = await mountReady();
    await act(async () => {
      await expect(result.current.addTab('Knowledge/A.md')).resolves.toBe(true);
    });
    expect(result.current.openTabs).toHaveLength(1);
    expect(result.current.openTabs[0].path).toBe('Knowledge/A.md');
    expect(result.current.activeTab?.path).toBe('Knowledge/A.md');
    expect(result.current.openFileContent).toBe('content:Knowledge/A.md');
  });

  it('addTab dedups: opening the same path twice keeps one tab', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('Knowledge/A.md'); });
    await act(async () => { await result.current.addTab('Knowledge/A.md'); });
    expect(result.current.openTabs).toHaveLength(1);
  });

  it('addTab does NOT prompt when an existing tab is dirty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const result = await mountReady();
    await act(async () => { await result.current.addTab('Knowledge/A.md'); });
    await act(async () => { result.current.setHasUnsavedFileChanges?.(true); });

    await act(async () => {
      await expect(result.current.addTab('Knowledge/B.md')).resolves.toBe(true);
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(result.current.openTabs).toHaveLength(2);
    expect(result.current.activeTab?.path).toBe('Knowledge/B.md');
    // Tab A's dirty state survived the switch — switching never discards work.
    const tabA = result.current.openTabs.find((t) => t.path === 'Knowledge/A.md');
    expect(tabA?.isDirty).toBe(true);
  });

  it('closeTab prompts when the tab is dirty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const result = await mountReady();
    await act(async () => { await result.current.addTab('Knowledge/A.md'); });
    await act(async () => { result.current.setHasUnsavedFileChanges?.(true); });

    const tabA = result.current.openTabs[0];
    await act(async () => {
      const result1 = await result.current.closeTab(tabA);
      expect(result1.closed).toBe(false);
    });
    expect(confirmSpy).toHaveBeenCalledWith(
      'You have unsaved changes in A.md. Close anyway?',
    );
    expect(result.current.openTabs).toHaveLength(1);

    confirmSpy.mockReturnValue(true);
    await act(async () => {
      const result2 = await result.current.closeTab(tabA);
      expect(result2.closed).toBe(true);
    });
    expect(result.current.openTabs).toHaveLength(0);
    expect(result.current.activeTab).toBeNull();
  });

  it('closeTab activates the left neighbor when closing the active tab', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('a.md'); });
    await act(async () => { await result.current.addTab('b.md'); });
    await act(async () => { await result.current.addTab('c.md'); });
    expect(result.current.activeTab?.path).toBe('c.md');

    const tabC = result.current.openTabs.find((t) => t.path === 'c.md')!;
    await act(async () => { await result.current.closeTab(tabC); });
    expect(result.current.activeTab?.path).toBe('b.md');
  });

  it('closeTab activates the right neighbor when closing the leftmost tab', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('a.md'); });
    await act(async () => { await result.current.addTab('b.md'); });
    await act(async () => { result.current.activateTab(result.current.openTabs[0]); });
    expect(result.current.activeTab?.path).toBe('a.md');

    const tabA = result.current.openTabs[0];
    await act(async () => { await result.current.closeTab(tabA); });
    expect(result.current.activeTab?.path).toBe('b.md');
  });

  it('deleteEntry sweeps tabs whose path matches the deleted path', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('keep.md'); });
    await act(async () => { await result.current.addTab('drop.md'); });

    await act(async () => { await result.current.deleteEntry('drop.md'); });

    expect(result.current.openTabs.map((t) => t.path)).toEqual(['keep.md']);
  });

  it('deleteEntry sweeps tabs under a deleted directory and prompts once for dirty', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const result = await mountReady();
    await act(async () => { await result.current.addTab('Knowledge/keep.md'); });
    await act(async () => { await result.current.addTab('OldDir/a.md'); });
    await act(async () => { result.current.setHasUnsavedFileChanges?.(true); });
    await act(async () => { await result.current.addTab('OldDir/b.md'); });

    await act(async () => { await result.current.deleteEntry('OldDir'); });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // Bulk-confirm message uses basename, not full path.
    expect(confirmSpy.mock.calls[0][0]).toMatch(/a\.md/);
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['Knowledge/keep.md']);
  });

  it('moveEntry rewrites tab paths in place', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('Old/A.md'); });
    await act(async () => { await result.current.addTab('Other.md'); });
    await act(async () => { result.current.activateTab(result.current.openTabs[0]); });

    await act(async () => { await result.current.moveEntry('Old/A.md', 'New/A.md'); });

    expect(result.current.openTabs.map((t) => t.path).sort()).toEqual(['New/A.md', 'Other.md']);
    expect(result.current.activeTab?.path).toBe('New/A.md');
  });

  it('moveEntry rewrites paths under a renamed directory', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('Old/x.md'); });
    await act(async () => { await result.current.addTab('Old/y.md'); });

    await act(async () => { await result.current.moveEntry('Old', 'New'); });

    expect(result.current.openTabs.map((t) => t.path).sort()).toEqual(['New/x.md', 'New/y.md']);
  });

  it('hasUnsavedFileChanges aggregates across tabs', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('a.md'); });
    await act(async () => { result.current.setHasUnsavedFileChanges?.(true); });
    await act(async () => { await result.current.addTab('b.md'); });

    expect(result.current.activeTab?.path).toBe('b.md');
    expect(result.current.hasUnsavedFileChanges).toBe(true);
    expect(result.current.dirtyTabFilenames).toEqual(['a.md']);
  });

  it('hydrateTabs fetches in parallel and silently drops 404s', async () => {
    apiMocks.readFile.mockImplementation(async (_wsId: string, path: string) => {
      if (path === 'gone.md') throw new WorkspaceApiError(404);
      return `content:${path}`;
    });
    const result = await mountReady();

    let dropped: string[] = [];
    await act(async () => {
      const out = await result.current.hydrateTabs(['a.md', 'gone.md', 'b.md'], 'b.md');
      dropped = out.dropped;
    });

    expect(result.current.openTabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
    expect(result.current.activeTab?.path).toBe('b.md');
    expect(dropped).toEqual(['gone.md']);
  });

  it('hydrateTabs throws on non-404 errors', async () => {
    apiMocks.readFile.mockRejectedValue(new WorkspaceApiError(500));
    const result = await mountReady();
    await expect(async () => {
      await act(async () => {
        await result.current.hydrateTabs(['a.md'], 'a.md');
      });
    }).rejects.toThrow();
  });

  it('reorderTab moves a tab to a new index', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('a.md'); });
    await act(async () => { await result.current.addTab('b.md'); });
    await act(async () => { await result.current.addTab('c.md'); });

    const tabA = result.current.openTabs[0];
    await act(async () => { result.current.reorderTab(tabA, 2); });
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('preserves typed-but-unsaved bytes across a tab switch', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('a.md'); });
    expect(result.current.openFileContent).toBe('content:a.md');

    // Simulate the renderer pushing a typed value via onValueChange.
    await act(async () => { result.current.setActiveTabContent('typed bytes for a'); });
    await act(async () => { result.current.setHasUnsavedFileChanges?.(true); });
    expect(result.current.openFileContent).toBe('typed bytes for a');
    expect(result.current.openFileSavedContent).toBe('content:a.md');

    // Open another tab; A's typed value MUST survive.
    await act(async () => { await result.current.addTab('b.md'); });
    expect(result.current.activeTab?.path).toBe('b.md');
    const tabA = result.current.openTabs.find((t) => t.path === 'a.md')!;
    expect(tabA.content).toBe('typed bytes for a');
    expect(tabA.savedContent).toBe('content:a.md');
    expect(tabA.isDirty).toBe(true);

    // Switch back to A — content reflects what was typed.
    await act(async () => { result.current.activateTab(tabA); });
    expect(result.current.activeTab?.path).toBe('a.md');
    expect(result.current.openFileContent).toBe('typed bytes for a');
    expect(result.current.openFileSavedContent).toBe('content:a.md');
  });

  /**
   * The reproduction's "URL and open file disagree after fast clicks": click
   * several unopened files, then one that is already open. Reopening an open
   * tab took a shortcut that skipped the "latest open" token, so the last
   * still-in-flight read counted as the newest intent and activated ITS file
   * when it landed — the URL naming one file and the screen showing another,
   * indefinitely.
   */
  it('reopening an already-open tab outranks an older read still in flight', async () => {
    const result = await mountReady();
    await act(async () => { await result.current.addTab('b.md'); });
    expect(result.current.activeTab?.path).toBe('b.md');

    // A click on an unopened file: its read hangs.
    let releaseRead: ((content: string) => void) | undefined;
    apiMocks.readFile.mockImplementation(
      () => new Promise<string>((resolve) => { releaseRead = resolve; }),
    );
    let slowOpen: Promise<boolean> | undefined;
    act(() => { slowOpen = result.current.addTab('a.md'); });

    // A click on `b.md`, which is already open — the last thing the user asked for.
    await act(async () => { await result.current.addTab('b.md'); });
    expect(result.current.activeTab?.path).toBe('b.md');

    // Now `a.md` arrives. It opens its tab, but it does NOT steal the focus.
    await act(async () => {
      releaseRead?.('content:a.md');
      await slowOpen;
    });
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['b.md', 'a.md']);
    expect(result.current.activeTab?.path).toBe('b.md');
  });

  it('persists tabs to localStorage after hydrate, debounced', async () => {
    // A real workspace id IS the encoded branch, and the persistence key is
    // built from the branch the workspace turned out to be — so the fixture
    // has to be a branch-shaped id, not an opaque one.
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'alice%2Fdraft' },
    });
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('alice%2Fdraft'));
    act(() => { result.current.setPersistenceBranch('alice/draft'); });
    await act(async () => { await result.current.hydrateTabs(['a.md', 'b.md'], 'b.md'); });
    await act(async () => { await result.current.addTab('c.md'); });

    // Wait for the 200ms debounce to flush.
    await waitFor(() => {
      const raw = localStorage.getItem('bevel.tabs.alice%2Fdraft.alice/draft');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.paths).toEqual(['a.md', 'b.md', 'c.md']);
      expect(parsed.activePath).toBe('c.md');
    });
  });

  /**
   * A restore and an open are different claims. The open says "this file is
   * what I want ACTIVE"; the restore says "these tabs are this branch's".
   * Sharing one token made an ordinary click mid-restore look like it had
   * retired the restore: the branch's whole tab list was dropped on the floor,
   * and — the marker for "this key has been hydrated" never being set —
   * persistence for that branch stayed off, so the list was never written
   * again either. The click wins the focus; it does not empty the strip.
   */
  it('an open during a hydration keeps the focus without discarding the restored tabs', async () => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'alice%2Fdraft' },
    });
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('alice%2Fdraft'));
    act(() => { result.current.setPersistenceBranch('alice/draft'); });

    // The restore's reads hang; the click's read answers at once.
    const pendingReads: ((content: string) => void)[] = [];
    apiMocks.readFile.mockImplementation(async (_wsId: string, path: string) => {
      if (path === 'c.md') return 'content:c.md';
      return new Promise<string>((resolve) => { pendingReads.push(resolve); });
    });

    let hydration: Promise<unknown> | undefined;
    act(() => { hydration = result.current.hydrateTabs(['a.md', 'b.md'], 'b.md'); });
    await act(async () => { await result.current.addTab('c.md'); });
    expect(result.current.activeTab?.path).toBe('c.md');

    await act(async () => {
      for (const resolve of pendingReads) resolve('content:restored');
      await hydration;
    });

    // Every restored tab is there, alongside the one the user clicked, and the
    // click keeps the focus it claimed.
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(result.current.activeTab?.path).toBe('c.md');

    // And persistence is live for this branch: the restore counted.
    await waitFor(() => {
      const raw = localStorage.getItem('bevel.tabs.alice%2Fdraft.alice/draft');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).paths).toEqual(['a.md', 'b.md', 'c.md']);
    });
  });

  /**
   * The other half of the same split: a NEWER RESTORE does retire an older
   * one, and the older one has to say so. A caller that recorded it as done
   * would mark the branch hydrated on the strength of a result that never
   * reached the screen.
   */
  it('reports a hydration overtaken by a newer hydration as superseded', async () => {
    const { result } = await (async () => {
      const r = renderHook(() => useWorkspaceState());
      await waitFor(() => expect(r.result.current.workspaceId).toBe('ws-1'));
      return r;
    })();

    const pendingReads: ((content: string) => void)[] = [];
    apiMocks.readFile.mockImplementation(
      () => new Promise<string>((resolve) => { pendingReads.push(resolve); }),
    );
    let first: Promise<{ superseded: boolean }> | undefined;
    act(() => { first = result.current.hydrateTabs(['a.md'], 'a.md'); });

    apiMocks.readFile.mockImplementation(async (_wsId: string, path: string) => `content:${path}`);
    await act(async () => { await result.current.hydrateTabs(['b.md'], 'b.md'); });

    let firstResult: { superseded: boolean } | undefined;
    await act(async () => {
      for (const resolve of pendingReads) resolve('content:a.md');
      firstResult = await first;
    });
    expect(firstResult?.superseded).toBe(true);
    // The newer restore's strip stands, untouched by the older one.
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['b.md']);
  });

  /**
   * The crossed key from the reproduction: `bevel.tabs.main.someone/draft` —
   * one branch's workspace under another branch's name. It was written
   * mid-switch, because the persistence key took its branch from
   * `persistenceBranch`, which points at the branch being switched TO from the
   * instant the switch starts, while `workspaceId` still serves the branch
   * being left. Tabs are persisted under the key of the branch they were READ
   * from, or not at all.
   */
  it('never persists one branch\'s tabs under another branch\'s key during a switch', async () => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'main' },
    });
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('main'));

    act(() => { result.current.setPersistenceBranch('main'); });
    await act(async () => { await result.current.hydrateTabs(['a.md'], 'a.md'); });
    await waitFor(() => {
      expect(localStorage.getItem('bevel.tabs.main.main')).not.toBeNull();
    });

    // A second hydration against `main` goes in flight…
    const pendingReads: ((content: string) => void)[] = [];
    apiMocks.readFile.mockImplementation(
      () => new Promise<string>((resolve) => { pendingReads.push(resolve); }),
    );
    let hydration: Promise<unknown> | undefined;
    act(() => { hydration = result.current.hydrateTabs(['a.md', 'b.md'], 'b.md'); });

    // …and mid-flight the user switches away. `persistenceBranch` moves to the
    // destination immediately; the destination's workspace never arrives.
    apiMocks.getOrCreateWorkspace.mockImplementation(() => new Promise(() => {}));
    act(() => { result.current.setPersistenceBranch('someone/draft'); });

    // Now `main`'s reads land. These bytes belong to `main` and to no other key.
    await act(async () => {
      for (const resolve of pendingReads) resolve('content:from-main');
      await hydration;
    });
    await new Promise((r) => setTimeout(r, 300));

    expect(localStorage.getItem('bevel.tabs.main.someone/draft')).toBeNull();
    expect(localStorage.getItem('bevel.tabs.someone%2Fdraft.someone/draft')).toBeNull();
    expect(JSON.parse(localStorage.getItem('bevel.tabs.main.main')!).paths)
      .toEqual(['a.md', 'b.md']);
  });

  /**
   * A restore overtaken by a click MERGES into the strip rather than replacing
   * it. If the strip still held the branch being left, the merge carried those
   * tabs over: shown on the new branch with the old branch's text, and
   * persisted under the new branch's key. The strip belongs to the workspace
   * it was read from, so a new workspace starts it empty.
   */
  it('a click during a switch never carries the previous branch\'s tabs into the new one', async () => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'main' },
    });
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('main'));
    act(() => { result.current.setPersistenceBranch('main'); });
    await act(async () => { await result.current.hydrateTabs(['only-on-main.md'], 'only-on-main.md'); });
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['only-on-main.md']);

    // Switch to the draft; its workspace arrives.
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'alice%2Fdraft' },
    });
    act(() => { result.current.setPersistenceBranch('alice/draft'); });
    await waitFor(() => expect(result.current.workspaceId).toBe('alice%2Fdraft'));

    // The draft's restore hangs; the user clicks a file meanwhile.
    const pendingReads: ((content: string) => void)[] = [];
    apiMocks.readFile.mockImplementation(async (_wsId: string, path: string) => {
      if (path === 'clicked.md') return 'content:clicked.md';
      return new Promise<string>((resolve) => { pendingReads.push(resolve); });
    });
    let hydration: Promise<unknown> | undefined;
    act(() => { hydration = result.current.hydrateTabs(['restored.md'], 'restored.md'); });
    await act(async () => { await result.current.addTab('clicked.md'); });
    await act(async () => {
      for (const resolve of pendingReads) resolve('content:restored.md');
      await hydration;
    });

    // Only the draft's tabs: the restored one and the clicked one.
    expect(result.current.openTabs.map((t) => t.path)).toEqual(['restored.md', 'clicked.md']);
    await waitFor(() => {
      const raw = localStorage.getItem('bevel.tabs.alice%2Fdraft.alice/draft');
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).paths).toEqual(['restored.md', 'clicked.md']);
    });
  });

  /**
   * The last read without a workspace guard: activating a tab whose bytes an
   * fs bump invalidated re-reads it in the background. If the branch switches
   * while that read is in flight, the tab of the same path on the new branch
   * is not the one it was for — its answer, bytes or a 404, is about the
   * branch that was left.
   */
  it.each([
    ['bytes', (resolve: (c: string) => void) => resolve('content:from-main')],
    ['a 404', (_resolve: (c: string) => void, reject: (e: unknown) => void) => reject(new WorkspaceApiError(404))],
  ])('an activate re-read from the branch left behind lands nowhere (%s)', async (_label, settle) => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'main' },
    });
    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('main'));
    await act(async () => { await result.current.addTab('shared.md'); });
    await act(async () => { await result.current.addTab('other.md'); });
    // An fs bump invalidates the inactive tab; re-activating it re-reads.
    act(() => { result.current.bumpFsRevision(); });
    await waitFor(() => {
      expect(result.current.openTabs.find((t) => t.path === 'shared.md')?.content).toBeNull();
    });
    let resolveOld: (c: string) => void = () => {};
    let rejectOld: (e: unknown) => void = () => {};
    apiMocks.readFile.mockImplementation((wsId: string, path: string) => {
      if (wsId === 'main') {
        return new Promise<string>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
      }
      return Promise.resolve(`content:draft:${path}`);
    });
    const invalidated = result.current.openTabs.find((t) => t.path === 'shared.md')!;
    act(() => { result.current.activateTab(invalidated); });

    // Switch to the draft and open the same path there.
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'alice%2Fdraft' },
    });
    act(() => { result.current.setPersistenceBranch('alice/draft'); });
    await waitFor(() => expect(result.current.workspaceId).toBe('alice%2Fdraft'));
    await act(async () => { await result.current.addTab('shared.md'); });

    // main's answer arrives late.
    await act(async () => { settle(resolveOld, rejectOld); await Promise.resolve(); });

    const draftTab = result.current.openTabs.find((t) => t.path === 'shared.md');
    expect(draftTab?.content).toBe('content:draft:shared.md');
  });
});


/**
 * An upload into a KB folder the caller may NOT write neither fails nor
 * forces its way in: it lands on the personal suggestions branch and becomes
 * (or extends) their one Knowledge change request — the same review path a
 * typed proposal takes.
 */
describe('dispatchUpload: suggestion routing', () => {
  // `target-company-state` is protected in the test branch model, and the
  // workspace id IS the encoded branch name — which is how the hook recovers
  // the branch to ask "is this protected?".
  const PROTECTED_FIXTURE = {
    workspace: {
      id: 'target-company-state',
      name: 'Workspace',
      absolutePath: '/tmp/ws',
      createdAt: '2026-04-20T00:00:00.000Z',
      kbDirName: 'knowledge-base',
    },
    fileTree: { name: '.', relativePath: '.', type: 'directory' as const, children: [] },
  };

  function wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthContext.Provider
        value={{
          user: { id: 'u1', email: 'reader@example.com', name: 'Rae Reader' },
          token: 't',
          isLoading: false,
          login: async () => {},
          logout: () => {},
        }}
      >
        {children}
      </AuthContext.Provider>
    );
  }

  beforeEach(() => {
    apiMocks.getOrCreateWorkspace.mockReset().mockResolvedValue(PROTECTED_FIXTURE);
    apiMocks.listFiles.mockReset().mockResolvedValue(PROTECTED_FIXTURE.fileTree);
    apiMocks.uploadFile.mockReset().mockResolvedValue(undefined);
    accessApiMock.fetchFileAccess.mockReset();
    proposeMocks.ensureKnowledgeSuggestionWorkspace.mockReset().mockResolvedValue({
      branch: 'suggestions/reader/knowledge',
      workspaceId: 'suggestions%2Freader%2Fknowledge',
      kbDirName: 'knowledge-base',
      existingCr: null,
    });
    proposeMocks.ensureKnowledgeChangeRequest.mockReset().mockResolvedValue({
      number: 12,
      title: 'Changes from Rae Reader. Knowledge',
      branch: 'suggestions/reader/knowledge',
      base: 'target-company-state',
      state: 'open',
      createdAt: '2026-08-06T00:00:00.000Z',
      touchedNodePaths: [],
      author: { login: 'user-x' },
      review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
      url: '',
    });
  });

  async function mountProtected() {
    const { result } = renderHook(() => useWorkspaceState(), { wrapper });
    await waitFor(() => expect(result.current.workspaceId).toBe('target-company-state'));
    return result;
  }

  it('routes an upload into a no-write folder to the suggestions branch', async () => {
    accessApiMock.fetchFileAccess.mockResolvedValue({
      canWrite: false,
      eligible: { roles: [], users: [] },
      owners: { roles: [], users: [] },
    });
    const result = await mountProtected();
    const onStale = vi.fn();
    window.addEventListener(PR_STALE_EVENT, onStale);
    const onAnnounce = vi.fn();
    window.addEventListener(SUGGESTIONS_OPTIMISTIC_EVENT, onAnnounce);
    try {
      const file = new File(['hello'], 'note.md', { type: 'text/markdown' });
      await act(async () => {
        await result.current.dispatchUpload(
          { kind: 'files', files: [file] },
          'knowledge-base/KnowledgeBase/Ops',
        );
      });

      // The ACL was asked about the TARGET folder, repo-relative.
      expect(accessApiMock.fetchFileAccess).toHaveBeenCalledWith(
        'target-company-state',
        'KnowledgeBase/Ops',
      );
      // The bytes went to the SUGGESTIONS workspace, same relative path.
      expect(apiMocks.uploadFile).toHaveBeenCalledWith(
        'suggestions%2Freader%2Fknowledge',
        'knowledge-base/KnowledgeBase/Ops/note.md',
        file,
        { defer: false },
      );
      // The change request exists, listeners were told, and the user was
      // told where the files went — silence would read as a failed upload.
      expect(proposeMocks.ensureKnowledgeChangeRequest).toHaveBeenCalled();
      expect(onStale).toHaveBeenCalled();
      // The rows are announced OPTIMISTICALLY, with the uploaded paths — the
      // server's touched-path diff may trail the commit worker for seconds.
      expect(onAnnounce).toHaveBeenCalledTimes(1);
      const detail = (onAnnounce.mock.calls[0][0] as CustomEvent).detail;
      expect(detail.number).toBe(12);
      expect(detail.touchedNodePaths).toContain('KnowledgeBase/Ops/note.md');
      expect(result.current.uploadNotice).toMatch(/became a suggestion/);
      // …and where to undo it. The notice used to say a thing happened and
      // nothing about reversing it, and the accent-coloured row it produces
      // said nothing either — which is how an accidental upload into a folder
      // you cannot write came to read as permanent.
      expect(result.current.uploadNotice).toMatch(
        /To take it back, right-click the file and choose Withdraw suggestion\.$/,
      );
      expect(result.current.uploadError).toBeNull();
    } finally {
      window.removeEventListener(PR_STALE_EVENT, onStale);
      window.removeEventListener(SUGGESTIONS_OPTIMISTIC_EVENT, onAnnounce);
    }
  });

  it('uploads normally when the caller may write the folder', async () => {
    accessApiMock.fetchFileAccess.mockResolvedValue({
      canWrite: true,
      eligible: { roles: [], users: [] },
      owners: { roles: [], users: [] },
    });
    const result = await mountProtected();
    const file = new File(['hello'], 'note.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current.dispatchUpload(
        { kind: 'files', files: [file] },
        'knowledge-base/KnowledgeBase/Ops',
      );
    });

    expect(apiMocks.uploadFile).toHaveBeenCalledWith(
      'target-company-state',
      'knowledge-base/KnowledgeBase/Ops/note.md',
      file,
      { defer: false },
    );
    expect(proposeMocks.ensureKnowledgeSuggestionWorkspace).not.toHaveBeenCalled();
    expect(result.current.uploadNotice).toBeNull();
  });

  it('never routes on a draft branch, even without write access', async () => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...PROTECTED_FIXTURE,
      workspace: { ...PROTECTED_FIXTURE.workspace, id: 'alice%2Fdraft' },
    });
    const { result } = renderHook(() => useWorkspaceState(), { wrapper });
    await waitFor(() => expect(result.current.workspaceId).toBe('alice%2Fdraft'));
    const file = new File(['hello'], 'note.md', { type: 'text/markdown' });
    await act(async () => {
      await result.current.dispatchUpload(
        { kind: 'files', files: [file] },
        'knowledge-base/KnowledgeBase/Ops',
      );
    });
    // Drafts are free-for-all: no ACL question, no suggestion detour.
    expect(accessApiMock.fetchFileAccess).not.toHaveBeenCalled();
    expect(apiMocks.uploadFile).toHaveBeenCalledWith(
      'alice%2Fdraft',
      'knowledge-base/KnowledgeBase/Ops/note.md',
      file,
      { defer: false },
    );
  });
});

/**
 * `?trace=files`: the bootstrap is one of the gates a blank file page waits on,
 * so its start and outcome are logged, and nothing else about it changes.
 */
describe('useWorkspaceState: bootstrap trace', () => {
  beforeEach(() => {
    sessionStorage.clear();
    apiMocks.getOrCreateWorkspace.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    localStorage.clear();
  });

  function traceCalls(info: ReturnType<typeof vi.spyOn>) {
    return info.mock.calls
      .filter((c: unknown[]) => c[0] === '[trace:files]')
      .map((c: unknown[]) => ({ event: c[1] as string, fields: c[2] as Record<string, unknown> }));
  }

  it('logs the start and the workspace a successful bootstrap produced', async () => {
    sessionStorage.setItem(FILE_TRACE_STORAGE_KEY, '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    apiMocks.getOrCreateWorkspace.mockResolvedValue(WORKSPACE_FIXTURE);

    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));

    const calls = traceCalls(info);
    expect(calls.map((c) => c.event)).toEqual(['bootstrap:start', 'bootstrap:ok']);
    expect(calls[0].fields).toMatchObject({ branch: null });
    expect(calls[1].fields).toMatchObject({ branch: null, workspaceId: 'ws-1', cancelled: false });
  });

  it('logs the status and message of a failed bootstrap, which still surfaces as bootstrapError', async () => {
    sessionStorage.setItem(FILE_TRACE_STORAGE_KEY, '1');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMocks.getOrCreateWorkspace.mockRejectedValue(new WorkspaceApiError(500));

    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(traceCalls(info).some((c) => c.event === 'bootstrap:failed')).toBe(true));

    expect(traceCalls(info).find((c) => c.event === 'bootstrap:failed')?.fields).toMatchObject({
      branch: null,
      status: 500,
      message: 'HTTP 500',
      cancelled: false,
    });
    expect(traceCalls(info).some((c) => c.event === 'bootstrap:ok')).toBe(false);
    await waitFor(() => expect(result.current.bootstrapError).toMatchObject({ status: 500 }));
    expect(result.current.workspaceId).toBeNull();
  });

  /**
   * A bootstrap failure used to be terminal for the session: the workspace
   * never came up, the file route waited on it forever, and only a full page
   * reload could try again. `retryBootstrap` re-runs the same request for the
   * same branch, which is what the file page's Retry is wired to.
   */
  it('retryBootstrap re-runs the request for the same branch and recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMocks.getOrCreateWorkspace.mockRejectedValue(new WorkspaceApiError(500));

    const { result } = renderHook(() => useWorkspaceState());
    act(() => { result.current.setPersistenceBranch('alice/draft'); });
    await waitFor(() =>
      expect(result.current.bootstrapError)
        .toMatchObject({ branch: 'alice/draft', status: 500, message: 'HTTP 500' }),
    );
    expect(result.current.workspaceId).toBeNull();

    // The outage clears; the reader presses Retry.
    apiMocks.getOrCreateWorkspace.mockResolvedValue({
      ...WORKSPACE_FIXTURE,
      workspace: { ...WORKSPACE_FIXTURE.workspace, id: 'alice%2Fdraft' },
    });
    act(() => { result.current.retryBootstrap(); });

    await waitFor(() => expect(result.current.workspaceId).toBe('alice%2Fdraft'));
    expect(result.current.bootstrapError).toBeNull();
    // Retried for the branch that was asked for, not the default.
    expect(apiMocks.getOrCreateWorkspace).toHaveBeenLastCalledWith('alice/draft');
  });

  it('logs nothing without the flag', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    apiMocks.getOrCreateWorkspace.mockResolvedValue(WORKSPACE_FIXTURE);

    const { result } = renderHook(() => useWorkspaceState());
    await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));

    expect(traceCalls(info)).toHaveLength(0);
  });
});
