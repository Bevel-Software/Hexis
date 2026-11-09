import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  HexisLocalVariableLoader,
  SignInRefusedError,
  bindLocalVariableResolver,
  fetchAllManuals,
  type HexisMcpConfig,
} from '../index.js';
/** The retry cadence after a failed proactive renewal, as renewal.ts sets it. */
import { RETRY_AFTER_FAILURE_MS as RETRY_MS } from '../renewal.js';

/**
 * A sign-in the workspace refused for good, reached the way a caller reaches
 * renewal: a REST read that meets a 401, and the proactive timer a successful
 * renewal arms from the grant's lifetime. The workspace is a fetch stub that
 * refuses one bearer and accepts any other, so fake timers drive the clock.
 */

const SENTENCE = 'The workspace refused this sign-in: restart hexis-mcp to sign in through your browser again.';


afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The workspace's REST surface: 401 for the refused bearer, an empty manual list otherwise. */
function stubWorkspace(refusedBearer: (bearer: string) => boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = String(new Headers(init?.headers).get('Authorization') ?? '').replace(/^Bearer /, '');
      if (refusedBearer(bearer)) return new Response('{"error":"Invalid token"}', { status: 401 });
      return new Response('{"manuals":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function oauthConfig(renew: NonNullable<HexisMcpConfig['renewConnectionKey']>): HexisMcpConfig & { ended: string[] } {
  const ended: string[] = [];
  return {
    baseUrl: 'https://x.example',
    connectionKey: 'tok-0',
    renewConnectionKey: renew,
    onSignInEnded: (s) => ended.push(s),
    ended,
  };
}

describe('a sign-in refused for good', () => {
  it('is never retried on the timer: one attempt, one stderr line, one notice to the server', async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubWorkspace((b) => b === 'tok-0');
    const renew = vi
      .fn<() => Promise<{ token: string; expiresInMs?: number }>>()
      .mockResolvedValueOnce({ token: 'tok-1', expiresInMs: 10_000 })
      .mockRejectedValue(new SignInRefusedError(SENTENCE));
    const config = oauthConfig(renew);

    // The 401 renews; the grant's lifetime arms the proactive timer.
    await fetchAllManuals(config);
    expect(config.connectionKey).toBe('tok-1');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);
    // An hour of the old once-a-minute retry cadence: nothing more is asked.
    await vi.advanceTimersByTimeAsync(60 * RETRY_MS);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(config.ended).toEqual([SENTENCE]);
    const lines = err.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes(SENTENCE))).toHaveLength(1);
    expect(lines.some((l) => l.includes('retrying'))).toBe(false);
  });

  it('refuses every later 401-triggered renewal without asking, and arms no timer', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubWorkspace(() => true);
    const renew = vi.fn(async (): Promise<{ token: string }> => {
      throw new SignInRefusedError(SENTENCE);
    });
    const config = oauthConfig(renew);

    await expect(fetchAllManuals(config)).rejects.toBeInstanceOf(SignInRefusedError);
    await expect(fetchAllManuals(config)).rejects.toThrow(SENTENCE);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(config.ended).toEqual([SENTENCE]);
  });

  it('a transient failure still retries: only the refusal for good is final', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubWorkspace((b) => b === 'tok-0');
    const renew = vi
      .fn<() => Promise<{ token: string; expiresInMs?: number }>>()
      .mockResolvedValueOnce({ token: 'tok-1', expiresInMs: 10_000 })
      .mockRejectedValueOnce(new Error('token endpoint returned HTTP 503'))
      .mockRejectedValueOnce(new SignInRefusedError(SENTENCE));
    const config = oauthConfig(renew);

    await fetchAllManuals(config);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(config.ended).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(config.ended).toEqual([SENTENCE]);
    await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it('fails a local tool variable lookup with the sentence instead of falling back to process.env', async () => {
    // The 401 renews, the renewal is refused for good, and the tool must not
    // run on process.env in place of the secrets it lost.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubWorkspace(() => true);
    const config = oauthConfig(async () => {
      throw new SignInRefusedError(SENTENCE);
    });
    const loader = new HexisLocalVariableLoader(
      bindLocalVariableResolver(config, new Map([['git', { slug: 'git', path: 'p' }]])),
    );
    await expect(loader.get('git_GITHUB_TOKEN')).rejects.toThrow(SENTENCE);
  });
});
