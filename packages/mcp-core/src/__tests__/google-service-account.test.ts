import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommunicationProtocol, UtcpClient, UtcpClientConfigSerializer } from '@utcp/sdk';
import { HttpCallTemplateSerializer } from '@utcp/http';
// The package's own entry point: what the platform and the local server load.
import {
  GOOGLE_TOKEN_URL,
  GoogleAuthHttpProtocol,
  GoogleServiceAccountTokenSource,
  ServiceAccountAuthError,
  findUnservedGoogleServiceAccountAuth,
  installGoogleServiceAccountAuth,
  type GoogleServiceAccountAuth,
  type IServiceAccountTokenSource,
} from '../index.js';

const { privateKey: PEM, publicKey: PUBLIC } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const CLIENT_EMAIL = 'reporting@acme-ads.iam.gserviceaccount.com';
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'acme-ads',
  private_key_id: 'key-1',
  private_key: PEM,
  client_email: CLIENT_EMAIL,
  token_uri: 'https://attacker.example/token',
});

function auth(over: Partial<GoogleServiceAccountAuth> = {}): GoogleServiceAccountAuth {
  return { auth_type: 'google_service_account', credentials: KEY_JSON, scopes: 'https://www.googleapis.com/auth/adwords', ...over };
}

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** A Google token endpoint that answers every exchange with the next token in line. */
function fakeGoogle(answer: (n: number) => Response = (n) => Response.json({ access_token: `token-${n}`, expires_in: 3600 })) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: new URLSearchParams(String(init?.body)) });
    return answer(requests.length);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

