import { describe, expect, it, vi } from 'vitest';
import { DbSecretsVaultService } from '../db-secrets-vault.service.js';
import { SecretOAuthError, type ManagedTokenRefresher, type ManagedTokenRevoker } from '../secrets-vault.contract.js';
import { TokenCrypto } from '../../../shared/token-crypto.js';
import type { Database } from '../../database/connection.js';

/**
 * A MANAGED sign-in: the tokens arrive from the broker through a handoff the
 * row was told to expect, renew through the broker, and are revoked with the
 * provider before the row goes. Everything else about the row is an ordinary
 * OAuth row, which the oauth suite covers.
 */

const ENC_KEY = Buffer.alloc(32, 9).toString('base64');
const crypto = new TokenCrypto(ENC_KEY);
const KEY = 'microsoft365_ACCESS_TOKEN';
const USER = 'user-1';
const NONCE = 'n0nce-n0nce-n0nce-n0nce';

const MANAGED_META = {
  authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  clientId: '',
  scopes: ['Mail.Read'],
  authParams: {},
  managed: { connectorId: 'microsoft365', scopeSet: 'read' },
};

/** The sequential fake drizzle chain the oauth suite uses, capturing what is written. */
function makeFakeDb(queue: unknown[]) {
  const captured: { values: Record<string, unknown>[]; set: Record<string, unknown>[] } = { values: [], set: [] };
  function nextChain() {
    const result = queue.shift();
    const chain: Record<string, unknown> = {};
    const passthrough = (recorder?: (args: unknown[]) => void) =>
      vi.fn((...args: unknown[]) => {
        recorder?.(args);
        return chain;
      });
    chain.values = passthrough((a) => captured.values.push(a[0] as Record<string, unknown>));
    chain.set = passthrough((a) => captured.set.push(a[0] as Record<string, unknown>));
    chain.where = passthrough();
    chain.limit = passthrough();
    chain.from = passthrough();
    chain.returning = passthrough();
    chain.onConflictDoUpdate = passthrough();
    chain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR);
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

function row(blob: Record<string, unknown>, meta: Record<string, unknown> = MANAGED_META, userId: string | null = USER) {
  return {
    id: 'row-1',
    userId,
    key: KEY,
    kind: 'oauth',
    label: null,
    valueEncrypted: crypto.encrypt(JSON.stringify(blob)),
    oauthMeta: meta,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const decryptSet = (captured: { set: Record<string, unknown>[] }, i = 0) =>
  JSON.parse(crypto.decrypt(captured.set[i].valueEncrypted as string)) as Record<string, unknown>;

describe('a managed sign-in: begin and the handoff', () => {
  it('begin writes a row that expects the nonce, keeping tokens a managed row already held', async () => {
    const existing = row({ tokens: { access_token: 'old', refresh_token: 'r-old' } });
    const { db, captured } = makeFakeDb([[existing], []]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    await vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE });
    const blob = decryptSet(captured);
    expect(blob.pendingNonce).toBe(NONCE);
    expect(blob.tokens).toEqual({ access_token: 'old', refresh_token: 'r-old' });
    expect(captured.set[0].oauthMeta).toMatchObject({ managed: { connectorId: 'microsoft365', scopeSet: 'read' } });
  });

  it('begin inserts a fresh row when there is none, and starts clean over a row of another kind', async () => {
    const stale = { ...row({ clientSecret: 'secret-of-an-own-app' }, { ...MANAGED_META, managed: undefined, clientId: 'own' }) };
    const { db, captured } = makeFakeDb([[stale], []]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    await vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE });
    const blob = decryptSet(captured);
    expect(blob.clientSecret).toBeUndefined();
    expect(blob.tokens).toBeUndefined();
    expect(blob.pendingNonce).toBe(NONCE);

    const fresh = makeFakeDb([[], []]);
    await new DbSecretsVaultService(fresh.db, ENC_KEY).beginManagedConnection({ userId: null, key: KEY, provider: MANAGED_META, nonce: NONCE });
    expect(fresh.captured.values[0]).toMatchObject({ userId: null, key: KEY, kind: 'oauth' });
  });

  it('the handoff lands the tokens, clears the nonce and remembers the account', async () => {
    const waiting = row({ pendingNonce: NONCE });
    const { db, captured } = makeFakeDb([[waiting], [{ id: 'row-1' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    const changed: (string | null)[] = [];
    vault.onMutation((u) => changed.push(u));
    await vault.completeManagedConnection({
      userId: USER,
      key: KEY,
      nonce: NONCE,
      tokens: { access_token: 'at', refresh_token: 'rt', expires_at: 123, scope: 'Mail.Read' },
      account: 'alice@example.com',
    });
    const blob = decryptSet(captured);
    expect(blob).toEqual({ tokens: { access_token: 'at', refresh_token: 'rt', expires_at: 123, scope: 'Mail.Read' } });
    expect(captured.set[0].oauthMeta).toMatchObject({ account: 'alice@example.com' });
    expect(changed).toEqual([USER]);
  });

  it('refuses a handoff whose nonce is wrong, and a second handoff for a nonce already used', async () => {
    const waiting = row({ pendingNonce: NONCE });
    const wrong = new DbSecretsVaultService(makeFakeDb([[waiting]]).db, ENC_KEY);
    await expect(
      wrong.completeManagedConnection({ userId: USER, key: KEY, nonce: 'other-nonce-other-nonce', tokens: { access_token: 'x' } }),
    ).rejects.toBeInstanceOf(SecretOAuthError);

    // After a handoff landed, the row holds tokens and no nonce: the same
    // handoff again finds nothing to match.
    const landed = row({ tokens: { access_token: 'at' } });
    const again = new DbSecretsVaultService(makeFakeDb([[landed]]).db, ENC_KEY);
    await expect(
      again.completeManagedConnection({ userId: USER, key: KEY, nonce: NONCE, tokens: { access_token: 'x' } }),
    ).rejects.toBeInstanceOf(SecretOAuthError);
  });

  it('refuses a handoff for a row that is not a managed sign-in, in the same words', async () => {
    const ordinary = row({ pendingNonce: NONCE }, { ...MANAGED_META, managed: undefined, clientId: 'own' });
    const vault = new DbSecretsVaultService(makeFakeDb([[ordinary]]).db, ENC_KEY);
    await expect(
      vault.completeManagedConnection({ userId: USER, key: KEY, nonce: NONCE, tokens: { access_token: 'x' } }),
    ).rejects.toThrow('No managed sign-in is waiting for this handoff');
  });
});

describe('a managed sign-in: refresh through the broker', () => {
  const expired = { access_token: 'stale', refresh_token: 'rt', expires_at: 1_000 };
  const scopeOf = async () => 'user' as const;

  it('resolve renews an expired token through the refresher and stores what it delivered', async () => {
    const stored = row({ tokens: expired });
    const { db, captured } = makeFakeDb([[stored], [{ id: 'row-1' }]]);
    const refresher: ManagedTokenRefresher = { refresh: vi.fn(async () => ({ access_token: 'fresh', expires_at: 9_000_000 })) };
    const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, scopeOf);
    vault.setManagedTokenHandlers({ refresher });
    expect(await vault.resolve(USER, KEY)).toBe('fresh');
    expect(refresher.refresh).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, 'rt');
    const blob = decryptSet(captured);
    // The refresh token is kept when the broker sends none back.
    expect(blob.tokens).toMatchObject({ access_token: 'fresh', refresh_token: 'rt' });
  });

  it('a 401 from the broker is a dead grant: the tokens are wiped, the sign-in reads as not connected', async () => {
    const stored = row({ tokens: expired });
    const { db, captured } = makeFakeDb([[stored], [{ id: 'row-1' }]]);
    const refresher: ManagedTokenRefresher = {
      refresh: vi.fn(async () => {
        throw new SecretOAuthError('The connector broker answered HTTP 401', 401);
      }),
    };
    const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, scopeOf);
    vault.setManagedTokenHandlers({ refresher });
    expect(await vault.resolve(USER, KEY)).toBeNull();
    expect(decryptSet(captured).tokens).toBeUndefined();
  });

  it('with no broker wired, an expired token is served as it is and nothing is written', async () => {
    const stored = row({ tokens: expired });
    const { db, captured } = makeFakeDb([[stored]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, scopeOf);
    expect(await vault.resolve(USER, KEY)).toBe('stale');
    expect(captured.set).toHaveLength(0);
  });

  it('forceRefresh repairs the SHARED row of a workspace connection', async () => {
    const shared = row({ tokens: expired }, MANAGED_META, null);
    const { db } = makeFakeDb([[shared], [{ id: 'row-1' }]]);
    const refresher: ManagedTokenRefresher = { refresh: vi.fn(async () => ({ access_token: 'fresh' })) };
    const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, async () => 'admin');
    vault.setManagedTokenHandlers({ refresher });
    expect(await vault.forceRefresh(USER, KEY)).toBe('refreshed');
  });
});

describe('a managed sign-in: revoked with the provider before it is deleted', () => {
  it('removeUserByKey tells the revoker first, then deletes, and deletes even when revoking fails', async () => {
    const stored = row({ tokens: { access_token: 'at', refresh_token: 'rt' } });
    const order: string[] = [];
    const revoker: ManagedTokenRevoker = {
      revoke: vi.fn(async () => {
        order.push('revoke');
      }),
    };
    const { db } = makeFakeDb([[stored], [{ id: 'row-1' }]]);
    (db as unknown as { delete: ReturnType<typeof vi.fn> }).delete.mockImplementation(() => {
      order.push('delete');
      const chain: Record<string, unknown> = {};
      chain.where = () => chain;
      chain.returning = () => Promise.resolve([{ id: 'row-1' }]);
      return chain;
    });
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    await vault.removeUserByKey(USER, KEY);
    expect(order).toEqual(['revoke', 'delete']);
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, { access_token: 'at', refresh_token: 'rt' });

    const failing: ManagedTokenRevoker = {
      revoke: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const second = makeFakeDb([[stored], [{ id: 'row-1' }]]);
    const v2 = new DbSecretsVaultService(second.db, ENC_KEY);
    v2.setManagedTokenHandlers({ revoker: failing });
    await expect(v2.removeUserByKey(USER, KEY)).resolves.toBeUndefined();
  });

  it('removeManagedRowsOfUser revokes and deletes only the managed rows, reporting how many', async () => {
    const managed = row({ tokens: { access_token: 'at' } });
    const ordinary = { ...row({ tokens: { access_token: 'o' } }, { ...MANAGED_META, managed: undefined, clientId: 'own' }), id: 'row-2', key: 'other_TOKEN' };
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    const { db } = makeFakeDb([[managed, ordinary], [{ id: 'row-1' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    expect(await vault.removeManagedRowsOfUser(USER)).toBe(1);
    expect(revoker.revoke).toHaveBeenCalledTimes(1);
  });
});

describe('status of a managed sign-in', () => {
  it('reports the shared row as authorized with its account, and an own app as such', async () => {
    const shared = row({ tokens: { access_token: 'at', scope: 'crm.objects.contacts.read' } }, { ...MANAGED_META, account: 'acme.hubspot.com' }, null);
    const { db } = makeFakeDb([[shared]]);
    const [st] = await new DbSecretsVaultService(db, ENC_KEY).statusFor(USER, [KEY]);
    expect(st).toMatchObject({ adminConfigured: true, adminAuthorized: true, adminAccount: 'acme.hubspot.com', adminBringsOwnApp: false, userConfigured: false });

    const own = row({ clientSecret: 's' }, { ...MANAGED_META, managed: undefined, clientId: 'own-app' }, null);
    const [st2] = await new DbSecretsVaultService(makeFakeDb([[own]]).db, ENC_KEY).statusFor(USER, [KEY]);
    expect(st2).toMatchObject({ adminBringsOwnApp: true, adminAuthorized: false });
  });
});
