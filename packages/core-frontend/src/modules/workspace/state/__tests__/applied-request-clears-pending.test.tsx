import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  PullRequestSummary,
  WorkflowEvent,
  WorkflowEventPayload,
} from '@bevel-software/platform-shared';

const api = vi.hoisted(() => ({
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
}));
vi.mock('../../../change-requests/services/change-requests.api', () => ({
  listOpenChangeRequests: api.listOpenChangeRequests,
  listMyChangeRequests: api.listMyChangeRequests,
  readFileOnBranch: vi.fn(),
}));

import { OpenChangeRequestsProvider } from '../open-change-requests';
import { useOpenChangeRequests } from '../../hooks/useOpenChangeRequests';
import { WorkspaceContext, type WorkspaceContextValue } from '../workspace.context';
import { ChangeRequestStaleBinder } from '../../../workflow/state/ChangeRequestStaleBinder';
import {
  EventBusContext,
  type EventBusContextValue,
} from '../../../workflow/state/event-bus.context';
import { PR_STALE_FALLBACK_MS } from '../../../../core/events';

/**
 * The reported bug: a business user uploads into a folder they cannot write
 * (a suggestion-routed change request), an admin applies it, and the request
 * keeps showing as pending.
 *
 * Reproduced cause: the merge WAS broadcast to every session
 * (`change-request-merged` is a global event), but nothing on the page
 * listened for it except the clicking tab's own apply hook, which ignores
 * requests it did not start. The tree's open-request provider refreshes only
 * on the in-page stale event, and only the clicker's tab ever dispatched that.
 * So the submitter's suggestion rows and every other viewer's markers stayed
 * until a manual reload, and a lost event stranded even the clicker's
 * sibling tabs, because the provider had no fallback read at all.
 *
 * Each test renders ONE viewer's tab: the bus binder mounted by the app shell,
 * the provider, and a fake bus the test drives as the server would.
 */

const KB = 'knowledge-base';
const SKILL = 'Plugins/x/SKILL.md';
const ACCESS = 'Plugins/x/access.md';

function pr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 7,
    title: 'Upload into Plugins/x',
    author: { login: 'user-bo' },
    appAuthor: { name: 'Bo Business' },
    branch: 'suggestions/bo/knowledge',
    base: 'main',
    state: 'open',
    createdAt: '2026-09-16T09:00:00.000Z',
    touchedNodePaths: [SKILL],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: '/change-requests/7',
    ...over,
  };
}

function fakeBus() {
  const handlers = new Map<string, Set<(e: WorkflowEvent) => void>>();
  const value: EventBusContextValue = {
    subscribe: (kind, handler) => {
      const set = handlers.get(kind) ?? new Set();
      set.add(handler as (e: WorkflowEvent) => void);
      handlers.set(kind, set);
      return () => set.delete(handler as (e: WorkflowEvent) => void);
    },
    setFocus: () => {},
    watchWorkspace: () => () => {},
  };
  const emit = (event: WorkflowEventPayload) => {
    for (const h of handlers.get(event.kind) ?? []) {
      h({ id: 1, ts: new Date().toISOString(), ...event } as WorkflowEvent);
    }
  };
  return { value, emit };
}

/** The server's answer before the apply (request open) and after (merged). */
function serverHasOpenRequest(open: boolean, opts: { submitter?: boolean } = {}) {
  api.listOpenChangeRequests.mockResolvedValue(open ? [pr()] : []);
  api.listMyChangeRequests.mockResolvedValue(
    opts.submitter ? [pr({ state: open ? 'open' : 'merged' })] : [],
  );
}

function renderTab(bus: EventBusContextValue | null) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <EventBusContext.Provider value={bus}>
      <WorkspaceContext.Provider value={{ kbDirName: KB } as unknown as WorkspaceContextValue}>
        <ChangeRequestStaleBinder />
        <OpenChangeRequestsProvider>{children}</OpenChangeRequestsProvider>
      </WorkspaceContext.Provider>
    </EventBusContext.Provider>
  );
  return renderHook(() => useOpenChangeRequests(), { wrapper });
}

const pending = (r: { current: ReturnType<typeof useOpenChangeRequests> }) =>
  r.current.paths.has(`${KB}/${SKILL}`);

beforeEach(() => {
  api.listOpenChangeRequests.mockReset();
  api.listMyChangeRequests.mockReset();
});

