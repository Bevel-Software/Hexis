import { describe, it, expect } from 'vitest';
import { TtlCache } from '../ttl-cache.js';

describe('TtlCache', () => {
  it('serves a value until the TTL runs out, then stops', () => {
    let now = 0;
    const cache = new TtlCache<string>(1000, () => now);
    cache.set('v', cache.begin());
    expect(cache.get()).toBe('v');
    now = 999;
    expect(cache.get()).toBe('v');
    now = 1000;
    expect(cache.get()).toBeNull();
  });

  it('invalidate() drops the value immediately', () => {
    const cache = new TtlCache<string>(1000, () => 0);
    cache.set('v', cache.begin());
    cache.invalidate();
    expect(cache.get()).toBeNull();
  });

  /**
   * The race the token exists for, and the one that made the merge fix a
   * no-op in exactly the case it targeted: a catalog read starts on the
   * pre-merge tree, the merge's pull lands and drops the cache, and the
   * in-flight read then writes its stale list back with a fresh full TTL —
   * silently undoing the drop.
   */
  it('discards a value whose fetch straddled an invalidate()', () => {
    const cache = new TtlCache<string>(1000, () => 0);
    const token = cache.begin(); // read starts on the old tree
    cache.invalidate(); //           the pull lands mid-read
    cache.set('stale', token); //    the read comes back and tries to store
    expect(cache.get()).toBeNull();
  });

  it('stores a value whose fetch did not straddle an invalidate()', () => {
    const cache = new TtlCache<string>(1000, () => 0);
    cache.invalidate();
    const token = cache.begin();
    cache.set('fresh', token);
    expect(cache.get()).toBe('fresh');
  });

  it('keeps refusing a token from before the drop, not just the first time', () => {
    const cache = new TtlCache<string>(1000, () => 0);
    const stale = cache.begin();
    cache.invalidate();
    const fresh = cache.begin();
    cache.set('fresh', fresh);
    cache.set('stale', stale);
    expect(cache.get()).toBe('fresh');
  });
});
