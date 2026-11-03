import { describe, expect, it, vi } from 'vitest';
import { DbSecretsVaultService } from '../db-secrets-vault.service.js';
import { managedSignInErasure } from '../managed-sign-in-erasure.js';
import { SecretOAuthError, type ManagedTokenRefresher, type ManagedTokenRevoker } from '../secrets-vault.contract.js';
import { TokenCrypto } from '../../../shared/token-crypto.js';
import type { Database } from '../../database/index.js';

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
  const captured: { values: Record<string, unknown>[]; set: Record<string, unknown>[]; where: unknown[]; for: unknown[] } = {
    values: [],
    set: [],
    where: [],
    for: [],
  };
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
    chain.where = passthrough((a) => captured.where.push(a[0]));
    chain.limit = passthrough();
    chain.from = passthrough();
    chain.returning = passthrough();
    chain.onConflictDoUpdate = passthrough();
    chain.for = passthrough((a) => captured.for.push(a[0]));
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

/**
 * Does a drizzle condition bind `value`? The condition is an SQL object whose
 * bound parameters sit in nested `queryChunks`; the test only needs to know
 * WHETHER a given ciphertext (or an `is null` chunk) is in it.
 */
function binds(cond: unknown, value: string): boolean {
  const seen = new Set<unknown>();
  const walk = (node: unknown): boolean => {
    if (node === value) return true;
    if (Array.isArray(node)) return node.some(walk);
    if (node === null || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    return Object.values(node as Record<string, unknown>).some(walk);
  };
  return walk(cond);
}

/**
 * A drizzle stub that answers UPDATEs from their WHERE clause: an update lands
 * only when its guard binds the row's CURRENT ciphertext. `reads` are what the
 * selects answer in order; `current` is the row as it is when a write arrives,
 * or null when there is no row (a fresh key).
 */
function whereAwareDb(input: { reads: ReturnType<typeof row>[]; current: ReturnType<typeof row> | null }) {
  const reads = [...input.reads];
  const captured: { values: Record<string, unknown>[]; set: Record<string, unknown>[] } = { values: [], set: [] };
  const updates: { landed: boolean }[] = [];
  const select = () => {
    const next = reads.shift() ?? input.current;
    const result = next ? [next] : [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => chain;
    chain.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) => Promise.resolve(result).then(onF, onR);
    return chain;
  };
  const update = () => {
    const chain: Record<string, unknown> = {};
    let landed = false;
    chain.set = (v: Record<string, unknown>) => {
      captured.set.push(v);
      return chain;
    };
    chain.where = (cond: unknown) => {
      landed = input.current !== null && binds(cond, input.current.valueEncrypted);
      updates.push({ landed });
      return chain;
    };
    chain.returning = () => Promise.resolve(landed && input.current ? [{ id: input.current.id }] : []);
    return chain;
  };
  const deletes: { landed: boolean }[] = [];
  const del = () => {
    const chain: Record<string, unknown> = {};
    let landed = false;
    chain.where = (cond: unknown) => {
      landed = input.current !== null && binds(cond, input.current.valueEncrypted);
      deletes.push({ landed });
      return chain;
    };
    chain.returning = () =>
      Promise.resolve(landed && input.current ? [{ id: input.current.id, userId: input.current.userId, kind: input.current.kind }] : []);
    return chain;
  };
  // An upsert with no row to conflict with INSERTS, guard or no guard, as the
  // database does; with a row there, it lands only when its `setWhere` guard
  // binds the row's CURRENT ciphertext (or carries no guard at all), and a
  // miss answers no row, as the database does when the conflict update's
  // WHERE is false.
  const inserts: { landed: boolean }[] = [];
  const insert = () => {
    const chain: Record<string, unknown> = {};
    let landed = true;
    let written: Record<string, unknown> | undefined;
    chain.values = (v: Record<string, unknown>) => {
      captured.values.push(v);
      written = v;
      return chain;
    };
    chain.onConflictDoUpdate = (cfg: { setWhere?: unknown }) => {
      landed = input.current === null || cfg.setWhere === undefined || binds(cfg.setWhere, input.current.valueEncrypted);
      inserts.push({ landed });
      return chain;
    };
    chain.returning = () => Promise.resolve(landed ? [input.current ?? { id: 'fresh-row', ...written }] : []);
    return chain;
  };
  const db = {
    select: vi.fn(select),
    update: vi.fn(update),
    insert: vi.fn(insert),
    delete: vi.fn(del),
  } as unknown as Database;
  return { db, captured, updates, deletes, inserts };
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
    const { db, captured } = makeFakeDb([[existing], [{ id: 'row-1' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    await vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE });
    const blob = decryptSet(captured);
    expect(blob.pendingNonce).toBe(NONCE);
    expect(blob.tokens).toEqual({ access_token: 'old', refresh_token: 'r-old' });
    expect(captured.set[0].oauthMeta).toMatchObject({ managed: { connectorId: 'microsoft365', scopeSet: 'read' } });
  });

  it('begin never overwrites tokens a concurrent refresh rotated: the guard misses the stale ciphertext, the re-read lands', async () => {
    const stale = row({ tokens: { access_token: 'old', refresh_token: 'r-old' } });
    const rotated = row({ tokens: { access_token: 'new', refresh_token: 'r-new' } });
    // The row as the first read sees it, and as it IS by the time the write
    // arrives. An update lands only when its guard binds the current
    // ciphertext — an unguarded write, or one guarded on the stale read,
    // fails this test.
    const { db, captured, updates } = whereAwareDb({ reads: [stale, rotated], current: rotated });
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    await vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE });
    expect(updates.map((u) => u.landed)).toEqual([false, true]);
    const landed = decryptSet(captured, 1);
    expect(landed.tokens).toEqual({ access_token: 'new', refresh_token: 'r-new' });
    expect(landed.pendingNonce).toBe(NONCE);
  });

  it('begin keeps tokens only for the SAME connection: another scope set’s token is revoked, not carried over', async () => {
    const otherSet = row({ tokens: { access_token: 'draft-token' } }, { ...MANAGED_META, managed: { connectorId: 'microsoft365', scopeSet: 'read_draft' } });
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    const { db, captured } = makeFakeDb([[otherSet], [{ id: 'row-1' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    const changed: (string | null)[] = [];
    vault.onMutation((u) => changed.push(u));
    await vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE });
    expect(decryptSet(captured).tokens).toBeUndefined();
    expect(captured.set[0].oauthMeta).not.toHaveProperty('account');
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read_draft' }, { access_token: 'draft-token', refresh_token: undefined });
    // Something else was replaced: caches are told.
    expect(changed).toEqual([USER]);
  });

  it('begin survives losing the insert race: the next pass updates the row the other start made', async () => {
    const theirs = row({ pendingNonce: 'their-nonce-their-nonce' });
    // No row; our insert collides; the re-read finds theirs; the guarded update lands.
    const { db, captured } = makeFakeDb([[], [theirs], [{ id: 'row-1' }]]);
    (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert.mockImplementationOnce(() => ({
      values: () => Promise.reject(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })),
    }));
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    await vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE });
    expect(decryptSet(captured).pendingNonce).toBe(NONCE);
  });

  it('begin gives up after repeated misses, leaving the row as it is', async () => {
    const stored = row({ tokens: { access_token: 'at' } });
    const { db } = makeFakeDb([[stored], [], [stored], [], [stored], []]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    await expect(
      vault.beginManagedConnection({ userId: USER, key: KEY, provider: MANAGED_META, nonce: NONCE }),
    ).rejects.toBeInstanceOf(SecretOAuthError);
    expect((db as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });

  it('begin inserts a fresh row when there is none, and starts clean over a row of another kind', async () => {
    const stale = { ...row({ clientSecret: 'secret-of-an-own-app' }, { ...MANAGED_META, managed: undefined, clientId: 'own' }) };
    const { db, captured } = makeFakeDb([[stale], [{ id: 'row-1' }]]);
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

  it('a handoff that names no scope is stored as covering what the sign-in asked for, not nothing', async () => {
    // Stored as unknown, the grant would cover no declared scope: the tool
    // hidden by the pre-call check, the card on "Needs reconnect", and every
    // reconnect landing the same way. The code exchange falls back to the
    // requested scopes; the handoff does the same from the row's declaration.
    const waiting = row({ pendingNonce: NONCE }, { ...MANAGED_META, scopes: ['Mail.Read', 'offline_access'] });
    const { db, captured } = makeFakeDb([[waiting], [{ id: 'row-1' }]]);
    await new DbSecretsVaultService(db, ENC_KEY).completeManagedConnection({
      userId: USER,
      key: KEY,
      nonce: NONCE,
      tokens: { access_token: 'at', refresh_token: 'rt' },
    });
    expect(decryptSet(captured).tokens).toMatchObject({ access_token: 'at', scope: 'Mail.Read offline_access' });
  });

  it('a handoff whose scope is explicitly empty is an empty grant, not a missing one', async () => {
    const waiting = row({ pendingNonce: NONCE }, { ...MANAGED_META, scopes: ['Mail.Read'] });
    const { db, captured } = makeFakeDb([[waiting], [{ id: 'row-1' }]]);
    await new DbSecretsVaultService(db, ENC_KEY).completeManagedConnection({
      userId: USER,
      key: KEY,
      nonce: NONCE,
      tokens: { access_token: 'at', scope: '' },
    });
    expect((decryptSet(captured).tokens as { scope?: string }).scope).toBe('');
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

describe('replacing a managed row is guarded on what its revoke read', () => {
  const revoker = (): ManagedTokenRevoker => ({ revoke: vi.fn(async () => undefined) });
  // Every read sees the row as it was; the row IS something else when the
  // write arrives (a refresh rotated its tokens, a handoff landed).
  const asRead = row({ tokens: { access_token: 'at-1', refresh_token: 'rt-1' } });
  const asItIs = row({ tokens: { access_token: 'at-2', refresh_token: 'rt-2' } });

  it('a write that would overwrite tokens rotated since the revoke misses, re-reads, revokes those too, and lands on the row as it is', async () => {
    const r = revoker();
    const db = whereAwareDb({ reads: [asRead, asItIs], current: asItIs });
    const vault = new DbSecretsVaultService(db.db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker: r });
    await vault.putStatic({ userId: USER, key: KEY, value: 'typed-token' });
    // The first pass revoked the tokens it read and missed; the second read
    // the rotated ones, revoked them, and its guarded write landed.
    expect(db.inserts.map((i) => i.landed)).toEqual([false, true]);
    expect(vi.mocked(r.revoke).mock.calls.map((c) => c[1].access_token)).toEqual(['at-1', 'at-2']);
  });

  it('a row that keeps changing under the revoke is left as it is, and the caller is told', async () => {
    const r = revoker();
    const db = whereAwareDb({ reads: [asRead, asRead, asRead, asRead], current: asItIs });
    const vault = new DbSecretsVaultService(db.db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker: r });
    await expect(vault.createOAuth({ userId: USER, key: KEY, provider: { ...MANAGED_META, managed: undefined, clientId: 'own-app' } })).rejects.toThrow(
      /kept changing while being replaced/,
    );
    expect(db.inserts.map((i) => i.landed)).toEqual([false, false, false]);
  });

  it('a fresh key with no row to conflict with is inserted under the guard, with nothing to revoke', async () => {
    const r = revoker();
    const db = whereAwareDb({ reads: [], current: null });
    const vault = new DbSecretsVaultService(db.db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker: r });
    const summary = await vault.putStatic({ userId: USER, key: KEY, value: 'typed-token' });
    expect(summary.key).toBe(KEY);
    expect(db.inserts).toEqual([{ landed: true }]);
    expect(r.revoke).not.toHaveBeenCalled();
  });

  it('with no revoker wired the replacement is one plain write, as before managed sign-ins', async () => {
    const db = whereAwareDb({ reads: [], current: asItIs });
    await new DbSecretsVaultService(db.db, ENC_KEY).putStatic({ userId: USER, key: KEY, value: 'typed-token' });
    expect(db.db.select).not.toHaveBeenCalled();
    expect(db.inserts).toEqual([{ landed: true }]);
  });
});

describe('a handoff survives a refresh that rotates the row under it', () => {
  it('a guard miss with the nonce still on the row re-reads and lands on the row as it is now', async () => {
    // Begun, with tokens of the same connection kept; a refresh rotated them
    // while the broker was doing the round-trip, and carried the nonce across.
    const asRead = row({ tokens: { access_token: 'at-1', refresh_token: 'rt-1' }, pendingNonce: NONCE });
    const rotated = row({ tokens: { access_token: 'at-2', refresh_token: 'rt-2' }, pendingNonce: NONCE });
    const db = whereAwareDb({ reads: [asRead, rotated], current: rotated });
    const vault = new DbSecretsVaultService(db.db, ENC_KEY);
    await vault.completeManagedConnection({ userId: USER, key: KEY, nonce: NONCE, tokens: { access_token: 'delivered' } });
    expect(db.updates.map((u) => u.landed)).toEqual([false, true]);
    const blob = JSON.parse(crypto.decrypt(db.captured.set[1].valueEncrypted as string)) as { tokens?: { access_token: string }; pendingNonce?: string };
    expect(blob.tokens?.access_token).toBe('delivered');
    expect(blob.pendingNonce).toBeUndefined();
  });

  it('a guard miss whose re-read finds the nonce gone is a handoff that already landed: refused', async () => {
    const asRead = row({ tokens: { access_token: 'at-1' }, pendingNonce: NONCE });
    const landedAlready = row({ tokens: { access_token: 'delivered' } });
    const db = whereAwareDb({ reads: [asRead, landedAlready], current: landedAlready });
    const vault = new DbSecretsVaultService(db.db, ENC_KEY);
    await expect(
      vault.completeManagedConnection({ userId: USER, key: KEY, nonce: NONCE, tokens: { access_token: 'again' } }),
    ).rejects.toThrow('No managed sign-in is waiting for this handoff');
    expect(db.updates.map((u) => u.landed)).toEqual([false]);
  });
});

describe('an account erasure removes the managed rows inside its own transaction as well', () => {
  it('locks, revokes and deletes through the transaction it is handed, touching the vault’s own connection for nothing', async () => {
    const managed = row({ tokens: { access_token: 'at', refresh_token: 'rt' } });
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    const own = makeFakeDb([]);
    const vault = new DbSecretsVaultService(own.db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    // The transaction: one locked read of the user's oauth rows, one delete.
    const tx = makeFakeDb([[managed], undefined]);
    await managedSignInErasure(vault).inTransaction(tx.db, { userId: USER });
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, { access_token: 'at', refresh_token: 'rt' });
    expect(tx.db.select).toHaveBeenCalledTimes(1);
    // Locked, not merely read: the lock is what makes a handoff arriving now wait.
    expect(tx.captured.for).toEqual(['update']);
    expect(tx.db.delete).toHaveBeenCalledTimes(1);
    expect(own.db.select).not.toHaveBeenCalled();
    expect(own.db.delete).not.toHaveBeenCalled();
  });

  it('a transaction that finds no managed row deletes nothing', async () => {
    const vault = new DbSecretsVaultService(makeFakeDb([]).db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker: { revoke: vi.fn(async () => undefined) } });
    const tx = makeFakeDb([[row({ clientSecret: 's' }, { ...MANAGED_META, managed: undefined, clientId: 'own' })]]);
    await managedSignInErasure(vault).inTransaction(tx.db, { userId: USER });
    expect(tx.db.delete).not.toHaveBeenCalled();
  });
});

describe('a managed sign-in: refresh through the broker', () => {
  const expired = { access_token: 'stale', refresh_token: 'rt', expires_at: 1_000 };
  const scopeOf = async () => 'user' as const;

  it('a broker that never answers is an outage: the stale token is served once the bound passes, and nothing is wiped', async () => {
    vi.useFakeTimers();
    try {
      const stored = row({ tokens: expired });
      const { db, captured } = makeFakeDb([[stored]]);
      const refresher: ManagedTokenRefresher = { refresh: vi.fn(() => new Promise(() => {})) };
      const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, scopeOf);
      vault.setManagedTokenHandlers({ refresher });
      const resolving = vault.resolve(USER, KEY);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await resolving).toBe('stale');
      expect(captured.set).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('a reconnect waiting for its handoff survives a refresh and a wipe in between: the nonce stays on the row', async () => {
    // `beginManagedConnection` keeps the tokens a managed row holds beside the
    // nonce it mints, so a refresh (or a dead grant's wipe) can land on the row
    // while the person is still with the provider. The handoff that follows
    // must still find its nonce.
    const waitingWithTokens = row({ tokens: expired, pendingNonce: NONCE });
    const refresher: ManagedTokenRefresher = { refresh: vi.fn(async () => ({ access_token: 'fresh', expires_at: 9_000_000 })) };
    const refreshedDb = makeFakeDb([[waitingWithTokens], [{ id: 'row-1' }]]);
    const v1 = new DbSecretsVaultService(refreshedDb.db, ENC_KEY, () => 5_000_000, scopeOf);
    v1.setManagedTokenHandlers({ refresher });
    expect(await v1.resolve(USER, KEY)).toBe('fresh');
    expect(decryptSet(refreshedDb.captured)).toMatchObject({ pendingNonce: NONCE, tokens: { access_token: 'fresh' } });

    const dead: ManagedTokenRefresher = {
      refresh: vi.fn(async () => {
        throw new SecretOAuthError('The connector broker answered HTTP 401', 401);
      }),
    };
    const wipedDb = makeFakeDb([[waitingWithTokens], [{ id: 'row-1' }]]);
    const v2 = new DbSecretsVaultService(wipedDb.db, ENC_KEY, () => 5_000_000, scopeOf);
    v2.setManagedTokenHandlers({ refresher: dead });
    expect(await v2.resolve(USER, KEY)).toBeNull();
    const wiped = decryptSet(wipedDb.captured);
    expect(wiped.tokens).toBeUndefined();
    expect(wiped.pendingNonce).toBe(NONCE);
  });

  it('with no broker wired, an expired token is served as it is and nothing is written', async () => {
    const stored = row({ tokens: expired });
    const { db, captured } = makeFakeDb([[stored]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, scopeOf);
    expect(await vault.resolve(USER, KEY)).toBe('stale');
    expect(captured.set).toHaveLength(0);
  });

  it('forceRefresh repairs the SHARED row of a workspace connection: it reads user_id IS NULL, not the caller’s row', async () => {
    const shared = row({ tokens: expired }, MANAGED_META, null);
    const { db, captured } = makeFakeDb([[shared], [{ id: 'row-1' }]]);
    const refresher: ManagedTokenRefresher = { refresh: vi.fn(async () => ({ access_token: 'fresh' })) };
    const vault = new DbSecretsVaultService(db, ENC_KEY, () => 5_000_000, async () => 'admin');
    vault.setManagedTokenHandlers({ refresher });
    expect(await vault.forceRefresh(USER, KEY)).toBe('refreshed');
    // The read's predicate: the shared tier (an `is null` on user_id), and
    // never the caller's id.
    const [readWhere] = captured.where;
    expect(binds(readWhere, ' is null')).toBe(true);
    expect(binds(readWhere, USER)).toBe(false);
    // And what was persisted is the refreshed set, on the row read.
    expect(decryptSet(captured).tokens).toMatchObject({ access_token: 'fresh', refresh_token: 'rt' });
  });
});

describe('a managed sign-in: revoked with the provider before it is deleted', () => {
  it('a delete is guarded on the ciphertext the revoke read: tokens a handoff landed in between are not deleted unrevoked', async () => {
    const before = row({ tokens: { access_token: 'at-1', refresh_token: 'rt-1' } });
    const after = row({ tokens: { access_token: 'at-2', refresh_token: 'rt-2' } });
    const revoked: string[] = [];
    const revoker: ManagedTokenRevoker = {
      revoke: vi.fn(async (_ref, tokens) => {
        revoked.push(tokens.access_token);
      }),
    };
    // The row as the first read sees it, and as it IS when the delete
    // arrives: a delete lands only when its guard binds the current
    // ciphertext, so an unguarded or stale-guarded delete fails this test.
    const { db, deletes } = whereAwareDb({ reads: [before, after], current: after });
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    await vault.removeUserByKey(USER, KEY);
    expect(revoked).toEqual(['at-1', 'at-2']);
    expect(deletes.map((d) => d.landed)).toEqual([false, true]);
  });

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
    // The user's rows; then the managed one re-read for the guarded delete; then the delete's answer.
    const { db } = makeFakeDb([[managed, ordinary], [managed], [{ id: 'row-1', userId: USER, kind: 'oauth' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    expect(await vault.removeManagedRowsOfUser(USER)).toBe(1);
    expect(revoker.revoke).toHaveBeenCalledTimes(1);
  });

  it('a bulk delete waits one revocation bound for every hung revoker, then deletes', async () => {
    vi.useFakeTimers();
    try {
      const first = row({ tokens: { access_token: 'at-1' } });
      const second = { ...row({ tokens: { access_token: 'at-2' } }), id: 'row-2', key: 'google_ACCESS_TOKEN' };
      // A revoker that never settles: the bound is the only way out.
      const revoker: ManagedTokenRevoker = { revoke: vi.fn(() => new Promise<void>(() => {})) };
      // The user's rows; the same two re-read for the guarded delete; one answer per delete.
      const { db } = makeFakeDb([
        [first, second],
        [first, second],
        [{ id: 'row-1', userId: USER, kind: 'oauth' }],
        [{ id: 'row-2', userId: USER, kind: 'oauth' }],
      ]);
      const vault = new DbSecretsVaultService(db, ENC_KEY);
      vault.setManagedTokenHandlers({ revoker });
      let settled: number | null = null;
      const removal = vault.removeManagedRowsOfUser(USER).then((n) => (settled = n));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBeNull();
      // ONE bound (the revocations run together), not one per row: a second
      // row's revocation cannot add a second wait.
      await vi.advanceTimersByTimeAsync(1);
      await removal;
      expect(settled).toBe(2);
      expect(revoker.revoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a value or an own-app client written over the caller’s managed row revokes its tokens first', async () => {
    // Every replacement of a row goes through the same guard: a typed value
    // and a registered client of the caller's own both drop the tokens the
    // broker delivered, and the provider is told before they go.
    const managed = row({ tokens: { access_token: 'at', refresh_token: 'rt' } });
    const order: string[] = [];
    const revoker: ManagedTokenRevoker = {
      revoke: vi.fn(async () => {
        order.push('revoke');
      }),
    };
    // The upsert records when it runs, so the order against the revoke is
    // what the test asserts, not only that both happened.
    const recordingInsert = (returned: unknown) => () => {
      order.push('write');
      const chain: Record<string, unknown> = {};
      chain.values = () => chain;
      chain.onConflictDoUpdate = () => chain;
      chain.returning = () => Promise.resolve([returned]);
      return chain;
    };
    const typed = makeFakeDb([[managed]]);
    (typed.db as unknown as { insert: ReturnType<typeof vi.fn> }).insert.mockImplementation(recordingInsert({ ...managed, kind: 'static' }));
    const v1 = new DbSecretsVaultService(typed.db, ENC_KEY);
    v1.setManagedTokenHandlers({ revoker });
    await v1.putStatic({ userId: USER, key: KEY, value: 'typed-token' });
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, { access_token: 'at', refresh_token: 'rt' });
    expect(order).toEqual(['revoke', 'write']);

    order.length = 0;
    const own = makeFakeDb([[managed]]);
    (own.db as unknown as { insert: ReturnType<typeof vi.fn> }).insert.mockImplementation(recordingInsert(managed));
    const v2 = new DbSecretsVaultService(own.db, ENC_KEY);
    v2.setManagedTokenHandlers({ revoker });
    await v2.createOAuth({ userId: USER, key: KEY, provider: { ...MANAGED_META, managed: undefined, clientId: 'own-app' } });
    expect(order).toEqual(['revoke', 'write']);
  });

  it('a managed row that keeps changing under the revoke is reported, and an erasure is refused rather than cascading it unrevoked', async () => {
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    // Every read sees the row as it was; by the time each delete arrives the
    // row IS something else (a refresh rotated its tokens), so the guard on
    // the ciphertext read misses — three times, the bound.
    const asRead = row({ tokens: { access_token: 'at-1', refresh_token: 'rt-1' } });
    const asItIs = row({ tokens: { access_token: 'at-2', refresh_token: 'rt-2' } });
    const unsettled = () => whereAwareDb({ reads: [asRead, asRead, asRead, asRead], current: asItIs });
    const first = unsettled();
    const vault = new DbSecretsVaultService(first.db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    await expect(vault.removeManagedRowsOfUser(USER)).rejects.toThrow(/kept changing while being revoked/);
    expect(first.deletes.map((d) => d.landed)).toEqual([false, false, false]);

    const second = unsettled();
    const v2 = new DbSecretsVaultService(second.db, ENC_KEY);
    v2.setManagedTokenHandlers({ revoker });
    await expect(managedSignInErasure(v2).before({ userId: USER })).rejects.toThrow(/kept changing/);
    expect(second.deletes.map((d) => d.landed)).toEqual([false, false, false]);
  });

  it('erasing the account revokes its managed sign-ins before the rows cascade away with the user', async () => {
    // Erasure deletes the user row and the vault rows go with it (ON DELETE
    // CASCADE); without this step an account erased while still switched on
    // would leave the grant live at the provider.
    const managed = row({ tokens: { access_token: 'at', refresh_token: 'rt' } });
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    const { db } = makeFakeDb([[managed], [managed], [{ id: 'row-1', userId: USER, kind: 'oauth' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    await managedSignInErasure(vault).before({ userId: USER });
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, { access_token: 'at', refresh_token: 'rt' });
  });
});

describe('a managed provider is accepted only where a managed sign-in is opened', () => {
  it('createOAuth still requires a client id, whatever `managed` a caller slips in', async () => {
    const vault = new DbSecretsVaultService(makeFakeDb([]).db, ENC_KEY);
    await expect(vault.createOAuth({ userId: USER, key: 'mine_TOKEN', provider: MANAGED_META })).rejects.toThrow(/clientId is required/);
  });

  it('an own app replacing a shared managed connection revokes its tokens first', async () => {
    const shared = row({ tokens: { access_token: 'at', refresh_token: 'rt' } }, MANAGED_META, null);
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    // The row as read before the revoke, then the guarded write answering the row it wrote.
    const { db } = makeFakeDb([[shared], [{ id: 'shared-row' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    await vault.putSharedOAuthClientSecret({
      key: KEY,
      clientSecret: 'own-secret',
      provider: { ...MANAGED_META, managed: undefined, clientId: 'own-app' },
    });
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, { access_token: 'at', refresh_token: 'rt' });
  });
});

describe('an owner’s own app on a managed sign-in: the start runs from the pinned client', () => {
  /** The shared row an owner pinned: the deployment's own client, no managed mark. */
  const pinned = row({ clientSecret: 'own-secret' }, { ...MANAGED_META, managed: undefined, clientId: 'own-app' }, null);
  /** The declaration as the route hands it over: a managed sign-in names no client of its own. */
  const declared = { authorizationUrl: MANAGED_META.authorizationUrl, tokenUrl: MANAGED_META.tokenUrl, clientId: '', scopes: ['Mail.Read'] };
  const start = (vault: DbSecretsVaultService) =>
    vault.beginToolOAuthByKey({ userId: USER, key: KEY, redirectUri: 'https://hexis.example/api/secrets/oauth/callback', state: 's', provider: declared });

  it('a declaration without a client id runs with the client id stored on the pinned row', async () => {
    const { db, captured } = makeFakeDb([[pinned], [], [{ id: 'row-1' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    const { url } = await start(vault);
    expect(new URL(url).searchParams.get('client_id')).toBe('own-app');
    expect(captured.values[0]).toMatchObject({ userId: USER, key: KEY, kind: 'oauth', oauthMeta: expect.objectContaining({ clientId: 'own-app' }) });
    expect((captured.values[0].oauthMeta as Record<string, unknown>).managed).toBeUndefined();
  });

  it('starting over the caller’s managed row revokes the broker’s tokens and carries none of them', async () => {
    const theirs = row({ tokens: { access_token: 'at', refresh_token: 'rt' } });
    const revoker: ManagedTokenRevoker = { revoke: vi.fn(async () => undefined) };
    // The shared row, the caller's row for the tokens it may carry, the caller's
    // row again as the guarded replacement reads it, then the write's answer.
    const { db, captured } = makeFakeDb([[pinned], [theirs], [theirs], [{ id: 'row-1' }]]);
    const vault = new DbSecretsVaultService(db, ENC_KEY);
    vault.setManagedTokenHandlers({ revoker });
    await start(vault);
    expect(revoker.revoke).toHaveBeenCalledWith({ connectorId: 'microsoft365', scopeSet: 'read' }, { access_token: 'at', refresh_token: 'rt' });
    const blob = JSON.parse(crypto.decrypt(captured.values[0].valueEncrypted as string)) as { tokens?: unknown; clientSecret?: string };
    expect(blob.tokens).toBeUndefined();
    expect(blob.clientSecret).toBe('own-secret');
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
