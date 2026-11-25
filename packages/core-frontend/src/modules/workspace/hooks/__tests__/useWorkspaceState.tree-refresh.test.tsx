/**
 * When an open workspace asks the server for its file tree again.
 *
 * The tree request builds the whole tree on the server, for every open tab.
 * A change that cannot alter the tree (the event says `listingUnchanged`)
 * must not cost one, and a burst of changes must share its requests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { VersionControlEvent } from '@bevel-software/platform-shared';

const apiMocks = vi.hoisted(() => {
  class FakeWorkspaceApiError extends Error {
    status: number;
    constructor(status: number, message?: string) {
      super(message ?? `HTTP ${status}`);
      this.status = status;
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
vi.mock('../../../access/api', () => ({
  fetchFileAccess: vi.fn(),
  fetchFileAccessBatch: vi.fn(async () => ({ results: {} })),
}));

import { ConfirmProvider } from '../../../../shared/components';
import { EventBusContext, type EventBusContextValue } from '../../../version-control/state/event-bus.context';
import { useWorkspaceState } from '../useWorkspaceState';

const TREE = { name: '.', relativePath: '.', type: 'directory' as const, children: [] };
const WORKSPACE = { workspace: { id: 'ws-1', name: 'Workspace', absolutePath: '/tmp/ws-1', createdAt: '2026-04-20T00:00:00.000Z' }, fileTree: TREE };

function makeFakeBus() {
  const handlers: Record<string, ((e: VersionControlEvent) => void)[]> = {};
  const bus: EventBusContextValue & { emit(e: object): void } = {
    subscribe(kind, handler) {
      (handlers[kind] ??= []).push(handler as (e: VersionControlEvent) => void);
      return () => {
        handlers[kind] = (handlers[kind] ?? []).filter((h) => h !== handler);
      };
    },
    setFocus() {},
    watchWorkspace: () => () => {},
    emit(e) {
      const event = e as VersionControlEvent;
      (handlers[event.kind] ?? []).forEach((h) => h(event));
    },
  };
  return bus;
}

const saved = (path: string, more: object = {}) => ({ kind: 'file-changed', workspaceId: 'ws-1', branch: 'ws-1', path, newSha: 'abc', byUserId: 'u', byUserName: 'U', ...more });
const tree = (more: object = {}) => ({ kind: 'fs-tree-changed', workspaceId: 'ws-1', branch: 'ws-1', ...more });

async function mount() {
  const bus = makeFakeBus();
  const { result, unmount } = renderHook(() => useWorkspaceState(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={bus}>
        <ConfirmProvider>{children}</ConfirmProvider>
      </EventBusContext.Provider>
    ),
  });
  await waitFor(() => expect(result.current.workspaceId).toBe('ws-1'));
  apiMocks.listFiles.mockClear();
  return { bus, result, unmount };
}

describe('the file tree is asked for again only when it may have changed', () => {
  beforeEach(() => {
    apiMocks.getOrCreateWorkspace.mockResolvedValue(WORKSPACE);
    apiMocks.listFiles.mockResolvedValue(TREE);
    apiMocks.readFile.mockImplementation(async (_ws: string, path: string) => `content:${path}`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('a save of an existing file, marked as leaving the listing alone, costs no tree request', async () => {
    const { bus } = await mount();
    await act(async () => {
      for (let i = 0; i < 100; i++) {
        bus.emit(saved('knowledge-base/ticket.md', { listingUnchanged: true }));
        bus.emit(tree({ listingUnchanged: true }));
      }
    });
    expect(apiMocks.listFiles).not.toHaveBeenCalled();
  });

  it('the open tab of the saved file still gets the new content', async () => {
    const { bus, result } = await mount();
    await act(async () => {
      await result.current.addTab('knowledge-base/ticket.md');
    });
    apiMocks.readFile.mockResolvedValue('new content');
    await act(async () => {
      bus.emit(saved('knowledge-base/ticket.md', { listingUnchanged: true }));
    });
    await waitFor(() => expect(result.current.openTabs.find((t) => t.path === 'knowledge-base/ticket.md')?.content).toBe('new content'));
    expect(apiMocks.listFiles).not.toHaveBeenCalled();
  });

  it('an unmarked change asks for the tree, as before', async () => {
    const { bus } = await mount();
    await act(async () => {
      bus.emit(saved('knowledge-base/new-page.md'));
    });
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(1));
  });

  it('a burst of unmarked changes within one request shares two: the one under way and one after it', async () => {
    const { bus } = await mount();
    const answers: (() => void)[] = [];
    apiMocks.listFiles.mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(TREE))));
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        bus.emit(saved(`knowledge-base/new-${i}.md`));
        bus.emit(tree());
      }
    });
    expect(apiMocks.listFiles).toHaveBeenCalledTimes(1);
    await act(async () => answers[0]!());
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(2));
    await act(async () => answers[1]!());
    // Nothing arrived during the second request, so there is no third.
    await act(async () => {});
    expect(apiMocks.listFiles).toHaveBeenCalledTimes(2);
  });

  it('a change that arrives after a burst is answered by a request of its own', async () => {
    const { bus } = await mount();
    await act(async () => {
      bus.emit(tree());
    });
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(1));
    await act(async () => {});
    await act(async () => {
      bus.emit(tree());
    });
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(2));
  });

  it('a burst that outlasts a request costs one request after another, never two at once', async () => {
    const { bus } = await mount();
    const answers: (() => void)[] = [];
    apiMocks.listFiles.mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(TREE))));
    for (let round = 0; round < 3; round++) {
      await act(async () => {
        for (let i = 0; i < 20; i++) bus.emit(tree());
      });
      // One request under way, whatever arrived; the rest wait for its end.
      expect(apiMocks.listFiles).toHaveBeenCalledTimes(round + 1);
      await act(async () => answers[round]!());
    }
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(4));
  });

  it('a request queued when the workspace closes is not made', async () => {
    const { bus, unmount } = await mount();
    const answers: (() => void)[] = [];
    apiMocks.listFiles.mockImplementation(() => new Promise((resolve) => answers.push(() => resolve(TREE))));
    await act(async () => {
      bus.emit(tree());
      bus.emit(tree());
    });
    expect(apiMocks.listFiles).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => answers[0]!());
    await act(async () => {});
    expect(apiMocks.listFiles).toHaveBeenCalledTimes(1);
  });

  it('a tree request that never answers stops holding the next one back after a minute', async () => {
    const { bus } = await mount();
    vi.useFakeTimers();
    try {
      apiMocks.listFiles.mockImplementation(() => new Promise(() => {}));
      await act(async () => {
        bus.emit(tree());
        bus.emit(tree());
      });
      expect(apiMocks.listFiles).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(apiMocks.listFiles).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      // The queued request is made, and a later change is answered too.
      expect(apiMocks.listFiles).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a tree request that fails does not stop the next one', async () => {
    const { bus } = await mount();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMocks.listFiles.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      bus.emit(tree());
    });
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(1));
    await act(async () => {});
    await act(async () => {
      bus.emit(tree());
    });
    await waitFor(() => expect(apiMocks.listFiles).toHaveBeenCalledTimes(2));
  });
});
