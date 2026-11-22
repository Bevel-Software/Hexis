import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { users, type Database } from '../../database/index.js';
import { PG_TEST_TIMEOUT, PG_ADMIN_URL, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { BotService, GONE_REASON, goneSentence } from '../bot.service.js';
import { BotAddressBook } from '../bot-address-book.js';
import type { BotDefinition, IBotDirectory } from '../index.js';

/**
 * The bots mechanism on a real Postgres: a users row per bot the
 * distribution names (made, renamed, retired, brought back), the "Connect
 * as" choices, "may act as", and what a connection made as a bot acts as on
 * every call. The directory is a stand-in the test edits between calls, as a
 * distribution's files change between requests.
 */

const def = (id: string, over: Partial<BotDefinition> = {}): BotDefinition => ({
  id,
  name: id,
  description: `${id} does things`,
  source: `Agents/${id}.agent`,
  problem: null,
  platformTools: null,
  ...over,
});

function directory() {
  const state = {
    defs: [] as BotDefinition[],
    /** Who may act as which definition, by `source`. */
    writers: new Map<string, Set<string>>(),
    legacy: new Map<string, string>(),
  };
  const dir: IBotDirectory = {
    definitions: async () => state.defs,
    mayActAs: async (email, d) => state.writers.get(d.source)?.has(email) ?? false,
    botIdForAgentPath: async (path) => state.legacy.get(path) ?? null,
  };
  return { state, dir };
}

function settings(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    resolve: (k: string) => values.get(k) ?? '',
    record: async (entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) values.set(k, v);
    },
  };
}

