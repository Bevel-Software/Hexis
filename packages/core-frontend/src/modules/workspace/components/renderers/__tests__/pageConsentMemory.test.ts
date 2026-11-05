import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_PAGES_KEY, ALLOWED_PAGES_MAX, isRemembered, remember } from '../pageConsentMemory';

/**
 * The browser's memory of the pages its viewer allowed to write: digests in
 * `localStorage`, the 500 most recently allowed, and nothing at all when the
 * browser will not store.
 */
describe('pageConsentMemory', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('remembers a digest it was given, and only that one', () => {
    expect(isRemembered('a1')).toBe(false);
    remember('a1');
    expect(isRemembered('a1')).toBe(true);
    expect(isRemembered('b2')).toBe(false);
    expect(JSON.parse(window.localStorage.getItem(ALLOWED_PAGES_KEY)!)).toEqual(['a1']);
  });

  it('keeps an earlier digest when a new one is allowed', () => {
    remember('old');
    remember('new');
    expect(isRemembered('old')).toBe(true);
    expect(isRemembered('new')).toBe(true);
  });

  it('keeps the 500 most recently allowed: the 501st forgets the least recently allowed', () => {
    expect(ALLOWED_PAGES_MAX).toBe(500);
    for (let i = 0; i < 500; i++) remember(`d${i}`);
    // Allowing d0 again makes it the most recent, so d1 is now the oldest.
    remember('d0');
    remember('d500');
    expect(isRemembered('d1')).toBe(false);
    expect(isRemembered('d0')).toBe(true);
    expect(isRemembered('d2')).toBe(true);
    expect(isRemembered('d500')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(ALLOWED_PAGES_KEY)!)).toHaveLength(500);
  });

  it('reads a blocked storage as nothing remembered, and stores nothing without an error', () => {
    // What a browser in strict privacy mode does: touching storage throws.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(isRemembered('a1')).toBe(false);
    expect(() => remember('a1')).not.toThrow();
    expect(isRemembered('a1')).toBe(false);
  });

  it('reads a storage whose calls throw as nothing remembered, and stores nothing without an error', () => {
    const fail = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    const setItem = vi.fn(fail);
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue({ getItem: fail, setItem } as unknown as Storage);
    expect(isRemembered('a1')).toBe(false);
    expect(() => remember('a1')).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(isRemembered('a1')).toBe(false);
  });

  it('reads a corrupt stored value as empty', () => {
    window.localStorage.setItem(ALLOWED_PAGES_KEY, '{not json');
    expect(isRemembered('a1')).toBe(false);
    window.localStorage.setItem(ALLOWED_PAGES_KEY, JSON.stringify({ a1: true }));
    expect(isRemembered('a1')).toBe(false);
    remember('a1');
    expect(JSON.parse(window.localStorage.getItem(ALLOWED_PAGES_KEY)!)).toEqual(['a1']);
  });
});
