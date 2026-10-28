import { describe, expect, it, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { DbSecretsVaultService } from '../db-secrets-vault.service.js';
import { InvalidSecretError, SecretOAuthError } from '../secrets-vault.contract.js';
import { TokenCrypto } from '../../../shared/token-crypto.js';
import type { Database } from '../../database/index.js';
import { setLogger } from '../../../shared/logging.js';
import type { ILogger, LogFields } from '../../../shared/logger.contract.js';

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

describe("DbSecretsVaultService — a refused token request names the provider's error code, never its text", () => {
  const confidentialRow = (blob: Record<string, unknown>) =>
    sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      oauthMeta: { ...PUBLIC_META, publicClient: false },
      valueEncrypted: crypto.encrypt(JSON.stringify(blob)),
    });
  const SECRET = 'client-secret-1';
  const BLOB = { clientSecret: SECRET, pendingVerifier: 'the-verifier' };
  const INVALID_CLIENT =
    'Token endpoint returned HTTP 400 (invalid_client). The client id or client secret this sign-in uses is not accepted by the provider. The tool owner should check the declared client id and set the client secret again.';

  async function exchangeFailure(
    body: string | ReadableStream<Uint8Array>,
    status = 400,
    blob: Record<string, unknown> = BLOB,
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

  it('names an OAuth error code and says what to do about it, with the status', async () => {
    const client = await exchangeFailure(
      JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' }),
    );
    expect(client.message).toBe(INVALID_CLIENT);
    expect(client.providerStatus).toBe(400);
    const grant = await exchangeFailure(JSON.stringify({ error: 'invalid_grant' }));
    expect(grant.message).toBe(
      'Token endpoint returned HTTP 400 (invalid_grant). The provider refused the grant: for a sign-in, a redirect URL mismatch or an expired or reused authorization code; for a refresh, a refresh token that has expired or been revoked. Sign in again.',
    );
    const scope = await exchangeFailure(JSON.stringify({ error: 'invalid_scope' }));
    expect(scope.message).toBe(
      "Token endpoint returned HTTP 400 (invalid_scope). The provider refused the scopes this sign-in asks for. The tool owner should check the declared scopes against the provider's app.",
    );
    const unauthorized = await exchangeFailure(JSON.stringify({ error: 'unauthorized_client' }));
    expect(unauthorized.message).toBe(
      "Token endpoint returned HTTP 400 (unauthorized_client). The provider does not allow this client to use this grant. The tool owner should check the provider's app settings.",
    );
  });

  it("names a provider's own status code (HubSpot's shape) with the sentence of its OAuth equivalent", async () => {
    const err = await exchangeFailure(
      JSON.stringify({ status: 'BAD_CLIENT_SECRET', message: 'client secret does not match', correlationId: 'c1' }),
    );
    expect(err.message).toBe(INVALID_CLIENT.replace('(invalid_client)', '(BAD_CLIENT_SECRET)'));
  });

  it('takes nothing of the body but the code: descriptions, unknown shapes, plain text and cut bodies leave no trace', async () => {
    const withDescription = JSON.stringify({ error: 'invalid_client', error_description: `secret ${SECRET} rejected` });
    expect((await exchangeFailure(withDescription)).message).toBe(INVALID_CLIENT);
    for (const body of [
      JSON.stringify({ detail: `${SECRET} rejected` }),
      `<html>${SECRET} rejected</html>`,
      `${SECRET} rejected\nmore`,
      JSON.stringify({ error: 'invalid_client', error_description: SECRET }).slice(0, 30),
      JSON.stringify(`${SECRET} rejected`),
      JSON.stringify([`${SECRET} rejected`]),
      '{}',
      '',
    ]) {
      expect((await exchangeFailure(body)).message).toBe('Token endpoint returned HTTP 400');
    }
  });

  it('takes a code only when it is exactly one Hexis knows: anything else in that field is not a code', async () => {
    // A secret, a secret with a suffix, a near-miss of a known code, a
    // prototype key, free text: none is on the list, none reaches a message.
    for (const code of [
      'wordy_secret',
      'wordy_secret_rejected',
      'Invalid_Client',
      'invalid_client ',
      'invalid_token',
      'constructor',
      'bad code',
      '',
    ]) {
      const err = await exchangeFailure(JSON.stringify({ error: code }), 400, {
        clientSecret: 'wordy_secret',
        pendingVerifier: 'the-verifier',
      });
      expect(err.message).toBe('Token endpoint returned HTTP 400');
    }
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
      [confidentialRow({ clientSecret: SECRET, tokens: { access_token: 'at', refresh_token: 'rt', expires_at: 1 } })],
      undefined,
    ]);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(failing(), { status: 400 })));
    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');
    expect(JSON.parse(crypto.decrypt(captured.set[0].valueEncrypted))).toEqual({ clientSecret: SECRET });
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
    expect(err.message).toBe('Token endpoint returned HTTP 502');
    expect(pulls).toBeLessThanOrEqual(3);
    expect(cancelled).toBe(true);
  });

  it('a refused refresh is logged with the key, the outcome and the code as the sign-in is wiped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = confidentialRow({
      clientSecret: SECRET,
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
    expect(line).toContain(`refresh refused for "${KEY}", sign-in wiped: Token endpoint returned HTTP 400 (invalid_grant).`);
    expect(line).not.toContain('rt-old');
    warn.mockRestore();
  });

  it('a refused refresh that lost to a concurrent rotation logs that the rotated sign-in was kept, not wiped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = confidentialRow({
      clientSecret: SECRET,
      tokens: { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1 },
    });
    const rotated = crypto.encrypt(
      JSON.stringify({ clientSecret: SECRET, tokens: { access_token: 'rotated-at', refresh_token: 'rt-2' } }),
    );
    // The row moved on between our read and our guarded wipe: the wipe matches nothing.
    const { db, updates } = whereAwareDb({ ...row, valueEncrypted: rotated }, row.valueEncrypted);
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('refreshed');
    expect(updates).toEqual([]);

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('refresh refused'));
    expect(line).toContain(`refresh refused for "${KEY}", the row had been rotated by a concurrent refresh meanwhile`);
    expect(line).toContain('the rotated sign-in is kept: Token endpoint returned HTTP 400 (invalid_grant)');
    expect(line).not.toContain('sign-in wiped');
    warn.mockRestore();
  });

  it('a refused refresh whose wipe matched nothing because the row was replaced logs that nothing was wiped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = confidentialRow({
      clientSecret: SECRET,
      tokens: { access_token: 'at-old', refresh_token: 'rt-old', expires_at: 1 },
    });
    // Read as the OAuth row it was; by the time the wipe writes, an edit has
    // made it a static value, so the guarded wipe matches nothing and no grant
    // is there to serve: `rejected`, yet nothing was wiped.
    const { db, updates } = whereAwareDb(
      { ...row, kind: 'static', valueEncrypted: crypto.encrypt(JSON.stringify({ value: 'x' })) },
      { valueEncrypted: row.valueEncrypted, kind: 'oauth' },
    );
    const svc = new DbSecretsVaultService(db, ENC_KEY);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    await expect(svc.forceRefresh('user-1', KEY)).resolves.toBe('rejected');
    expect(updates).toEqual([]);

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('refresh refused'));
    expect(line).toContain(`refresh refused for "${KEY}", the row had been removed or replaced meanwhile; nothing wiped:`);
    expect(line).not.toContain('sign-in wiped');
    warn.mockRestore();
  });
});