describe.skipIf(!PG_ADMIN_URL)('bots on a real Postgres', () => {
  let db: Database;
  let closeDb: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_bots'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  const PERSON = { id: '00000000-0000-4000-8000-000000000001', email: 'dana@acme.com' };

  async function rowOf(botId: string) {
    const [row] = await db.select().from(users).where(eq(users.botId, botId));
    return row;
  }

  it('core alone supplies no bot: no row, no choice, and every connection is the person\'s', async () => {
    const service = new BotService(db, settings(), { definitions: async () => [], mayActAs: async () => false });
    await service.load();
    expect(await service.choicesFor(PERSON.email)).toEqual([]);
    expect(await service.resolveConnection(PERSON, { botUserId: null, agentPath: null })).toEqual({ kind: 'myself' });
    expect(await db.select().from(users).where(eq(users.botId, 'anything'))).toEqual([]);
  });

  it('makes a row for a bot the first time it is named, at <id>@agent.hexis, and the address book knows it', async () => {
    const { state, dir } = directory();
    state.defs = [def('release-helper')];
    const book = new BotAddressBook();
    const service = new BotService(db, settings(), dir, book);
    await service.load();
    await service.sync();
    const row = await rowOf('release-helper');
    expect(row).toMatchObject({ email: 'release-helper@agent.hexis', name: 'release-helper', botRetiredAt: null, passwordHash: null });
    expect(book.isBot('release-helper@agent.hexis')).toBe(true);
    expect(book.isBot('dana@acme.com')).toBe(false);
  });

  it('offers only the bots the person may act as; one they may only read is not offered and is refused like one that does not exist', async () => {
    const { state, dir } = directory();
    state.defs = [def('coder'), def('mechanic'), def('reader-only')];
    state.writers.set('Agents/coder.agent', new Set([PERSON.email]));
    state.writers.set('Agents/mechanic.agent', new Set([PERSON.email]));
    const service = new BotService(db, settings(), dir);
    await service.load();
    const choices = await service.choicesFor(PERSON.email);
    expect(choices.map((c) => c.id)).toEqual(['coder', 'mechanic']);
    expect(choices[0]).toMatchObject({ name: 'coder', description: 'coder does things', address: 'coder@agent.hexis', unavailable: null });
    expect(await service.actAs(PERSON.email, 'reader-only')).toBeNull();
    expect(await service.actAs(PERSON.email, 'nobody')).toBeNull();
    expect(await service.actAs(PERSON.email, 'coder')).toMatchObject({ botId: 'coder', email: 'coder@agent.hexis' });
  });

  it('two definitions with one id make neither usable, and each says so', async () => {
    const { state, dir } = directory();
    state.defs = [def('twin', { source: 'Agents/a/twin.agent' }), def('twin', { source: 'Agents/b/twin.agent' })];
    state.writers.set('Agents/a/twin.agent', new Set([PERSON.email]));
    const service = new BotService(db, settings(), dir);
    await service.load();
    expect(await service.choicesFor(PERSON.email)).toEqual([
      expect.objectContaining({ id: 'twin', unavailable: 'two files share the id twin' }),
    ]);
    expect(await service.actAs(PERSON.email, 'twin')).toBeNull();
    const row = await rowOf('twin');
    const resolved = await service.resolveConnection(PERSON, { botUserId: row!.id, agentPath: null });
    expect(resolved).toMatchObject({ kind: 'unavailable', reason: 'cannot be used: two files share the id twin' });
  });

  it('a connection made as a bot acts as the bot, re-checked on every call: losing write, deletion and invalidity stop it, never falling back', async () => {
    const { state, dir } = directory();
    state.defs = [def('ops', { platformTools: ['read_file'] })];
    state.writers.set('Agents/ops.agent', new Set([PERSON.email]));
    const service = new BotService(db, settings(), dir);
    await service.load();
    const bot = (await service.actAs(PERSON.email, 'ops'))!;
    const choice = { botUserId: bot.id, agentPath: null };

    expect(await service.resolveConnection(PERSON, choice)).toEqual({
      kind: 'bot',
      actor: { id: bot.id, email: 'ops@agent.hexis' },
      madeBy: PERSON,
      bot: { id: 'ops', name: 'ops' },
      platformTools: ['read_file'],
    });

    // The person loses write on the definition: the next call stops, with one sentence.
    state.writers.set('Agents/ops.agent', new Set());
    expect(await service.resolveConnection(PERSON, choice)).toEqual({
      kind: 'unavailable',
      bot: { id: 'ops', name: 'ops' },
      sentence: goneSentence('ops'),
      reason: GONE_REASON,
    });

    // Write comes back; then the definition becomes invalid: says why.
    state.writers.set('Agents/ops.agent', new Set([PERSON.email]));
    state.defs = [def('ops', { problem: 'its frontmatter does not parse' })];
    expect(await service.resolveConnection(PERSON, choice)).toMatchObject({
      kind: 'unavailable',
      reason: 'cannot be used: its frontmatter does not parse',
    });

    // Deleted: the same sentence as "you may no longer act as it", disclosing neither.
    state.defs = [];
    expect(await service.resolveConnection(PERSON, choice)).toMatchObject({ kind: 'unavailable', sentence: goneSentence('ops') });
  });

  it('a removed definition retires the bot, keeping its row; the same id coming back brings the same row back', async () => {
    const { state, dir } = directory();
    state.defs = [def('phoenix')];
    state.writers.set('Agents/phoenix.agent', new Set([PERSON.email]));
    const book = new BotAddressBook();
    const service = new BotService(db, settings(), dir, book);
    await service.load();
    await service.sync();
    const first = await rowOf('phoenix');

    state.defs = [];
    await service.sync();
    const retired = await rowOf('phoenix');
    expect(retired!.id).toBe(first!.id);
    expect(retired!.botRetiredAt).not.toBeNull();
    // Still a bot's address: never a person, never "everyone".
    expect(book.isBot('phoenix@agent.hexis')).toBe(true);
    expect(await service.actAs(PERSON.email, 'phoenix')).toBeNull();
    expect(await service.resolveConnection(PERSON, { botUserId: first!.id, agentPath: null })).toMatchObject({ kind: 'unavailable' });

    state.defs = [def('phoenix', { name: 'Phoenix' })];
    await service.sync();
    const back = await rowOf('phoenix');
    expect(back).toMatchObject({ id: first!.id, botRetiredAt: null, name: 'Phoenix' });
  });

  it('a failed listing retires nothing', async () => {
    const { state, dir } = directory();
    state.defs = [def('steady')];
    const service = new BotService(db, settings(), dir);
    await service.load();
    await service.sync();
    state.defs = undefined as never; // the distribution cannot list: definitions() rejects below
    const failing = new BotService(db, settings(), { ...dir, definitions: async () => Promise.reject(new Error('repo down')) });
    await failing.load();
    await expect(failing.sync()).rejects.toThrow('repo down');
    expect((await rowOf('steady'))!.botRetiredAt).toBeNull();
  });

  it('a connection made "as an agent" before bots acts as the bot its path maps to, and loads nothing when none does', async () => {
    const { state, dir } = directory();
    state.defs = [def('legacy-bot')];
    state.writers.set('Agents/legacy-bot.agent', new Set([PERSON.email]));
    state.legacy.set('Agents/legacy-bot.agent', 'legacy-bot');
    const service = new BotService(db, settings(), dir);
    await service.load();
    expect(await service.resolveConnection(PERSON, { botUserId: null, agentPath: 'Agents/legacy-bot.agent' })).toMatchObject({
      kind: 'bot',
      bot: { id: 'legacy-bot' },
    });
    expect(await service.resolveConnection(PERSON, { botUserId: null, agentPath: 'Agents/unmapped.agent' })).toMatchObject({
      kind: 'unavailable',
      sentence: goneSentence('Agents/unmapped.agent'),
    });
    // Its owner may not write the definition: it stops, saying why.
    state.writers.set('Agents/legacy-bot.agent', new Set());
    expect(await service.resolveConnection(PERSON, { botUserId: null, agentPath: 'Agents/legacy-bot.agent' })).toMatchObject({
      kind: 'unavailable',
    });
  });

  it('a bot may act as another bot under the rule a person follows', async () => {
    const { state, dir } = directory();
    state.defs = [def('lead'), def('helper'), def('locked')];
    state.writers.set('Agents/helper.agent', new Set(['lead@agent.hexis']));
    const service = new BotService(db, settings(), dir);
    await service.load();
    expect(await service.actAs('lead@agent.hexis', 'helper')).toMatchObject({ botId: 'helper' });
    expect(await service.actAs('lead@agent.hexis', 'locked')).toBeNull();
  });

  it('a person at the bot\'s address keeps it: the bot gets no row and says why', async () => {
    await db.insert(users).values({ email: 'clash@agent.hexis', emailBidx: 'clash@agent.hexis', name: 'A person' });
    const { state, dir } = directory();
    state.defs = [def('clash')];
    state.writers.set('Agents/clash.agent', new Set([PERSON.email]));
    const service = new BotService(db, settings(), dir);
    await service.load();
    expect(await service.choicesFor(PERSON.email)).toEqual([
      expect.objectContaining({ id: 'clash', unavailable: 'its address belongs to a person' }),
    ]);
    expect(await service.actAs(PERSON.email, 'clash')).toBeNull();
  });
});