describe('GoogleServiceAccountTokenSource', () => {
  it('exchanges an RS256 assertion signed with the key for an access token, at Google and nowhere else', async () => {
    const google = fakeGoogle();
    const now = 1_760_000_000_000;
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl, () => now);

    expect(await source.accessToken(auth({ subject: 'ads-admin@acme.com' }))).toBe('token-1');

    expect(google.requests).toHaveLength(1);
    const { url, body } = google.requests[0]!;
    // The key's own token_uri is ignored: the assertion only ever goes to Google.
    expect(url).toBe(GOOGLE_TOKEN_URL);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const [header, claims, signature] = body.get('assertion')!.split('.');
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-1' });
    expect(decode(claims!)).toEqual({
      iss: CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/adwords',
      aud: GOOGLE_TOKEN_URL,
      iat: now / 1000,
      exp: now / 1000 + 3600,
      sub: 'ads-admin@acme.com',
    });
    const verified = createVerify('RSA-SHA256').update(`${header}.${claims}`).end().verify(PUBLIC, signature!, 'base64url');
    expect(verified).toBe(true);
  });

  it('joins a list of scopes with spaces and sends no subject when none is named', async () => {
    const google = fakeGoogle();
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl);

    await source.accessToken(auth({ scopes: ['https://www.googleapis.com/auth/tagmanager.readonly', 'openid'] }));

    const claims = decode(google.requests[0]!.body.get('assertion')!.split('.')[1]!);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/tagmanager.readonly openid');
    expect(claims).not.toHaveProperty('sub');
  });

  it('sends scopes trimmed, however the whitespace was written', async () => {
    const google = fakeGoogle();
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl);

    await source.accessToken(auth({ scopes: ['  scope-a  ', 'scope-b scope-c'] }));
    await source.accessToken(auth({ scopes: '  scope-d   scope-e ' }));

    const scopeOf = (n: number) => decode(google.requests[n]!.body.get('assertion')!.split('.')[1]!).scope;
    expect(scopeOf(0)).toBe('scope-a scope-b scope-c');
    expect(scopeOf(1)).toBe('scope-d scope-e');
  });

  it('keeps a token until a minute before it expires, then fetches a new one', async () => {
    const google = fakeGoogle();
    let now = 1_760_000_000_000;
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl, () => now);

    expect(await source.accessToken(auth())).toBe('token-1');
    now += 58 * 60_000;
    expect(await source.accessToken(auth())).toBe('token-1');
    now += 60_000;
    expect(await source.accessToken(auth())).toBe('token-2');
    expect(google.requests).toHaveLength(2);
  });

  it('shares one exchange between calls that ask at the same time', async () => {
    const google = fakeGoogle();
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl);

    const tokens = await Promise.all([source.accessToken(auth()), source.accessToken(auth()), source.accessToken(auth())]);

    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(google.requests).toHaveLength(1);
  });

  it('keeps a separate token for each scope set and subject', async () => {
    const google = fakeGoogle();
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl);

    await source.accessToken(auth());
    await source.accessToken(auth({ scopes: 'https://www.googleapis.com/auth/tagmanager.readonly' }));
    await source.accessToken(auth({ subject: 'someone@acme.com' }));

    expect(google.requests).toHaveLength(3);
  });

  it('accepts the key JSON in base64', async () => {
    const google = fakeGoogle();
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl);

    expect(await source.accessToken(auth({ credentials: Buffer.from(KEY_JSON).toString('base64') }))).toBe('token-1');
  });

  it('says what is wrong with stored credentials without quoting them', async () => {
    const source = new GoogleServiceAccountTokenSource(fakeGoogle().fetchImpl);
    const stored = 'not-a-key-but-maybe-a-secret';

    const err = await source.accessToken(auth({ credentials: stored })).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceAccountAuthError);
    expect((err as Error).message).toMatch(/not a key JSON/);
    expect((err as Error).message).not.toContain(stored);

    const noKey = await source
      .accessToken(auth({ credentials: JSON.stringify({ client_email: CLIENT_EMAIL }) }))
      .catch((e: unknown) => e);
    expect((noKey as Error).message).toMatch(/no client_email or private_key/);
  });

  it("passes on Google's reason for refusing, holds the same token back for a few seconds, then tries again", async () => {
    const google = fakeGoogle((n) =>
      n === 1
        ? Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 })
        : Response.json({ access_token: 'token-after-fix', expires_in: 3600 }),
    );
    let now = 1_760_000_000_000;
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl, () => now);
    const refusal = `Google refused the service account ${CLIENT_EMAIL} (HTTP 400): invalid_grant: Invalid JWT Signature.`;

    await expect(source.accessToken(auth())).rejects.toThrow(refusal);
    // Answered from memory: an outage is not met with an exchange per call.
    now += 4_000;
    await expect(source.accessToken(auth())).rejects.toThrow(refusal);
    expect(google.requests).toHaveLength(1);

    now += 1_000;
    expect(await source.accessToken(auth())).toBe('token-after-fix');
    expect(google.requests).toHaveLength(2);
  });

  it("holds back for Google's Retry-After, capped at a minute", async () => {
    const google = fakeGoogle((n) =>
      n === 1
        ? Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '30' } })
        : n === 2
          ? Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '86400' } })
          : Response.json({ access_token: 'token-3', expires_in: 3600 }),
    );
    let now = 1_760_000_000_000;
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl, () => now);

    await expect(source.accessToken(auth())).rejects.toThrow(/HTTP 429/);
    now += 29_000;
    await expect(source.accessToken(auth())).rejects.toThrow(/HTTP 429/);
    expect(google.requests).toHaveLength(1);

    now += 1_000;
    await expect(source.accessToken(auth())).rejects.toThrow(/HTTP 429/);
    expect(google.requests).toHaveLength(2);
    // A day-long Retry-After holds calls back for the cap, not the day.
    now += 60_000;
    expect(await source.accessToken(auth())).toBe('token-3');
  });

  it('shares one failed exchange between concurrent calls, and never holds back a corrected key', async () => {
    const { privateKey: otherPem } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const google = fakeGoogle((n) =>
      n === 1 ? new Response('upstream down', { status: 503 }) : Response.json({ access_token: 'token-new-key', expires_in: 3600 }),
    );
    const source = new GoogleServiceAccountTokenSource(google.fetchImpl);

    const results = await Promise.allSettled([source.accessToken(auth()), source.accessToken(auth()), source.accessToken(auth())]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(google.requests).toHaveLength(1);

    const corrected = JSON.stringify({ ...JSON.parse(KEY_JSON), private_key_id: 'key-2', private_key: otherPem });
    expect(await source.accessToken(auth({ credentials: corrected }))).toBe('token-new-key');
  });
});

