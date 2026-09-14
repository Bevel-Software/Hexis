import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOWNSTREAM_IDLE_TTL_MS,
  DEFAULT_DOWNSTREAM_MAX_ENTRIES,
  DownstreamPool,
} from '../downstream-pool.js';

/**
 * The downstream pool's own contract, isolated from MCP: single-flight
 * creation, failures never cached, idle eviction and the size cap — each of
 * which must CLOSE what it drops — and invalidation that reaches a creation
 * still in flight.
 */

/** Let fire-and-forget disposals run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePool(opts: { idleTtlMs?: number; maxEntries?: number } = {}) {
  let now = 0;
  const disposed: string[] = [];
  const pool = new DownstreamPool<string>({
    ...opts,
    now: () => now,
    dispose: async (value) => {
      disposed.push(value);
    },
  });
  return { pool, disposed, advance: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DownstreamPool', () => {
  it("defaults to the retired session store's numbers: 4 hours idle, 5000 entries", () => {
    expect(DEFAULT_DOWNSTREAM_IDLE_TTL_MS).toBe(4 * 60 * 60 * 1000);
    expect(DEFAULT_DOWNSTREAM_MAX_ENTRIES).toBe(5000);
  });

  it('single-flight: concurrent first acquires share ONE creation', async () => {
    const { pool } = makePool();
    const gate = deferred<string>();
    const create = vi.fn(() => gate.promise);
    const waiters = [pool.acquire('k', create), pool.acquire('k', create), pool.acquire('k', create)];
    gate.resolve('conn-1');
    expect(await Promise.all(waiters)).toEqual(['conn-1', 'conn-1', 'conn-1']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reuses a pooled value until it is evicted', async () => {
    const { pool } = makePool();
    const create = vi.fn(async () => 'conn');
    await pool.acquire('k', create);
    await pool.acquire('k', create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(1);
  });

  it('keys are independent: (user, server) pairs never share a value', async () => {
    const { pool } = makePool();
    expect(await pool.acquire('user-A/notion', async () => 'a')).toBe('a');
    expect(await pool.acquire('user-B/notion', async () => 'b')).toBe('b');
  });

  it('a failed creation is not cached: every waiter sees it, the next acquire retries', async () => {
    const { pool } = makePool();
    const gate = deferred<string>();
    const failing = vi.fn(() => gate.promise);
    const waiters = [pool.acquire('k', failing), pool.acquire('k', failing)];
    gate.reject(new Error('dial failed'));
    for (const w of waiters) await expect(w).rejects.toThrow('dial failed');
    expect(pool.size()).toBe(0);

    const create = vi.fn(async () => 'conn');
    expect(await pool.acquire('k', create)).toBe('conn');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('idle eviction closes an entry unused past the TTL; the next acquire re-creates it', async () => {
    const { pool, disposed, advance } = makePool({ idleTtlMs: 1000 });
    let n = 0;
    const create = vi.fn(async () => `conn-${++n}`);
    await pool.acquire('k', create);
    advance(1001);
    expect(await pool.acquire('k', create)).toBe('conn-2');
    await flush();
    expect(disposed).toEqual(['conn-1']);
  });

  it('use keeps an entry alive: idleness is measured from the LAST use', async () => {
    const { pool, disposed, advance } = makePool({ idleTtlMs: 1000 });
    const create = vi.fn(async () => 'conn');
    await pool.acquire('k', create);
    advance(800);
    await pool.acquire('k', create);
    advance(800); // 1600 since creation, 800 since last use
    await pool.acquire('k', create);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(disposed).toEqual([]);
  });

  it('the size cap evicts (and closes) the least-recently-used entry', async () => {
    const { pool, disposed, advance } = makePool({ maxEntries: 2 });
    await pool.acquire('a', async () => 'A');
    advance(1);
    await pool.acquire('b', async () => 'B');
    advance(1);
    await pool.acquire('a', async () => 'A-again'); // touch a → b is now the oldest
    advance(1);
    await pool.acquire('c', async () => 'C');
    await flush();
    expect(disposed).toEqual(['B']);
    expect(pool.size()).toBe(2);
  });

  it('evictWhere closes matching entries and leaves the rest', async () => {
    const { pool, disposed } = makePool();
    await pool.acquire('user-A\u0000x', async () => 'ax');
    await pool.acquire('user-A\u0000y', async () => 'ay');
    await pool.acquire('user-B\u0000x', async () => 'bx');
    pool.evictWhere((key) => key.startsWith('user-A\u0000'));
    await flush();
    expect(disposed.sort()).toEqual(['ax', 'ay']);
    expect(pool.size()).toBe(1);
  });

  it('an invalidation that lands mid-creation closes the stale result and builds a fresh one', async () => {
    const { pool, disposed } = makePool();
    const gate = deferred<string>();
    const create = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(async () => 'fresh');
    const first = pool.acquire('k', create);
    const joiner = pool.acquire('k', create);
    pool.evictWhere(() => true);
    gate.resolve('stale');
    expect(await first).toBe('fresh');
    expect(await joiner).toBe('fresh');
    await flush();
    expect(disposed).toEqual(['stale']);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('a dispose that throws is logged, never thrown into the request that swept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 0;
    const pool = new DownstreamPool<string>({
      idleTtlMs: 10,
      now: () => now,
      dispose: async () => {
        throw new Error('close failed');
      },
    });
    await pool.acquire('user\u0000manual\u0000fp', async () => 'old');
    now = 100;
    await expect(pool.acquire('user\u0000manual\u0000fp', async () => 'new')).resolves.toBe('new');
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user=user manual=manual'), expect.any(Error));
  });
});
