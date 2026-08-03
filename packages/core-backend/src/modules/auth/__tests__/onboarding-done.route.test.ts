import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthRoutes } from '../auth.routes.js';
import type { AuthService } from '../auth.service.js';

/**
 * POST /auth/onboarding-done — the one write behind the welcome page's Done
 * AND the reminder pill's ×. The contract worth pinning:
 *
 *  - it acts on the AUTHENTICATED user (req.userId), never on a body param —
 *    there is no way to conclude someone else's onboarding;
 *  - it is idempotent from the caller's view (the service call is an UPDATE
 *    to the value it may already have), so both buttons can fire it blind;
 *  - unauthenticated callers never reach the service.
 */

const USER_ID = 'user-123';

let server: HttpServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
});

function listen(service: Pick<AuthService, 'markOnboardingDone'>, authed = true): string {
  const app = express();
  app.use(express.json());
  const middleware: express.RequestHandler = (req, res, next) => {
    if (!authed) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    req.userId = USER_ID;
    next();
  };
  app.use('/api', createAuthRoutes(service as AuthService, middleware));
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe('POST /auth/onboarding-done', () => {
  it('marks the caller — and only the caller — done', async () => {
    const markOnboardingDone = vi.fn().mockResolvedValue(undefined);
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A body naming somebody else must be ignored, not honored.
      body: JSON.stringify({ userId: 'somebody-else' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(markOnboardingDone).toHaveBeenCalledTimes(1);
    expect(markOnboardingDone).toHaveBeenCalledWith(USER_ID);
  });

  it('never reaches the service unauthenticated', async () => {
    const markOnboardingDone = vi.fn();
    const base = listen({ markOnboardingDone }, false);
    const res = await fetch(`${base}/api/auth/onboarding-done`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(markOnboardingDone).not.toHaveBeenCalled();
  });

  it('reports a failed write as a 500, not as success', async () => {
    const markOnboardingDone = vi.fn().mockRejectedValue(new Error('db down'));
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, { method: 'POST' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('db down');
  });
});
