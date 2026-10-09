import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchLoginProvidersStrict } from '../services/sso';

/**
 * The strict sign-in-methods probe answers only what the server said: a
 * failed request, a non-OK status or a body missing either answer is
 * "couldn't check", never a guess of password-only.
 */

function answer(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchLoginProvidersStrict', () => {
  it('returns what the server says', async () => {
    const sso = [{ key: 'oidc', label: 'Duende Demo', startPath: '/api/auth/oidc/start' }];
    answer({ password: false, sso });
    await expect(fetchLoginProvidersStrict()).resolves.toEqual({ password: false, sso });
  });

  it('rejects a non-OK answer', async () => {
    answer({}, 503);
    await expect(fetchLoginProvidersStrict()).rejects.toThrow();
  });

  it.each([
    ['an empty body', {}],
    ['no password answer', { sso: [] }],
    ['no single sign-on list', { password: true }],
    ['a password answer that is not a boolean', { password: 'yes', sso: [] }],
    ['a provider without a label', { password: true, sso: [{ key: 'oidc' }] }],
    ['null', null],
  ])('rejects %s rather than guessing', async (_label, body) => {
    answer(body);
    await expect(fetchLoginProvidersStrict()).rejects.toThrow("Couldn't read the sign-in methods");
  });
});