describe('DbSecretsVaultService — a declared sign-in follows the live declaration', () => {
  // What the owner's client-secret save stored: client id A and its endpoints.
  const SAVED_META = {
    authorizationUrl: 'https://old.example.com/authorize',
    tokenUrl: 'https://old.example.com/token',
    clientId: 'client-A',
    scopes: ['crm.read'],
    authParams: {},
    pkce: true,
    resource: 'https://mcp.example.com/',
  };
  // What the tool file reads now: client id B.
  const LIVE = {
    authorizationUrl: 'https://app.example.com/oauth/authorize',
    tokenUrl: 'https://api.example.com/oauth/v1/token',
    clientId: 'client-B',
    scopes: ['crm.read', 'crm.write'],
    authParams: { optional_scope: 'tickets' },
    pkce: true,
    resource: 'https://mcp.example.com/',
  };
  const confidentialShared = () =>
    sharedRow({ oauthMeta: SAVED_META, valueEncrypted: crypto.encrypt(JSON.stringify({ clientSecret: 'cs-owner' })) });

  const begin = (svc: DbSecretsVaultService, provider: Record<string, unknown> = LIVE) =>
    svc.beginToolOAuthByKey({
      userId: 'user-1',
      key: KEY,
      redirectUri: 'https://bevel.example.com/api/secrets/oauth/callback',
      state: 's',
      provider: provider as never,
    });

  it('builds the consent URL from the live declaration, not the stored copy, and records it on the caller row', async () => {
    const { db, captured } = makeFakeDb([[confidentialShared()], [], [{ id: 'user-row-1' }]]);
    const { url } = await begin(new DbSecretsVaultService(db, ENC_KEY));

    const consent = new URL(url);
    expect(consent.origin + consent.pathname).toBe(LIVE.authorizationUrl);
    expect(consent.searchParams.get('client_id')).toBe('client-B');
    expect(consent.searchParams.get('resource')).toBe(LIVE.resource);
    expect(consent.searchParams.get('scope')).toBe('crm.read crm.write');
    expect(consent.searchParams.get('optional_scope')).toBe('tickets');
    const blob = JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted));
    expect(consent.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(blob.pendingVerifier).digest('base64url'),
    );
    // The secret is the owner's, unchanged; the configuration is the file's.
    expect(blob.clientSecret).toBe('cs-owner');
    expect(captured.values[0].oauthMeta).toMatchObject({ clientId: 'client-B', tokenUrl: LIVE.tokenUrl });
    expect(captured.values[0].oauthMeta.publicClient).toBeUndefined();
  });

  it('omits PKCE when the declaration opts out', async () => {
    const { db, captured } = makeFakeDb([[confidentialShared()], [], [{ id: 'user-row-1' }]]);
    const { url } = await begin(new DbSecretsVaultService(db, ENC_KEY), { ...LIVE, pkce: false });
    expect(new URL(url).searchParams.get('code_challenge')).toBeNull();
    expect(JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted)).pendingVerifier).toBeUndefined();
  });

  it('the exchange that completes it posts to the live token endpoint with client id B and the stored secret', async () => {
    const start = makeFakeDb([[confidentialShared()], [], [{ id: 'user-row-1' }]]);
    await begin(new DbSecretsVaultService(start.db, ENC_KEY));
    // The callback reads the caller row exactly as the start wrote it.
    const written = start.captured.values[0];
    const userRow = sharedRow({ id: 'user-row-1', userId: 'user-1', ...written });
    const { db } = makeFakeDb([[userRow], undefined]);
    const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new DbSecretsVaultService(db, ENC_KEY).completeOAuth('user-1', 'user-row-1', 'code', 'https://bevel.example.com/cb');

    expect(String(fetchMock.mock.calls[0][0])).toBe(LIVE.tokenUrl);
    const body = new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.get('client_id')).toBe('client-B');
    expect(body.get('client_secret')).toBe('cs-owner');
    expect(body.get('resource')).toBe(LIVE.resource);
  });

  it('a later refresh of that grant uses the configuration the consent was given for', async () => {
    const userRow = sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      oauthMeta: { ...LIVE },
      valueEncrypted: crypto.encrypt(
        JSON.stringify({ clientSecret: 'cs-owner', tokens: { access_token: 'old', refresh_token: 'rt', expires_at: 1_000 } }),
      ),
    });
    const { db } = makeFakeDb([[userRow], undefined]);
    const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      new DbSecretsVaultService(db, ENC_KEY, undefined, async () => 'user' as const).resolve('user-1', KEY),
    ).resolves.toBe('fresh');
    expect(String(fetchMock.mock.calls[0][0])).toBe(LIVE.tokenUrl);
    expect(new URLSearchParams(String(fetchMock.mock.calls[0][1]?.body)).get('client_id')).toBe('client-B');
  });

  it.each([
    ['an http:// token endpoint', { tokenUrl: 'http://api.example.com/token' }, 'tokenUrl must use https'],
    ['a loopback token endpoint', { tokenUrl: 'https://127.0.0.1/token' }, 'tokenUrl host is not allowed'],
    ['a private token endpoint', { tokenUrl: 'https://10.0.0.5/token' }, 'tokenUrl host is not allowed'],
    ['a link-local authorize endpoint', { authorizationUrl: 'https://169.254.169.254/authorize' }, 'authorizationUrl host is not allowed'],
  ])('refuses %s with the save’s validation message, writing and sending nothing', async (_name, over, message) => {
    const { db } = makeFakeDb([[confidentialShared()]]);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const err = await begin(new DbSecretsVaultService(db, ENC_KEY), { ...LIVE, ...over }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidSecretError);
    expect((err as Error).message).toBe(message);
    expect(db.insert).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses with \"owner hasn't finished\" when the shared row holds no secret, whatever it says of itself", async () => {
    // A row the platform once registered as a public client, under a file that
    // now declares its own client: the declared client is confidential.
    const { db } = makeFakeDb([[sharedRow()]]);
    await expect(begin(new DbSecretsVaultService(db, ENC_KEY))).rejects.toThrow("hasn't finished setting this up");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('keeps the tokens a re-entered sign-in already holds when the declaration is unchanged, key order notwithstanding', async () => {
    // jsonb does not keep key order: the stored copy reads back reordered.
    const reordered = Object.fromEntries(Object.entries({ ...LIVE }).reverse());
    const existing = sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      oauthMeta: reordered,
      valueEncrypted: crypto.encrypt(JSON.stringify({ clientSecret: 'cs-owner', tokens: { access_token: 'held' } })),
    });
    const { db, captured } = makeFakeDb([[confidentialShared()], [existing], [{ id: 'user-row-1' }]]);
    await begin(new DbSecretsVaultService(db, ENC_KEY));
    expect(JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted)).tokens).toEqual({ access_token: 'held' });
  });

  it('does not carry tokens minted under client A into a sign-in under client B', async () => {
    const existing = sharedRow({
      id: 'user-row-1',
      userId: 'user-1',
      oauthMeta: SAVED_META,
      valueEncrypted: crypto.encrypt(JSON.stringify({ clientSecret: 'cs-owner', tokens: { access_token: 'under-A' } })),
    });
    const { db, captured } = makeFakeDb([[confidentialShared()], [existing], [{ id: 'user-row-1' }]]);
    await begin(new DbSecretsVaultService(db, ENC_KEY));
    expect(JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted)).tokens).toBeUndefined();
  });

  it('a platform-registered client (no provider handed over) still starts from its stored row', async () => {
    const { db, captured } = makeFakeDb([[sharedRow()], [], [{ id: 'user-row-1' }]]);
    const { url } = await new DbSecretsVaultService(db, ENC_KEY).beginToolOAuthByKey({
      userId: 'user-1',
      key: KEY,
      redirectUri: 'https://bevel.example.com/cb',
      state: 's',
    });
    expect(new URL(url).searchParams.get('client_id')).toBe('dcr-client-1');
    expect(captured.values[0].oauthMeta).toEqual(PUBLIC_META);
  });

  // The moved property, pinned in both directions: the secret used to be bound to
  // the token endpoint recorded at its save; it now goes where the file says, and
  // the move leaves a line naming both origins (never a path) for an operator.
  describe('where the stored secret goes when the declaration moves the token endpoint', () => {
    const capture = () => {
      const lines: Array<{ message: string; fields?: LogFields }> = [];
      const make = (): ILogger => ({
        debug: () => {},
        info: () => {},
        warn: (message, fields) => void lines.push({ message, fields }),
        error: () => {},
        child: () => make(),
      });
      const previous = setLogger(make());
      return { lines, restore: () => setLogger(previous) };
    };

    it('follows the file to the new endpoint, and says so with both origins', async () => {
      const log = capture();
      try {
        const { db, captured } = makeFakeDb([[confidentialShared()], [], [{ id: 'user-row-1' }]]);
        await begin(new DbSecretsVaultService(db, ENC_KEY));
        expect(captured.values[0].oauthMeta.tokenUrl).toBe(LIVE.tokenUrl);
        expect(JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted)).clientSecret).toBe('cs-owner');
        expect(log.lines).toEqual([
          {
            message: `sign-in on ${KEY}: the declared token endpoint differs from the one recorded when the client secret was saved`,
            fields: { savedOrigin: 'https://old.example.com', declaredOrigin: 'https://api.example.com' },
          },
        ]);
      } finally {
        log.restore();
      }
    });

    it('says nothing when the declared token endpoint is the one recorded at the save', async () => {
      const log = capture();
      try {
        const { db } = makeFakeDb([[confidentialShared()], [], [{ id: 'user-row-1' }]]);
        await begin(new DbSecretsVaultService(db, ENC_KEY), { ...LIVE, tokenUrl: SAVED_META.tokenUrl });
        expect(log.lines).toEqual([]);
      } finally {
        log.restore();
      }
    });
  });
});
