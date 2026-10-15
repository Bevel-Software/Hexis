import { describe, expect, it, vi } from 'vitest';
import { SurfaceCache } from '../surface-cache.js';

/** A cache on a clock the test moves. */
function makeCache(opts: { idleTtlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000_000;
  const cache = new SurfaceCache<string>({ ...opts, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

const HOUR = 60 * 60 * 1000;

describe('SurfaceCache', () => {
  it('builds once per key and answers every later get from what it built', async () => {
    const { cache } = makeCache();
    const build = vi.fn(async () => 'surface');
    expect(await cache.get('alice|rev-1', build)).toEqual({ value: 'surface', hit: false });
    expect(await cache.get('alice|rev-1', build)).toEqual({ value: 'surface', hit: true });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('builds anew for a new key — a new catalog revision is a new surface', async () => {
    const { cache } = makeCache();
    await cache.get('alice|rev-1', async () => 'old');
    expect(await cache.get('alice|rev-2', async () => 'new')).toEqual({ value: 'new', hit: false });
  });

  it('shares one build between concurrent misses on a key', async () => {
    const { cache } = makeCache();
    let release!: (v: string) => void;
    const build = vi.fn(() => new Promise<string>((r) => (release = r)));
    const first = cache.get('k', build);
    const second = cache.get('k', build);
    release('built');
    expect(await first).toEqual({ value: 'built', hit: false });
    expect(await second).toEqual({ value: 'built', hit: true });
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('remembers no failed build: the next get tries again', async () => {
    const { cache } = makeCache();
    await expect(cache.get('k', async () => Promise.reject(new Error('loopback down')))).rejects.toThrow('loopback down');
    expect(await cache.get('k', async () => 'built')).toEqual({ value: 'built', hit: false });
  });

  it('drops an entry unused for the idle time, and keeps one that is used', async () => {
    const { cache, advance } = makeCache({ idleTtlMs: HOUR });
    await cache.get('used', async () => 'a');
    await cache.get('idle', async () => 'b');
    advance(HOUR / 2);
    await cache.get('used', async () => 'never');
    advance(HOUR / 2);
    expect(cache.keys()).toEqual(['used']);
    expect(await cache.get('idle', async () => 'rebuilt')).toEqual({ value: 'rebuilt', hit: false });
  });

  it('holds at most maxEntries, dropping the least recently used first', async () => {
    const { cache, advance } = makeCache({ maxEntries: 3 });
    for (const k of ['a', 'b', 'c']) {
      await cache.get(k, async () => k);
      advance(1);
    }
    // `a` is used again, so `b` is now the least recently used.
    await cache.get('a', async () => 'never');
    await cache.get('d', async () => 'd');
    expect(cache.keys().sort()).toEqual(['a', 'c', 'd']);
    expect(cache.size).toBe(3);
  });

  it('with maxEntries 0 keeps nothing: every get builds', async () => {
    const { cache } = makeCache({ maxEntries: 0 });
    const build = vi.fn(async () => 'x');
    await cache.get('k', build);
    await cache.get('k', build);
    expect(build).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('evicts by key, and a build in flight at the eviction answers its waiter but is not kept', async () => {
    const { cache } = makeCache();
    await cache.get('alice|r', async () => 'alice');
    await cache.get('bob|r', async () => 'bob');
    cache.evictWhere((k) => k.startsWith('alice|'));
    expect(cache.keys()).toEqual(['bob|r']);

    let release!: (v: string) => void;
    const inFlight = cache.get('carol|r', () => new Promise<string>((r) => (release = r)));
    cache.clear();
    release('stale');
    expect((await inFlight).value).toBe('stale');
    expect(cache.size).toBe(0);
  });

  it('ends an entry early when its value says so, whatever its use', async () => {
    const { cache, advance } = makeCache();
    await cache.get('k', async () => 'degraded', () => 60_000);
    advance(30_000);
    expect((await cache.get('k', async () => 'never')).hit).toBe(true);
    advance(30_000);
    expect(await cache.get('k', async () => 'whole')).toEqual({ value: 'whole', hit: false });
  });
});
