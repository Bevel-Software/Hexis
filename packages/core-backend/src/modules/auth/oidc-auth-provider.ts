import { createHash, randomBytes } from 'node:crypto';
import type express from 'express';
import type { AuthProviderPlugin } from './auth.routes.js';
import { AUTH_COOKIE_MAX_AGE_S } from './auth.routes.js';
import { AUTH_COOKIE_NAME } from './auth.middleware.js';
import type { AuthService } from './auth.service.js';

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

export interface OidcAuthProviderOptions {
  /** Issuer base URL; `<issuer>/.well-known/openid-configuration` must exist. */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Space-separated; must include `openid` (and `email` for most providers). */
  scopes: string;
  /** Login-button label shown by the login screen. */
  label: string;
  publicBackendUrl: string;
  publicFrontendUrl: string;
  /** See MicrosoftAuthDeps.cookieSecure — scheme-derived, not NODE_ENV. */
  cookieSecure: boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
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
 * configured purely from the environment (see CoreConfig `oidc*`).
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
  readonly label: string;
  readonly startPath = '/api/auth/oidc/login';

  private readonly fetchImpl: typeof fetch;
  private discovery: OidcDiscovery | null = null;

  constructor(private readonly opts: OidcAuthProviderOptions) {
    this.label = opts.label;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Fetch + cache the issuer's discovery document. Resolved lazily (not at
   * boot) so a temporarily unreachable issuer delays the first login instead
   * of failing the whole deployment; a failed attempt is not cached.
   */
  private async discover(): Promise<OidcDiscovery> {
    if (this.discovery) return this.discovery;
    const url = `${this.opts.issuerUrl}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} ${url}`);
    const doc = (await res.json()) as Partial<OidcDiscovery>;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) {
      throw new Error('OIDC discovery document is missing required endpoints');
    }
    this.discovery = {
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      userinfo_endpoint: doc.userinfo_endpoint,
    };
    return this.discovery;
  }

  private redirectUri(): string {
    return `${this.opts.publicBackendUrl}/api/auth/oidc/callback`;
  }

  mountRoutes(router: express.Router, authService: AuthService): void {
    const { publicFrontendUrl, cookieSecure } = this.opts;

    // GET /api/auth/oidc/login — start the round-trip: mint state + PKCE
    // verifier (both in one short-lived HttpOnly cookie), redirect to the
    // provider's authorization endpoint.
    router.get('/auth/oidc/login', async (_req, res) => {
      try {
        const discovery = await this.discover();
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
        url.searchParams.set('client_id', this.opts.clientId);
        url.searchParams.set('redirect_uri', this.redirectUri());
        url.searchParams.set('scope', this.opts.scopes);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        res.redirect(url.toString());
      } catch (error) {
        console.error('OIDC start error:', error instanceof Error ? error.message : error);
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

        const discovery = await this.discover();
        const basic = Buffer.from(
          `${encodeURIComponent(this.opts.clientId)}:${encodeURIComponent(this.opts.clientSecret)}`,
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
          console.error('OIDC token exchange failed:', tokenRes.status, await tokenRes.text().catch(() => ''));
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
          console.error('OIDC userinfo failed:', infoRes.status);
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
          console.error('OIDC userinfo returned no email claim');
          fail('auth');
          return;
        }
        const name =
          claims.name ??
          [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim() ??
          claims.preferred_username ??
          '';

        const { token } = await authService.loginWithSso(claims.email, name);
        res.cookie(AUTH_COOKIE_NAME, token, {
          httpOnly: true,
          sameSite: 'lax',
          secure: cookieSecure,
          maxAge: AUTH_COOKIE_MAX_AGE_S * 1000,
          path: '/',
        });
        res.redirect(`${publicFrontendUrl}/auth/oidc/callback#token=${encodeURIComponent(token)}`);
      } catch (error) {
        console.error('OIDC callback error:', error instanceof Error ? error.message : error);
        fail('auth');
      }
    });
  }
}
