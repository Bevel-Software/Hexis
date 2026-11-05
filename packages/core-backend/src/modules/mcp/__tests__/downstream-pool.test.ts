import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DOWNSTREAM_IDLE_TTL_MS,
  DEFAULT_DOWNSTREAM_MAX_ENTRIES,
  DownstreamPool,
} from '../downstream-pool.js';

/**
 * The downstream pool's own contract, isolated from MCP: single-flight
 * creation, failures never cached, idle eviction and the size cap — each of
 * which must CLOSE what it drops — invalidation that reaches a creation still
 * in flight, and leases that keep a connection in use from being closed.
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
  /** One completed use: acquire, release at once, return the value. */
  const use = async (key: string, create: () => Promise<string>) => {
    const lease = await pool.acquire(key, create);
    lease.release();
    return lease.value;
  };
  return { pool, use, disposed, advance: (ms: number) => (now += ms) };
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
    const { use } = makePool();
    const gate = deferred<string>();
    const create = vi.fn(() => gate.promise);
    const waiters = [use('k', create), use('k', create), use('k', create)];
    gate.resolve('conn-1');
    expect(await Promise.all(waiters)).toEqual(['conn-1', 'conn-1', 'conn-1']);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reuses a pooled value until it is evicted', async () => {
    const { pool, use } = makePool();
    const create = vi.fn(async () => 'conn');
    await use('k', create);
    await use('k', create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(pool.size()).toBe(1);
  });

  it('keys are independent: (user, server) pairs never share a value', async () => {
    const { use } = makePool();
    expect(await use('user-A/notion', async () => 'a')).toBe('a');
    expect(await use('user-B/notion', async () => 'b')).toBe('b');
  });

  it('a failed creation is not cached: every waiter sees it, the next acquire retries', async () => {
    const { pool, use } = makePool();
    const gate = deferred<string>();
    const failing = vi.fn(() => gate.promise);
    const waiters = [use('k', failing), use('k', failing)];
    gate.reject(new Error('dial failed'));
    for (const w of waiters) await expect(w).rejects.toThrow('dial failed');
    expect(pool.size()).toBe(0);

    const create = vi.fn(async () => 'conn');
    expect(await use('k', create)).toBe('conn');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('idle eviction closes an entry unused past the TTL; the next acquire re-creates it', async () => {
    const { use, disposed, advance } = makePool({ idleTtlMs: 1000 });
    let n = 0;
    const create = vi.fn(async () => `conn-${++n}`);
    await use('k', create);
    advance(1001);
    expect(await use('k', create)).toBe('conn-2');
    await flush();
    expect(disposed).toEqual(['conn-1']);
  });

  it('use keeps an entry alive: idleness is measured from the LAST use', async () => {
    const { use, disposed, advance } = makePool({ idleTtlMs: 1000 });
    const create = vi.fn(async () => 'conn');
    await use('k', create);
    advance(800);
    await use('k', create);
    advance(800); // 1600 since creation, 800 since last use
    await use('k', create);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);
    expect(disposed).toEqual([]);
  });

  it('the size cap evicts (and closes) the least-recently-used entry', async () => {
    const { pool, use, disposed, advance } = makePool({ maxEntries: 2 });
    await use('a', async () => 'A');
    advance(1);
    await use('b', async () => 'B');
    advance(1);
    await use('a', async () => 'A-again'); // touch a → b is now the oldest
    advance(1);
    await use('c', async () => 'C');
    await flush();
    expect(disposed).toEqual(['B']);
    expect(pool.size()).toBe(2);
  });

  it('evictWhere closes matching entries and leaves the rest', async () => {
    const { pool, use, disposed } = makePool();
    await use('user-A\u0000x', async () => 'ax');
    await use('user-A\u0000y', async () => 'ay');
    await use('user-B\u0000x', async () => 'bx');
    pool.evictWhere((key) => key.startsWith('user-A\u0000'));
    await flush();
    expect(disposed.sort()).toEqual(['ax', 'ay']);
    expect(pool.size()).toBe(1);
  });

  it('an invalidation that lands mid-creation closes the stale result and builds a fresh one', async () => {
    const { pool, use, disposed } = makePool();
    const gate = deferred<string>();
    const create = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => gate.promise)
      .mockImplementationOnce(async () => 'fresh');
    const first = use('k', create);
    const joiner = use('k', create);
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
    (await pool.acquire('user\u0000manual\u0000fp', async () => 'old')).release();
    now = 100;
    const lease = await pool.acquire('user\u0000manual\u0000fp', async () => 'new');
    expect(lease.value).toBe('new');
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user=user manual=manual'), expect.any(Error));
  });

  describe('leases', () => {
    it('an entry in use outlives the idle TTL; idleness restarts when the use ends', async () => {
      const { pool, use, disposed, advance } = makePool({ idleTtlMs: 1000 });
      const lease = await pool.acquire('k', async () => 'conn');
      advance(5000); // a long call, well past the TTL
      await use('other', async () => 'other'); // sweeps
      await flush();
      expect(disposed).toEqual([]);

      lease.release();
      advance(999);
      await use('other', async () => 'other');
      await flush();
      expect(disposed).toEqual([]);

      advance(2);
      await use('other', async () => 'other');
      await flush();
      expect(disposed).toEqual(['conn']);
    });

    it('the size cap never evicts an entry in use: the idle LRU goes instead', async () => {
      const { pool, use, disposed, advance } = makePool({ maxEntries: 2 });
      const held = await pool.acquire('a', async () => 'A'); // oldest, but in use
      advance(1);
      await use('b', async () => 'B');
      advance(1);
      await use('c', async () => 'C');
      await flush();
      expect(disposed).toEqual(['B']);
      expect(held.value).toBe('A');
      held.release();
    });

    it('when every entry is in use, the cap is exceeded rather than closing a live call', async () => {
      const { pool, disposed } = makePool({ maxEntries: 1 });
      const a = await pool.acquire('a', async () => 'A');
      const b = await pool.acquire('b', async () => 'B');
      await flush();
      expect(disposed).toEqual([]);
      expect(pool.size()).toBe(2);
      a.release();
      b.release();
    });

    it('an invalidated entry in use leaves the pool at once but is closed only on its last release', async () => {
      const { pool, disposed } = makePool();
      const create = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(async () => 'old')
        .mockImplementationOnce(async () => 'new');
      const first = await pool.acquire('k', create);
      const second = await pool.acquire('k', create);
      pool.evictWhere(() => true);
      await flush();
      expect(disposed).toEqual([]);

      // New callers get a connection built from the current state.
      const fresh = await pool.acquire('k', create);
      expect(fresh.value).toBe('new');

      first.release();
      first.release(); // idempotent: does not count as the second lease ending
      await flush();
      expect(disposed).toEqual([]);
      second.release();
      await flush();
      expect(disposed).toEqual(['old']);
      fresh.release();
    });
  });
});

describe('cap after an all-leased overflow', () => {
  it('re-applies the cap when a lease ends, instead of waiting for the next acquire', async () => {
    const { pool, disposed } = makePool({ maxEntries: 2 });
    const a = await pool.acquire('a', async () => 'A');
    const b = await pool.acquire('b', async () => 'B');
    // Every entry is leased, so this insert cannot evict: the pool overflows.
    const c = await pool.acquire('c', async () => 'C');
    expect(pool.size()).toBe(3);
    expect(disposed).toEqual([]);

    // Ending A's lease makes it the only idle entry — and the cap applies now,
    // with no acquire in sight. A is the least recently used idle entry.
    a.release();
    await flush();
    expect(disposed).toEqual(['A']);
    expect(pool.size()).toBe(2);

    // Back within the cap: further releases evict nothing.
    b.release();
    c.release();
    await flush();
    expect(disposed).toEqual(['A']);
    expect(pool.size()).toBe(2);
  });
});
