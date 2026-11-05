import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { BevelOAuthProvider } from '../oauth/bevel-oauth-provider.js';
import { ExternalApiKeyService } from '../../tool-auth/external-api-key.service.js';
import { closeDb, createDb, type Database } from '../../database/connection.js';
import { agentConnections, externalApiKeys, oauthClients, users } from '../../database/core-schema.js';
import { coreMigrationsDir } from '../../../assets.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, scratchDatabaseUrl } from '../../../__tests__/pg-scratch.js';

/**
 * The "Connect as" choice, through the real intermediary it is stored in: a
 * migrated Postgres. The consent's choice goes onto the one-time code at
 * Finish, crosses the token exchange onto the agent connection, and comes back
 * out of every access-token verification; a key's choice goes onto its row at
 * mint and comes back out of every key verification. Driven through the
 * provider's and the key service's public surfaces only. Skipped without
 * `TEST_DATABASE_URL`, as every `*.pg.test.ts` is.
 */

const PREFIX = 'bevel-mcp_';
const REDIRECT = 'https://agent.example.com/callback';

describe.skipIf(!PG_ADMIN_URL)('connecting as an agent, on a real Postgres', () => {
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

  /** Finish on the consent step with `agentPath` (undefined: the route's Everything), then the client's exchange. */
  async function consent(userId: string, client: OAuthClientInformationFull, agentPath?: string | null) {
    const st = { c: client.client_id, r: REDIRECT, cc: 'challenge', iat: Date.now() };
    const { redirectTo } =
      agentPath === undefined ? await provider.issueAuthCode(userId, st) : await provider.issueAuthCode(userId, st, agentPath);
    const code = new URL(redirectTo).searchParams.get('code')!;
    return provider.exchangeAuthorizationCode(client, code);
  }

  const connectionsOf = (userId: string) =>
    db
      .select({ id: agentConnections.id, agentPath: agentConnections.agentPath, revokedAt: agentConnections.revokedAt })
      .from(agentConnections)
      .where(eq(agentConnections.userId, userId));

  it('Everything: a consent with no choice records null and verifies with none — exactly as before', async () => {
    const userId = await person('everything');
    const tokens = await consent(userId, await registeredClient('everything'));
    expect(await connectionsOf(userId)).toEqual([{ id: expect.any(String), agentPath: null, revokedAt: null }]);
    expect((await provider.verifyAccessToken(tokens.access_token)).extra?.agentPath).toBeNull();
  });

  it("the consent's choice round-trips to the connection row, and out of every verification", async () => {
    const userId = await person('ada');
    const client = await registeredClient('ada');
    const tokens = await consent(userId, client, 'Agents/delivery-mechanic.agent');

    const [row] = await connectionsOf(userId);
    expect(row!.agentPath).toBe('Agents/delivery-mechanic.agent');
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra).toMatchObject({ connectionId: row!.id, agentPath: 'Agents/delivery-mechanic.agent' });

    // A refresh keeps the connection's choice.
    const refreshed = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
    expect((await provider.verifyAccessToken(refreshed.access_token)).extra?.agentPath).toBe('Agents/delivery-mechanic.agent');
  });

  it('re-consenting with another choice changes the live connection, and its tokens follow it', async () => {
    const userId = await person('bea');
    const first = await consent(userId, await registeredClient('bea'), 'Agents/a.agent');
    // Claude registers afresh on every re-authorisation; the agent is one connection.
    await consent(userId, await registeredClient('bea'), null);

    const rows = await connectionsOf(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.agentPath).toBeNull();
    // The earlier pair still verifies — and now as the connection's choice.
    expect((await provider.verifyAccessToken(first.access_token)).extra?.agentPath).toBeNull();

    await consent(userId, await registeredClient('bea'), 'Agents/b.agent');
    expect((await connectionsOf(userId))[0]!.agentPath).toBe('Agents/b.agent');
  });

  it("a key's choice is stored at mint and comes back out of every verification", async () => {
    const userId = await person('cy');
    const keys = new ExternalApiKeyService(db, 'bevel_');
    const asAgent = await keys.mint(userId, 'pipeline', { agentPath: 'Agents/ops.agent' });
    const asEverything = await keys.mint(userId, 'laptop');

    expect(asAgent.summary.agentPath).toBe('Agents/ops.agent');
    expect(asEverything.summary.agentPath).toBeNull();
    expect((await keys.verifyAndLoadToken(asAgent.plaintext))?.agentPath).toBe('Agents/ops.agent');
    expect((await keys.verifyAndLoadToken(asEverything.plaintext))?.agentPath).toBeNull();

    const stored = await db
      .select({ label: externalApiKeys.label, agentPath: externalApiKeys.agentPath })
      .from(externalApiKeys)
      .where(eq(externalApiKeys.userId, userId));
    expect(stored.sort((a, b) => a.label.localeCompare(b.label))).toEqual([
      { label: 'laptop', agentPath: null },
      { label: 'pipeline', agentPath: 'Agents/ops.agent' },
    ]);
    expect((await keys.listForUser(userId)).map((k) => k.agentPath).sort()).toEqual(['Agents/ops.agent', null]);
  });
});
