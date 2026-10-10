import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusContext, type EventBusContextValue } from '../../../workflow/state/event-bus.context';
import { WorkspaceContext, type WorkspaceContextValue } from '../../state/workspace.context';
import { WorkspaceApiError } from '../../services/workspace.api';
import { makeWorkspaceFixture } from '../../__tests__/testFixtures';
import { useItemDeletedElsewhere } from '../useItemDeletedElsewhere';

const readFile = vi.hoisted(() => vi.fn());
vi.mock('../../services/workspace.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readFile,
}));

const WS = 'main';
const TOOL_A = 'kb/Tools/a.json';
const TOOL_B = 'kb/Tools/b.json';

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

const changed = (path: string): WorkflowEvent => ({
  id: 1,
  ts: '',
  kind: 'file-changed',
  workspaceId: WS,
  branch: WS,
  path,
  newSha: 'abc',
  byUserId: 'u2',
  byUserName: 'Sam Rivera',
});

function mount(bus: ReturnType<typeof makeFakeBus>, workspace?: Partial<WorkspaceContextValue>) {
  const value = makeWorkspaceFixture(workspace ?? {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EventBusContext.Provider value={bus}>
      <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
    </EventBusContext.Provider>
  );
  return renderHook(
    ({ path }: { path: string }) => useItemDeletedElsewhere({ workspaceId: WS, itemPath: path, keyFile: path }),
    { wrapper, initialProps: { path: TOOL_A } },
  );
}

describe('useItemDeletedElsewhere', () => {
  beforeEach(() => {
    readFile.mockReset();
  });

  // Its events went unwatched while another item was on screen: coming back
  // must not show a delete that a restore since then undid.
  it('starts over when the item is left and visited again', async () => {
    const bus = makeFakeBus();
    const { result, rerender } = mount(bus);

    readFile.mockRejectedValue(new WorkspaceApiError(404));
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(result.current?.name).toBe('Sam Rivera'));

    rerender({ path: TOOL_B });
    expect(result.current).toBeNull();
    // Restored while B was on screen: A's event reaches nobody watching A.
    readFile.mockResolvedValue('{}');
    rerender({ path: TOOL_A });

    expect(result.current).toBeNull();
  });

  // A path this session deleted, then restored, then someone else deleted
  // within the minute: the read that found it back ends "our own".
  it('tells the workspace the path is back, so a later delete is someone else\'s', async () => {
    const bus = makeFakeBus();
    const ownDeletes = new Set([TOOL_A]);
    const isOwnDelete = vi.fn((path: string) => ownDeletes.has(path));
    const forgetOwnDelete = vi.fn((path: string) => { ownDeletes.delete(path); });
    readFile.mockResolvedValue('{}');
    const { result } = mount(bus, { isOwnDelete, forgetOwnDelete });

    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(forgetOwnDelete).toHaveBeenCalledWith(TOOL_A));

    readFile.mockRejectedValue(new WorkspaceApiError(404));
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(result.current?.name).toBe('Sam Rivera'));
  });

  // Deleted by this session, restored, then OPENED again: no event has
  // re-read it yet, and someone else deletes it within the minute.
  it('forgets our own delete when the restored item is opened', async () => {
    const bus = makeFakeBus();
    const ownDeletes = new Set([TOOL_A]);
    const isOwnDelete = vi.fn((path: string) => ownDeletes.has(path));
    const forgetOwnDelete = vi.fn((path: string) => { ownDeletes.delete(path); });
    readFile.mockResolvedValue('{}');
    const { result } = mount(bus, { isOwnDelete, forgetOwnDelete });

    await waitFor(() => expect(forgetOwnDelete).toHaveBeenCalledWith(TOOL_A));
    expect(result.current).toBeNull();

    readFile.mockRejectedValue(new WorkspaceApiError(404));
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(result.current?.name).toBe('Sam Rivera'));
  });

  it('reads nothing on open when no delete of ours covers the item', () => {
    mount(makeFakeBus(), { isOwnDelete: () => false });
    expect(readFile).not.toHaveBeenCalled();
  });
});