describe('an applied change request stops showing as pending — for every viewer', () => {
  it('the admin who applied: the marker clears on the merged event', async () => {
    serverHasOpenRequest(true);
    const bus = fakeBus();
    const { result } = renderTab(bus.value);
    await waitFor(() => expect(pending(result)).toBe(true));

    serverHasOpenRequest(false);
    act(() => bus.emit({ kind: 'change-request-merged', number: 7 }));
    await waitFor(() => expect(pending(result)).toBe(false));
    // The refetch bypasses the server's list cache.
    expect(api.listOpenChangeRequests).toHaveBeenLastCalledWith({ fresh: true });
  });

  it('the submitter (upload into a folder they cannot write): the suggestion rows clear too', async () => {
    serverHasOpenRequest(true, { submitter: true });
    const bus = fakeBus();
    const { result } = renderTab(bus.value);
    await waitFor(() => expect(result.current.minePaths.get(`${KB}/${SKILL}`)).toBe(7));

    // The upload also announced the request optimistically in this tab.
    act(() => {
      window.dispatchEvent(
        new CustomEvent('bevel:suggestions-optimistic', {
          detail: pr({ touchedNodePaths: [SKILL, 'Plugins/x/extra.md'] }),
        }),
      );
    });
    expect(result.current.mineNumbers.has(7)).toBe(true);
    // The merge happens later than the announcement, never in the same instant.
    await new Promise((r) => setTimeout(r, 5));

    serverHasOpenRequest(false, { submitter: true });
    act(() => bus.emit({ kind: 'change-request-merged', number: 7 }));
    await waitFor(() => expect(result.current.mineNumbers.has(7)).toBe(false));
    expect(result.current.minePaths.size).toBe(0);
    expect(pending(result)).toBe(false);
  });

  it('a viewer who can read the folder’s access.md but not its content: same basis before and after', async () => {
    serverHasOpenRequest(true);
    const bus = fakeBus();
    const { result } = renderTab(bus.value);
    await waitFor(() => expect(pending(result)).toBe(true));
    // The request never touched the one file this viewer can open, so no box
    // or tab marker is offered there before the apply…
    expect(result.current.forPath(`${KB}/${ACCESS}`)).toEqual([]);

    serverHasOpenRequest(false);
    act(() => bus.emit({ kind: 'change-request-merged', number: 7 }));
    await waitFor(() => expect(pending(result)).toBe(false));
    // …nor after it, and nothing is left behind for the hidden content.
    expect(result.current.forPath(`${KB}/${ACCESS}`)).toEqual([]);
    expect(result.current.forPath(`${KB}/${SKILL}`)).toEqual([]);
  });

  it('a reload shows the same', async () => {
    serverHasOpenRequest(false, { submitter: true });
    const { result } = renderTab(fakeBus().value);
    await waitFor(() => expect(api.listMyChangeRequests).toHaveBeenCalled());
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalled());
    expect(pending(result)).toBe(false);
    expect(result.current.minePaths.size).toBe(0);
  });

  it('a declined request and a failed apply refresh every viewer too, and so does a resync', async () => {
    serverHasOpenRequest(true);
    const bus = fakeBus();
    renderTab(bus.value);
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(1));

    act(() => bus.emit({ kind: 'change-request-rejected', number: 7 }));
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(2));
    act(() => bus.emit({ kind: 'change-request-apply-failed', number: 7 }));
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(3));
    act(() => bus.emit({ kind: 'resync', reason: 'buffer overflow' }));
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(4));
  });
});

/**
 * Arms a stand-in for the provider's fallback interval: the test fires it by
 * hand instead of faking the clock, because faked intervals would also stall
 * `waitFor`'s own polling. Every other interval runs for real.
 */
function captureFallback() {
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  const armed = new Map<number, { fn: () => void; ms: number }>();
  let next = 1_000_000;
  const set = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
    fn: () => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    if (ms !== PR_STALE_FALLBACK_MS) return realSet(fn, ms, ...rest);
    const id = next++;
    armed.set(id, { fn, ms });
    return id;
  }) as unknown as typeof setInterval);
  const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: number) => {
    if (armed.delete(id)) return;
    realClear(id);
  }) as unknown as typeof clearInterval);
  return {
    armedCount: () => armed.size,
    fire: () => act(() => armed.forEach((a) => a.fn())),
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

describe('a lost event: the page reconciles from the server within the fallback window', () => {
  let fallback: ReturnType<typeof captureFallback>;
  beforeEach(() => {
    fallback = captureFallback();
  });
  afterEach(() => fallback.restore());

  it('clears the marker on the next fallback read, with no event and no reload', async () => {
    serverHasOpenRequest(true);
    // A bus that never delivers the merge.
    const { result } = renderTab(fakeBus().value);
    await waitFor(() => expect(pending(result)).toBe(true));
    // Armed on the shared window, the same one the review dock polls on.
    expect(fallback.armedCount()).toBe(1);

    serverHasOpenRequest(false);
    fallback.fire();
    await waitFor(() => expect(pending(result)).toBe(false));
  });

  it('a hidden tab skips the fallback read and catches up the moment it is shown', async () => {
    serverHasOpenRequest(true);
    const { result } = renderTab(fakeBus().value);
    await waitFor(() => expect(pending(result)).toBe(true));
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);

    serverHasOpenRequest(false);
    fallback.fire();
    expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(1);

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(pending(result)).toBe(false));
    hidden.mockRestore();
  });

  it('stops reading once the page is gone', async () => {
    serverHasOpenRequest(true);
    const { unmount } = renderTab(fakeBus().value);
    await waitFor(() => expect(api.listOpenChangeRequests).toHaveBeenCalledTimes(1));
    unmount();
    expect(fallback.armedCount()).toBe(0);
  });
});
