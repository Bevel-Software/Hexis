import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmConnectionKey } from '../deployment.js';
import { closeRenewal } from '../renewal.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * The key check reads the deployment before every listing and every call, so a
 * refusal it leaves unread pins one connection per request. The property: every
 * answer that is not a 2xx has its body consumed (read to the end or
 * cancelled) by the time the read fails, whichever refusal it is.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A response whose body records whether anyone consumed it. */
function tracked(status: number, body: unknown, seen: { consumed: boolean }[]): Response {
  const record = { consumed: false };
  seen.push(record);
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        record.consumed = true;
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(bytes);
    },
    cancel() {
      record.consumed = true;
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
}

function stub(status: number, body: unknown = { error: 'no' }) {
  const seen: { consumed: boolean }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => tracked(status, body, seen)),
  );
  return seen;
}

const keyConfig = (): HexisMcpConfig => ({ baseUrl: 'https://x.example', connectionKey: 'bevel_k' }) as HexisMcpConfig;

/**
 * A refusal whose status arrived and whose body then stalls. Like a real
 * fetch, aborting the request's signal errors the body.
 */
function stalled(status: number, init?: RequestInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason));
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'application/json' } });
}

describe('a refusal whose body stalls past the confirmation deadline stays a refusal', () => {
  it('key mode: the 401 rejects the key', { timeout: 20_000 }, async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => stalled(401, init)),
    );
    await expect(confirmConnectionKey(keyConfig())).rejects.toThrow(/connection key was rejected/);
  });

  it('browser sign-in mode: the 401 after renewing stays the sign-in refusal', { timeout: 20_000 }, async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        calls += 1;
        return calls === 1 ? new Response('{}', { status: 401 }) : stalled(401, init);
      }),
    );
    const config = {
      ...keyConfig(),
      renewConnectionKey: async () => ({ token: 'fresh', expiresInMs: 3_600_000 }),
    } as HexisMcpConfig;
    try {
      await expect(confirmConnectionKey(config)).rejects.toThrow(/even after refreshing it/);
      expect(calls).toBe(2);
    } finally {
      closeRenewal(config);
    }
  });
});

describe('a renewal that rejects after the confirmation deadline', () => {
  it('stays observed: the confirmation gives up and no rejection goes unhandled', { timeout: 20_000 }, async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    // The first 401 arrives after the 3 s deadline, so the renewal starts on a
    // signal that has already aborted, and then fails.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_300));
        return new Response('{}', { status: 401 });
      }),
    );
    const config = {
      ...keyConfig(),
      renewConnectionKey: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('renewal failed');
      },
    } as HexisMcpConfig;
    try {
      await expect(confirmConnectionKey(config)).rejects.toThrow(/Gave up on the agent instructions/);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      closeRenewal(config);
    }
  });
});

describe('every refusal the key check meets is drained', () => {
  it.each([
    ['a revoked key (401)', 401, {}, /connection key was rejected/],
    ['a permission answer (403)', 403, { error: 'no' }, /denied access \(HTTP 403\)/],
    [
      'a connection that cannot be used (403 with its code)',
      403,
      { error: 'Not here.', code: 'not_available_to_connection' },
      /^Not here\.$/,
    ],
    ['a deployment error (502)', 502, {}, /HTTP 502/],
  ])('key mode: %s', async (_name, status, body, message) => {
    const seen = stub(status, body);
    await expect(confirmConnectionKey(keyConfig())).rejects.toThrow(message);
    expect(seen).toHaveLength(1);
    expect(seen.every((r) => r.consumed)).toBe(true);
  });

  it.each([
    ['refused even after renewing (401, 401)', 401, /even after refreshing it/],
    ['a permission answer (403)', 403, /denied access \(HTTP 403\)/],
  ])('browser sign-in mode: %s', async (_name, status, message) => {
    const seen = stub(status);
    const config = {
      ...keyConfig(),
      renewConnectionKey: async () => ({ token: 'fresh', expiresInMs: 3_600_000 }),
    } as HexisMcpConfig;
    try {
      await expect(confirmConnectionKey(config)).rejects.toThrow(message);
      expect(seen).toHaveLength(status === 401 ? 2 : 1);
      expect(seen.every((r) => r.consumed)).toBe(true);
    } finally {
      closeRenewal(config);
    }
  });
});
