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
});
