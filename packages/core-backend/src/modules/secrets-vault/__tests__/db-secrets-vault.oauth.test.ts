import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { DbSecretsVaultService } from '../db-secrets-vault.service.js';
import { SecretOAuthError } from '../secrets-vault.contract.js';
import { TokenCrypto } from '../../../shared/token-crypto.js';
import type { Database } from '../../database/connection.js';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const crypto = new TokenCrypto(ENC_KEY);

const KEY = 'notion_MCP_OAUTH';
const RESOURCE = 'https://mcp.example.com/mcp';

/** PUBLIC-client provider meta, as auto-discovery persists it. */
const PUBLIC_META = {
  authorizationUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'dcr-client-1',
  scopes: ['mcp.read'],
  authParams: {},
  pkce: true,
  publicClient: true,
  resource: RESOURCE,
};

/** Fake drizzle chain (same shape as external-api-key.service.test.ts), capturing
 * `values`/`set` payloads so encrypted blobs can be decrypted and asserted. */
function makeFakeDb(queue: any[]) {
  const captured: { values: any[]; set: any[] } = { values: [], set: [] };
  function nextChain() {
    const result = queue.shift();
    const chain: any = {};
    const passthrough = (recorder?: (args: any[]) => void) =>
      vi.fn((...args: any[]) => {
        recorder?.(args);
        return chain;
      });
    chain.values = passthrough((a) => captured.values.push(a[0]));
    chain.set = passthrough((a) => captured.set.push(a[0]));
    chain.where = passthrough();
    chain.limit = passthrough();
    chain.from = passthrough();
    chain.returning = passthrough();
    chain.onConflictDoUpdate = passthrough();
    chain.then = (onF: any, onR: any) => Promise.resolve(result).then(onF, onR);
    return chain;
  }
  const db = {
    insert: vi.fn(() => nextChain()),
    select: vi.fn(() => nextChain()),
    update: vi.fn(() => nextChain()),
    delete: vi.fn(() => nextChain()),
  } as unknown as Database;
  return { db, captured };
}

function sharedRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'shared-1',
    userId: null,
    key: KEY,
    kind: 'oauth',
    label: 'notion sign-in',
    valueEncrypted: crypto.encrypt(JSON.stringify({})), // no clientSecret — public client
    oauthMeta: PUBLIC_META,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DbSecretsVaultService — PKCE + public-client tool OAuth', () => {
  it('beginToolOAuthByKey works for a secret-less PUBLIC client and adds PKCE + resource', async () => {
    const { db, captured } = makeFakeDb([
      [sharedRow()], // shared row lookup
      [], // no existing user row
      [{ id: 'user-row-1' }], // provisioned row
    ]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);

    const { id, url } = await svc.beginToolOAuthByKey({
      userId: 'user-1',
      key: KEY,
      redirectUri: 'https://bevel.example.com/api/secrets/oauth/callback',
      state: 'signed-state',
    });

    expect(id).toBe('user-row-1');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('resource')).toBe(RESOURCE);
    expect(parsed.searchParams.get('client_id')).toBe('dcr-client-1');

    // The challenge in the URL must be S256(verifier stored on the row).
    const blob = JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted));
    expect(typeof blob.pendingVerifier).toBe('string');
    const expectedChallenge = createHash('sha256').update(blob.pendingVerifier).digest('base64url');
    expect(parsed.searchParams.get('code_challenge')).toBe(expectedChallenge);
  });

  it('still refuses a CONFIDENTIAL client whose owner has not set the secret', async () => {
    const meta = { ...PUBLIC_META, pkce: false, publicClient: false };
    const { db } = makeFakeDb([[sharedRow({ oauthMeta: meta })]]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    await expect(
      svc.beginToolOAuthByKey({
        userId: 'user-1',
        key: KEY,
        redirectUri: 'https://bevel.example.com/cb',
        state: 's',
      }),
    ).rejects.toBeInstanceOf(SecretOAuthError);
  });

  it('completeOAuth sends the PKCE verifier + resource and drops the verifier after the exchange', async () => {
    const userRow = sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      valueEncrypted: crypto.encrypt(JSON.stringify({ pendingVerifier: 'the-verifier' })),
    });
    const { db, captured } = makeFakeDb([
      [userRow], // requireRow
      undefined, // token persist update
    ]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);

    let tokenBody: URLSearchParams | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        tokenBody = new URLSearchParams(String(init?.body));
        return new Response(
          JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'mcp.read' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await svc.completeOAuth('user-1', 'user-row-1', 'the-code', 'https://bevel.example.com/cb');

    expect(tokenBody!.get('code_verifier')).toBe('the-verifier');
    expect(tokenBody!.get('resource')).toBe(RESOURCE);
    expect(tokenBody!.get('client_secret')).toBeNull(); // public client — PKCE only

    // Verifier is one-time: the persisted blob carries tokens but no verifier.
    const stored = JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted));
    expect(stored.tokens.access_token).toBe('at-1');
    expect(stored.pendingVerifier).toBeUndefined();
  });

  it('beginToolOAuthByKey remembers the scopes it asked for, and completeOAuth takes them as granted when the provider echoes none', async () => {
    // RFC 6749 §5.1: `scope` in the token response is OPTIONAL when identical
    // to what was requested. A provider that omits it (HubSpot) granted the
    // request, not nothing — reading it as nothing would flag every declared
    // scope as missing and block the tool behind a permanent "sign in again".
    const begin = makeFakeDb([[sharedRow()], [], [{ id: 'user-row-1' }]]);
    const svc = new DbSecretsVaultService(begin.db, ENC_KEY);
    const { url } = await svc.beginToolOAuthByKey({
      userId: 'user-1',
      key: KEY,
      redirectUri: 'https://bevel.example.com/cb',
      state: 's',
      scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read'],
    });
    expect(new URL(url).searchParams.get('scope')).toBe('crm.objects.contacts.read crm.objects.companies.read');
    const pending = JSON.parse(crypto.decrypt(begin.captured.values[0].valueEncrypted));
    expect(pending.pendingScopes).toBe('crm.objects.contacts.read crm.objects.companies.read');

    const complete = async (tokenResponse: Record<string, unknown>) => {
      const userRow = sharedRow({
        id: 'user-row-1',
        userId: 'user-1',
        valueEncrypted: crypto.encrypt(
          JSON.stringify({ pendingVerifier: 'v', pendingScopes: 'crm.objects.contacts.read crm.objects.companies.read' }),
        ),
      });
      const { db, captured } = makeFakeDb([[userRow], undefined]);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify(tokenResponse), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      );
      await new DbSecretsVaultService(db, ENC_KEY).completeOAuth('user-1', 'user-row-1', 'code', 'https://bevel.example.com/cb');
      return JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted));
    };

    // No `scope` echoed → the requested scopes are the granted ones.
    const silent = await complete({ access_token: 'at-1', expires_in: 3600 });
    expect(silent.tokens.scope).toBe('crm.objects.contacts.read crm.objects.companies.read');
    expect(silent.pendingScopes).toBeUndefined(); // one-time, like the verifier
    // An echoed `scope` is the provider's word and wins — a narrower grant stays visible.
    const echoed = await complete({ access_token: 'at-2', expires_in: 3600, scope: 'crm.objects.contacts.read' });
    expect(echoed.tokens.scope).toBe('crm.objects.contacts.read');
    // …and so does an EXPLICIT empty grant: only an absent field means "as requested".
    const empty = await complete({ access_token: 'at-3', expires_in: 3600, scope: '' });
    expect(empty.tokens.scope).toBe('');
  });

  it('beginOAuth never writes a stale blob over tokens a concurrent refresh just rotated', async () => {
    // The standalone flow stashes the pending verifier/scopes with a
    // read-modify-write. Between its read and its write a refresh persists
    // rotated tokens; the guarded update misses (0 rows), the row is re-read,
    // and the pending fields are merged onto THOSE tokens.
    const stale = sharedRow({
      id: 'secret-1',
      userId: 'user-1',
      oauthMeta: { ...PUBLIC_META, pkce: false },
      valueEncrypted: crypto.encrypt(JSON.stringify({ tokens: { access_token: 'old', refresh_token: 'rt-old' } })),
    });
    const rotated = {
      ...stale,
      valueEncrypted: crypto.encrypt(JSON.stringify({ tokens: { access_token: 'new', refresh_token: 'rt-new' } })),
    };
    const { db, captured } = makeFakeDb([
      [stale], // requireRow
      [], // guarded update: the ciphertext changed underneath us
      [rotated], // re-read
      [{ id: 'secret-1' }], // guarded update against the fresh ciphertext
    ]);
    const url = await new DbSecretsVaultService(db, ENC_KEY).beginOAuth('user-1', 'secret-1', 'https://bevel.example.com/cb', 's');
    expect(new URL(url).searchParams.get('scope')).toBe('mcp.read');
    expect(captured.set).toHaveLength(2);
    const persisted = JSON.parse(crypto.decrypt(captured.set[1].valueEncrypted));
    expect(persisted.tokens).toEqual({ access_token: 'new', refresh_token: 'rt-new' });
    expect(persisted.pendingScopes).toBe('mcp.read');

    // Only a token rotation is merge-able: a row that meanwhile became another
    // provider's sign-in (or a static value) aborts, since the consent URL was
    // built for the provider we read first.
    for (const changed of [
      { ...rotated, oauthMeta: { ...PUBLIC_META, pkce: false, clientId: 'someone-else' } },
      { ...rotated, kind: 'static' },
    ]) {
      const race = makeFakeDb([[stale], [], [changed]]);
      await expect(
        new DbSecretsVaultService(race.db, ENC_KEY).beginOAuth('user-1', 'secret-1', 'https://bevel.example.com/cb', 's'),
      ).rejects.toBeInstanceOf(SecretOAuthError);
      expect(race.captured.set).toHaveLength(1); // nothing written onto the changed row
    }
  });
});