describe('the google_service_account auth type', () => {
  const template = (authBlock: Record<string, unknown>) => ({
    call_template_type: 'http',
    url: 'https://googleads.googleapis.com/v22/customers:listAccessibleCustomers',
    http_method: 'GET',
    auth: authBlock,
  });

  it('validates on an http call template', () => {
    const parsed = new HttpCallTemplateSerializer().validateDict(
      template({ auth_type: 'google_service_account', credentials: '${GOOGLE_SA_KEY}', scopes: ['a', 'b'], subject: 'x@acme.com' }),
    );
    expect(parsed.auth).toEqual({
      auth_type: 'google_service_account',
      credentials: '${GOOGLE_SA_KEY}',
      scopes: ['a', 'b'],
      subject: 'x@acme.com',
    });
  });

  it('is refused without scopes or credentials', () => {
    const serializer = new HttpCallTemplateSerializer();
    expect(() => serializer.validateDict(template({ auth_type: 'google_service_account', credentials: '${K}' }))).toThrow();
    expect(() => serializer.validateDict(template({ auth_type: 'google_service_account', scopes: 'a' }))).toThrow();
  });

  it('refuses blank scopes', () => {
    const serializer = new HttpCallTemplateSerializer();
    const withScopes = (scopes: unknown) =>
      template({ auth_type: 'google_service_account', credentials: '${K}', scopes });

    expect(() => serializer.validateDict(withScopes('   '))).toThrow();
    expect(() => serializer.validateDict(withScopes(['a', '  ']))).toThrow();
    expect(() => serializer.validateDict(withScopes(['  a  ', 'b']))).not.toThrow();
  });
});

describe('where the auth type may sit', () => {
  const authBlock = { auth_type: 'google_service_account', credentials: '${K}', scopes: 'a' };
  /** A document of tools, and the answer for it when its tools are called through `tools[].tool_call_template`. */
  const unservedIn = (templates: Record<string, unknown>[], rest: Record<string, unknown> = {}) => {
    const doc = { ...rest, tools: templates.map((template, i) => ({ name: `t${i}`, tool_call_template: template })) };
    return findUnservedGoogleServiceAccountAuth(doc, templates);
  };
  const NOT_AN_AUTH = "somewhere that is not a call template's `auth`";
  const NOT_CALLED_THROUGH = 'an `http` call template that no tool is called through';

  it('is served as the auth of an http template a tool is called through, however the type is written', () => {
    expect(unservedIn([{ call_template_type: 'http', url: 'https://x', auth: authBlock }])).toBeNull();
    expect(unservedIn([{ call_template_type: ' HTTP ', url: 'https://x', auth: authBlock }])).toBeNull();
  });

  it.each(['sse', 'streamable_http', 'mcp'])('names a %s call template, whose protocol would send no token', (type) => {
    expect(unservedIn([{ call_template_type: type, url: 'https://x', auth: authBlock }])).toBe(`a \`${type}\` call template`);
  });

  it('describes a call template type it does not know, rather than quoting what the file wrote', () => {
    const written = 'ghp_a-token-pasted-into-the-wrong-field';
    const where = unservedIn([{ call_template_type: written, auth: authBlock }]);
    expect(where).toBe('a call template that is not an `http` one');
    expect(where).not.toContain(written);
  });

  it('is not served by an http template that no tool is called through', () => {
    // The shape alone proves nothing: the same object, in a document whose
    // tools are not called through it, is read by nobody.
    const template = { call_template_type: 'http', url: 'https://x', auth: authBlock };
    expect(findUnservedGoogleServiceAccountAuth({ tools: [{ name: 't', tool_call_template: template }] }, [])).toBe(NOT_CALLED_THROUGH);
    // At the root of a file that discovers its tools from a url.
    expect(findUnservedGoogleServiceAccountAuth({ type: 'http', call_template_type: 'http', url: 'https://x', auth: authBlock }, [])).toBe(
      NOT_CALLED_THROUGH,
    );
    // Nested inside a template that IS served.
    expect(unservedIn([{ call_template_type: 'http', url: 'https://x', inner: { call_template_type: 'http', auth: authBlock } }])).toBe(
      NOT_CALLED_THROUGH,
    );
  });

  it('is not served anywhere that is not a call template’s auth', () => {
    expect(findUnservedGoogleServiceAccountAuth({ type: 'http', url: 'https://x', auth: authBlock }, [])).toBe(NOT_AN_AUTH);
    // `auth_tools` is read when a manual is discovered, never on a tool call.
    expect(unservedIn([{ call_template_type: 'http', url: 'https://x', auth_tools: authBlock }])).toBe(NOT_AN_AUTH);
    expect(findUnservedGoogleServiceAccountAuth(authBlock, [])).toBe(NOT_AN_AUTH);
    expect(findUnservedGoogleServiceAccountAuth([authBlock], [])).toBe(NOT_AN_AUTH);
  });

  it('finds one misplaced block among served ones, at any depth', () => {
    expect(
      unservedIn([
        { call_template_type: 'http', url: 'https://x', auth: authBlock },
        { call_template_type: 'http', url: 'https://x', inner: [{ deeper: { call_template_type: 'sse', auth: authBlock } }] },
      ]),
    ).toBe('a `sse` call template');
  });

  it('judges a block by each place it sits, when one block is written once and used twice', () => {
    // What a YAML anchor produces: the same object under two parents.
    const shared = { ...authBlock };
    expect(
      unservedIn([
        { call_template_type: 'http', url: 'https://x', auth: shared },
        { call_template_type: 'sse', url: 'https://y', auth: shared },
      ]),
    ).toBe('a `sse` call template');
  });

  it('leaves every other auth type, and a document with none, alone', () => {
    expect(unservedIn([{ call_template_type: 'sse', auth: { auth_type: 'api_key', api_key: '${K}' } }])).toBeNull();
    expect(findUnservedGoogleServiceAccountAuth(null, [])).toBeNull();
    expect(findUnservedGoogleServiceAccountAuth('google_service_account', [])).toBeNull();
  });

  it('terminates on a document that contains itself', () => {
    const cyclic: Record<string, unknown> = { call_template_type: 'sse', auth: authBlock };
    cyclic.self = cyclic;
    expect(findUnservedGoogleServiceAccountAuth(cyclic, [])).toBe('a `sse` call template');
    const benign: Record<string, unknown> = { call_template_type: 'http', auth: authBlock };
    benign.self = benign;
    expect(findUnservedGoogleServiceAccountAuth(benign, [benign])).toBeNull();
  });

  it('reads a document nested far deeper than the call stack is', () => {
    let deep: Record<string, unknown> = { call_template_type: 'sse', auth: authBlock };
    for (let i = 0; i < 200_000; i++) deep = { inner: deep };
    expect(findUnservedGoogleServiceAccountAuth(deep, [])).toBe('a `sse` call template');
  });
});

