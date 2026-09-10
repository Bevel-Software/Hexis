import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAuthMiddleware, AUTH_COOKIE_NAME } from '../auth.middleware.js';
import type { AuthService } from '../auth.service.js';

/**
 * The cookie fallback is the whole reason a markdown image can be a plain
 * `<img>`: the tag sends no Authorization header, only the `bevel_token`
 * cookie the login route set. Nothing else in the suite exercised that path
 * (the route harnesses inject `userId` directly), so this pins it.
 */

const GOOD_TOKEN = 'good-token';
const IDENTITY = { userId: 'user-1', email: 'alice@example.com' };

function run(headers: Record<string, string>) {
  const verifyToken = vi.fn((token: string) => {
    if (token !== GOOD_TOKEN) throw new Error('bad token');
    return IDENTITY;
  });
  const authService = { verifyToken } as unknown as AuthService;
  const req = { headers } as unknown as Request;
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  createAuthMiddleware(authService)(req, res, next);
  return { req, next, status, json, verifyToken };
}

describe('createAuthMiddleware', () => {
  it('authenticates a request that carries only the auth cookie (an <img>, an EventSource)', () => {
    const { req, next, status } = run({ cookie: `${AUTH_COOKIE_NAME}=${GOOD_TOKEN}` });
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    expect(req.userId).toBe(IDENTITY.userId);
    expect(req.userEmail).toBe(IDENTITY.email);
  });

  it('finds the cookie among others, and decodes a percent-encoded value', () => {
    const { next, verifyToken } = run({
      cookie: `theme=dark; ${AUTH_COOKIE_NAME}=${encodeURIComponent(GOOD_TOKEN)}; seen=1`,
    });
    expect(verifyToken).toHaveBeenCalledWith(GOOD_TOKEN);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('prefers the Bearer header when both are present', () => {
    const { next, verifyToken } = run({
      authorization: `Bearer ${GOOD_TOKEN}`,
      cookie: `${AUTH_COOKIE_NAME}=stale-cookie`,
    });
    expect(verifyToken).toHaveBeenCalledTimes(1);
    expect(verifyToken).toHaveBeenCalledWith(GOOD_TOKEN);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses a request with neither', () => {
    const { next, status, json } = run({});
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].error).toContain('auth cookie');
  });

  it('refuses an empty cookie value as missing, not as a token to verify', () => {
    const { next, status, verifyToken } = run({ cookie: `${AUTH_COOKIE_NAME}=` });
    expect(verifyToken).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('refuses a cookie the auth service rejects', () => {
    const { next, status, json } = run({ cookie: `${AUTH_COOKIE_NAME}=forged` });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
    expect(json.mock.calls[0][0].error).toBe('Invalid or expired token');
  });
});
