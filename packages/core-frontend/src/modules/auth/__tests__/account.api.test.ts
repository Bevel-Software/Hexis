import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { changePassword } from '../services/account.api';
import { authFetch, getToken, setToken } from '../../../lib/api';

/**
 * A password change ends every session opened before it, the changer's old
 * token included, so the page keeps working only if the token the change
 * hands back is what the NEXT request carries. Only `fetch` is stubbed: the
 * real `changePassword` and `authFetch` read and write the stored token.
 */
describe('changePassword and the token it hands back', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('authenticates the next request with the replacement token', async () => {
    setToken('token-before-the-change');
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, token: 'token-after-the-change' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: {} }), { status: 200 }));

    await changePassword('old-password-1', 'new-password-1');
    await authFetch('/api/auth/me');

    const authorization = (call: number) =>
      new Headers((fetchMock.mock.calls[call][1] as RequestInit).headers).get('Authorization');
    expect(authorization(0)).toBe('Bearer token-before-the-change');
    expect(authorization(1)).toBe('Bearer token-after-the-change');
    expect(getToken()).toBe('token-after-the-change');
  });

  it('keeps the stored token when the change is refused', async () => {
    setToken('token-before-the-change');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Your password was changed from another session; nothing was changed.' }), {
        status: 409,
      }),
    );

    await expect(changePassword('old-password-1', 'new-password-1')).rejects.toThrow(/another session/);
    expect(getToken()).toBe('token-before-the-change');
  });
});
