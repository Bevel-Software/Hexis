import { randomBytes } from 'node:crypto';
import { assertSafeFetchUrl } from '../../shared/ssrf.js';

/** The single sign-on configuration a deployment would sign people in with. */
export interface OidcConfiguration {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** `<PUBLIC_BACKEND_URL>/api/auth/oidc/callback` — what the real callback sends. */
  redirectUri: string;
}

/** Which form field a definitive refusal is about — the save reports it against that input. */
export type OidcField = 'oidcIssuerUrl' | 'oidcClientSecret';

/**
 * What asking the issuer about its discovery document came to:
 *
 *  - `verified`: an OIDC issuer — it published the authorization, token and
 *    userinfo endpoints the sign-in flow uses;
 *  - `unreachable`: no discovery document came back — a refused or failed
 *    request, a non-2xx answer, or an address the outbound-URL check refuses;
 *  - `not-oidc`: a document came back, but not one this flow can sign in with.
 */
export type IssuerCheck =
  | { outcome: 'verified'; tokenEndpoint: string }
  | { outcome: 'unreachable' | 'not-oidc'; field: 'oidcIssuerUrl'; error: string };

/**
 * The three answers a configuration can give:
 *
 *  - `verified`: the issuer is an OIDC issuer, and its token endpoint accepted
 *    the application id and secret (it went on to refuse the made-up code);
 *  - `unverified`: the issuer is fine, but the token endpoint's answer says
 *    nothing definite about the credentials — saved, labelled Unverified;
 *  - `rejected`: a definitive no — the issuer (on the issuer field) or the
 *    credentials (on the secret field).
 */
export type OidcCheck =
  | { outcome: 'verified' }
  | { outcome: 'unverified'; error: string }
  | {
      outcome: 'rejected';
      reason: 'unreachable' | 'not-oidc' | 'credentials';
      field: OidcField;
      error: string;
    };

/** Bounds each request, so a hung issuer cannot hold a save open. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The token endpoint's `error` codes that mean "the client authenticated, and
 * then the code was refused". `invalid_grant` is the one RFC 6749 §5.2 names
 * for a bad authorization code, and the one every mainstream provider sends.
 */
const CODE_REJECTIONS: readonly string[] = ['invalid_grant'];

/** The issuer as the provider appends `/.well-known/...` to it: no trailing slash. */
export function normalizeIssuerUrl(issuerUrl: string): string {
  return issuerUrl.trim().replace(/\/+$/, '');
}

const UNREACHABLE = 'The provider address could not be reached — check it and try again.';
const NOT_OIDC =
  'That address is not a single sign-on provider — its discovery document is missing the authorization, token or userinfo endpoint.';

/**
 * Fetch `<issuer>/.well-known/openid-configuration` — after the deployment's
 * outbound-URL safety check — and say whether it describes an issuer the
 * sign-in flow can use. Never throws.
 */
export async function checkOidcIssuer(
  issuerUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IssuerCheck> {
  const url = `${normalizeIssuerUrl(issuerUrl)}/.well-known/openid-configuration`;
  const unreachable = (error = UNREACHABLE): IssuerCheck => ({
    outcome: 'unreachable',
    field: 'oidcIssuerUrl',
    error,
  });
  try {
    assertSafeFetchUrl(url, { requireHttps: true, label: 'issuer' });
  } catch {
    return unreachable('The provider address must be a public https:// address.');
  }
  let doc: Record<string, unknown>;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      // A redirect would take the request past the safety check above.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return unreachable();
    const body = (await res.json().catch(() => null)) as unknown;
    if (!body || typeof body !== 'object') {
      return { outcome: 'not-oidc', field: 'oidcIssuerUrl', error: NOT_OIDC };
    }
    doc = body as Record<string, unknown>;
  } catch {
    return unreachable();
  }
  const endpoint = (key: string) => (typeof doc[key] === 'string' ? (doc[key] as string) : '');
  if (!endpoint('authorization_endpoint') || !endpoint('token_endpoint') || !endpoint('userinfo_endpoint')) {
    return { outcome: 'not-oidc', field: 'oidcIssuerUrl', error: NOT_OIDC };
  }
  // The secret is about to be sent here, so the endpoint the issuer names
  // passes the same check the issuer did.
  try {
    assertSafeFetchUrl(endpoint('token_endpoint'), { requireHttps: true, label: 'token_endpoint' });
  } catch {
    return {
      outcome: 'not-oidc',
      field: 'oidcIssuerUrl',
      error: 'The provider names a token endpoint that is not a public https:// address.',
    };
  }
  return { outcome: 'verified', tokenEndpoint: endpoint('token_endpoint') };
}

/**
 * Ask the issuer whether this configuration signs people in: discovery first,
 * then a token request for an authorization code that does not exist, with the
 * application id and secret as HTTP Basic and the configured redirect URI —
 * exactly the shape the real callback sends.
 *
 * A provider authenticates the client BEFORE it looks at the code, so its
 * refusal says which half was wrong: `invalid_client` is the credentials,
 * `invalid_grant` is the code (and so the credentials passed). Nothing else is
 * read as an answer either way.
 *
 * THE SECRET GOES ONLY TO THE TOKEN ENDPOINT THIS ISSUER PUBLISHES, over https,
 * with redirects refused — and never into a log line or a returned message:
 * every message here is fixed text, and the provider's response body is read
 * for its `error` code alone.
 *
 * The ONE function both "Test sign-in configuration" and the settings save
 * call, so the button can never say "verified" about values the save refuses.
 * Never throws.
 */
export async function checkOidcConfiguration(
  config: OidcConfiguration,
  fetchImpl: typeof fetch = fetch,
): Promise<OidcCheck> {
  const issuer = await checkOidcIssuer(config.issuerUrl, fetchImpl);
  if (issuer.outcome !== 'verified') {
    return { outcome: 'rejected', reason: issuer.outcome, field: issuer.field, error: issuer.error };
  }

  const basic = Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
    'utf8',
  ).toString('base64');
  let status: number;
  let errorCode = '';
  try {
    const res = await fetchImpl(issuer.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        // Random, so it cannot collide with a code anyone was issued.
        code: `hexis-configuration-check-${randomBytes(16).toString('hex')}`,
        redirect_uri: config.redirectUri,
        code_verifier: randomBytes(32).toString('base64url'),
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = res.status;
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (body && typeof body.error === 'string') errorCode = body.error;
  } catch {
    return {
      outcome: 'unverified',
      error: 'The provider’s token endpoint did not answer, so the application ID and secret could not be verified.',
    };
  }

  if (errorCode === 'invalid_client') {
    return {
      outcome: 'rejected',
      reason: 'credentials',
      field: 'oidcClientSecret',
      error: 'The provider rejected the application ID or secret.',
    };
  }
  if (CODE_REJECTIONS.includes(errorCode)) return { outcome: 'verified' };
  // Only a plain error code is echoed — anything else could be text of the
  // provider's choosing.
  const code = /^[a-z_]{1,64}$/.test(errorCode) ? ` (${errorCode})` : ` (HTTP ${status})`;
  return {
    outcome: 'unverified',
    error: `The application ID and secret could not be verified — the provider gave an answer that does not say whether they are right${code}.`,
  };
}
