import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { accountKeyPrefix, useAuthState } from '..';
import { getToken, setToken } from '../../../lib/api';

/**
 * Signing out clears what the account kept in this browser, through the real
 * hook and `localStorage`; only the server's answer about the session is stubbed.
 */
const A_ENTRY = `${accountKeyPrefix('user-a')}htmlPage.allowedWrite.digest`;
const B_ENTRY = `${accountKeyPrefix('user-b')}htmlPage.allowedWrite.digest`;

/** The session the server answers: `user-a`, or an expired token. */
function stubSession(status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      status === 200
        ? new Response(JSON.stringify({ id: 'user-a', email: 'a@example.com', name: 'A' }), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{}', { status }),
    ),
  );
}

async function signedIn() {
  setToken('token-a');
  stubSession();
  const { result } = renderHook(() => useAuthState());
  await waitFor(() => expect(result.current.user?.id).toBe('user-a'));
  return result;
}

describe('useAuthState signing out', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(A_ENTRY, '1');
    window.localStorage.setItem(B_ENTRY, '2');
    window.localStorage.setItem('bevel.htmlPage.height', '300');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears the signed-out account's entries and leaves another account's", async () => {
    const auth = await signedIn();
    expect(window.localStorage.getItem(A_ENTRY)).toBe('1');

    act(() => auth.current.logout());

    expect(auth.current.user).toBeNull();
    expect(getToken()).toBeNull();
    expect(window.localStorage.getItem(A_ENTRY)).toBeNull();
    expect(window.localStorage.getItem(B_ENTRY)).toBe('2');
    expect(window.localStorage.getItem('bevel.htmlPage.height')).toBe('300');
  });

  it("never reaches another account whose id starts with the signed-out one's, whatever the id holds", async () => {
    const others = ['user-a.b', 'user-a/b', 'user-a%2Fb', 'user-a b', 'user-ab', 'user-a@example.com'];
    for (const other of others) window.localStorage.setItem(`${accountKeyPrefix(other)}entry`, '1');
    const auth = await signedIn();

    act(() => auth.current.logout());

    expect(window.localStorage.getItem(A_ENTRY)).toBeNull();
    for (const other of others) expect(window.localStorage.getItem(`${accountKeyPrefix(other)}entry`)).toBe('1');
    expect(new Set(others.map(accountKeyPrefix)).size).toBe(others.length);
  });

  it('still signs out when the storage cannot be listed', async () => {
    const auth = await signedIn();
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    });

    act(() => auth.current.logout());

    expect(auth.current.user).toBeNull();
    expect(getToken()).toBeNull();
  });

  it('keeps the entries when a session ends without signing out: they are still only that account\'s', async () => {
    setToken('expired');
    stubSession(401);
    const { result } = renderHook(() => useAuthState());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.user).toBeNull();
    expect(window.localStorage.getItem(A_ENTRY)).toBe('1');
    expect(window.localStorage.getItem(B_ENTRY)).toBe('2');
  });
});