describe('DbSecretsVaultService — dead-grant detection on refresh', () => {
  const expiredTokens = {
    access_token: 'stale-at',
    refresh_token: 'dead-rt',
    expires_at: 1_000, // long past
    scope: 'mcp.read',
  };
  const userRow = () =>
    sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      valueEncrypted: crypto.encrypt(JSON.stringify({ tokens: expiredTokens })),
    });
  const userScope = async () => 'user' as const;

  it('a definitive 400/401 refresh rejection wipes the token set and resolves null', async () => {
    const { db, captured } = makeFakeDb([
      [userRow()], // resolve row lookup
      undefined, // wipe update
    ]);
    const svc = new DbSecretsVaultService(db, ENC_KEY, undefined, userScope);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })),
    );

    await expect(svc.resolve('user-1', KEY)).resolves.toBeNull();

    // The persisted blob keeps the client secret slot but no tokens — so
    // statusFor reports not-authorized and every fail-closed surface (pre-call
    // check, /connect, listing filter) routes the user to re-authorize.
    const stored = JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted));
    expect(stored.tokens).toBeUndefined();
  });

  it('a SUCCESSFUL refresh notifies mutation listeners with the row user (cache repair signal)', async () => {
    const { db } = makeFakeDb([
      [userRow()], // resolve row lookup
      undefined, // refreshed-token persist
    ]);
    const svc = new DbSecretsVaultService(db, ENC_KEY, undefined, userScope);
    const onMutation = vi.fn();
    svc.onMutation(onMutation);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh-at', refresh_token: 'rt-2', expires_in: 3600 }),
          { status: 200 },
        ),
      ),
    );

    await expect(svc.resolve('user-1', KEY)).resolves.toBe('fresh-at');
    expect(onMutation).toHaveBeenCalledWith('user-1');
  });

  it('a refresh keeps the recorded grant when `scope` is absent, and takes an echoed one — empty included', async () => {
    // Same rule as the code exchange: only an ABSENT field means "unchanged".
    const refreshWith = async (body: Record<string, unknown>) => {
      const { db, captured } = makeFakeDb([[userRow()], undefined]);
      const svc = new DbSecretsVaultService(db, ENC_KEY, undefined, userScope);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
      await svc.resolve('user-1', KEY);
      return JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted)).tokens.scope;
    };
    expect(await refreshWith({ access_token: 'a', expires_in: 3600 })).toBe('mcp.read');
    expect(await refreshWith({ access_token: 'a', expires_in: 3600, scope: 'mcp.read mcp.write' })).toBe('mcp.read mcp.write');
    expect(await refreshWith({ access_token: 'a', expires_in: 3600, scope: '' })).toBe('');
  });

  it('putSharedOAuthProvider notifies mutation listeners with null (shared → everyone)', async () => {
    const { db } = makeFakeDb([undefined]); // provider upsert
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    const onMutation = vi.fn();
    svc.onMutation(onMutation);
    await svc.putSharedOAuthProvider({
      key: KEY,
      provider: {
        clientId: 'client-1',
        authorizationUrl: 'https://idp.example.com/authorize',
        tokenUrl: 'https://idp.example.com/token',
        scopes: ['mcp.read'],
      },
    });
    expect(onMutation).toHaveBeenCalledWith(null);
  });

  it('a transient failure (network / 5xx) keeps the tokens and returns the stale one', async () => {
    for (const impl of [
      async () => new Response('bad gateway', { status: 502 }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const { db, captured } = makeFakeDb([[userRow()]]);
      const svc = new DbSecretsVaultService(db, ENC_KEY, undefined, userScope);
      vi.stubGlobal('fetch', vi.fn(impl));

      await expect(svc.resolve('user-1', KEY)).resolves.toBe('stale-at');
      expect(captured.set).toEqual([]); // nothing wiped
    }
  });
});
