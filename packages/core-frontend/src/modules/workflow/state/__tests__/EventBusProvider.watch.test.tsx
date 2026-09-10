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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
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
