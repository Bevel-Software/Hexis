import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../../shared/logging.js';

const log = logger('oidc');
import type express from 'express';
import type { AuthProviderPlugin } from './auth.routes.js';
import { AUTH_COOKIE_MAX_AGE_S } from './auth.routes.js';
import { AUTH_COOKIE_NAME } from './auth.middleware.js';
import type { AuthService } from './auth.service.js';
import { normalizeIssuerUrl } from '../settings/oidc-check.js';

// Short-lived CSRF state + PKCE verifier for the OAuth round-trip: set before
// redirecting to the provider, verified/consumed on callback.
const OAUTH_STATE_COOKIE = 'oidc_oauth_state';
const OAUTH_STATE_MAX_AGE_S = 10 * 60;

/** The subset of the issuer's discovery document this provider consumes. */
interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

/** The settings that make up one OIDC configuration. */
export interface OidcSettings {
  /** Issuer base URL; `<issuer>/.well-known/openid-configuration` must exist. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated; must include `openid` (and `email` for most providers). */
  scopes: string;
  /** Login-button label shown by the login screen. */
  label: string;
}

/**
 * The OIDC configuration in effect, resolved through deployment settings —
 * the environment first, then what an admin saved on the setup screen (see
 * DeploymentSettingsService). Null unless issuer, client id and secret are
 * all set.
 */
export function oidcSettingsFrom(settings: { resolve(key: string): string }): OidcSettings | null {
  // Normalized so `<issuer>/.well-known/…` is well-formed, `https://idp/` and
  // `https://idp` are one issuer to the discovery cache, and the values a
  // sign-in records match the ones the setup screen checks.
  const issuerUrl = normalizeIssuerUrl(settings.resolve('oidcIssuerUrl'));
  const clientId = settings.resolve('oidcClientId');
  const clientSecret = settings.resolve('oidcClientSecret');
  if (!issuerUrl || !clientId || !clientSecret) return null;
  return {
    issuerUrl,
    clientId,
    clientSecret,
    scopes: settings.resolve('oidcScopes') || 'openid profile email',
    label: settings.resolve('oidcProviderLabel') || 'Single sign-on',
  };
}

export interface OidcAuthProviderOptions {
  /**
   * The configuration in effect, or null while it is incomplete. Called on
   * every probe and every sign-in step rather than once at construction, so a
   * configuration saved on a running deployment applies to the next sign-in
   * without a restart.
   */
  settings(): OidcSettings | null;
  publicBackendUrl: string;
  publicFrontendUrl: string;
  /** See MicrosoftAuthDeps.cookieSecure — scheme-derived, not NODE_ENV. */
  cookieSecure: boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Called after someone has signed in through this provider, with the
   * configuration that sign-in used — the proof that those values work.
   * Failures are logged, never fail the sign-in.
   */
  onSignedIn?: (used: OidcSettings) => void | Promise<void>;
}

/**
 * The redirect URI to register with the provider — and the one the
 * configuration check sends. `publicBackendUrl` arrives from CoreConfig
 * without userinfo or a trailing slash, so it is used exactly as configured.
 */
export function oidcRedirectUri(publicBackendUrl: string): string {
  return `${publicBackendUrl}/api/auth/oidc/callback`;
}

