import express from 'express';
import { logger } from '../../shared/logging.js';

const log = logger('auth');
import { PasswordChangedMeanwhileError, PasswordRefusedError, type AuthService } from './auth.service.js';
import { setAuthCookie } from './auth.middleware.js'; // also imports Express Request augmentation
import { FixedWindowRateLimiter } from './rate-limit.js';
import { AccountDeactivatedError } from './account-admission.js';
import { canonicalEmail } from '../../shared/email-identity.js';

// The cookie's lifetime lives beside its one issue site now; still offered
// here for the providers that learnt it from this file.
export { AUTH_COOKIE_MAX_AGE_S } from './auth.middleware.js';

/** What {@link createAuthRoutes} takes beyond its services. */
export interface AuthRoutesOptions {
  /**
   * Whether the auth cookie is marked `Secure`: the composition root derives
   * it from the deployment's public URL (`authCookieSecure`), the one rule
   * every provider's cookie follows too. Absent — a harness that mounts the
   * routes on their own — it falls back to `NODE_ENV === 'production'`.
   */
  cookieSecure?: boolean;
}

/**
 * A pluggable SSO login method. Core ships password login and (when
 * configured) the generic OIDC provider; overlays may pass additional plugins
 * (e.g. the enterprise "Sign in with Microsoft", owned by its sharepoint
 * module). A plugin mounts its own routes under `/auth/<key>/…` and is
 * advertised to the login screen by the capability probe, which renders one
 * button per provider from `label` + `startPath`. A plugin is advertised while
 * it is present and — if it implements {@link AuthProviderPlugin.isEnabled} —
 * says it is enabled. That second half lets a provider configured at runtime
 * (the generic OIDC one, from the setup screen) mount once at boot and appear
 * the moment its configuration is complete.
 */
export interface AuthProviderPlugin {
  /** Probe key + route namespace (e.g. 'oidc' → /auth/oidc/…). */
  readonly key: string;
  /** Login-button label (e.g. "Sign in with Microsoft"). */
  readonly label: string;
  /** Browser navigation target that starts the flow (e.g. '/api/auth/oidc/login'). */
  readonly startPath: string;
  /**
   * Whether the login screen should offer it right now; asked on every probe.
   * Absent means always — a plugin whose presence is its enablement.
   */
  isEnabled?(): boolean;
  /** Mount the provider's routes (login redirect, callback) on the auth router. */
  mountRoutes(router: express.Router, authService: AuthService): void;
}

/**
 * The single sign-on providers offered right now: present, and enabled when
 * they say whether they are. The login screen's probe lists them, and an
 * invitation reads from them whether the deployment has single sign-on.
 */
export function offeredProviders(providers: readonly AuthProviderPlugin[]): AuthProviderPlugin[] {
  return providers.filter((p) => p.isEnabled?.() ?? true);
}

export function createAuthRoutes(
  authService: AuthService,
  authMiddleware: express.RequestHandler,
  providers: AuthProviderPlugin[] = [],
  passwordLoginEnabled = true,
  options: AuthRoutesOptions = {},
): express.Router {
  const router = express.Router();
  const cookieSecure = options.cookieSecure ?? process.env.NODE_ENV === 'production';

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
    // IP budget FIRST, and it returns before the pair key exists. Order is the
    // whole guard here: `consume` inserts an entry for any key it has not seen,
    // and that entry lives for the full 15-minute window. Consuming the pair
    // budget first therefore let an address that was ALREADY over its IP limit
    // keep minting `ip|email` entries, one per attacker-chosen email — and
    // since `consume` scans the whole map on every call, that growth is also a
    // latency tax on every legitimate login for the rest of the window.
    if (!loginIpLimiter.consume(ip)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }
    const pairKey = `${ip}|${canonicalEmail(email)}`;
    if (!loginPairLimiter.consume(pairKey)) {
      res.status(429).json({ error: 'Too many attempts. Try again later.' });
      return;
    }

    try {
      const result = await authService.loginWithPassword(email, password);
      // A real login clears the pair budget — a user who fumbled a few
      // attempts isn't rate-limited on their next visit. (The wider per-ip
      // window intentionally keeps counting.)
      loginPairLimiter.reset(pairKey);
      setAuthCookie(res, result.token, cookieSecure);
      res.json(result);
    } catch (error) {
      // The password was right and an admin switched the account off: said
      // as such (only ever after the password is proven, see
      // `loginWithPassword`), so the person knows whom to ask.
      if (error instanceof AccountDeactivatedError) {
        res.status(403).json({ error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : 'Unknown error';
      log.error('Login error:', { detail: msg });
      res.status(401).json({ error: 'Authentication failed' });
    }
  });

  // GET /api/auth/providers — unprotected capability probe so the login screen
  // knows which login methods to render: the password form, plus one button
  // per SSO provider (label + the path that starts its flow).
  router.get('/auth/providers', (_req, res) => {
    res.json({
      password: passwordLoginEnabled,
      sso: offeredProviders(providers).map((p) => ({ key: p.key, label: p.label, startPath: p.startPath })),
    });
  });

  for (const provider of providers) provider.mountRoutes(router, authService);

  // POST /api/auth/change-password — self-service (protected). Requires the
  // current password whenever one is set; an SSO-only account sets its first
  // password without one.
  //
  // A change ends every session opened before it, this one included, so the
  // caller is handed a fresh token (body and cookie) to carry on with.
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
      const { token } = await authService.changePassword(req.userId!, currentPassword, newPassword);
      setAuthCookie(res, token, cookieSecure);
      res.json({ ok: true, token });
    } catch (error) {
      // Another session changed the password first: what this one proved is
      // no longer current, and nothing was written.
      if (error instanceof PasswordChangedMeanwhileError) {
        res.status(409).json({ error: error.message });
        return;
      }
      // A refusal the service made on purpose — a policy violation, a wrong
      // current password, an account whose password is not kept here — is
      // the caller's to fix, and its words are written for them.
      if (error instanceof PasswordRefusedError) {
        res.status(400).json({ error: error.message });
        return;
      }
      // Anything else is a fault, not a verdict: logged in full, answered
      // generic, so a driver's message never reaches a browser.
      log.error('Change-password error:', { err: error });
      res.status(500).json({ error: 'Could not change the password' });
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
      log.error('Onboarding-done error:', { detail: msg });
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
      // Logged in full, returned generic — the rule every route here follows:
      // a raw driver message would hand the caller the schema or the host.
      log.error('Auth me error:', { err: error });
      res.status(500).json({ error: 'Could not load your account' });
    }
  });

  return router;
}
