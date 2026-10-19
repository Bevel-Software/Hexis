import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';
import { closeDb, createDb, type Database } from '../../database/connection.js';
import { agentConnections, oauthClients, oauthTokens, users } from '../../database/core-schema.js';
import { coreMigrationsDir } from '../../../assets.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';

/**
 * Refresh-token rotation as the DATABASE ends up holding it — on a real
 * Postgres, through the provider's public surface alone (a sign-in's pair
 * seeded as the token endpoint leaves one, then `exchangeRefreshToken`,
 * `verifyAccessToken` and `revokeToken`), with the clock moved by hand.
 *
 * The fake-database suite beside this pins which statements run and what
 * their predicates say; this one pins what those statements DO to a row over
 * time: a retired pair's access token verifying for the rest of its hour and
 * not after, the one replay a retired refresh token gets, a revoke ending a
 * retired pair at once, and the prune keeping a retired row for exactly as
 * long as it can still authenticate. Skipped without `TEST_DATABASE_URL`, as
 * every `*.pg.test.ts` is; CI provides one.
 */

const PREFIX = 'bevel-mcp_';
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const T0 = new Date('2026-10-19T10:00:00Z');
const HOUR = 60 * 60_000;

describe.skipIf(!PG_ADMIN_URL)('refresh-token rotation, on a real Postgres', () => {
  let db: Database;
  let provider: BevelOAuthProvider;

  beforeAll(async () => {
    // A handle that holds a personal-data key, as the application's does:
    // the seeded person's email and name are encrypted columns.
    db = createDb(await scratchDatabaseUrl('hexis_oauth'), { piiKey: randomBytes(32).toString('base64') });
    await migrate(db, { migrationsFolder: coreMigrationsDir() });
    provider = new BevelOAuthProvider({
      db,
      crypto: null,
      stateSecret: 'test-state-secret',
      publicFrontendUrl: 'https://app.example.com',
      tokenPrefix: PREFIX,
    });
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    await closeDb(db);
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  beforeEach(() => {
    // Only the clock is faked: the driver's own timers keep running.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Move the clock `n` minutes on. */
  const minutes = (n: number) => vi.setSystemTime(new Date(Date.now() + n * 60_000));

  /** The row a refresh token's hash resolves to, or undefined once pruned. */
  const rowOf = async (refreshToken: string) =>
    (await db.select().from(oauthTokens).where(eq(oauthTokens.refreshTokenHash, sha256(refreshToken))))[0];

  /**
   * A person, a registered client, the agent connection their sign-in made,
   * and the pair that sign-in minted — one of each per case, named by `tag`.
   */
  async function seed(tag: string) {
    const [user] = await db
      .insert(users)
      .values({ email: `${tag}@example.com`, emailBidx: `${tag}@example.com`, name: tag })
      .returning({ id: users.id });
    const clientId = `client-${tag}`;
    await db.insert(oauthClients).values({ clientId, redirectUris: ['https://agent.example.com/callback'] });
    const [connection] = await db
      .insert(agentConnections)
      .values({ userId: user!.id, clientId, clientName: 'Claude', agentKey: 'claude' })
      .returning({ id: agentConnections.id });
    const access = `${PREFIX}a-${tag}`;
    const refresh = `${PREFIX}r_${tag}`;
    await db.insert(oauthTokens).values({
      accessTokenHash: sha256(access),
      refreshTokenHash: sha256(refresh),
      clientId,
      userId: user!.id,
      connectionId: connection!.id,
      scope: 'mcp',
      expiresAt: new Date(Date.now() + HOUR),
      refreshExpiresAt: new Date(Date.now() + 30 * 24 * HOUR),
    });
    const client: OAuthClientInformationFull = {
      client_id: clientId,
      redirect_uris: ['https://agent.example.com/callback'],
      token_endpoint_auth_method: 'none',
    };
    return { client, access, refresh };
  }

  it("a retired pair's access token verifies for the rest of its hour, and not after", async () => {
    const { client, access, refresh } = await seed('hour');
    await expect(provider.verifyAccessToken(access)).resolves.toMatchObject({ clientId: client.client_id });

    const next = await provider.exchangeRefreshToken(client, refresh);
    const retired = await rowOf(refresh);
    expect(retired?.rotatedAt).toBeInstanceOf(Date);
    expect(retired?.revokedAt).toBeNull();
    // Retired, not revoked: the old access token is still served…
    await expect(provider.verifyAccessToken(access)).resolves.toMatchObject({ clientId: client.client_id });
    minutes(59);
    await expect(provider.verifyAccessToken(access)).resolves.toMatchObject({ clientId: client.client_id });
    // …until its own expiry, like any access token.
    minutes(2);
    await expect(provider.verifyAccessToken(access)).rejects.toBeInstanceOf(InvalidTokenError);
    // The pair the rotation minted carries on: its refresh token is good for 30 days.
    await expect(provider.exchangeRefreshToken(client, next.refresh_token!)).resolves.toMatchObject({ token_type: 'Bearer' });
  }, PG_TEST_TIMEOUT);

  it('a retired refresh token is honoured once more within the grace — which ends the retired pair — and refused after that, or later', async () => {
    const { client, access, refresh } = await seed('replay');
    const winner = await provider.exchangeRefreshToken(client, refresh);
    // The loser of a double refresh, a moment later: a fresh pair of its own.
    const loser = await provider.exchangeRefreshToken(client, refresh);
    expect(loser.refresh_token).not.toBe(winner.refresh_token);
    // The replay revoked the retired row, access token included.
    expect((await rowOf(refresh))?.revokedAt).toBeInstanceOf(Date);
    await expect(provider.verifyAccessToken(access)).rejects.toBeInstanceOf(InvalidTokenError);
    // Once: a third presentation is refused.
    await expect(provider.exchangeRefreshToken(client, refresh)).rejects.toBeInstanceOf(InvalidGrantError);
    // Both pairs are live and refresh on their own.
    const winnerNext = await provider.exchangeRefreshToken(client, winner.refresh_token!);
    await expect(provider.exchangeRefreshToken(client, loser.refresh_token!)).resolves.toMatchObject({ token_type: 'Bearer' });
    // Past the grace, a retired token is not honoured again at all.
    minutes(2);
    await expect(provider.exchangeRefreshToken(client, winner.refresh_token!)).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(provider.exchangeRefreshToken(client, winnerNext.refresh_token!)).resolves.toMatchObject({ token_type: 'Bearer' });
  }, PG_TEST_TIMEOUT);

  it('three refreshes of one token at the same instant: exactly two pairs, the third refused — the row lock decides', async () => {
    // What a client refreshing from several places at once actually sends.
    // All three read the token fresh; the row lock serialises their retires,
    // so one wins and the other two find it rotated under them; of those,
    // the replay statement admits exactly one, and the last finds the row
    // revoked. Nothing here is mocked: the database's own locking is the
    // mechanism, and this is the one place it is exercised.
    const { client, refresh } = await seed('race');
    const outcomes = await Promise.allSettled([
      provider.exchangeRefreshToken(client, refresh),
      provider.exchangeRefreshToken(client, refresh),
      provider.exchangeRefreshToken(client, refresh),
    ]);
    const fulfilled = outcomes.filter((o): o is PromiseFulfilledResult<Awaited<ReturnType<typeof provider.exchangeRefreshToken>>> => o.status === 'fulfilled');
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(InvalidGrantError);
    // Two distinct pairs, both live.
    const [a, b] = fulfilled.map((o) => o.value.refresh_token!);
    expect(a).not.toBe(b);
    await expect(provider.exchangeRefreshToken(client, a)).resolves.toMatchObject({ token_type: 'Bearer' });
    await expect(provider.exchangeRefreshToken(client, b)).resolves.toMatchObject({ token_type: 'Bearer' });
    // The original is spent for good: retired by the winner, revoked by the replay.
    const row = await rowOf(refresh);
    expect(row?.rotatedAt).toBeInstanceOf(Date);
    expect(row?.revokedAt).toBeInstanceOf(Date);
    await expect(provider.exchangeRefreshToken(client, refresh)).rejects.toBeInstanceOf(InvalidGrantError);
  }, PG_TEST_TIMEOUT);

  it("a revoke ends a retired pair's access token at once, hour or no hour", async () => {
    const { client, access, refresh } = await seed('revoke');
    await provider.exchangeRefreshToken(client, refresh);
    await expect(provider.verifyAccessToken(access)).resolves.toMatchObject({ clientId: client.client_id });
    await provider.revokeToken(client, { token: access, token_type_hint: 'access_token' });
    await expect(provider.verifyAccessToken(access)).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(provider.exchangeRefreshToken(client, refresh)).rejects.toBeInstanceOf(InvalidGrantError);
  }, PG_TEST_TIMEOUT);

  it('the prune keeps a retired row for its hour and the grace, then removes it', async () => {
    const { client, refresh } = await seed('prune');
    const next = await provider.exchangeRefreshToken(client, refresh);
    // The mint prunes, and the row it just retired is kept: it can still verify and be replayed.
    expect(await rowOf(refresh)).toBeDefined();
    minutes(30);
    const later = await provider.exchangeRefreshToken(client, next.refresh_token!);
    expect(await rowOf(refresh)).toBeDefined();
    // 62 minutes after its rotation it can do neither, and the next mint's prune drops it.
    minutes(32);
    await provider.exchangeRefreshToken(client, later.refresh_token!);
    expect(await rowOf(refresh)).toBeUndefined();
    // The row retired 32 minutes ago is still there.
    expect(await rowOf(next.refresh_token!)).toBeDefined();
  }, PG_TEST_TIMEOUT);
});
