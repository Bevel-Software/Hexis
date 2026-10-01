import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useContext, useEffect, useRef } from 'react';
import { EventBusProvider } from '../EventBusProvider';
import { EventBusContext, type EventBusContextValue } from '../event-bus.context';

/** The focus POSTs the provider made, newest last. */
function focusBodies(fetchMock: ReturnType<typeof vi.fn>): { workspaceId: string; alsoWatch: string[] }[] {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/focus'))
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

function Harness({ onReady }: { onReady: (bus: EventBusContextValue) => void }) {
  const bus = useContext(EventBusContext);
  const fired = useRef(false);
  useEffect(() => {
    if (!bus || fired.current) return;
    fired.current = true;
    onReady(bus);
  }, [bus, onReady]);
  return null;
}

/**
 * jsdom ships no EventSource, and the provider skips its connection effect
 * without one — which also skips the `open` handler that re-syncs focus after
 * a reconnect. This stub makes that path reachable and lets a test fire a
 * second `open` the way a dropped-and-restored stream does.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: Event) => void)[]>();
  constructor() {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(fn);
    this.listeners.set(type, bucket);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  close() {}
  fire(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new Event(type));
  }
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  window.sessionStorage.setItem('bevel-event-bus-session-id', 'sess-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

/**
 * The delivery list this tab declares to the server. One focus per session was
 * the model until a page needed content from a workspace other than the branch
 * in the address bar — the skill page renders the default branch's files from
 * wherever you are standing, and its images heard nothing about a teammate
 * replacing one.
 */
describe('EventBusProvider watchWorkspace', () => {
  it('carries a watched workspace alongside the focus', async () => {
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    await act(async () => {
      bus.watchWorkspace('main');
      bus.setFocus('alice%2Fdraft');
    });
    const last = focusBodies(fetchMock).at(-1);
    expect(last?.workspaceId).toBe('alice%2Fdraft');
    expect(last?.alsoWatch).toEqual(['main']);
  });

  it('re-posts when a watch is added after the focus is already set', async () => {
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    await act(async () => bus.setFocus('alice%2Fdraft'));
    expect(focusBodies(fetchMock).at(-1)?.alsoWatch).toEqual([]);
    await act(async () => bus.watchWorkspace('main'));
    expect(focusBodies(fetchMock).at(-1)?.alsoWatch).toEqual(['main']);
  });

  // Two components can want the same workspace; the first to unmount must not
  // cut the second's events.
  it('ref-counts, so a release only drops the last holder', async () => {
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    let releaseA!: () => void;
    let releaseB!: () => void;
    await act(async () => {
      releaseA = bus.watchWorkspace('main');
      releaseB = bus.watchWorkspace('main');
      bus.setFocus('alice%2Fdraft');
    });
    await act(async () => releaseA());
    expect(focusBodies(fetchMock).at(-1)?.alsoWatch).toEqual(['main']);
    await act(async () => releaseB());
    expect(focusBodies(fetchMock).at(-1)?.alsoWatch).toEqual([]);
  });

  // These POSTs are not independent: each REPLACES the session's whole
  // delivery list, so the last to reach the server wins. Fired concurrently,
  // two can be processed out of order, leaving the server on the older list
  // while this tab records the newer one as synced — after which nothing
  // retries and the workspace that lost its watch is silent for the life of
  // the tab.
  it('sends one focus POST at a time, so a slow one cannot overwrite a newer list', async () => {
    const releases: (() => void)[] = [];
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 })));
        }),
    );
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    await act(async () => bus.setFocus('alice%2Fdraft'));
    // The first POST is in flight and unanswered; a watch lands on top of it.
    await act(async () => bus.watchWorkspace('main'));
    expect(releases).toHaveLength(1);

    // Only once the first completes does the second go out, carrying the list
    // as it stands now rather than the snapshot it was queued with.
    await act(async () => releases[0]());
    expect(releases).toHaveLength(2);
    await act(async () => releases[1]());

    const bodies = focusBodies(fetchMock);
    expect(bodies.at(-1)?.alsoWatch).toEqual(['main']);
  });

  // Serialising the sends means a queued one can find the list already synced
  // and skip its request. That is the point, but it must only skip when the
  // SERVER still holds the list.
  it('skips a redundant send when the server already holds that list', async () => {
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    await act(async () => {
      bus.watchWorkspace('main');
      bus.setFocus('alice%2Fdraft');
    });
    const sentBefore = focusBodies(fetchMock).length;
    await act(async () => bus.setFocus('alice%2Fdraft'));
    expect(focusBodies(fetchMock)).toHaveLength(sentBefore);
  });

  // ...and a reconnect is exactly when it no longer does: the server has a NEW
  // session record with an empty delivery list, so a coalesced resync would
  // leave the tab believing in watches nobody is honouring.
  it('re-posts the whole list on every reconnect, coalescing notwithstanding', async () => {
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    await act(async () => {
      bus.watchWorkspace('main');
      bus.setFocus('alice%2Fdraft');
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    const stream = FakeEventSource.instances[0];

    // The stream's FIRST open, which is not a reconnect. Baseline is taken
    // after it so the assertion below is about the second one alone.
    await act(async () => stream.fire('open'));
    const sentBefore = focusBodies(fetchMock).length;

    // Dropped and restored. The list goes out again, in full.
    await act(async () => stream.fire('open'));
    const bodies = focusBodies(fetchMock);
    expect(bodies.length).toBe(sentBefore + 1);
    expect(bodies.at(-1)).toEqual({ workspaceId: 'alice%2Fdraft', alsoWatch: ['main'] });
  });

  it('does not list the focused workspace twice when it is also watched', async () => {
    let bus!: EventBusContextValue;
    render(
      <EventBusProvider>
        <Harness onReady={(b) => (bus = b)} />
      </EventBusProvider>,
    );
    await act(async () => {
      bus.watchWorkspace('main');
      bus.setFocus('main');
    });
    const last = focusBodies(fetchMock).at(-1);
    expect(last?.workspaceId).toBe('main');
    expect(last?.alsoWatch).toEqual([]);
  });
});
