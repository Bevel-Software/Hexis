import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accountKeyPrefix, clearAccountStorage } from '..';

/** What each account keeps in the browser, and the one thing signing out does with it. */
const keys = (): string[] =>
  Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!).sort();

describe('accountStorage', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("clears every entry of the account and leaves other accounts' and the app's own", () => {
    const a = accountKeyPrefix('a');
    const b = accountKeyPrefix('b');
    window.localStorage.setItem(`${a}one`, '1');
    window.localStorage.setItem(`${a}two`, '2');
    window.localStorage.setItem(`${b}one`, '3');
    window.localStorage.setItem('bevel_token', 't');

    clearAccountStorage('a');

    expect(keys()).toEqual(['bevel_token', `${b}one`].sort());
  });

  it("never reaches another account whose id starts with this one's, whatever the id holds", () => {
    const others = ['a.b', 'a/b', 'a%2Fb', 'a b', 'ab', 'a@example.com'];
    for (const other of others) window.localStorage.setItem(`${accountKeyPrefix(other)}entry`, '1');
    window.localStorage.setItem(`${accountKeyPrefix('a')}entry`, '1');

    clearAccountStorage('a');

    expect(keys()).toEqual(others.map((other) => `${accountKeyPrefix(other)}entry`).sort());
    expect(new Set(others.map(accountKeyPrefix)).size).toBe(others.length);
  });

  it('does nothing for an account that kept nothing', () => {
    window.localStorage.setItem(`${accountKeyPrefix('b')}entry`, '1');
    clearAccountStorage('a');
    expect(keys()).toEqual([`${accountKeyPrefix('b')}entry`]);
  });

  it('does not throw on a blocked storage', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });
    expect(() => clearAccountStorage('a')).not.toThrow();
  });
});
