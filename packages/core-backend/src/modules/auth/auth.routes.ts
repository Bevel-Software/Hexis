import express from 'express';
import type { AuthService } from './auth.service.js';
import { AUTH_COOKIE_NAME } from './auth.middleware.js'; // also imports Express Request augmentation
import { FixedWindowRateLimiter } from './rate-limit.js';

/**
 * Max age of the JWT cookie (seconds). Matches the JWT's own `expiresIn:
 * '7d'` so the cookie expires when the token does — browsers stop
 * sending it past expiry, sparing the auth middleware verifying tokens
 * that are guaranteed to fail.
 */
export const AUTH_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * A pluggable SSO login method. Core ships password login and (when
 * configured) the generic OIDC provider; overlays may pass additional plugins
 * (e.g. the enterprise "Sign in with Microsoft", owned by its sharepoint
 * module). A plugin mounts its own routes under `/auth/<key>/…` and is
 * advertised to the login screen by the capability probe, which renders one
 * button per provider from `label` + `startPath`. A plugin is only present
 * when its machinery is configured AND the instance hasn't switched it off —
 * presence means enabled.
 */
export interface AuthProviderPlugin {
  /** Probe key + route namespace (e.g. 'oidc' → /auth/oidc/…). */
  readonly key: string;
  /** Login-button label (e.g. "Sign in with Microsoft"). */
  readonly label: string;
  /** Browser navigation target that starts the flow (e.g. '/api/auth/oidc/login'). */
  readonly startPath: string;
  /** Mount the provider's routes (login redirect, callback) on the auth router. */
  mountRoutes(router: express.Router, authService: AuthService): void;
}

export function createAuthRoutes(
  authService: AuthService,
  authMiddleware: express.RequestHandler,
  providers: AuthProviderPlugin[] = [],
  passwordLoginEnabled = true,
): express.Router {
  const router = express.Router();

  // Brute-force guards on the password endpoints (scrypt also makes each
  // attempt expensive server-side, so these double as DoS protection):
  //  - login: a tight per-(ip, email) budget plus a wider per-ip budget so a
  //    single address can't spray many emails; the pair key resets on a
  //    successful login.
  //  - change-password: per authenticated account (a stolen session must not
  //    get unlimited guesses at the current password).
  const loginPairLimiter = new FixedWindowRateLimiter(10, 15 * 60_000);
  const loginIpLimiter = new FixedWindowRateLimiter(50, 15 * 60_000);
  const changePasswordLimiter = new FixedWindowRateLimiter(10, 15 * 60_000);
  const clientIp = (req: express.Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';

  // POST /api/auth/login — email + password login (unprotected): the env
  // bootstrap admin or a per-user account password (see AuthService).
  router.post('/auth/login', async (req, res) => {
    if (!passwordLoginEnabled) {
      res.status(403).json({ error: 'Password login is disabled' });
      return;
    }
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    const ip = clientIp(req);
    const pairKey = `${ip}|${email.trim().toLowerCase()}`;
    if (!loginPairLimiter.consume(pairKey) || !loginIpLimiter.consume(ip)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }

    try {
      const result = await authService.loginWithPassword(email, password);
      // A real login clears the pair budget — a user who fumbled a few
      // attempts isn't rate-limited on their next visit. (The wider per-ip
      // window intentionally keeps counting.)
      loginPairLimiter.reset(pairKey);
      // Also set the JWT as an HttpOnly cookie so transports that can't
      // carry headers (EventSource for SSE, image tags) authenticate
      // automatically. JSON callers continue to use the Bearer header
      // returned in the body. Secure in production; off in dev so the
      // cookie survives `http://localhost` requests.
      res.cookie(AUTH_COOKIE_NAME, result.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: AUTH_COOKIE_MAX_AGE_S * 1000,
        path: '/',
      });
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Login error:', msg);
      res.status(401).json({ error: 'Authentication failed' });
    }
  });

  // GET /api/auth/providers — unprotected capability probe so the login screen
  // knows which login methods to render: the password form, plus one button
  // per SSO provider (label + the path that starts its flow).
  router.get('/auth/providers', (_req, res) => {
    res.json({
      password: passwordLoginEnabled,
      sso: providers.map((p) => ({ key: p.key, label: p.label, startPath: p.startPath })),
    });
  });

  for (const provider of providers) provider.mountRoutes(router, authService);

  // POST /api/auth/change-password — self-service (protected). Requires the
  // current password whenever one is set; an SSO-only account sets its first
  // password without one.
  router.post('/auth/change-password', authMiddleware, async (req, res) => {
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!newPassword) {
      res.status(400).json({ error: 'newPassword is required' });
      return;
    }
    if (!changePasswordLimiter.consume(req.userId!)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    try {
      await authService.changePassword(req.userId!, currentPassword, newPassword);
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      // Policy violations and a wrong current password are caller errors, not
      // server faults — and the message is safe to show verbatim.
      res.status(400).json({ error: msg });
    }
  });

  // POST /api/auth/onboarding-done — conclude the connect-your-agent
  // onboarding for the caller (protected). One-way and idempotent; the
  // welcome page's Done and the reminder pill's × are its two callers.
  router.post('/auth/onboarding-done', authMiddleware, async (req, res) => {
    try {
      // The caller must state WHICH account it believes it is concluding, and
      // anything but an exact match is refused rather than applied to the
      // token's owner.
      //
      // The bearer token lives in one shared localStorage key, so two accounts
      // in two tabs share it: a stale tab still rendering A, after B signs in
      // elsewhere, would otherwise send A's intent with B's token and
      // irreversibly conclude B's onboarding — an account B has no way to
      // reopen. `userId` is an assertion about intent, never an authorization:
      // the write still targets `req.userId` alone.
      //
      // REQUIRED, not merely checked-when-present. Treating an absent claim as
      // consent reopens the same hole from the other side: a stale or malformed
      // client that posts `{}` while rendering A would conclude B's onboarding
      // unopposed. A caller that cannot name the account it means has not
      // expressed the intent this route needs.
      const claimed = (req.body as { userId?: unknown } | undefined)?.userId;
      if (typeof claimed !== 'string' || claimed !== req.userId) {
        res.status(409).json({ error: 'Session changed — sign in again' });
        return;
      }
      await authService.markOnboardingDone(req.userId!);
      res.json({ ok: true });
    } catch (error) {
      // Logged in full, returned generic — same rule as `/auth/login` above.
      // A raw driver message here would hand an unauthenticated-adjacent
      // caller the schema, the host, or the connection string.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Onboarding-done error:', msg);
      res.status(500).json({ error: 'Could not save that' });
    }
  });

  // GET /api/auth/me — validate stored JWT, return user info (protected)
  router.get('/auth/me', authMiddleware, async (req, res) => {
    try {
      const user = await authService.getUserById(req.userId!);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      res.json(user);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
