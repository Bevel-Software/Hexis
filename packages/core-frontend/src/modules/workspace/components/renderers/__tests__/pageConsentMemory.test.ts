import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_PAGE_KEY_PREFIX, ALLOWED_PAGES_MAX, isRemembered, remember } from '../pageConsentMemory';

/**
 * The browser's memory of the pages its viewer allowed to write: one
 * `localStorage` entry per digest, the 500 most recently allowed, and nothing
 * at all when the browser will not store.
 */
/** The digests stored in localStorage, least recently allowed first: read through the storage API, as another tab would. */
const rememberedDigests = (): string[] =>
  Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((key) => key.startsWith(ALLOWED_PAGE_KEY_PREFIX) && Number.isFinite(Number(window.localStorage.getItem(key))))
    .sort((a, b) => Number(window.localStorage.getItem(a)) - Number(window.localStorage.getItem(b)))
    .map((key) => key.slice(ALLOWED_PAGE_KEY_PREFIX.length));

describe('pageConsentMemory', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('remembers a digest it was given, and only that one', () => {
    expect(isRemembered('a1')).toBe(false);
    remember('a1');
    expect(isRemembered('a1')).toBe(true);
    expect(isRemembered('b2')).toBe(false);
    expect(rememberedDigests()).toEqual(['a1']);
    expect(window.localStorage.getItem(`${ALLOWED_PAGE_KEY_PREFIX}a1`)).not.toBeNull();
  });

  it('keeps an earlier digest when a new one is allowed', () => {
    remember('old');
    remember('new');
    expect(isRemembered('old')).toBe(true);
    expect(isRemembered('new')).toBe(true);
    expect(rememberedDigests()).toEqual(['old', 'new']);
  });

  it("an Allow writes only its own entry, so another tab's Allow at the same moment survives", () => {
    remember('mine');
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const removeItem = vi.spyOn(window.localStorage, 'removeItem');
    remember('also-mine');
    // Another tab's Allow lands as its own entry, whenever it lands.
    window.localStorage.setItem(`${ALLOWED_PAGE_KEY_PREFIX}theirs`, String(Date.now()));
    expect(setItem.mock.calls[0]![0]).toBe(`${ALLOWED_PAGE_KEY_PREFIX}also-mine`);
    expect(removeItem).not.toHaveBeenCalled();
    expect(rememberedDigests().sort()).toEqual(['also-mine', 'mine', 'theirs']);
  });

  it('keeps the 500 most recently allowed: the 501st forgets the least recently allowed', () => {
    expect(ALLOWED_PAGES_MAX).toBe(500);
    // 500 earlier Allows, d0 the least recent.
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${ALLOWED_PAGE_KEY_PREFIX}d${i}`, String(i + 1));
    // Allowing d0 again makes it the most recent, so d1 is now the oldest.
    remember('d0');
    remember('d500');
    expect(isRemembered('d1')).toBe(false);
    expect(isRemembered('d0')).toBe(true);
    expect(isRemembered('d2')).toBe(true);
    expect(isRemembered('d500')).toBe(true);
    expect(rememberedDigests()).toHaveLength(500);
    expect(rememberedDigests().slice(-2)).toEqual(['d0', 'd500']);
  });

  it('leaves entries that are not its own alone', () => {
    window.localStorage.setItem('bevel.htmlPage.height', '300');
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${ALLOWED_PAGE_KEY_PREFIX}d${i}`, String(i + 1));
    remember('d500');
    expect(isRemembered('d0')).toBe(false);
    expect(window.localStorage.getItem('bevel.htmlPage.height')).toBe('300');
  });

  it('reads a blocked storage as nothing remembered, and stores nothing without an error', () => {
    // What a browser in strict privacy mode does: touching storage throws.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(isRemembered('a1')).toBe(false);
    expect(() => remember('a1')).not.toThrow();
    expect(isRemembered('a1')).toBe(false);
    // Unblocked again, the storage holds nothing of that Allow.
    vi.restoreAllMocks();
    expect(rememberedDigests()).toEqual([]);
  });

  it('reads a storage whose calls throw as nothing remembered, and stores nothing without an error', () => {
    const fail = () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    };
    const setItem = vi.fn(fail);
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      length: 0,
      key: () => null,
      getItem: fail,
      setItem,
      removeItem: fail,
    } as unknown as Storage);
    expect(isRemembered('a1')).toBe(false);
    expect(() => remember('a1')).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(isRemembered('a1')).toBe(false);
  });

  it('ignores a corrupt stored entry', () => {
    window.localStorage.setItem(`${ALLOWED_PAGE_KEY_PREFIX}a1`, 'not a time');
    expect(isRemembered('a1')).toBe(false);
    expect(rememberedDigests()).toEqual([]);
    remember('a1');
    expect(rememberedDigests()).toEqual(['a1']);
  });
});
