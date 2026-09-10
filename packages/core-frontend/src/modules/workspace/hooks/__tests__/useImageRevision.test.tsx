import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue } from '../../../workflow/state/event-bus.context';
import { useImageRevision, isImagePath } from '../useImageRevision';

function makeFakeBus() {
  const handlers: Record<string, ((e: WorkflowEvent) => void)[]> = {};
  // The workspaces the hook has ASKED to be delivered. Without a watch the
  // real stream sends nothing for a workspace the session isn't focused on,
  // so "did it subscribe" and "will anything arrive" are separate facts and
  // the fake tracks both.
  const watched: string[] = [];
  const bus: EventBusContextValue & { emit(e: WorkflowEvent): void; watched: string[] } = {
    subscribe(kind, handler) {
      (handlers[kind] ??= []).push(handler as (e: WorkflowEvent) => void);
      return () => {
        handlers[kind] = (handlers[kind] ?? []).filter((h) => h !== handler);
      };
    },
    setFocus() {},
    watchWorkspace(workspaceId) {
      watched.push(workspaceId);
      return () => {
        const at = watched.indexOf(workspaceId);
        if (at >= 0) watched.splice(at, 1);
      };
    },
    watched,
    emit(e) {
      (handlers[e.kind] ?? []).forEach((h) => h(e));
    },
  };
  return bus;
}

function fileChanged(workspaceId: string, path: string): WorkflowEvent {
  return {
    kind: 'file-changed',
    workspaceId,
    branch: workspaceId,
    path,
    newSha: 'abc123',
  } as unknown as WorkflowEvent;
}

function treeChanged(workspaceId: string): WorkflowEvent {
  return { kind: 'fs-tree-changed', workspaceId, branch: workspaceId } as unknown as WorkflowEvent;
}

function renderRevision(bus: ReturnType<typeof makeFakeBus>, workspaceId: string | null) {
  return renderHook(({ ws }: { ws: string | null }) => useImageRevision(ws), {
    initialProps: { ws: workspaceId },
    wrapper: ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={bus}>{children}</EventBusContext.Provider>
    ),
  });
}

describe('useImageRevision', () => {
  it('starts at 0, so an image URL stays cacheable until something changes', () => {
    const { result } = renderRevision(makeFakeBus(), 'ws-1');
    expect(result.current).toBe(0);
  });

  it('bumps when an image in the workspace changes', () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-1', 'knowledge-base/assets/shot.png')));
    expect(result.current).toBe(1);
    act(() => bus.emit(fileChanged('ws-1', 'knowledge-base/assets/other.png')));
    expect(result.current).toBe(2);
  });

  // Local state holds the URL-encoded branch, the event the decoded one; a
  // branch with a `/` in its name must still match (see canonicalizeWorkspaceId).
  it('matches the event workspace to the subscribed one across encodings', () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, 'alice%2Fdraft');
    act(() => bus.emit(fileChanged('alice/draft', 'KB/a.png')));
    expect(result.current).toBe(1);
  });

  it("ignores another workspace's event", () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-2', 'KB/a.png')));
    expect(result.current).toBe(0);
  });

  it("ignores a text file: a document re-read is the workspace hook's job, and must not revalidate every screenshot", () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-1', 'KB/Node.md')));
    expect(result.current).toBe(0);
  });

  // The backend emits a tree change after EVERY write, text or image, and
  // names no file in it; the paths a bulk change touched arrive as per-file
  // events of their own. Counting the tree event would revalidate every
  // screenshot on each text save and bump twice on an image save.
  it('ignores a tree change: the per-file events already name every image that changed', () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, 'ws-1');
    act(() => bus.emit(treeChanged('ws-1')));
    expect(result.current).toBe(0);
    act(() => {
      bus.emit(fileChanged('ws-1', 'KB/assets/shot.png'));
      bus.emit(treeChanged('ws-1'));
    });
    expect(result.current).toBe(1);
  });

  // A count carried across a switch would be a number about a different tree.
  it('starts over on a workspace switch, in both directions', () => {
    const bus = makeFakeBus();
    const { result, rerender } = renderRevision(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-1', 'KB/a.png')));
    expect(result.current).toBe(1);
    rerender({ ws: 'ws-2' });
    expect(result.current).toBe(0);
    act(() => bus.emit(fileChanged('ws-2', 'KB/a.png')));
    expect(result.current).toBe(1);
    rerender({ ws: 'ws-1' });
    expect(result.current).toBe(0);
  });

  it('counts nothing without a workspace or a bus', () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, null);
    act(() => bus.emit(fileChanged('ws-1', 'KB/a.png')));
    expect(result.current).toBe(0);
    const bare = renderHook(() => useImageRevision('ws-1'));
    expect(bare.result.current).toBe(0);
  });

  // The stream delivers workspace-scoped events only for the workspaces the
  // session declared, and the focus binder declares one: the branch in the
  // address bar. A hook counting events for ANY other workspace — the skill
  // page renders the default branch's images from whatever branch you are
  // standing on — counts an event that never arrives unless it asks.
  it('watches the workspace it counts for, so events reach it off the focused branch', () => {
    const bus = makeFakeBus();
    const { unmount } = renderRevision(bus, 'main');
    expect(bus.watched).toEqual(['main']);
    unmount();
    expect(bus.watched).toEqual([]);
  });

  it('moves the watch with the workspace, leaving nothing behind', () => {
    const bus = makeFakeBus();
    const { rerender } = renderRevision(bus, 'ws-1');
    rerender({ ws: 'ws-2' });
    expect(bus.watched).toEqual(['ws-2']);
  });

  it('watches nothing without a workspace', () => {
    const bus = makeFakeBus();
    renderRevision(bus, null);
    expect(bus.watched).toEqual([]);
  });
});

describe('isImagePath', () => {
  it('recognises the extensions the raw route serves as pictures, case-insensitively', () => {
    expect(isImagePath('a/b.PNG')).toBe(true);
    expect(isImagePath('a/b.jpeg')).toBe(true);
    expect(isImagePath('a/b.svg')).toBe(true);
    expect(isImagePath('a/b.md')).toBe(false);
    expect(isImagePath('a/b.pdf')).toBe(false);
    expect(isImagePath('noext')).toBe(false);
  });
});