describe('loading the package', () => {
  it('leaves the service-account-aware protocol in place of the stock http one', () => {
    expect(CommunicationProtocol.communicationProtocols['http']).toBeInstanceOf(GoogleAuthHttpProtocol);
  });
});

describe('a tool call through the service-account-aware http protocol', () => {
  const seen: GoogleServiceAccountAuth[] = [];
  const tokens: IServiceAccountTokenSource = {
    accessToken: async (a) => {
      seen.push(a);
      return 'minted-token';
    },
  };
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    const manual = () => ({
      utcp_version: '1.1.0',
      manual_version: '1.0.0',
      tools: [
        {
          name: 'whoami',
          description: 'Echo the Authorization header the API received.',
          inputs: { type: 'object', properties: {} },
          outputs: { type: 'object', properties: {} },
          tool_call_template: {
            call_template_type: 'http',
            http_method: 'GET',
            url: `${base}/echo`,
            auth: { auth_type: 'google_service_account', credentials: '${SA_KEY}', scopes: 'scope-a' },
          },
        },
        {
          name: 'plain',
          description: 'A call that names no auth.',
          inputs: { type: 'object', properties: {} },
          outputs: { type: 'object', properties: {} },
          tool_call_template: { call_template_type: 'http', http_method: 'GET', url: `${base}/echo` },
        },
      ],
    });
    server = createServer((req, res) => {
      const body = req.url === '/manual' ? manual() : { authorization: req.headers.authorization ?? null };
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Answer for Google: the protocol the package installed, with these tokens.
    installGoogleServiceAccountAuth(tokens);
  });

  afterAll(async () => {
    // Back to what loading the package left: the real token source.
    installGoogleServiceAccountAuth();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('sends the minted token as a bearer header, with the key filled in from the variables', async () => {
    const client = await UtcpClient.create(
      process.cwd(),
      new UtcpClientConfigSerializer().validateDict({ variables: { gads_SA_KEY: 'the-stored-key' } }),
    );
    const registered = await client.registerManual({
      name: 'gads',
      call_template_type: 'http',
      http_method: 'GET',
      url: `${base}/manual`,
    } as Parameters<typeof client.registerManual>[0]);
    expect(registered.success).toBe(true);

    expect(await client.callTool('gads.whoami', {})).toEqual({ authorization: 'Bearer minted-token' });
    expect(seen).toEqual([{ auth_type: 'google_service_account', credentials: 'the-stored-key', scopes: 'scope-a' }]);

    // A call that names no auth is left exactly as it was.
    expect(await client.callTool('gads.plain', {})).toEqual({ authorization: null });
    expect(seen).toHaveLength(1);
  });
});
