import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue } from '../../../workflow/state/event-bus.context';
import { useImageVersions, isImagePath } from '../useImageVersions';

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

function renderVersions(bus: EventBusContextValue, workspaceId: string | null) {
  return renderHook(() => useImageVersions(workspaceId), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={bus}>{children}</EventBusContext.Provider>
    ),
  });
}

describe('useImageVersions', () => {
  it('starts every image at 0, so the URL stays cacheable until something changes', () => {
    const { result } = renderVersions(makeFakeBus(), 'ws-1');
    expect(result.current('knowledge-base/assets/shot.png')).toBe(0);
  });

  it('bumps the version of an image a file-changed event names, and only that image', () => {
    const bus = makeFakeBus();
    const { result } = renderVersions(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-1', 'knowledge-base/assets/shot.png')));
    expect(result.current('knowledge-base/assets/shot.png')).toBe(1);
    expect(result.current('knowledge-base/assets/other.png')).toBe(0);
    act(() => bus.emit(fileChanged('ws-1', 'knowledge-base/assets/shot.png')));
    expect(result.current('knowledge-base/assets/shot.png')).toBe(2);
  });

  // Local state holds the URL-encoded branch, the event the decoded one; a
  // branch with a `/` in its name must still match (see canonicalizeWorkspaceId).
  it('matches the event workspace to the subscribed one across encodings', () => {
    const bus = makeFakeBus();
    const { result } = renderVersions(bus, 'alice%2Fdraft');
    act(() => bus.emit(fileChanged('alice/draft', 'KB/a.png')));
    expect(result.current('KB/a.png')).toBe(1);
  });

  it("ignores another workspace's event", () => {
    const bus = makeFakeBus();
    const { result } = renderVersions(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-2', 'KB/a.png')));
    expect(result.current('KB/a.png')).toBe(0);
  });

  it('ignores a non-image path: a document re-read is the workspace hook\'s job', () => {
    const bus = makeFakeBus();
    const { result } = renderVersions(bus, 'ws-1');
    act(() => bus.emit(fileChanged('ws-1', 'KB/Node.md')));
    expect(result.current('KB/Node.md')).toBe(0);
  });

  it('subscribes to nothing without a workspace or a bus', () => {
    const bus = makeFakeBus();
    const { result } = renderVersions(bus, null);
    act(() => bus.emit(fileChanged('ws-1', 'KB/a.png')));
    expect(result.current('KB/a.png')).toBe(0);
    const bare = renderHook(() => useImageVersions('ws-1'));
    expect(bare.result.current('KB/a.png')).toBe(0);
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
