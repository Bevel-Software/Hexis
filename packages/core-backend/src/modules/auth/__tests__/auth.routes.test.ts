import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAuthRoutes, type AuthRoutesOptions } from '../auth.routes.js';
import { PasswordChangedMeanwhileError, PasswordRefusedError, type AuthService } from '../auth.service.js';
import { AUTH_COOKIE_NAME } from '../auth.middleware.js';

const authService = {
  loginWithPassword: vi.fn(async () => {
    throw new Error('Invalid credentials');
  }),
  changePassword: vi.fn(async () => {
    throw new PasswordRefusedError('Current password is incorrect');
  }),
  getUserById: vi.fn(async () => null),
} as unknown as AuthService;

const fakeAuthMiddleware: express.RequestHandler = (req, _res, next) => {
  req.userId = 'user-1';
  req.userEmail = 'alice@example.com';
  next();
};

let server: Server;
beforeEach(() => {
  vi.mocked(authService.loginWithPassword).mockClear();
});
afterEach(() => {
  server?.close();
});

async function listen(options?: AuthRoutesOptions): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthRoutes(authService, fakeAuthMiddleware, [], true, options));
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

function postLogin(base: string, email: string, password = 'wrong') {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

describe('auth routes — rate limiting', () => {
  it('429s login for an (ip, email) pair after repeated failures; other emails unaffected', async () => {
    const base = await listen();
    for (let i = 0; i < 10; i++) {
      expect((await postLogin(base, 'alice@example.com')).status).toBe(401);
    }
    const limited = await postLogin(base, 'alice@example.com');
    expect(limited.status).toBe(429);
    // The service is not even consulted once the limit is hit.
    expect(authService.loginWithPassword).toHaveBeenCalledTimes(10);
    // A different email from the same address still has pair budget (the
    // wider per-ip budget is 50).
    expect((await postLogin(base, 'bob@example.com')).status).toBe(401);
  });

  it('a successful login resets the pair budget', async () => {
    const base = await listen();
    for (let i = 0; i < 9; i++) await postLogin(base, 'alice@example.com');
    vi.mocked(authService.loginWithPassword).mockResolvedValueOnce({
      token: 'jwt',
      user: { id: 'user-1', email: 'alice@example.com', name: 'Alice' },
    });
    expect((await postLogin(base, 'alice@example.com', 'right')).status).toBe(200);
    // Budget is fresh again — failures start counting from zero.
    expect((await postLogin(base, 'alice@example.com')).status).toBe(401);
  });

  it('429s change-password per account after repeated failures', async () => {
    const base = await listen();
    const post = () =>
      fetch(`${base}/api/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new-password-1' }),
      });
    for (let i = 0; i < 10; i++) {
      expect((await post()).status).toBe(400);
    }
    expect((await post()).status).toBe(429);
  });
});

describe('auth routes — change-password', () => {
  const post = (base: string) =>
    fetch(`${base}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password-1' }),
    });

  it('hands the changer a fresh token, in the body and the auth cookie', async () => {
    vi.mocked(authService.changePassword).mockResolvedValueOnce({ token: 'fresh-jwt' });
    const res = await post(await listen());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, token: 'fresh-jwt' });
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${AUTH_COOKIE_NAME}=fresh-jwt;`))).toBe(true);
  });

  it('answers a change another session got in first with a 409 and its words, and no cookie', async () => {
    vi.mocked(authService.changePassword).mockRejectedValueOnce(new PasswordChangedMeanwhileError());
    const res = await post(await listen());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/changed from another session/);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('answers a refusal the service made on purpose with a 400 and its words', async () => {
    vi.mocked(authService.changePassword).mockRejectedValueOnce(new PasswordRefusedError('Password must be at least 8 characters'));
    const res = await post(await listen());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Password must be at least 8 characters' });
  });

  it('answers a fault with a generic 500 that carries nothing of the cause', async () => {
    vi.mocked(authService.changePassword).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED db.internal:5432 (role bevel, database bevel)'),
    );
    const res = await post(await listen());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'Could not change the password' });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|5432|bevel/);
  });

  it('marks the cookie Secure when the deployment is reached over https, and not otherwise', async () => {
    vi.mocked(authService.changePassword).mockResolvedValueOnce({ token: 'fresh-jwt' });
    const secure = await post(await listen({ cookieSecure: true }));
    expect(secure.headers.getSetCookie()[0]).toMatch(/; Secure/);
    vi.mocked(authService.changePassword).mockResolvedValueOnce({ token: 'fresh-jwt' });
    const plain = await post(await listen({ cookieSecure: false }));
    expect(plain.headers.getSetCookie()[0]).not.toMatch(/; Secure/);
  });
});

describe('auth routes — me', () => {
  it('answers a fault with a generic 500 that carries nothing of the cause', async () => {
    vi.mocked(authService.getUserById).mockRejectedValueOnce(
      new Error('connect ECONNREFUSED db.internal:5432 (role bevel, database bevel)'),
    );
    const res = await fetch(`${await listen()}/api/auth/me`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: 'Could not load your account' });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|5432|bevel/);
  });
});
