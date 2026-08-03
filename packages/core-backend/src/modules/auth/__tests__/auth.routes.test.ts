import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createAuthRoutes } from '../auth.routes.js';
import type { AuthService } from '../auth.service.js';

const authService = {
  loginWithPassword: vi.fn(async () => {
    throw new Error('Invalid credentials');
  }),
  changePassword: vi.fn(async () => {
    throw new Error('Current password is incorrect');
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

async function listen(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthRoutes(authService, fakeAuthMiddleware));
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
