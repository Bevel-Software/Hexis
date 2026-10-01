import { describe, expect, it } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { DownstreamRefreshGuard, isDownstreamTokenRejection } from '../downstream-token-refresh.js';

describe('isDownstreamTokenRejection', () => {
  it('reads a failed call: the SDK error carries the HTTP status', () => {
    expect(isDownstreamTokenRejection(new StreamableHTTPError(401, 'Error POSTing to endpoint: '))).toBe(true);
  });

  it('reads a failed registration: @utcp/mcp flattens it to prose with only the body left', () => {
    expect(
      isDownstreamTokenRejection(
        new Error(`Server 'srv': Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}`),
      ),
    ).toBe(true);
    expect(isDownstreamTokenRejection('HTTP 401 Unauthorized')).toBe(true);
  });

  it('follows the cause chain', () => {
    expect(isDownstreamTokenRejection(new Error('tool failed', { cause: { status: 401 } }))).toBe(true);
  });

  it('is not fooled by anything that is not a token rejection', () => {
    // 403: the token is fine, it just is not permitted — a refresh changes nothing.
    expect(isDownstreamTokenRejection(new StreamableHTTPError(403, 'Forbidden'))).toBe(false);
    // Session loss, a JSON-RPC code, an ordinary tool failure.
    expect(isDownstreamTokenRejection(new StreamableHTTPError(404, '{"code":-32001,"message":"Session not found"}'))).toBe(false);
    expect(isDownstreamTokenRejection(new McpError(ErrorCode.RequestTimeout, 'Request timed out'))).toBe(false);
    expect(isDownstreamTokenRejection(new Error('kaboom'))).toBe(false);
    // Digits inside a URL are not a status.
    expect(isDownstreamTokenRejection(new Error('connect ECONNREFUSED https://api.example.com/v1/401/x'))).toBe(false);
  });

  it('a stated non-401 status outranks its own prose', () => {
    // Providers do answer 403 with an OAuth error body. The status is the
    // verdict — refreshing would swap a valid token for another equally
    // unpermitted one, once a minute, forever.
    expect(isDownstreamTokenRejection(new StreamableHTTPError(403, '{"error":"invalid_token"}'))).toBe(false);
    expect(isDownstreamTokenRejection({ status: 403, message: 'Unauthorized' })).toBe(false);
    expect(isDownstreamTokenRejection({ response: { status: 500 }, message: 'invalid_token' })).toBe(false);
    // …and a 403 shell does not let its own body be re-read one link up.
    expect(
      isDownstreamTokenRejection(new Error('call failed', { cause: { status: 403, message: 'invalid_token' } })),
    ).toBe(false);
    // A status is still only a number in the HTTP range: `code` as a syscall
    // name or a JSON-RPC code leaves the status unknown, so the message decides.
    expect(isDownstreamTokenRejection({ code: 'ECONNRESET', message: 'invalid_token' })).toBe(true);
    expect(isDownstreamTokenRejection({ code: -32000, message: 'invalid_token' })).toBe(true);
  });

  it('reads "unauthorized" as a word, not as the start of some other OAuth error', () => {
    // `unauthorized_client` is about the client registration; a refreshed
    // token changes nothing about it, so it must not cost a refresh (or, for
    // a grant with no refresh token, the sign-in).
    expect(
      isDownstreamTokenRejection(new Error(`Server 'srv': Streamable HTTP error: Error POSTing to endpoint: {"error":"unauthorized_client"}`)),
    ).toBe(false);
    expect(isDownstreamTokenRejection(new Error('Error POSTing to endpoint: {"error":"unauthorized"}'))).toBe(true);
  });
});

