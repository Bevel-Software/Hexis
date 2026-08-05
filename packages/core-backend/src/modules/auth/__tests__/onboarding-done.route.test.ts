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
 *  - it REQUIRES the caller to name the account it means, and refuses anything
 *    that is not an exact match — including a claim that is absent or not a
 *    string, since "said nothing" is not the same as "meant this account";
 *  - it is idempotent from the caller's view (the service call is an UPDATE
 *    to the value it may already have), so both buttons can fire it blind;
 *  - unauthenticated callers never reach the service.
 */

const USER_ID = 'user-123';

let server: HttpServer | null = null;

afterEach(() => {
  server?.close();
  server = null;
  // In a hook, not at the end of a test body: a failing assertion would
  // otherwise leave a `console.error` spy installed and silence the rest of
  // the file.
  vi.restoreAllMocks();
});

/**
 * Mount the auth router on a throwaway port with a stand-in auth middleware,
 * and return its base URL. `authed: false` makes that middleware reject like
 * the real one, which is how the "never reaches the service" case is proved
 * rather than assumed.
 */
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
  it('marks the caller done when the claimed account matches the token', async () => {
    const markOnboardingDone = vi.fn().mockResolvedValue(undefined);
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(markOnboardingDone).toHaveBeenCalledTimes(1);
    expect(markOnboardingDone).toHaveBeenCalledWith(USER_ID);
  });

  /**
   * A caller that names no account has not expressed the intent this route
   * needs. Accepting `{}` as consent would reopen the stale-tab hole from the
   * other side — an old or malformed client posting an empty body while
   * rendering account A would conclude account B's onboarding unopposed — so
   * the absent claim is refused exactly like a wrong one.
   */
  it('refuses a caller that claims nothing, and writes nothing', async () => {
    const markOnboardingDone = vi.fn();
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(markOnboardingDone).not.toHaveBeenCalled();
  });

  // Same rule for a claim of the wrong TYPE: only an exact string match is
  // consent, so a number that happens to stringify to the user id is not.
  it('refuses a claim that is not a string', async () => {
    const markOnboardingDone = vi.fn();
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: { toString: () => USER_ID } }),
    });
    expect(res.status).toBe(409);
    expect(markOnboardingDone).not.toHaveBeenCalled();
  });

  /**
   * The stale-tab case. Two accounts share one bearer-token key in
   * localStorage: a tab still rendering A, after B signs in elsewhere, sends
   * A's intent with B's token. Concluding B's onboarding there would be
   * irreversible — there is no API to undo it — so the mismatch is refused
   * and NOTHING is written.
   */
  it('refuses when the claimed account is not the token holder, and writes nothing', async () => {
    const markOnboardingDone = vi.fn();
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'a-different-account' }),
    });
    expect(res.status).toBe(409);
    expect(markOnboardingDone).not.toHaveBeenCalled();
  });

  it('never reaches the service unauthenticated', async () => {
    const markOnboardingDone = vi.fn();
    const base = listen({ markOnboardingDone }, false);
    const res = await fetch(`${base}/api/auth/onboarding-done`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(markOnboardingDone).not.toHaveBeenCalled();
  });

  // A failed write must not be reported as success — and must not narrate the
  // database to the client either. Same rule as /auth/login.
  it('reports a failed write as a generic 500, keeping the detail server-side', async () => {
    const detail = 'connection to 10.0.0.4:5432 refused';
    const markOnboardingDone = vi.fn().mockRejectedValue(new Error(detail));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const base = listen({ markOnboardingDone });
    const res = await fetch(`${base}/api/auth/onboarding-done`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: USER_ID }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Could not save that');
    expect(body.error).not.toContain(detail);
    expect(logged).toHaveBeenCalledWith('Onboarding-done error:', detail);
  });
});
