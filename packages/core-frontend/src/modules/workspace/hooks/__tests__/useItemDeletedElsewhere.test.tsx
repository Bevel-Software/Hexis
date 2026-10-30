import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkflowEvent } from '@bevel-software/platform-shared';
import { EventBusProvider } from '../../../workflow';
import { stubServerEventStream } from '../../../../__tests__/server-event-stream';
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

function mount(workspace?: Partial<WorkspaceContextValue>) {
  const value = makeWorkspaceFixture({ workspaceId: WS, ...workspace });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EventBusProvider>
      <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
    </EventBusProvider>
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
    const bus = stubServerEventStream();
    const { result, rerender } = mount();

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
    const bus = stubServerEventStream();
    // No marker at mount, so the open-time read stays out of it: only the
    // event's read can forget the delete marked after the page opened.
    const ownDeletes = new Set<string>();
    const isOwnDelete = vi.fn((path: string) => ownDeletes.has(path));
    const forgetOwnDelete = vi.fn((path: string) => { ownDeletes.delete(path); });
    readFile.mockResolvedValue('{}');
    const { result } = mount({ isOwnDelete, forgetOwnDelete });
    expect(readFile).not.toHaveBeenCalled();

    ownDeletes.add(TOOL_A);
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(forgetOwnDelete).toHaveBeenCalledWith(TOOL_A, expect.any(Number)));
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(ownDeletes.has(TOOL_A)).toBe(false);

    readFile.mockRejectedValue(new WorkspaceApiError(404));
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(result.current?.name).toBe('Sam Rivera'));
  });

  // Deleted by this session, restored, then OPENED again: no event has
  // re-read it yet, and someone else deletes it within the minute.
  it('forgets our own delete when the restored item is opened', async () => {
    const bus = stubServerEventStream();
    const ownDeletes = new Set([TOOL_A]);
    const isOwnDelete = vi.fn((path: string) => ownDeletes.has(path));
    const forgetOwnDelete = vi.fn((path: string) => { ownDeletes.delete(path); });
    readFile.mockResolvedValue('{}');
    const { result } = mount({ isOwnDelete, forgetOwnDelete });

    await waitFor(() => expect(forgetOwnDelete).toHaveBeenCalledWith(TOOL_A, expect.any(Number)));
    expect(result.current).toBeNull();

    readFile.mockRejectedValue(new WorkspaceApiError(404));
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(result.current?.name).toBe('Sam Rivera'));
  });

  // Our own delete answered while a read sent before it was still out: that
  // read found the file as it was before the delete, so the delete stays ours.
  it('keeps our own delete when the read that found the item was sent before it', async () => {
    const bus = stubServerEventStream();
    // The workspace's rule: a marker set at or after the read was sent stays.
    const ownDeletes = new Map<string, number>();
    const isOwnDelete = vi.fn((path: string) => ownDeletes.has(path));
    const forgetOwnDelete = vi.fn((path: string, readIssuedAt?: number) => {
      const at = ownDeletes.get(path);
      if (at !== undefined && (readIssuedAt === undefined || at < readIssuedAt)) ownDeletes.delete(path);
    });
    let answer!: () => void;
    readFile.mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve('{}'); }));
    mount({ isOwnDelete, forgetOwnDelete });

    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(answer).toBeDefined());
    await new Promise((r) => setTimeout(r, 2));
    ownDeletes.set(TOOL_A, Date.now());
    await act(async () => { answer(); });

    await waitFor(() => expect(forgetOwnDelete).toHaveBeenCalled());
    expect(ownDeletes.has(TOOL_A)).toBe(true);
  });

  // The workspace's record is for its own branch: the Library watches the
  // default branch while the session is on another.
  it('neither reads nor ends a delete of ours made on another branch', async () => {
    const bus = stubServerEventStream();
    const ownDeletes = new Set<string>([TOOL_A]);
    const isOwnDelete = vi.fn((path: string) => ownDeletes.has(path));
    const forgetOwnDelete = vi.fn((path: string) => { ownDeletes.delete(path); });
    readFile.mockResolvedValue('{}');
    const { result } = mount({ workspaceId: 'feature', isOwnDelete, forgetOwnDelete });
    expect(readFile).not.toHaveBeenCalled();

    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(forgetOwnDelete).not.toHaveBeenCalled();
    expect(ownDeletes.has(TOOL_A)).toBe(true);

    // Someone else deletes it on the watched branch: the notice shows.
    readFile.mockRejectedValue(new WorkspaceApiError(404));
    act(() => bus.emit(changed(TOOL_A)));
    await waitFor(() => expect(result.current?.name).toBe('Sam Rivera'));
    expect(isOwnDelete).not.toHaveBeenCalled();
  });

  it('reads nothing on open when no delete of ours covers the item', () => {
    stubServerEventStream();
    mount({ isOwnDelete: () => false });
    expect(readFile).not.toHaveBeenCalled();
  });
});
