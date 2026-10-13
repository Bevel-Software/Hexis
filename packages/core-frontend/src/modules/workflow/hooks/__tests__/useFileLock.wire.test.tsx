import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { FileLock } from '@bevel-software/platform-shared';
// Nothing of the lock service is mocked here: these tests are about the
// request a release becomes on the wire, so the hook is driven through
// workflow's entry point, as other modules use it, down to `fetch`.
import { useFileLock } from '../..';
import { setToken } from '../../../../lib/api';

const ME = 'u-juan';
const PATH = 'kb/Knowledge/Foo.md';

const fetchMock = vi.fn();

function answer(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function heldByMe(): FileLock {
  const now = Date.now();
  return {
    branch: 'main',
    path: PATH,
    holderUserId: ME,
    holderName: 'Juan',
    acquiredAt: new Date(now).toISOString(),
    lastHeartbeatAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  };
}

/** The calls `fetch` saw with `method`, as `[url, init]`. */
function requests(method: string): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => (init?.method ?? 'GET') === method)
    .map(([url, init]) => [url, init ?? {}]);
}

function mount() {
  const persistToDisk = vi.fn(async () => {});
  const hook = renderHook(() =>
    useFileLock({
      workspaceId: 'ws',
      branch: 'main',
      path: PATH,
      currentUserId: ME,
      readPendingContent: () => 'typed since the last autosave',
      persistToDisk,
    }),
  );
  return { ...hook, persistToDisk };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
  setToken('t0k3n');
  // The server as far as these tests need it: the page is free, an acquire
  // succeeds, a release answers that the commit is queued.
  fetchMock.mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => {
    switch (init?.method ?? 'GET') {
      case 'POST':
        return answer({ acquired: true, lock: heldByMe() });
      case 'DELETE':
        return answer({ queued: true });
      default:
        return answer({ lock: null });
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useFileLock — the release on the wire', () => {
  // A tab closing or reloading sends its release on `pagehide`; only a
  // keep-alive request outlives the page, and it must still carry the
  // bearer header (which `sendBeacon` cannot).
  it('a closing tab sends one keep-alive release with the bearer header, and saves nothing first', async () => {
    const { result, persistToDisk } = mount();
    await act(async () => { await result.current.acquire(); });
    expect(result.current.holdingLock).toBe(true);

    await act(async () => { window.dispatchEvent(new Event('pagehide')); });

    const releases = requests('DELETE');
    expect(releases).toHaveLength(1);
    const [url, init] = releases[0]!;
    expect(url).toBe('/api/workspace/ws/workflow/locks');
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer t0k3n');
    expect(JSON.parse(String(init.body))).toEqual({ branch: 'main', path: PATH });
    expect(persistToDisk).not.toHaveBeenCalled();
    expect(result.current.holdingLock).toBe(false);
  });

  it('Done sends an ordinary release, and the server\'s queued answer is all it waits for', async () => {
    const { result, persistToDisk } = mount();
    await act(async () => { await result.current.acquire(); });

    await act(async () => {
      await expect(result.current.saveAndRelease()).resolves.toBeUndefined();
    });

    expect(persistToDisk).toHaveBeenCalledTimes(1);
    const releases = requests('DELETE');
    expect(releases).toHaveLength(1);
    const [, init] = releases[0]!;
    expect(init.keepalive).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({ branch: 'main', path: PATH });
    expect(result.current.holdingLock).toBe(false);
  });
});
