import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';
import { ExternalApiKeyService } from '../../tool-auth/external-api-key.service.js';
import { closeDb, createDb, type Database } from '../../database/connection.js';
import { agentConnections, oauthClients, users } from '../../database/core-schema.js';
import { coreMigrationsDir } from '../../../assets.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';

/**
 * The "Connect as" choice — a bot's users row — through the real intermediary it is stored in: a
 * migrated Postgres. The consent's choice goes onto the one-time code at
 * Finish, crosses the token exchange onto the agent connection, and comes back
 * out of every access-token verification; a key's choice goes onto its row at
 * mint and comes back out of every key verification. Driven through the
 * provider's and the key service's public surfaces only. Skipped without
 * `TEST_DATABASE_URL`, as every `*.pg.test.ts` is.
 */

const PREFIX = 'bevel-mcp_';
const REDIRECT = 'https://agent.example.com/callback';

describe.skipIf(!PG_ADMIN_URL)('connecting as a bot, on a real Postgres', () => {
  let db: Database;
  let provider: BevelOAuthProvider;

  beforeAll(async () => {
    db = createDb(await scratchDatabaseUrl('hexis_connect_as'), { piiKey: randomBytes(32).toString('base64') });
    await migrate(db, { migrationsFolder: coreMigrationsDir() });
    provider = new BevelOAuthProvider({
      db,
      crypto: null,
      stateSecret: 'test-state-secret',
      publicFrontendUrl: 'https://app.example.com',
      tokenPrefix: PREFIX,
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb(db);
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  async function person(tag: string): Promise<string> {
    const [user] = await db
      .insert(users)
      .values({ email: `${tag}@example.com`, emailBidx: `${tag}@example.com`, name: tag })
      .returning({ id: users.id });
    return user!.id;
  }

  async function registeredClient(tag: string): Promise<OAuthClientInformationFull> {
    const clientId = `client-${tag}-${randomBytes(4).toString('hex')}`;
    await db.insert(oauthClients).values({ clientId, clientName: 'Claude', redirectUris: [REDIRECT] });
    return { client_id: clientId, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' };
  }

  /** A bot's own users row, as the bots mechanism keeps it. */
  async function bot(id: string): Promise<string> {
    const address = `${id}@agent.hexis`;
    const [row] = await db
      .insert(users)
      .values({ email: address, emailBidx: address, name: id, botId: id })
      .returning({ id: users.id });
    return row!.id;
  }

  /** Finish on the consent step with `botUserId` (undefined: the route's Myself), then the client's exchange. */
  async function consent(userId: string, client: OAuthClientInformationFull, botUserId?: string | null) {
    const st = { c: client.client_id, r: REDIRECT, cc: 'challenge', iat: Date.now() };
    const { redirectTo } =
      botUserId === undefined ? await provider.issueAuthCode(userId, st) : await provider.issueAuthCode(userId, st, botUserId);
    const code = new URL(redirectTo).searchParams.get('code')!;
    return provider.exchangeAuthorizationCode(client, code);
  }

  const connectionsOf = (userId: string) =>
    db
      .select({ id: agentConnections.id, botUserId: agentConnections.botUserId, agentPath: agentConnections.agentPath, revokedAt: agentConnections.revokedAt })
      .from(agentConnections)
      .where(eq(agentConnections.userId, userId));

  it('Myself: a consent with no choice records none and verifies with none — exactly as before', async () => {
    const userId = await person('myself');
    const tokens = await consent(userId, await registeredClient('myself'));
    expect(await connectionsOf(userId)).toEqual([{ id: expect.any(String), botUserId: null, agentPath: null, revokedAt: null }]);
    const extra = (await provider.verifyAccessToken(tokens.access_token)).extra;
    expect(extra?.botUserId).toBeNull();
    expect(extra?.agentPath).toBeNull();
  });

  it("the consent's bot round-trips to the connection row, and out of every verification", async () => {
    const userId = await person('ada');
    const coder = await bot('delivery-coder');
    const client = await registeredClient('ada');
    const tokens = await consent(userId, client, coder);

    const [row] = await connectionsOf(userId);
    expect(row!.botUserId).toBe(coder);
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra).toMatchObject({ connectionId: row!.id, botUserId: coder });
    expect(await provider.liveConnectionChoice(row!.id)).toEqual({ botUserId: coder, agentPath: null });

    // A refresh keeps the connection's choice.
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect((await provider.verifyAccessToken(refreshed.access_token)).extra?.botUserId).toBe(coder);
  });

  it('re-consenting changes the live connection, its tokens follow it, and a legacy agent path is replaced', async () => {
    const userId = await person('bea');
    const a = await bot('bot-a');
    const b = await bot('bot-b');
    const first = await consent(userId, await registeredClient('bea'), a);
    // A connection made "as an agent" before bots: only the legacy path.
    const [row] = await connectionsOf(userId);
    await db.update(agentConnections).set({ botUserId: null, agentPath: 'Agents/old.agent' }).where(eq(agentConnections.id, row!.id));
    expect((await provider.verifyAccessToken(first.access_token)).extra).toMatchObject({ botUserId: null, agentPath: 'Agents/old.agent' });

    // Claude registers afresh on every re-authorisation; the agent is one connection.
    await consent(userId, await registeredClient('bea'), null);
    const rows = await connectionsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ botUserId: null, agentPath: null });
    expect((await provider.verifyAccessToken(first.access_token)).extra?.botUserId).toBeNull();

    await consent(userId, await registeredClient('bea'), b);
    expect((await connectionsOf(userId))[0]!.botUserId).toBe(b);
  });

  it("a key's bot is stored at mint and comes back out of every verification", async () => {
    const userId = await person('cy');
    const ops = await bot('ops');
    const keys = new ExternalApiKeyService(db, 'bevel_');
    const asBot = await keys.mint(userId, 'pipeline', { botUserId: ops });
    const asMyself = await keys.mint(userId, 'laptop');

    expect(asBot.summary.botUserId).toBe(ops);
    expect(asMyself.summary.botUserId).toBeNull();
    // The key still belongs to the person; the bot rides beside it.
    expect(await keys.verifyAndLoadToken(asBot.plaintext)).toMatchObject({ user: { id: userId }, botUserId: ops, agentPath: null });
    expect((await keys.verifyAndLoadToken(asMyself.plaintext))?.botUserId).toBeNull();
    expect((await keys.listForUser(userId)).map((k) => k.botUserId).sort()).toEqual([null, ops].sort());
  });
});