/** Read one named cookie from the raw header (no cookie-parser dep, matching auth.middleware). */
function readCookie(req: express.Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    if (!value) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

/**
 * Generic OIDC single sign-on as an {@link AuthProviderPlugin} — works with
 * any spec-compliant provider (Entra, Okta, Auth0, Keycloak, Google, …),
 * configured from the environment or the setup screen ({@link oidcSettingsFrom}).
 *
 * Registered once and LIVE: the configuration is read on every use, so the
 * provider is advertised only while it is complete ({@link isEnabled}), its
 * label and scopes follow the latest save, and a changed issuer is
 * re-discovered on the next sign-in.
 *
 * Flow: authorization-code with PKCE (S256) as a confidential client.
 * Identity claims come from the `userinfo` endpoint called with the freshly
 * exchanged access token — the token arrived over TLS directly from the
 * issuer's token endpoint, so no local id_token signature verification (and
 * no JWKS handling) is needed to trust it.
 *
 * Register `<PUBLIC_BACKEND_URL>/api/auth/oidc/callback` as the redirect URI
 * with the provider.
 */
export class OidcAuthProvider implements AuthProviderPlugin {
  readonly key = 'oidc';
  readonly startPath = '/api/auth/oidc/login';

  private readonly fetchImpl: typeof fetch;
  /**
   * The discovery for exactly one issuer — the one last asked for. Held as a
   * promise so concurrent sign-ins share one fetch; replaced whenever the
   * issuer differs, so no other issuer's document is ever served.
   */
  private discovery: { issuerUrl: string; doc: Promise<OidcDiscovery> } | null = null;

  constructor(private readonly opts: OidcAuthProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get label(): string {
    return this.opts.settings()?.label ?? '';
  }

  isEnabled(): boolean {
    return this.opts.settings() !== null;
  }

  /**
   * Fetch + cache the issuer's discovery document. Resolved lazily (not at
   * boot) so a temporarily unreachable issuer delays the first login instead
   * of failing the whole deployment; a failed attempt is not cached.
   */
  private discover(issuerUrl: string): Promise<OidcDiscovery> {
    if (this.discovery?.issuerUrl === issuerUrl) return this.discovery.doc;
    const entry = { issuerUrl, doc: this.fetchDiscovery(issuerUrl) };
    this.discovery = entry;
    entry.doc.catch(() => {
      if (this.discovery === entry) this.discovery = null;
    });
    return entry.doc;
  }

  private async fetchDiscovery(issuerUrl: string): Promise<OidcDiscovery> {
    const url = `${issuerUrl}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${url}`);
    const doc = (await res.json()) as Partial<OidcDiscovery>;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
      throw new Error('OIDC discovery document is missing required endpoints');
    }
    return {
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      userinfo_endpoint: doc.userinfo_endpoint,
    };
  }

  private redirectUri(): string {
    return oidcRedirectUri(this.opts.publicBackendUrl);
  }

  mountRoutes(router: express.Router, authService: AuthService): void {
    const { publicFrontendUrl, cookieSecure } = this.opts;

    // GET /api/auth/oidc/login — start the round-trip: mint state + PKCE
    // verifier (both in one short-lived HttpOnly cookie), redirect to the
    // provider's authorization endpoint. An incomplete configuration is an
    // answer, not an error: back to the sign-in page, which says so.
    router.get('/auth/oidc/login', async (_req, res) => {
      const oidc = this.opts.settings();
      if (!oidc) {
        res.redirect(`${publicFrontendUrl}/auth/oidc/callback#error=not_configured`);
        return;
      }
      try {
        const discovery = await this.discover(oidc.issuerUrl);
        const state = randomBytes(16).toString('hex');
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        res.cookie(OAUTH_STATE_COOKIE, `${state}.${verifier}`, {
          httpOnly: true,
          sameSite: 'lax',
          secure: cookieSecure,
          maxAge: OAUTH_STATE_MAX_AGE_S * 1000,
          path: '/',
        });
        const url = new URL(discovery.authorization_endpoint);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', oidc.clientId);
        url.searchParams.set('redirect_uri', this.redirectUri());
        url.searchParams.set('scope', oidc.scopes);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        res.redirect(url.toString());
      } catch (error) {
        log.error('OIDC start error:', { err: error });
        res.redirect(`${publicFrontendUrl}/auth/oidc/callback#error=start`);
      }
    });

    // GET /api/auth/oidc/callback — verify state, exchange the code (PKCE +
    // client secret), read identity from userinfo, issue the app JWT, and hand
    // it to the frontend in the URL fragment (kept out of query/logs/Referer).
    router.get('/auth/oidc/callback', async (req, res) => {
      const fail = (reason: string) =>
        res.redirect(`${publicFrontendUrl}/auth/oidc/callback#error=${reason}`);
      try {
        const { code, state } = req.query as { code?: string; state?: string };
        const cookie = readCookie(req, OAUTH_STATE_COOKIE);
        res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
        const [expectedState, verifier] = cookie?.split('.') ?? [];
        if (!code || !state || !expectedState || !verifier || state !== expectedState) {
          fail('state');
          return;
        }

        // Read again rather than carried from the login step: the token
        // endpoint is asked with whatever is in effect now.
        const oidc = this.opts.settings();
        if (!oidc) {
          fail('not_configured');
          return;
        }
        const discovery = await this.discover(oidc.issuerUrl);
        const basic = Buffer.from(
          `${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`,
          'utf8',
        ).toString('base64');
        const tokenRes = await this.fetchImpl(discovery.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basic}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: this.redirectUri(),
            code_verifier: verifier,
          }).toString(),
        });
        if (!tokenRes.ok) {
          log.error('OIDC token exchange failed:', {
            status: tokenRes.status,
            body: await tokenRes.text().catch(() => ''),
          });
          fail('auth');
          return;
        }
        const tokens = (await tokenRes.json()) as { access_token?: string };
        if (!tokens.access_token) {
          fail('auth');
          return;
        }

        const infoRes = await this.fetchImpl(discovery.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (!infoRes.ok) {
          log.error('OIDC userinfo failed:', { status: infoRes.status });
          fail('auth');
          return;
        }
        const claims = (await infoRes.json()) as {
          email?: string;
          name?: string;
          preferred_username?: string;
          given_name?: string;
          family_name?: string;
        };
        if (!claims.email) {
          // Most likely a missing `email` scope / claim mapping at the provider.
          log.error('OIDC userinfo returned no email claim');
          fail('auth');
          return;
        }
        const name =
          claims.name ??
          [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim() ??
          claims.preferred_username ??
          '';

        const { token } = await authService.loginWithSso(claims.email, name);
        try {
          await this.opts.onSignedIn?.(oidc);
        } catch (error) {
          log.error('OIDC sign-in record failed:', { err: error });
        }
        res.cookie(AUTH_COOKIE_NAME, token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: cookieSecure,
          maxAge: AUTH_COOKIE_MAX_AGE_S * 1000,
          path: '/',
        });
        res.redirect(`${publicFrontendUrl}/auth/oidc/callback#token=${encodeURIComponent(token)}`);
      } catch (error) {
        log.error('OIDC callback error:', { err: error });
        fail('auth');
      }
    });
  }
}
