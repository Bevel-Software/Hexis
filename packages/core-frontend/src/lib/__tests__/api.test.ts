import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { authFetch, API_UNREACHABLE_EVENT } from '../api';

/** Counts API_UNREACHABLE_EVENT dispatches for the span of one test. */
function watchUnreachable(): { seen: () => number; stop: () => void } {
  let count = 0;
  const onEvent = (): void => {
    count += 1;
  };
  window.addEventListener(API_UNREACHABLE_EVENT, onEvent);
  return {
    seen: () => count,
    stop: () => window.removeEventListener(API_UNREACHABLE_EVENT, onEvent),
  };
}

/** The rejection `fetch` produces when its signal is aborted. */
function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError') as unknown as Error;
}

describe('authFetch transport-failure signalling', () => {
  let watcher: ReturnType<typeof watchUnreachable>;

  beforeEach(() => {
    vi.restoreAllMocks();
    watcher = watchUnreachable();
  });

  afterEach(() => {
    watcher.stop();
  });

  it('does NOT signal unreachable when the caller aborted its own request', async () => {
    // The binary viewers abort in flight on unmount and on every file switch.
    // Treating that as backend downtime probes /api/health and can raise the
    // maintenance overlay during ordinary navigation.
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError());

    await expect(authFetch('/api/workspace/file')).rejects.toMatchObject({ name: 'AbortError' });
    expect(watcher.seen()).toBe(0);
  });

  it('does NOT signal unreachable when the abort carried a custom reason', async () => {
    // `abort(reason)` rejects the fetch with THAT value rather than an
    // AbortError, so the rejection alone cannot identify the abort.
    const controller = new AbortController();
    controller.abort('viewer closed');
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('viewer closed');

    await expect(
      authFetch('/api/workspace/file', { signal: controller.signal }),
    ).rejects.toBe('viewer closed');
    expect(watcher.seen()).toBe(0);
  });

  it('does NOT signal unreachable when the aborted signal rode on a Request', async () => {
    const controller = new AbortController();
    controller.abort('viewer closed');
    const request = { signal: controller.signal } as unknown as Request;
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce('viewer closed');

    await expect(authFetch(request)).rejects.toBe('viewer closed');
    expect(watcher.seen()).toBe(0);
  });

  it('still signals unreachable when init overrides a Request that was already aborted', async () => {
    // `fetch` uses init's signal and ignores the Request's when both are
    // given, so a stale aborted signal on the Request must not mask a real
    // transport failure on the live one.
    const stale = new AbortController();
    stale.abort();
    const live = new AbortController();
    const request = { signal: stale.signal } as unknown as Request;
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(authFetch(request, { signal: live.signal })).rejects.toThrow('Failed to fetch');
    expect(watcher.seen()).toBe(1);
  });

  it('still signals unreachable when the connection genuinely fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(authFetch('/api/workspace/file')).rejects.toThrow('Failed to fetch');
    expect(watcher.seen()).toBe(1);
  });

  it('still signals unreachable when the proxy answers for a dead upstream', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({ status: 503 } as Response);

    await authFetch('/api/workspace/file');
    expect(watcher.seen()).toBe(1);
  });
});

describe('authFetch application-level responses', () => {
  let watcher: ReturnType<typeof watchUnreachable>;
  beforeEach(() => {
    vi.restoreAllMocks();
    watcher = watchUnreachable();
  });
  afterEach(() => {
    watcher.stop();
  });

  it('a 503 the endpoint marked as its own does not signal; an unmarked 503 and a 502 still do', async () => {
    // `POST /api/sync` answers 503 when a branch could not be pulled and stamps
    // the response; a reverse proxy answering for a dead backend never does.
    const marked = (r: Response) => r.headers.get('x-hexis-sync') === 'result';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 503, headers: { 'x-hexis-sync': 'result' } }),
    );
    await authFetch('/api/sync', { method: 'POST' }, { isApplicationResponse: marked });
    expect(watcher.seen()).toBe(0);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>503</html>', { status: 503 }));
    await authFetch('/api/sync', { method: 'POST' }, { isApplicationResponse: marked });
    expect(watcher.seen()).toBe(1);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 502 }));
    await authFetch('/api/sync', { method: 'POST' }, { isApplicationResponse: marked });
    expect(watcher.seen()).toBe(2);
  });

  it('a network failure on such a call still signals', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(
      authFetch('/api/sync', { method: 'POST' }, { isApplicationResponse: () => true }),
    ).rejects.toThrow('Failed to fetch');
    expect(watcher.seen()).toBe(1);
  });
});
