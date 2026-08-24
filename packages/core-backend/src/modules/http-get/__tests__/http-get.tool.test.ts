import { describe, expect, it, afterEach, vi } from 'vitest';
import { governedHttpGet } from '../http-get.tool.js';

/** A Response whose body streams in chunks, so the cap is exercised on the stream. */
function streaming(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    }),
    init,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('http_get', () => {
  it('returns status and body for a public URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streaming(['{"status":"ok"}'], {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const r = await governedHttpGet('https://status.example.com/health');
    expect(r).toMatchObject({ status: 200, ok: true, body: '{"status":"ok"}', truncated: false });
    expect(r.contentType).toBe('application/json');
  });

  it('returns a non-2xx as a result rather than raising', async () => {
    // "Not up yet" is the answer a gate is waiting for; making it an error
    // would leave a chain unable to tell it from a broken tool.
    vi.stubGlobal('fetch', vi.fn(async () => streaming(['down'], { status: 503 })));
    const r = await governedHttpGet('https://status.example.com/health');
    expect(r.status).toBe(503);
    expect(r.ok).toBe(false);
  });

  it.each([
    ['http://localhost:3000/', 'loopback by name'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://10.0.0.5/internal', 'private range'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['file:///etc/passwd', 'a non-http scheme'],
    ['not a url', 'a malformed URL'],
  ])('refuses %s (%s) without reaching the network', async (url) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(governedHttpGet(url)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caps the body and says so', async () => {
    // A poller that can be made to read a stream forever is a denial of
    // service against whatever is waiting on the tick.
    vi.stubGlobal('fetch', vi.fn(async () => streaming(['x'.repeat(40_000), 'y'.repeat(40_000)])));
    const r = await governedHttpGet('https://big.example.com/');
    expect(r.truncated).toBe(true);
    expect(r.body.length).toBe(64 * 1024);
  });

  it('sends no caller-controlled headers', async () => {
    const fetchSpy = vi.fn(async () => streaming(['ok']));
    vi.stubGlobal('fetch', fetchSpy);
    await governedHttpGet('https://status.example.com/health');
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Accept: '*/*' });
  });

  it('reports the final URL after redirects', async () => {
    const res = streaming(['ok'], { status: 200 });
    Object.defineProperty(res, 'url', { value: 'https://status.example.com/health/v2' });
    vi.stubGlobal('fetch', vi.fn(async () => res));
    expect((await governedHttpGet('https://status.example.com/health')).url).toBe(
      'https://status.example.com/health/v2',
    );
  });
});
