import express from 'express';
import type { AuthService } from './auth.service.js';
import { AUTH_COOKIE_NAME } from './auth.middleware.js'; // also imports Express Request augmentation

/**
 * Max age of the JWT cookie (seconds). Matches the JWT's own `expiresIn:
 * '7d'` so the cookie expires when the token does — browsers stop
 * sending it past expiry, sparing the auth middleware verifying tokens
 * that are guaranteed to fail.
 */
export const AUTH_COOKIE_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * A pluggable SSO login method. Core ships password login only; the
 * composition root passes provider plugins (e.g. Microsoft OIDC, owned by the
 * sharepoint module) which mount their own routes under `/auth/<key>/…` and
 * are advertised to the login screen under `key` by the capability probe.
 * A plugin is only passed in when its machinery is configured AND the
 * instance hasn't switched it off — presence means enabled.
 */
export interface AuthProviderPlugin {
  /** Probe key + route namespace (e.g. 'microsoft' → /auth/microsoft/…). */
  readonly key: string;
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

  // POST /api/auth/login — email + shared-password login (unprotected)
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

    try {
      const result = await authService.loginWithPassword(email, password);
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
  // knows which login methods to render. SSO providers appear under their key.
  router.get('/auth/providers', (_req, res) => {
    res.json({
      password: passwordLoginEnabled,
      ...Object.fromEntries(providers.map((p) => [p.key, true])),
    });
  });

  for (const provider of providers) provider.mountRoutes(router, authService);

  // POST /api/auth/onboarding-done — conclude the connect-your-agent
  // onboarding for the caller (protected). One-way and idempotent; the
  // welcome page's Done and the reminder pill's × are its two callers.
  router.post('/auth/onboarding-done', authMiddleware, async (req, res) => {
    try {
      await authService.markOnboardingDone(req.userId!);
      res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: msg });
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
