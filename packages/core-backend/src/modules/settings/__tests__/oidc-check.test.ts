import { describe, expect, it, vi } from 'vitest';
import { checkOidcConfiguration, checkOidcIssuer, type OidcConfiguration } from '../oidc-check.js';

const ISSUER = 'https://login.example.com/tenant/v2.0';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const TOKEN_URL = 'https://tokens.example.com/oauth2/token';
const SECRET = 's3cr3t-value-never-echoed';

const CONFIG: OidcConfiguration = {
  issuerUrl: ISSUER,
  clientId: 'app-id',
  clientSecret: SECRET,
  redirectUri: 'https://hexis.example.com/api/auth/oidc/callback',
};

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: 'https://login.example.com/authorize',
  token_endpoint: TOKEN_URL,
  userinfo_endpoint: 'https://login.example.com/userinfo',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A provider: discovery answers `discovery`, the token endpoint answers `token`. */
function provider(discovery: () => Response | Promise<Response>, token?: () => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === DISCOVERY_URL) return discovery();
    if (url === TOKEN_URL && token) return token();
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('checkOidcIssuer — discovery', () => {
  it('verifies an issuer whose document names all three endpoints', async () => {
    const fetchImpl = provider(() => json(200, DISCOVERY));
    expect(await checkOidcIssuer(`${ISSUER}/`, fetchImpl)).toEqual({ outcome: 'verified', tokenEndpoint: TOKEN_URL });
    // Trailing slash normalized, redirects refused.
    expect(fetchImpl.mock.calls[0][0]).toBe(DISCOVERY_URL);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('reports a network failure as not reachable', async () => {
    const fetchImpl = provider(() => {
      throw new TypeError('fetch failed');
    });
    expect(await checkOidcIssuer(ISSUER, fetchImpl)).toMatchObject({ outcome: 'unreachable', field: 'oidcIssuerUrl' });
  });

  it('reports a 404 as not reachable', async () => {
    const fetchImpl = provider(() => new Response('nope', { status: 404 }));
    expect(await checkOidcIssuer(ISSUER, fetchImpl)).toMatchObject({ outcome: 'unreachable', field: 'oidcIssuerUrl' });
  });

  it.each(['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint'])(
    'reports a document without %s as not an OIDC issuer',
    async (missing) => {
      const doc: Record<string, string> = { ...DISCOVERY };
      delete doc[missing];
      expect(await checkOidcIssuer(ISSUER, provider(() => json(200, doc)))).toMatchObject({
        outcome: 'not-oidc',
        field: 'oidcIssuerUrl',
      });
    },
  );

  it('reports a body that is not JSON as not an OIDC issuer', async () => {
    const fetchImpl = provider(() => new Response('<html>hello</html>', { status: 200 }));
    expect(await checkOidcIssuer(ISSUER, fetchImpl)).toMatchObject({ outcome: 'not-oidc' });
  });

  it.each([
    'https://127.0.0.1/realms/x',
    'https://169.254.169.254/latest',
    'https://localhost:8443',
    'https://[::1]/issuer',
    'http://login.example.com',
  ])('refuses %s before any request is made (outbound-URL check)', async (issuer) => {
    const fetchImpl = provider(() => json(200, DISCOVERY));
    expect(await checkOidcIssuer(issuer, fetchImpl)).toMatchObject({ outcome: 'unreachable', field: 'oidcIssuerUrl' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a token endpoint on an internal address, so the secret is never sent there', async () => {
    const fetchImpl = provider(() => json(200, { ...DISCOVERY, token_endpoint: 'https://10.0.0.5/token' }));
    const result = await checkOidcConfiguration(CONFIG, fetchImpl);
    expect(result).toMatchObject({ outcome: 'rejected', reason: 'not-oidc', field: 'oidcIssuerUrl' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('checkOidcConfiguration — token probe', () => {
  it('sends an invalid code with the redirect URI and Basic credentials, to the published token endpoint only', async () => {
    const fetchImpl = provider(
      () => json(200, DISCOVERY),
      () => json(400, { error: 'invalid_grant' }),
    );
    await checkOidcConfiguration(CONFIG, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`app-id:${SECRET}`).toString('base64')}`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(CONFIG.redirectUri);
    expect(form.get('code')).toBeTruthy();
    // The secret travels in the header alone, and discovery never carried it.
    expect(String(init.body)).not.toContain(SECRET);
    const discoveryInit = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(JSON.stringify(discoveryInit)).not.toContain(Buffer.from(`app-id:${SECRET}`).toString('base64'));
  });

  it('invalid_client: the provider rejected the application id or secret — on the secret field', async () => {
    const result = await checkOidcConfiguration(
      CONFIG,
      provider(() => json(200, DISCOVERY), () => json(401, { error: 'invalid_client', error_description: `bad ${SECRET}` })),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: 'credentials',
      field: 'oidcClientSecret',
      error: 'The provider rejected the application ID or secret.',
    });
  });

  it('invalid_grant: credentials verified', async () => {
    const result = await checkOidcConfiguration(
      CONFIG,
      provider(() => json(200, DISCOVERY), () => json(400, { error: 'invalid_grant' })),
    );
    expect(result).toEqual({ outcome: 'verified' });
  });

  it.each([
    ['another error code', () => json(400, { error: 'unsupported_grant_type' })],
    ['a server error', () => new Response('oops', { status: 500 })],
    ['a success (nothing to conclude from)', () => json(200, { access_token: 'x' })],
    ['no answer at all', () => {
      throw new TypeError('fetch failed');
    }],
  ])('%s: could not be verified', async (_name, token) => {
    const result = await checkOidcConfiguration(CONFIG, provider(() => json(200, DISCOVERY), token));
    expect(result.outcome).toBe('unverified');
  });

  it('never returns the secret or provider-chosen text in a message', async () => {
    const results = await Promise.all([
      checkOidcConfiguration(CONFIG, provider(() => json(200, DISCOVERY), () => json(401, { error: 'invalid_client', error_description: SECRET }))),
      checkOidcConfiguration(CONFIG, provider(() => json(200, DISCOVERY), () => json(400, { error: `weird ${SECRET}` }))),
      checkOidcConfiguration(CONFIG, provider(() => json(404, {}))),
    ]);
    for (const result of results) expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('a discovery failure stops before the token endpoint and rejects on the issuer field', async () => {
    const fetchImpl = provider(() => new Response('', { status: 404 }), () => json(400, { error: 'invalid_grant' }));
    expect(await checkOidcConfiguration(CONFIG, fetchImpl)).toMatchObject({
      outcome: 'rejected',
      reason: 'unreachable',
      field: 'oidcIssuerUrl',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
