import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware, AUTH_COOKIE_NAME } from '../auth.middleware.js';
import { AccountDeactivatedError } from '../account-admission.js';
import type { AuthService } from '../auth.service.js';

/**
 * The cookie fallback is the whole reason a markdown image can be a plain
 * `<img>`: the tag sends no Authorization header, only the `bevel_token`
 * cookie the login route set. Nothing else in the suite exercised that path
 * (the route harnesses inject `userId` directly), so this pins it.
 */

const GOOD_TOKEN = 'good-token';
const OFF_TOKEN = 'switched-off-token';
const IDENTITY = { userId: 'user-1', email: 'alice@example.com' };

async function run(headers: Record<string, string>) {
  const resolveSession = vi.fn(async (token: string) => {
    if (token === OFF_TOKEN) throw new AccountDeactivatedError();
    if (token !== GOOD_TOKEN) throw new Error('bad token');
    return IDENTITY;
  });
  const authService = { resolveSession } as unknown as AuthService;
  const req = { headers } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  await createAuthMiddleware(authService)(req, res, next);
  return { req, next, status, json, resolveSession };
}

describe('createAuthMiddleware', async () => {
  it('authenticates a request that carries only the auth cookie (an <img>, an EventSource)', async () => {
    const { req, next, status } = await run({ cookie: `${AUTH_COOKIE_NAME}=${GOOD_TOKEN}` });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.userId).toBe(IDENTITY.userId);
    expect(req.userEmail).toBe(IDENTITY.email);
  });

  it('finds the cookie among others, and decodes a percent-encoded value', async () => {
    const { next, resolveSession } = await run({
      cookie: `theme=dark; ${AUTH_COOKIE_NAME}=${encodeURIComponent(GOOD_TOKEN)}; seen=1`,
    });
    expect(resolveSession).toHaveBeenCalledWith(GOOD_TOKEN);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('prefers the Bearer header when both are present', async () => {
    const { next, resolveSession } = await run({
      authorization: `Bearer ${GOOD_TOKEN}`,
      cookie: `${AUTH_COOKIE_NAME}=stale-cookie`,
    });
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(resolveSession).toHaveBeenCalledWith(GOOD_TOKEN);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses a request with neither', async () => {
    const { next, status, json } = await run({});
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].error).toContain('auth cookie');
  });

  it('refuses an empty cookie value as missing, not as a token to verify', async () => {
    const { next, status, resolveSession } = await run({ cookie: `${AUTH_COOKIE_NAME}=` });
    expect(resolveSession).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('refuses a cookie the auth service rejects', async () => {
    const { next, status, json } = await run({ cookie: `${AUTH_COOKIE_NAME}=forged` });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].error).toBe('Invalid or expired token');
  });
});

describe('createAuthMiddleware — a switched-off account', () => {
  it('refuses a valid session whose account an admin switched off, and says why', async () => {
    const { next, status, json } = await run({ authorization: `Bearer ${OFF_TOKEN}` });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].error).toContain('switched off');
  });
});
