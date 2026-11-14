import { describe, expect, it, vi } from 'vitest';
import { SURFACE_BUILD_TIMEOUT_MS, SurfaceCache } from '../surface-cache.js';

/** A cache on a clock the test moves. */
function makeCache(opts: { idleTtlMs?: number; maxEntries?: number } = {}) {
  let now = 1_000_000;
  const cache = new SurfaceCache<string>({ ...opts, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}

const HOUR = 60 * 60 * 1000;

/** Whether `key` is held: a get that finds it is a hit, and one that does not builds (and so holds it from then on). */
async function holds(cache: SurfaceCache<string>, key: string): Promise<boolean> {
  return (await cache.get(key, async () => 'rebuilt')).hit;
}

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

  it('lets go of a build that hangs: past the build timeout the next get builds again', async () => {
    const { cache, advance } = makeCache();
    let releaseStuck!: (v: string) => void;
    const stuck = cache.get('k', () => new Promise<string>((r) => (releaseStuck = r)));
    advance(SURFACE_BUILD_TIMEOUT_MS - 1);
    const joined = cache.get('k', async () => 'unused');
    advance(1);
    expect(await cache.get('k', async () => 'fresh')).toEqual({ value: 'fresh', hit: false });
    expect(await cache.get('k', async () => 'unused')).toEqual({ value: 'fresh', hit: true });
    // The hung build still answers whoever was waiting on it, and is not kept.
    releaseStuck('late');
    expect(await stuck).toEqual({ value: 'late', hit: false });
    expect(await joined).toEqual({ value: 'late', hit: true });
    expect(await cache.get('k', async () => 'unused')).toEqual({ value: 'fresh', hit: true });
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
    expect(await cache.get('idle', async () => 'rebuilt')).toEqual({ value: 'rebuilt', hit: false });
    expect(await cache.get('used', async () => 'never')).toEqual({ value: 'a', hit: true });
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
    // Checked newest first, so no check's own rebuild pushes out an entry still to be checked.
    expect(await holds(cache, 'd')).toBe(true);
    expect(await holds(cache, 'c')).toBe(true);
    expect(await holds(cache, 'a')).toBe(true);
    expect(await holds(cache, 'b')).toBe(false);
  });

  it('with maxEntries 0 keeps nothing: every get builds', async () => {
    const { cache } = makeCache({ maxEntries: 0 });
    const build = vi.fn(async () => 'x');
    expect((await cache.get('k', build)).hit).toBe(false);
    expect((await cache.get('k', build)).hit).toBe(false);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('evicts by key, and a build in flight at the eviction answers its waiter but is not kept', async () => {
    const { cache } = makeCache();
    await cache.get('alice|r', async () => 'alice');
    await cache.get('bob|r', async () => 'bob');
    cache.evictWhere((k) => k.startsWith('alice|'));
    expect(await holds(cache, 'bob|r')).toBe(true);
    expect(await holds(cache, 'alice|r')).toBe(false);

    let release!: (v: string) => void;
    const inFlight = cache.get('carol|r', () => new Promise<string>((r) => (release = r)));
    cache.clear();
    release('stale');
    expect((await inFlight).value).toBe('stale');
    expect(await cache.get('carol|r', async () => 'fresh')).toEqual({ value: 'fresh', hit: false });
    expect(await holds(cache, 'bob|r')).toBe(false);
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
