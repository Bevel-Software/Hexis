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

/**
 * A drizzle stub that ANSWERS FROM THE WHERE-CLAUSE, for the one assertion the
 * sequential `makeFakeDb` cannot make: that the optimistic-concurrency guard
 * (`eq(valueEncrypted, <the ciphertext we read>)`) is what stops a stale write.
 *
 * `current` is the row as it is NOW — already rotated by a concurrent refresh.
 * `stale` is the ciphertext the caller read a moment before that, which the
 * FIRST select hands back; any later select sees `current`. An UPDATE is
 * applied unless its where-clause binds `stale`, i.e. unless it is guarded on
 * a version the row has moved past. Remove the guard from the code under test
 * and the UPDATE lands — which is what makes such a test fail.
 */
function whereAwareDb(
  current: Record<string, unknown> & { valueEncrypted: string },
  /** The ciphertext the caller read first — or the whole row as it read then, when more than the ciphertext has since changed. */
  staleRead: string | (Partial<Record<string, unknown>> & { valueEncrypted: string }),
) {
  const updates: Array<Record<string, unknown>> = [];
  let row = { ...current };
  let firstSelect = true;
  const staleRow = typeof staleRead === 'string' ? { valueEncrypted: staleRead } : staleRead;
  const stale = staleRow.valueEncrypted;
  // Drizzle builds the condition into an SQL object whose bound parameters sit
  // in nested `queryChunks`; the test only needs to know WHETHER a given
  // ciphertext was bound, so it scans the object graph for that string.
  const binds = (cond: unknown, value: string): boolean => {
    const seen = new Set<unknown>();
    const walk = (node: unknown): boolean => {
      if (node === value) return true;
      if (node === null || typeof node !== 'object' || seen.has(node)) return false;
      seen.add(node);
      return Object.values(node as Record<string, unknown>).some(walk);
    };
    return walk(cond);
  };
  type Thenable<T> = { then: (onF: (v: T) => unknown, onR?: (e: unknown) => unknown) => Promise<unknown> };
  type SelectChain = Thenable<Array<Record<string, unknown>>> & {
    from: () => SelectChain;
    where: () => SelectChain;
    limit: () => SelectChain;
  };
  type UpdateChain = Thenable<Array<{ id: unknown }>> & {
    set: (values: Record<string, unknown>) => UpdateChain;
    where: (cond: unknown) => UpdateChain;
    returning: () => UpdateChain;
  };
  const db = {
    select: (): SelectChain => {
      const chain: SelectChain = {
        from: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (onF, onR) => {
          const seen = firstSelect ? { ...row, ...staleRow } : row;
          firstSelect = false;
          return Promise.resolve([seen]).then(onF, onR);
        },
      };
      return chain;
    },
    update: (): UpdateChain => {
      let payload: Record<string, unknown> = {};
      let matched = true;
      const chain: UpdateChain = {
        set: (values) => {
          payload = values;
          return chain;
        },
        where: (cond) => {
          matched = !binds(cond, stale) || stale === row.valueEncrypted;
          return chain;
        },
        returning: () => chain,
        then: (onF, onR) => {
          if (matched) {
            updates.push(payload);
            row = { ...row, ...payload } as typeof row;
          }
          return Promise.resolve(matched ? [{ id: row.id }] : []).then(onF, onR);
        },
      };
      return chain;
    },
  };
  return { db: db as unknown as Database, updates };
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

describe('DbSecretsVaultService — forceRefresh (a downstream rejected the token)', () => {
  // NOT expired by its own account: the stored expiry is an hour away. The
  // downstream's 401 is what says the token is dead.
  const liveTokens = () => ({
    access_token: 'rejected-at',
    refresh_token: 'rt-1',
    expires_at: Date.now() + 3_600_000,
    scope: 'mcp.read',
  });
  const userRow = (blob: Record<string, unknown> = { clientSecret: 'client-secret-1', tokens: liveTokens() }) =>
    sharedRow({ id: 'user-row-1', userId: 'user-1', valueEncrypted: crypto.encrypt(JSON.stringify(blob)) });

  it('refreshes ignoring the stored expiry, persists the fresh tokens and notifies', async () => {
    const { db, captured } = makeFakeDb([[userRow()], undefined]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    const onMutation = vi.fn();
    svc.onMutation(onMutation);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'fresh-at', expires_in: 3600 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('refreshed');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted));
    expect(stored.tokens.access_token).toBe('fresh-at');
    expect(stored.tokens.refresh_token).toBe('rt-1'); // provider omitted it — kept
    expect(stored.clientSecret).toBe('client-secret-1');
    expect(onMutation).toHaveBeenCalledWith('user-1');
  });

  it('a definitive rejection wipes the tokens, keeps the client secret, and the sign-in reads not connected', async () => {
    for (const status of [400, 401]) {
      const { db, captured } = makeFakeDb([[userRow()], undefined]);
      const svc = new DbSecretsVaultService(db, ENC_KEY);
      const onMutation = vi.fn();
      svc.onMutation(onMutation);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status })));

      await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');

      const wiped = captured.set[0].valueEncrypted;
      const stored = JSON.parse(crypto.decrypt(wiped));
      expect(stored).toEqual({ clientSecret: 'client-secret-1' });
      expect(onMutation).toHaveBeenCalledWith('user-1');

      // What list_tool_setup and /connect read: the row exists, the sign-in does not.
      const status2 = makeFakeDb([[{ key: KEY, userId: 'user-1', kind: 'oauth', valueEncrypted: wiped }]]);
      const [row] = await new DbSecretsVaultService(status2.db, ENC_KEY).statusFor('user-1', [KEY]);
      expect(row).toMatchObject({ userConfigured: true, userAuthorized: false });
    }
  });

  it('a transient failure (network / 5xx) keeps the token untouched', async () => {
    for (const impl of [
      async () => new Response('bad gateway', { status: 503 }),
      async () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const { db, captured } = makeFakeDb([[userRow()]]);
      const svc = new DbSecretsVaultService(db, ENC_KEY);
      vi.stubGlobal('fetch', vi.fn(impl));

      await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('transient');
      expect(captured.set).toEqual([]);
    }
  });

  it('a rejected token with no refresh token to try is a dead grant: wiped', async () => {
    const { access_token } = liveTokens();
    const { db, captured } = makeFakeDb([[userRow({ tokens: { access_token } })], undefined]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted)).tokens).toBeUndefined();
  });

  it('a concurrent refresh that already rotated the tokens wins over our stale rejection', async () => {
    const rotated = crypto.encrypt(JSON.stringify({ tokens: { access_token: 'rotated-at', refresh_token: 'rt-2' } }));
    // Not the sequential stub: this one READS the where-clause, so the wipe
    // matches nothing precisely BECAUSE the row's ciphertext moved on. Drop the
    // optimistic-concurrency guard from `wipeTokens` and the UPDATE matches, the
    // rotated grant is wiped, and this test fails — which is the point of it.
    const { db, updates } = whereAwareDb({ ...userRow(), valueEncrypted: rotated }, userRow().valueEncrypted);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('refreshed');
    expect(updates).toEqual([]); // the guarded wipe never matched the rotated row
  });

  it('a refresh whose write loses the same race serves what the winner stored, not our unwritten token', async () => {
    const rotated = crypto.encrypt(JSON.stringify({ tokens: { access_token: 'rotated-at', refresh_token: 'rt-2' } }));
    const { db, updates } = whereAwareDb({ ...userRow(), valueEncrypted: rotated }, userRow().valueEncrypted);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    const onMutation = vi.fn();
    svc.onMutation(onMutation);
    // Our OWN refresh succeeds — but the row moved on while it was in flight.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'ours-at', expires_in: 3600 }), { status: 200 })),
    );

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('refreshed');

    // Nothing persisted, so nothing is announced and `resolve` keeps serving
    // the winner's token — never the one that exists only in this call frame.
    expect(updates).toEqual([]);
    expect(onMutation).not.toHaveBeenCalled();
  });

  it('a refresh that loses the race to a WIPE reports the grant not connected', async () => {
    const wipedOut = crypto.encrypt(JSON.stringify({ clientSecret: 'client-secret-1' }));
    const { db, updates } = whereAwareDb({ ...userRow(), valueEncrypted: wipedOut }, userRow().valueEncrypted);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'ours-at', expires_in: 3600 }), { status: 200 })),
    );

    // A concurrent path found the grant dead and wiped it; the stored truth is
    // "not connected", and that is what the caller is told.
    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');
    expect(updates).toEqual([]);
  });

  it('a refresh that loses the race to a row turned STATIC reports not connected, whatever the value parses as', async () => {
    // The edit that replaced the sign-in stored a static value shaped exactly
    // like a token blob. It is not a grant, and must not be served as one.
    const lookalike = crypto.encrypt(JSON.stringify({ tokens: { access_token: 'not-a-grant' } }));
    // Read as the OAuth row it was; by the time the refresh writes, it is static.
    const { db, updates } = whereAwareDb(
      { ...userRow(), kind: 'static', valueEncrypted: lookalike },
      { valueEncrypted: userRow().valueEncrypted, kind: 'oauth' },
    );
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'ours-at', expires_in: 3600 }), { status: 200 })),
    );

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');
    expect(updates).toEqual([]);
  });

  it('nothing to refresh — no row, or never signed in — is skipped without a provider call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const rows of [[], [userRow({ clientSecret: 'client-secret-1' })]]) {
      const { db } = makeFakeDb([rows]);
      await expect(new DbSecretsVaultService(db, ENC_KEY).forceRefresh('user-1', KEY)).resolves.toBe('skipped');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('DbSecretsVaultService — a refused token request says why', () => {
  const confidentialRow = (blob: Record<string, unknown>) =>
    sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      oauthMeta: { ...PUBLIC_META, publicClient: false },
      valueEncrypted: crypto.encrypt(JSON.stringify(blob)),
    });

  async function exchangeFailure(
    body: string | ReadableStream<Uint8Array>,
    status = 400,
    blob: Record<string, unknown> = { clientSecret: 'client-secret-1', pendingVerifier: 'the-verifier' },
  ): Promise<SecretOAuthError> {
    const { db } = makeFakeDb([[confidentialRow(blob)]]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
    try {
      await svc.completeOAuth('user-1', 'user-row-1', 'the-code', 'https://bevel.example.com/cb');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretOAuthError);
      return err as SecretOAuthError;
    }
    throw new Error('the exchange was expected to fail');
  }

  it('carries the OAuth error and its description, and the status', async () => {
    const err = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: 'client authentication failed' }),
    );
    expect(err.message).toBe('Token endpoint returned HTTP 400: invalid_client — client authentication failed');
    expect(err.providerStatus).toBe(400);
  });

  it("carries a provider's status and message pair (HubSpot's shape)", async () => {
    const err = await exchangeFailure(
      JSON.stringify({ status: 'BAD_CLIENT_SECRET', message: 'client secret does not match', correlationId: 'c1' }),
    );
    expect(err.message).toBe('Token endpoint returned HTTP 400: BAD_CLIENT_SECRET — client secret does not match');
  });

  it('keeps the first line of a body that is not an OAuth error, and cuts a long reason', async () => {
    const err = await exchangeFailure('<html>Bad Gateway</html>\nsecond line', 502);
    expect(err.message).toBe('Token endpoint returned HTTP 502: <html>Bad Gateway</html>');
    // Within the read cap, so the body parses; the reason itself is cut to length.
    const long = await exchangeFailure(JSON.stringify({ error: 'server_error', error_description: 'x'.repeat(1500) }));
    expect(long.message.length).toBeLessThan(400);
    expect(long.message.endsWith('…')).toBe(true);
    // A plain-text body longer than the read cap was cut there: nothing of it is quoted.
    const cutPlain = await exchangeFailure('x'.repeat(5000));
    expect(cutPlain.message).toBe('Token endpoint returned HTTP 400');
  });

  it('adds nothing for an empty body', async () => {
    const err = await exchangeFailure('');
    expect(err.message).toBe('Token endpoint returned HTTP 400');
  });

  it('redacts every request secret a provider echoes', async () => {
    const err = await exchangeFailure(
      JSON.stringify({
        error: 'invalid_client',
        error_description: 'secret client-secret-1 rejected for code the-code (verifier the-verifier)',
      }),
    );
    expect(err.message).toBe(
      'Token endpoint returned HTTP 400: invalid_client — secret *** rejected for code *** (verifier ***)',
    );
  });

  it('redacts a secret a JSON body carries in its escaped spelling', async () => {
    // In the body the secret reads `se\"cr\\et`; parsing spells it out again,
    // so a scrub of the raw body would miss it and the log would carry it.
    const err = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: 'secret se"cr\\et refused' }),
      400,
      { clientSecret: 'se"cr\\et', pendingVerifier: 'the-verifier' },
    );
    expect(err.message).toBe('Token endpoint returned HTTP 400: invalid_client — secret *** refused');
  });

  it('never quotes JSON as written: an unknown shape contributes its decoded strings, a cut JSON body nothing', async () => {
    const blob = { clientSecret: 'se"cr\\et', pendingVerifier: 'the-verifier' };
    // No known field: the decoded string values, scrubbed — not the raw text
    // where the secret reads `se\"cr\\et` and no plain-spelling scrub finds it.
    const unknown = await exchangeFailure(JSON.stringify({ detail: 'se"cr\\et rejected', code: 17 }), 400, blob);
    expect(unknown.message).toBe('Token endpoint returned HTTP 400: *** rejected');
    // A JSON body cut short at the read cap does not parse; its first line is
    // JSON as written, so it contributes nothing but the status.
    const cut = JSON.stringify({ error: 'invalid_client', error_description: 'se"cr\\et rejected' }).slice(0, 40);
    const truncated = await exchangeFailure(cut, 400, blob);
    expect(truncated.message).toBe('Token endpoint returned HTTP 400');
    // A plain-text body keeps its first line; a secret there is spelled plainly.
    const plain = await exchangeFailure('se"cr\\et rejected\nmore', 400, blob);
    expect(plain.message).toBe('Token endpoint returned HTTP 400: *** rejected');
    // A cut JSON STRING does not parse and does not start with a brace, yet it
    // is JSON as written all the same: nothing but the status.
    const cutString = await exchangeFailure(JSON.stringify('refused se"cr\\et here').slice(0, 18), 400, blob);
    expect(cutString.message).toBe('Token endpoint returned HTTP 400');
  });

  it('scrubs a plain-text body whole before taking its first line, so a secret with a line break leaves no head', async () => {
    const err = await exchangeFailure('refused: first-half\nsecond-half of it\nmore', 400, {
      clientSecret: 'first-half\nsecond-half',
      pendingVerifier: 'the-verifier',
    });
    // Split first, the line would read `refused: first-half`.
    expect(err.message).toBe('Token endpoint returned HTTP 400: refused: *** of it');
  });

  it('redacts a secret the provider quotes back in its wire spelling', async () => {
    // A provider that echoes the request echoes it as received: percent-encoded
    // in a URL, form-encoded in a body (`+` for a space).
    const encoded = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: 'client_secret=a%2Bb%2Fc%3D rejected' }),
      400,
      { clientSecret: 'a+b/c=', pendingVerifier: 'the-verifier' },
    );
    expect(encoded.message).toBe('Token endpoint returned HTTP 400: invalid_client — client_secret=*** rejected');
    const form = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: 'client_secret=pass+word+here rejected' }),
      400,
      { clientSecret: 'pass word here', pendingVerifier: 'the-verifier' },
    );
    expect(form.message).toBe('Token endpoint returned HTTP 400: invalid_client — client_secret=*** rejected');
  });

  it('quotes no plain text from a body cut at the read cap, where the head of a secret could end it', async () => {
    // 2045 spaces then the secret: the cap (2048 bytes) ends on its first three
    // characters, too few for the redactor's echoed-prefix floor to catch.
    const cut = await exchangeFailure(`${' '.repeat(2045)}abcXYZsecret and more`, 400, {
      clientSecret: 'abcXYZsecret',
      pendingVerifier: 'the-verifier',
    });
    expect(cut.message).toBe('Token endpoint returned HTTP 400');
    // A plain-text body that merely FILLS the cap (2048 bytes exactly) is
    // complete and is quoted, cut to the reason's own length.
    const full = await exchangeFailure(`${'x'.repeat(2040)} refused`, 400);
    expect(full.message.startsWith('Token endpoint returned HTTP 400: xxx')).toBe(true);
    expect(full.message.endsWith('…')).toBe(true);
  });

  it('keeps the status when the refusal body cannot be read, so a refused refresh still retires the grant', async () => {
    const failing = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('connection reset');
        },
      });
    const err = await exchangeFailure(failing(), 401);
    expect(err.message).toBe('Token endpoint returned HTTP 401');
    expect(err.providerStatus).toBe(401);

    const { db, captured } = makeFakeDb([
      [confidentialRow({ clientSecret: 'client-secret-1', tokens: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } })],
      undefined,
    ]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(failing(), { status: 400 })));
    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');
    expect(JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted))).toEqual({ clientSecret: 'client-secret-1' });
  });

  it('redacts a secret with whitespace in it, and one the length cut would otherwise split', async () => {
    // Scrubbed on the body as received: collapsing whitespace or cutting to
    // length first would leave such a secret, or a fragment of it, in the log.
    const spaced = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: 'refused:  pass  word\n echoed' }),
      400,
      { clientSecret: 'pass  word\n', pendingVerifier: 'the-verifier' },
    );
    expect(spaced.message).toBe('Token endpoint returned HTTP 400: invalid_client — refused: *** echoed');

    // "invalid_client — " + 275 x + a space puts the secret at character 293 of
    // the reason, across the 300-character cut: cut first, "client-" survives.
    const straddling = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: `${'x'.repeat(275)} client-secret-1 ${'y'.repeat(50)}` }),
    );
    expect(straddling.message).not.toContain('client-');
    expect(straddling.message).toContain('***');
    expect(straddling.message.length).toBeLessThan(400);
  });

  it('reads a refusal body only up to its cap and cancels the rest of the stream', async () => {
    // Without the cap this never returns: the stream has no end.
    let pulls = 0;
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('z'.repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const err = await exchangeFailure(endless, 502);
    // Cut at the cap, so no plain text is quoted: the status alone.
    expect(err.message).toBe('Token endpoint returned HTTP 502');
    expect(pulls).toBeLessThanOrEqual(4);
    expect(cancelled).toBe(true);
  });

  it('a refused refresh is logged with the key and the reason as the sign-in is wiped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = confidentialRow({
      clientSecret: 'client-secret-1',
      tokens: { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1 },
    });
    const { db } = makeFakeDb([[row], undefined]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'rt-old was revoked' }), {
            status: 400,
          }),
      ),
    );

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('refresh refused'));
    expect(line).toContain(
      `refresh refused for "${KEY}", sign-in wiped: Token endpoint returned HTTP 400: invalid_grant — *** was revoked`,
    );
    warn.mockRestore();
  });

  it('a refused refresh that lost to a concurrent rotation logs that the rotated sign-in was kept, not wiped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = confidentialRow({
      clientSecret: 'client-secret-1',
      tokens: { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1 },
    });
    const rotated = crypto.encrypt(
      JSON.stringify({ clientSecret: 'client-secret-1', tokens: { access_token: 'rotated-at', refresh_token: 'rt-2' } }),
    );
    // The row moved on between our read and our guarded wipe: the wipe matches nothing.
    const { db, updates } = whereAwareDb({ ...row, valueEncrypted: rotated }, row.valueEncrypted);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('refreshed');
    expect(updates).toEqual([]);

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('refresh refused'));
    expect(line).toContain(`refresh refused for "${KEY}" against a token a concurrent refresh had already rotated`);
    expect(line).toContain('the rotated sign-in is kept: Token endpoint returned HTTP 400: invalid_grant');
    expect(line).not.toContain('wiped');
    warn.mockRestore();
  });
});
