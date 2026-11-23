import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { users, type Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { AuthService, BOT_ADDRESS_REFUSAL } from '../auth.service.js';
import { hashPassword } from '../password-hash.js';
import { botAddressBook } from '../../../__tests__/bot-address-book.js';

/**
 * A bot never signs in: every way in refuses a bot's row and any address at
 * the bots' domain — password sign-in, single sign-on, setting a password,
 * making or inviting an account, the embed identity — a token naming a bot's
 * row is no session, and bots are neither accounts on the accounts list nor
 * people a change request's approvers are told about. On a real Postgres,
 * through the service's public methods.
 */

const JWT_SECRET = 'test-jwt-secret';
const BOT = 'release-helper@agent.hexis';

describe.skipIf(!PG_ADMIN_URL)('a bot and the ways in, on a real Postgres', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let auth: AuthService;
  let botId: string;

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_bot_auth'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const book = botAddressBook();
    book.replace({ domain: 'agent.hexis', botIds: ['release-helper'], previousDomain: null });
    auth = new AuthService(db, { jwtSecret: JWT_SECRET, adminEmail: '', adminPassword: '', allowedEmailDomains: [] }, undefined, book);
    // A bot's row, with a password hash planted on it: even that never signs it in.
    const [row] = await db
      .insert(users)
      .values({ email: BOT, emailBidx: BOT, name: 'release-helper', botId: 'release-helper', passwordHash: await hashPassword('correct horse battery') })
      .returning({ id: users.id });
    botId = row!.id;
    await db.insert(users).values({ email: 'dana@acme.com', emailBidx: 'dana@acme.com', name: 'Dana' });
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it('refuses password sign-in with the answer a wrong password gets', async () => {
    await expect(auth.loginWithPassword(BOT, 'correct horse battery')).rejects.toThrow('Invalid credentials');
    await expect(auth.loginWithPassword(BOT, 'anything')).rejects.toThrow('Invalid credentials');
  });

  it('refuses single sign-on presenting a bot\'s address, or any address at the bots\' domain', async () => {
    await expect(auth.loginWithSso(BOT, 'Release helper')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
    await expect(auth.loginWithSso('someone@agent.hexis', 'Someone', { admittedByProvider: true })).rejects.toThrow(BOT_ADDRESS_REFUSAL);
  });

  it('refuses setting a password, making, inviting or embedding a person at a bot\'s address', async () => {
    await expect(auth.changePassword(botId, undefined, 'a long enough password')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
    await expect(auth.createAccount(BOT, 'x', 'a long enough password')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
    await expect(auth.createAccount('someone@agent.hexis', 'x')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
    await expect(auth.createAccountWithoutPassword('someone@agent.hexis', 'x')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
    await expect(auth.createAccountWithStartingPassword(BOT, 'a long enough password')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
    await expect(auth.getOrCreateByEmail('someone@agent.hexis', 'x')).rejects.toThrow(BOT_ADDRESS_REFUSAL);
  });

  it('holds no session: a token naming the bot\'s row is refused', async () => {
    const forged = jwt.sign({ userId: botId, email: BOT, sv: 0 }, JWT_SECRET, { expiresIn: '7d' });
    await expect(auth.resolveSession(forged)).rejects.toThrow();
  });

  it('is not an account on the accounts list, and is never told of a change request', async () => {
    const accounts = await auth.listAccounts();
    expect(accounts.map((a) => a.email)).toContain('dana@acme.com');
    expect(accounts.map((a) => a.email)).not.toContain(BOT);
    const told = await auth.findActiveAccountsByEmail([BOT, 'dana@acme.com']);
    expect([...told.keys()]).toEqual(['dana@acme.com']);
  });

  it('leaves people as they were', async () => {
    const person = await auth.createAccount('newcomer@acme.com', 'Newcomer', 'a long enough password');
    expect(person.email).toBe('newcomer@acme.com');
    const { token } = await auth.loginWithPassword('newcomer@acme.com', 'a long enough password');
    expect((await auth.resolveSession(token)).email).toBe('newcomer@acme.com');
  });
});
