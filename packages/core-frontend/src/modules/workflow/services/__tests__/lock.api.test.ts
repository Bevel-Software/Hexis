import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EDITING_ENDED_MESSAGE, LockApiError, releaseLock } from '../lock.api';
import { setToken } from '../../../../lib/api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});

function refusal(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('lock.api', () => {
  it('says a lapsed editing session in plain words, not the server sentence', async () => {
    fetchMock.mockResolvedValueOnce(
      refusal(400, {
        kind: 'lock-not-held',
        branch: 'main',
        path: 'kb/Knowledge/Foo.md',
        error: 'Cannot release lock on "kb/Knowledge/Foo.md": not held by you (or no longer exists).',
      }),
    );
    const err = await releaseLock('ws', 'main', 'kb/Knowledge/Foo.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockApiError);
    expect((err as LockApiError).message).toBe(EDITING_ENDED_MESSAGE);
    expect((err as LockApiError).message).not.toMatch(/lock/i);
    expect((err as LockApiError).status).toBe(400);
  });

  it('passes any other refusal through as the server wrote it', async () => {
    fetchMock.mockResolvedValueOnce(refusal(409, { error: '"Foo.md" is being edited by Dana. Try again in a moment.' }));
    const err = await releaseLock('ws', 'main', 'kb/Knowledge/Foo.md').catch((e: unknown) => e);
    expect((err as LockApiError).message).toBe('"Foo.md" is being edited by Dana. Try again in a moment.');
  });
});

describe('releaseLock keep-alive', () => {
  // A tab closing or reloading sends its release on `pagehide`; only a
  // keep-alive request outlives the page, and it must still carry the
  // bearer header (which `sendBeacon` cannot).
  it('sends a keep-alive DELETE with the bearer header when asked', async () => {
    setToken('t0k3n');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ change: null }), { status: 200 }));
    await releaseLock('ws', 'main', 'kb/Knowledge/Foo.md', undefined, { keepalive: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/workspace/ws/workflow/locks');
    expect(init.method).toBe('DELETE');
    expect(init.keepalive).toBe(true);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer t0k3n');
    expect(JSON.parse(String(init.body))).toEqual({ branch: 'main', path: 'kb/Knowledge/Foo.md' });
  });

  it('is an ordinary request otherwise', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ change: null }), { status: 200 }));
    await releaseLock('ws', 'main', 'kb/Knowledge/Foo.md');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBeUndefined();
  });
});
