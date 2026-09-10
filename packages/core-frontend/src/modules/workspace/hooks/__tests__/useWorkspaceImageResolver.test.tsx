import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue } from '../../../workflow/state/event-bus.context';
import { WorkspaceContext } from '../../state/workspace.context';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { useWorkspaceImageResolver } from '../useWorkspaceImageResolver';

function makeFakeBus() {
  const handlers: Record<string, ((e: WorkflowEvent) => void)[]> = {};
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

function imageChanged(workspaceId: string, path: string): WorkflowEvent {
  return {
    kind: 'file-changed',
    workspaceId,
    branch: workspaceId,
    path,
    newSha: 'abc123',
  } as unknown as WorkflowEvent;
}

function renderResolver(
  bus: ReturnType<typeof makeFakeBus>,
  workspaceId: string | null,
  basePath: string | null,
  kbDirName: string | null = 'knowledge-base',
) {
  return renderHook(() => useWorkspaceImageResolver(workspaceId, basePath), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <EventBusContext.Provider value={bus}>
        <WorkspaceContext.Provider value={makeWorkspaceFixture({ kbDirName })}>
          {children}
        </WorkspaceContext.Provider>
      </EventBusContext.Provider>
    ),
  });
}

/**
 * The one image resolver every markdown surface uses — the markdown renderer,
 * the review panel's diff and the skill page. It used to be three hand-rolled
 * copies of the same closure, which is how the two bugs below reached three
 * surfaces at once.
 */
describe('useWorkspaceImageResolver', () => {
  it('resolves a relative src against the file it sits in, on its own workspace', () => {
    const { result } = renderResolver(makeFakeBus(), 'ws-1', 'knowledge-base/Knowledge/Foo.md');
    expect(result.current('./assets/shot.png')).toEqual({
      path: 'knowledge-base/Knowledge/assets/shot.png',
      src: '/api/workspace/ws-1/file/raw?path=knowledge-base%2FKnowledge%2Fassets%2Fshot.png',
    });
  });

  // The junk-segment repair is for a citation LINK a model may have mangled.
  // Run on an image src it truncates a path the author wrote correctly, and
  // the reader gets a placeholder where the picture belongs.
  it('does not run the mangled-path repair on an image src', () => {
    const { result } = renderResolver(makeFakeBus(), 'ws-1', 'Skills/deploy/SKILL.md');
    expect(result.current('./assets/knowledge-base/shot.png')?.path).toBe(
      'Skills/deploy/assets/knowledge-base/shot.png',
    );
  });

  it('leaves an external src to the browser', () => {
    const { result } = renderResolver(makeFakeBus(), 'ws-1', 'knowledge-base/Foo.md');
    expect(result.current('https://example.com/x.png')).toBeNull();
  });

  it('resolves nothing without a workspace or a file to resolve against', () => {
    const bus = makeFakeBus();
    expect(renderResolver(bus, null, 'knowledge-base/Foo.md').result.current('./a.png')).toBeNull();
    expect(renderResolver(bus, 'ws-1', null).result.current('./a.png')).toBeNull();
  });

  // A replaced screenshot must reach an open tab: the URL carries the
  // revision, so a changed picture is a changed URL and the browser refetches.
  it('changes the URL when an image in that workspace is replaced', () => {
    const bus = makeFakeBus();
    const { result } = renderResolver(bus, 'ws-1', 'knowledge-base/Foo.md');
    const before = result.current('./shot.png')?.src;
    act(() => bus.emit(imageChanged('ws-1', 'knowledge-base/shot.png')));
    const after = result.current('./shot.png')?.src;
    expect(after).not.toBe(before);
    expect(after).toContain('&v=1');
  });

  // The skill page's case: it renders the DEFAULT branch's files while the
  // reader stands on their own suggestion branch. The session is focused
  // elsewhere, so unless the resolver asks for that workspace's events the
  // replaced screenshot never reaches it.
  it('asks for events from the workspace it serves, not the one in the address bar', () => {
    const bus = makeFakeBus();
    const { result } = renderResolver(bus, 'main', 'knowledge-base/Skills/deploy/SKILL.md');
    expect(bus.watched).toEqual(['main']);
    act(() => bus.emit(imageChanged('main', 'knowledge-base/Skills/deploy/assets/shot.png')));
    expect(result.current('./assets/shot.png')?.src).toContain('&v=1');
  });
});
