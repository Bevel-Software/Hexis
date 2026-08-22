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
