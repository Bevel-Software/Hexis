import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue } from '../../../workflow/state/event-bus.context';
import { useImageRevision, isImagePath } from '../useImageRevision';

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

function renderRevision(bus: EventBusContextValue, workspaceId: string | null) {
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

  // A folder delete or a large sync arrives as one tree change naming no file.
  it('bumps on a tree change, which may have replaced any image', () => {
    const bus = makeFakeBus();
    const { result } = renderRevision(bus, 'ws-1');
    act(() => bus.emit(treeChanged('ws-1')));
    expect(result.current).toBe(1);
    act(() => bus.emit(treeChanged('ws-2')));
    expect(result.current).toBe(1);
  });

  // Events for a workspace only arrive while it is focused, so a count carried
  // across a switch would be a number about a different tree.
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
