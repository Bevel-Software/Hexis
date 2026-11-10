import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRemembered, remember } from '../pageConsentMemory';

/**
 * The browser's memory of the pages an account allowed to write: one
 * `localStorage` entry per digest under the account's prefix, its 500 most
 * recently allowed, and nothing at all with no account or when the browser
 * will not store.
 */
const A = 'user-a';
const B = 'user-b';
const prefixOf = (account: string) => `bevel.account/${account}/htmlPage.allowedWrite.`;
const PREFIX = prefixOf(A);

/** The account's digests stored in localStorage, least recently allowed first: read through the storage API, as another tab would. */
const rememberedDigests = (account: string = A): string[] =>
  Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!)
    .filter((key) => key.startsWith(prefixOf(account)) && Number.isFinite(Number(window.localStorage.getItem(key))))
    .sort((a, b) => Number(window.localStorage.getItem(a)) - Number(window.localStorage.getItem(b)))
    .map((key) => key.slice(prefixOf(account).length));

describe('pageConsentMemory', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('remembers a digest it was given, and only that one', () => {
    expect(isRemembered(A, 'a1')).toBe(false);
    remember(A, 'a1');
    expect(isRemembered(A, 'a1')).toBe(true);
    expect(isRemembered(A, 'b2')).toBe(false);
    expect(rememberedDigests()).toEqual(['a1']);
    expect(window.localStorage.getItem(`${PREFIX}a1`)).not.toBeNull();
  });

  it('keeps an earlier digest when a new one is allowed', () => {
    remember(A, 'old');
    remember(A, 'new');
    expect(isRemembered(A, 'old')).toBe(true);
    expect(isRemembered(A, 'new')).toBe(true);
    expect(rememberedDigests()).toEqual(['old', 'new']);
  });

  it("an Allow writes only its own entry, so another tab's Allow at the same moment survives", () => {
    remember(A, 'mine');
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    const removeItem = vi.spyOn(window.localStorage, 'removeItem');
    remember(A, 'also-mine');
    // Another tab's Allow lands as its own entry, whenever it lands.
    window.localStorage.setItem(`${PREFIX}theirs`, String(Date.now()));
    expect(setItem.mock.calls[0]![0]).toBe(`${PREFIX}also-mine`);
    expect(removeItem).not.toHaveBeenCalled();
    expect(rememberedDigests().sort()).toEqual(['also-mine', 'mine', 'theirs']);
  });

  it('keeps the 500 most recently allowed: the 501st forgets the least recently allowed', () => {
    // 500 earlier Allows, d0 the least recent.
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${PREFIX}d${i}`, String(i + 1));
    // Allowing d0 again makes it the most recent, so d1 is now the oldest.
    remember(A, 'd0');
    remember(A, 'd500');
    expect(isRemembered(A, 'd1')).toBe(false);
    expect(isRemembered(A, 'd0')).toBe(true);
    expect(isRemembered(A, 'd2')).toBe(true);
    expect(isRemembered(A, 'd500')).toBe(true);
    expect(rememberedDigests()).toHaveLength(500);
    expect(rememberedDigests().slice(-2)).toEqual(['d0', 'd500']);
  });

  it('trims to the cap from what storage holds after its write, so two tabs allowing at once never leave more than 500', () => {
    // Another tab's Allow at the same moment already took the account to 501.
    for (let i = 0; i < 501; i++) window.localStorage.setItem(`${PREFIX}d${i}`, String(i + 1));
    remember(A, 'mine');
    expect(rememberedDigests()).toHaveLength(500);
    expect(isRemembered(A, 'mine')).toBe(true);
    expect(isRemembered(A, 'd0')).toBe(false);
    expect(isRemembered(A, 'd1')).toBe(false);
  });

  it("never forgets an entry another tab allowed again while this Allow was being written", () => {
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${PREFIX}d${i}`, String(i + 1));
    const original = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      original(key, value);
      // Another tab allows the oldest page again right as this write lands.
      if (key === `${PREFIX}mine`) original(`${PREFIX}d0`, String(Number(value) + 1));
    });
    remember(A, 'mine');
    expect(isRemembered(A, 'd0')).toBe(true);
    expect(isRemembered(A, 'mine')).toBe(true);
    expect(isRemembered(A, 'd1')).toBe(false);
    expect(rememberedDigests()).toHaveLength(500);
  });

  it('leaves entries that are not its own alone', () => {
    window.localStorage.setItem('bevel.htmlPage.height', '300');
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${PREFIX}d${i}`, String(i + 1));
    remember(A, 'd500');
    expect(isRemembered(A, 'd0')).toBe(false);
    expect(window.localStorage.getItem('bevel.htmlPage.height')).toBe('300');
  });

  it("is the account's: another account is not remembered for a digest the first allowed", () => {
    remember(A, 'a1');
    expect(isRemembered(B, 'a1')).toBe(false);
    remember(B, 'a1');
    expect(isRemembered(B, 'a1')).toBe(true);
    expect(rememberedDigests(A)).toEqual(['a1']);
    expect(rememberedDigests(B)).toEqual(['a1']);
  });

  it("counts the cap per account: one account's Allows never forget another's", () => {
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${PREFIX}d${i}`, String(i + 1));
    for (let i = 0; i < 500; i++) window.localStorage.setItem(`${prefixOf(B)}d${i}`, String(i + 1));

    remember(B, 'd500');

    expect(rememberedDigests(A)).toHaveLength(500);
    expect(isRemembered(A, 'd0')).toBe(true);
    expect(rememberedDigests(B)).toHaveLength(500);
    expect(isRemembered(B, 'd0')).toBe(false);
  });


  it('keeps nothing with no account', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    remember(null, 'a1');
    expect(setItem).not.toHaveBeenCalled();
    expect(isRemembered(null, 'a1')).toBe(false);
    expect(window.localStorage.length).toBe(0);
  });

  it('reads a blocked storage as nothing remembered, and stores nothing without an error', () => {
    // What a browser in strict privacy mode does: touching storage throws.
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(isRemembered(A, 'a1')).toBe(false);
    expect(() => remember(A, 'a1')).not.toThrow();
    expect(isRemembered(A, 'a1')).toBe(false);
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
    expect(isRemembered(A, 'a1')).toBe(false);
    expect(() => remember(A, 'a1')).not.toThrow();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(isRemembered(A, 'a1')).toBe(false);
  });

  it('reads an account id that cannot be encoded as nothing remembered, without an error', () => {
    const unencodable = 'user-\uD800';
    expect(isRemembered(unencodable, 'a1')).toBe(false);
    expect(() => remember(unencodable, 'a1')).not.toThrow();
    expect(window.localStorage.length).toBe(0);
  });

  it('ignores a corrupt stored entry', () => {
    window.localStorage.setItem(`${PREFIX}a1`, 'not a time');
    expect(isRemembered(A, 'a1')).toBe(false);
    expect(rememberedDigests()).toEqual([]);
    remember(A, 'a1');
    expect(rememberedDigests()).toEqual(['a1']);
  });
});