describe('DownstreamRefreshGuard — at most once per (user, manual) per minute', () => {
  it('refuses a second refresh inside the window and allows one after it', async () => {
    let now = 0;
    const guard = new DownstreamRefreshGuard<string>(60_000, () => now);
    let runs = 0;
    const refresh = async () => `run-${++runs}`;

    await expect(guard.run('u\0notion', refresh)).resolves.toBe('run-1');
    now += 59_999;
    expect(guard.run('u\0notion', refresh)).toBeUndefined();
    // Another (user, manual) pair has a window of its own.
    await expect(guard.run('u\0linear', refresh)).resolves.toBe('run-2');
    now += 1;
    await expect(guard.run('u\0notion', refresh)).resolves.toBe('run-3');
    expect(runs).toBe(3);
  });

  it('a rejection that arrives while the refresh runs shares its outcome instead of being refused', async () => {
    const guard = new DownstreamRefreshGuard<string>(60_000, () => 0);
    let release!: (v: string) => void;
    let runs = 0;
    const refresh = () => {
      runs += 1;
      return new Promise<string>((r) => (release = r));
    };
    const first = guard.run('k', refresh);
    const second = guard.run('k', refresh);
    expect(second).toBeDefined();
    release('refreshed');
    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);
    expect(runs).toBe(1);
    // Settled, still inside the window: no more.
    expect(guard.run('k', refresh)).toBeUndefined();
  });

  it('a refresh that never settles does not pin its key past the window', async () => {
    let now = 0;
    const guard = new DownstreamRefreshGuard<string>(60_000, () => now);
    let runs = 0;
    // A token request with no timeout, hanging forever.
    const hang = () => {
      runs += 1;
      return new Promise<string>(() => {});
    };
    expect(guard.run('k', hang)).toBeDefined();
    now += 59_999;
    expect(guard.run('k', hang)).toBeDefined(); // still in flight — shared, not re-run
    expect(runs).toBe(1);
    now += 1;
    // The window is over. The hung attempt is forgotten rather than holding
    // this key — and this map entry — for the life of the process.
    await expect(guard.run('k', async () => 'recovered')).resolves.toBe('recovered');
    expect(runs).toBe(1);
  });

  it('a clock that steps backward does not stretch the window by the step', async () => {
    let now = 1_000_000;
    const guard = new DownstreamRefreshGuard<string>(60_000, () => now);
    let runs = 0;
    const refresh = async () => `run-${++runs}`;
    await expect(guard.run('k', refresh)).resolves.toBe('run-1');

    // An NTP step of ten minutes into the past. Measured from the old stamp
    // this window would now hold for eleven minutes, not one.
    now -= 600_000;
    await expect(guard.run('k', refresh)).resolves.toBe('run-2');
    // …and from there the usual minute applies.
    now += 59_999;
    expect(guard.run('k', refresh)).toBeUndefined();
    now += 1;
    await expect(guard.run('k', refresh)).resolves.toBe('run-3');
  });

  it('clearWhere forgets the windows it selects, by key and by outcome', async () => {
    const guard = new DownstreamRefreshGuard<string>(60_000, () => 0);
    await guard.run('u1\0notion', async () => 'transient');
    await guard.run('u1\0linear', async () => 'refreshed');
    await guard.run('u2\0notion', async () => 'transient');

    guard.clearWhere((key, outcome) => key.startsWith('u1\0') && outcome !== 'refreshed');

    // Forgotten: u1's failed window. Kept: u1's successful one, and u2 entirely.
    await expect(guard.run('u1\0notion', async () => 'again')).resolves.toBe('again');
    expect(guard.run('u1\0linear', async () => 'again')).toBeUndefined();
    expect(guard.run('u2\0notion', async () => 'again')).toBeUndefined();
  });

  it('a refresh still in flight is not cleared by the predicate the proxy uses', async () => {
    const guard = new DownstreamRefreshGuard<string>(60_000, () => 0);
    let runs = 0;
    let release!: (v: string) => void;
    const refresh = () => {
      runs += 1;
      return new Promise<string>((r) => (release = r));
    };
    const first = guard.run('u1\0notion', refresh);

    // Exactly what `forgetStaleRefreshWindows` passes. A refresh of our own is
    // itself a secrets mutation, and it notifies BEFORE it settles — so an
    // in-flight window (outcome still undefined) must survive this, or the
    // guard would be reset by the very refresh it issued and a provider that
    // keeps minting refused tokens would get one refresh per call.
    guard.clearWhere((key, outcome) => key.startsWith('u1\0') && outcome !== undefined && outcome !== 'refreshed');

    // Still the same attempt: shared, not re-run, and not refused either.
    const second = guard.run('u1\0notion', refresh);
    expect(second).toBeDefined();
    release('refreshed');
    await expect(Promise.all([first, second])).resolves.toEqual(['refreshed', 'refreshed']);
    expect(runs).toBe(1);
    // And once it HAS settled as 'refreshed', the window still stands.
    guard.clearWhere((key, outcome) => key.startsWith('u1\0') && outcome !== undefined && outcome !== 'refreshed');
    expect(guard.run('u1\0notion', refresh)).toBeUndefined();
    expect(runs).toBe(1);
  });
});
