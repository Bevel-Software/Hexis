import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { users, type Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { BotService } from '../bot.service.js';
import { BotAddressBook } from '../bot-address-book.js';
import { botsDomainRefusal, rewriteBotGrants } from '../bot-domain.js';
import type { DeploymentSettingsService } from '../../settings/index.js';
import { deploymentSettingsOver } from '../../../__tests__/real-settings.js';
import { deploymentSettings } from '../../database/index.js';
import { createBotsRoutes } from '../bots.routes.js';
import type { BotDefinition } from '../index.js';

/**
 * Changing the bots' domain: every bot's address moves at once, one change
 * request rewrites the grants written at the old domain, a grant at the old
 * domain counts until that request is merged, a domain people use or text
 * that is not a domain is refused, and only an admin may change it.
 */

const def = (id: string): BotDefinition => ({ id, name: id, description: '', source: `Agents/${id}.agent`, problem: null, platformTools: null });

describe('rewriting grants and refusing domains', () => {
  it('rewrites a bot\'s grants at the old domain in access files and in frontmatter only', () => {
    const access = 'read:\n  - Release helper <release-helper@agent.hexis>\n  - Someone <other@agent.hexis.example>\n';
    expect(rewriteBotGrants('Team/access.md', access, ['release-helper'], 'agent.hexis', 'bots.acme.com')).toBe(
      'read:\n  - Release helper <release-helper@bots.acme.com>\n  - Someone <other@agent.hexis.example>\n',
    );
    const page = '---\nread:\n  - R <release-helper@agent.hexis>\n---\nMail release-helper@agent.hexis for help.\n';
    expect(rewriteBotGrants('Team/page.md', page, ['release-helper'], 'agent.hexis', 'bots.acme.com')).toBe(
      '---\nread:\n  - R <release-helper@bots.acme.com>\n---\nMail release-helper@agent.hexis for help.\n',
    );
    // A fence with surrounding whitespace is a fence to the access model, so its grants are rewritten too;
    // CRLF line endings stay as they were.
    const spaced = '---  \r\nread:\r\n  - R <release-helper@agent.hexis>\r\n --- \r\nbody\r\n';
    expect(rewriteBotGrants('Team/page.md', spaced, ['release-helper'], 'agent.hexis', 'bots.acme.com')).toBe(
      '---  \r\nread:\r\n  - R <release-helper@bots.acme.com>\r\n --- \r\nbody\r\n',
    );
    expect(rewriteBotGrants('Team/page.md', '---\nread:\n  - R <release-helper@agent.hexis>\n', ['release-helper'], 'agent.hexis', 'x.io')).toBeNull();
    expect(rewriteBotGrants('Team/page.md', '# nothing\n', ['release-helper'], 'agent.hexis', 'x.io')).toBeNull();
    expect(rewriteBotGrants('roles.yaml', 'groups:\n  G:\n    - not-a-bot@agent.hexis\n', ['release-helper'], 'agent.hexis', 'x.io')).toBeNull();
  });

  it('refuses text that is not a domain, the domain in effect, and a domain people\'s addresses use', () => {
    expect(botsDomainRefusal('not a domain', [], 'agent.hexis')).toMatch(/is not a domain/);
    expect(botsDomainRefusal('localhost', [], 'agent.hexis')).toMatch(/is not a domain/);
    expect(botsDomainRefusal('agent.hexis', [], 'agent.hexis')).toMatch(/already/);
    expect(botsDomainRefusal('acme.com', ['dana@acme.com'], 'agent.hexis')).toMatch(/People's addresses use acme\.com/);
    expect(botsDomainRefusal('bots.acme.com', ['dana@acme.com'], 'agent.hexis')).toBeNull();
  });
});

describe.skipIf(!PG_ADMIN_URL)('the bots\' domain on a real Postgres', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let server: Server;
  let base: string;
  // The REAL settings store: `deployment_settings.updated_by` is a uuid
  // keyed to `users.id`, and a fake that ignores who recorded the change hid
  // a domain change that answered 500 on a real deployment.
  let store: DeploymentSettingsService;
  const book = new BotAddressBook();
  let service: BotService;
  /** The state of the rewrite's change request, as the database would answer it. */
  const rewrite = { state: 'open' as 'open' | 'merged' | 'closed' };
  const rewriter = { open: vi.fn(async () => 42) };
  let admin: { id: string; email: string; name: string };

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_bot_domain'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await db.insert(users).values({ email: 'dana@acme.com', emailBidx: 'dana@acme.com', name: 'Dana' });
    const [adminRow] = await db
      .insert(users)
      .values({ email: 'admin@acme.com', emailBidx: 'admin@acme.com', name: 'Admin' })
      .returning({ id: users.id });
    admin = { id: adminRow!.id, email: 'admin@acme.com', name: 'Admin' };
    store = deploymentSettingsOver(db);
    await store.load();
    service = new BotService(db, store, { definitions: async () => [def('release-helper')], mayActAs: async () => true }, book, async () => rewrite.state);
    await service.load();
    await service.sync();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const who = req.headers['x-as'];
      req.userId = admin.id;
      req.userEmail = typeof who === 'string' ? who : admin.email;
      next();
    });
    app.use(
      '/api',
      createBotsRoutes({
        bots: service,
        isAdmin: async (email) => email === admin.email,
        resolveUser: async () => admin,
        rewriter,
      }),
    );
    await new Promise<void>((r) => {
      server = app.listen(0, r);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => server.close(() => r()));
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  const put = (domain: string, as?: string) =>
    fetch(`${base}/api/bots/domain`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(as ? { 'x-as': as } : {}) },
      body: JSON.stringify({ domain }),
    });

  it('is agent.hexis unless an admin changed it', async () => {
    expect(await (await fetch(`${base}/api/bots/domain`)).json()).toEqual({ domain: 'agent.hexis' });
  });

  it('refuses someone who is not an admin, and a domain people use, saying why', async () => {
    const notAdmin = await put('bots.acme.com', 'dana@acme.com');
    expect(notAdmin.status).toBe(403);
    const peoples = await put('acme.com');
    expect(peoples.status).toBe(422);
    expect(((await peoples.json()) as { error: string }).error).toMatch(/People's addresses use acme\.com/);
    expect(rewriter.open).not.toHaveBeenCalled();
  });

  it('gives every bot its new address at once, opens the rewrite, and counts the old address until it is merged', async () => {
    const res = await put('Bots.Acme.com');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ domain: 'bots.acme.com', changeRequest: 42 });
    expect(rewriter.open).toHaveBeenCalledWith(admin, 'agent.hexis', 'bots.acme.com', ['release-helper']);
    const [row] = await db.select().from(users).where(eq(users.botId, 'release-helper'));
    expect(row!.email).toBe('release-helper@bots.acme.com');
    expect(book.addressesOf('release-helper@bots.acme.com')).toEqual(['release-helper@bots.acme.com', 'release-helper@agent.hexis']);
    expect(book.isBot('release-helper@agent.hexis')).toBe(true);
    // Recorded in the real store, by the admin's row.
    const saved = await db.select().from(deploymentSettings).where(eq(deploymentSettings.key, 'botsDomain'));
    expect(saved[0]).toMatchObject({ value: 'bots.acme.com', updatedBy: admin.id });
    expect(store.resolve('botsDomainChangeRequest')).toBe('42');

    // While the rewrite is open a second change is refused: only one previous
    // domain is kept, and its grants would stop counting before anyone merged it.
    const again = await put('robots.acme.com');
    expect(again.status).toBe(422);
    expect(((await again.json()) as { error: string }).error).toMatch(/\(#42\) is still open/);
    expect(book.isBot('release-helper@agent.hexis')).toBe(true);

    // The rewrite is merged: the next look drops the old spelling.
    rewrite.state = 'merged';
    await service.sync();
    expect(book.addressesOf('release-helper@bots.acme.com')).toEqual(['release-helper@bots.acme.com']);
    expect(book.isBot('release-helper@agent.hexis')).toBe(false);
    expect((await service.choicesFor('dana@acme.com'))[0]!.address).toBe('release-helper@bots.acme.com');
  });

  it('says so, with no credential, when the rewrite cannot be opened, and keeps the old address counting', async () => {
    const secret = 'ghp_s3cretTokenValueThatMustNotLeak';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const prevToken = process.env.GIT_TOKEN;
    process.env.GIT_TOKEN = secret;
    try {
      rewriter.open.mockRejectedValueOnce(new Error(`push to https://x:${secret}@github.com/acme/kb.git refused`));
      const res = await put('robots.acme.com');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { domain: string; changeRequest: number | null; changeRequestError?: string };
      expect(body.domain).toBe('robots.acme.com');
      expect(body.changeRequest).toBeNull();
      expect(body.changeRequestError).toMatch(/^The change request rewriting the grants at bots\.acme\.com could not be opened \(.*\), so those grants still count until the domain is changed again\.$/);
      expect(body.changeRequestError).not.toContain(secret);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      expect(book.addressesOf('release-helper@robots.acme.com')).toEqual(['release-helper@robots.acme.com', 'release-helper@bots.acme.com']);
    } finally {
      if (prevToken === undefined) delete process.env.GIT_TOKEN;
      else process.env.GIT_TOKEN = prevToken;
      warn.mockRestore();
    }
  });
});

describe.skipIf(!PG_ADMIN_URL)('a domain change on a real Postgres: every bot named now, and rows and settings together', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let store: DeploymentSettingsService;
  let admin: { id: string; email: string; name: string };

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_bot_domain_rows'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const [adminRow] = await db
      .insert(users)
      .values({ email: 'admin@acme.com', emailBidx: 'admin@acme.com', name: 'Admin' })
      .returning({ id: users.id });
    admin = { id: adminRow!.id, email: 'admin@acme.com', name: 'Admin' };
    store = deploymentSettingsOver(db);
    await store.load();
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  const emailOf = async (botId: string) => (await db.select().from(users).where(eq(users.botId, botId)))[0]?.email;

  it('re-addresses and rewrites a bot defined since the last look, not only the rows made so far', async () => {
    const defs = [def('first')];
    const service = new BotService(db, store, { definitions: async () => defs, mayActAs: async () => true });
    await service.load();
    await service.sync();
    defs.push(def('second'));
    const rewriter = { open: vi.fn(async () => 7) };
    await service.changeDomain(admin, 'bots-a.acme.com', rewriter);
    expect(await emailOf('first')).toBe('first@bots-a.acme.com');
    expect(await emailOf('second')).toBe('second@bots-a.acme.com');
    expect(rewriter.open).toHaveBeenCalledWith(admin, 'agent.hexis', 'bots-a.acme.com', ['first', 'second']);
  });

  it('puts every row back when the settings cannot be recorded, so rows and settings never disagree', async () => {
    const failing = {
      resolve: (key: string) => store.resolve(key),
      reload: (key: string) => store.reload(key),
      clear: (key: string) => store.clear(key),
      record: async () => {
        throw new Error('settings store down');
      },
    };
    const service = new BotService(db, failing as never, { definitions: async () => [def('first'), def('second')], mayActAs: async () => true });
    await service.load();
    const before = service.domain();
    await expect(service.changeDomain(admin, 'bots-b.acme.com')).rejects.toThrow('settings store down');
    expect(service.domain()).toBe(before);
    expect(await emailOf('first')).toBe(`first@${before}`);
    expect(await emailOf('second')).toBe(`second@${before}`);
  });

  it('puts the settings back too when the store recorded some of them before it failed', async () => {
    const before = await store.reload('botsDomain');
    const previousBefore = await store.reload('botsPreviousDomain');
    let calls = 0;
    const partway = {
      resolve: (key: string) => store.resolve(key),
      reload: (key: string) => store.reload(key),
      clear: (key: string) => store.clear(key),
      // The first write lands its domain and then fails; putting back goes through.
      record: async (entries: Record<string, string>, by: string | null) => {
        calls += 1;
        if (calls > 1) return store.record(entries, by);
        await store.record({ botsDomain: entries.botsDomain }, by);
        throw new Error('settings store failed part-way');
      },
    };
    const service = new BotService(db, partway, { definitions: async () => [def('first')], mayActAs: async () => true });
    await service.load();
    const domain = service.domain();
    await expect(service.changeDomain(admin, 'bots-c.acme.com')).rejects.toThrow('settings store failed part-way');
    expect(await store.reload('botsDomain')).toBe(before);
    expect(await store.reload('botsPreviousDomain')).toBe(previousBefore);
    expect(service.domain()).toBe(domain);
    expect(await emailOf('first')).toBe(`first@${domain}`);
  });

  it('moves what names each bot with its row, from its stored address to its new one, and back when the settings cannot be recorded', async () => {
    const calls: string[] = [];
    const recorded = {
      // Once per transaction, before any row is touched.
      holdRecordWriters: vi.fn(async () => {
        calls.push('hold');
      }),
      readdressIdentity: vi.fn(async (_tx: unknown, from: string, to: string) => {
        calls.push(`${from} -> ${to}`);
      }),
    };
    const ok = new BotService(db, store, { definitions: async () => [def('first'), def('second')], mayActAs: async () => true }, undefined, undefined, recorded);
    await ok.load();
    const before = ok.domain();
    await ok.changeDomain(admin, 'bots-c.acme.com');
    expect(calls[0]).toBe('hold');
    expect(calls.slice(1).sort()).toEqual([`first@${before} -> first@bots-c.acme.com`, `second@${before} -> second@bots-c.acme.com`]);

    calls.length = 0;
    const failing = {
      resolve: (key: string) => store.resolve(key),
      reload: (key: string) => store.reload(key),
      clear: (key: string) => store.clear(key),
      record: async () => {
        throw new Error('settings store down');
      },
    };
    const down = new BotService(db, failing as never, { definitions: async () => [def('first'), def('second')], mayActAs: async () => true }, undefined, undefined, recorded);
    await down.load();
    const firstRow = (await db.select().from(users).where(eq(users.botId, 'first')))[0]!;
    await expect(down.changeDomain(admin, 'bots-d.acme.com')).rejects.toThrow('settings store down');
    // There and back for EVERY bot: the first transaction moves each, the second puts each back.
    expect(calls).toHaveLength(6);
    expect(calls[0]).toBe('hold');
    expect(calls.slice(1, 3).sort()).toEqual(['first@bots-c.acme.com -> first@bots-d.acme.com', 'second@bots-c.acme.com -> second@bots-d.acme.com']);
    expect(calls[3]).toBe('hold');
    expect(calls.slice(4).sort()).toEqual(['first@bots-d.acme.com -> first@bots-c.acme.com', 'second@bots-d.acme.com -> second@bots-c.acme.com']);
    expect(await emailOf('first')).toBe('first@bots-c.acme.com');
    expect(await emailOf('second')).toBe('second@bots-c.acme.com');
    // And what a connection resolves is back at the address the row has.
    const resolved = await down.resolveConnection({ id: admin.id, email: admin.email }, { botUserId: firstRow.id, agentPath: null });
    expect(resolved.kind === 'bot' ? resolved.actor.email : resolved.kind).toBe('first@bots-c.acme.com');
  });

  it('resolves a bot at its new address as soon as its row has moved, before the settings are written', async () => {
    const seen: string[] = [];
    let firstId = '';
    const watching = {
      resolve: (key: string) => store.resolve(key),
      reload: (key: string) => store.reload(key),
      clear: (key: string) => store.clear(key),
      record: async (values: Record<string, string>, by: string) => {
        if (values.botsDomain) {
          const resolved = await service.resolveConnection({ id: admin.id, email: admin.email }, { botUserId: firstId, agentPath: null });
          seen.push(resolved.kind === 'bot' ? resolved.actor.email : resolved.kind);
        }
        return store.record(values, by);
      },
    };
    // Read by `watching` only once the change is under way.
    const service = new BotService(db, watching as never, { definitions: async () => [def('first'), def('second')], mayActAs: async () => true });
    await service.load();
    firstId = (await db.select().from(users).where(eq(users.botId, 'first')))[0]!.id;
    await service.changeDomain(admin, 'bots-f.acme.com');
    expect(seen).toEqual(['first@bots-f.acme.com']);
  });

  it('leaves every row where it was when moving what names a bot fails, and changes no setting', async () => {
    const recorded = {
      holdRecordWriters: vi.fn(async () => undefined),
      readdressIdentity: vi.fn(async (_tx: unknown, from: string) => {
        if (from.startsWith('second@')) throw new Error('approval lock timed out');
      }),
    };
    const service = new BotService(db, store, { definitions: async () => [def('first'), def('second')], mayActAs: async () => true }, undefined, undefined, recorded);
    await service.load();
    const before = service.domain();
    await expect(service.changeDomain(admin, 'bots-e.acme.com')).rejects.toThrow('approval lock timed out');
    // One transaction: the first bot's row, updated before the failure, is rolled back with it.
    expect(await emailOf('first')).toBe(`first@${before}`);
    expect(await emailOf('second')).toBe(`second@${before}`);
    expect(service.domain()).toBe(before);
    expect(store.resolve('botsDomain') || 'agent.hexis').toBe(before);
  });
});

describe.skipIf(!PG_ADMIN_URL)('a domain change seen from two processes over one database', () => {
  let db: Database;
  let closeDb: () => Promise<void>;
  let admin: { id: string; email: string; name: string };
  const directory = { definitions: async () => [def('ops')], mayActAs: async () => true };
  /** One process: its own settings cache and its own bots, over the shared database. */
  const process_ = async () => {
    const store = deploymentSettingsOver(db);
    await store.load();
    const service = new BotService(db, store, directory);
    await service.load();
    await service.sync();
    return service;
  };

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_bot_domain_two'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const [adminRow] = await db
      .insert(users)
      .values({ email: 'admin@acme.com', emailBidx: 'admin@acme.com', name: 'Admin' })
      .returning({ id: users.id });
    admin = { id: adminRow!.id, email: 'admin@acme.com', name: 'Admin' };
  }, PG_TEST_TIMEOUT);

  afterAll(async () => {
    vi.restoreAllMocks();
    await closeDb();
    await dropScratchDatabases();
  }, PG_TEST_TIMEOUT);

  it('refuses a second change, on another process, while the first is still opening its rewrite', async () => {
    const [a, b] = [await process_(), await process_()];
    let release!: () => void;
    const opening = new Promise<void>((r) => {
      release = r;
    });
    const rewriterA = {
      open: vi.fn(async () => {
        await opening;
        return 5;
      }),
    };
    const rewriterB = { open: vi.fn(async () => 6) };
    const first = a.changeDomain(admin, 'one.acme.com', rewriterA);
    await vi.waitFor(() => expect(rewriterA.open).toHaveBeenCalled());
    await expect(b.changeDomain(admin, 'two.acme.com', rewriterB)).rejects.toThrow(/being changed already/);
    expect(rewriterB.open).not.toHaveBeenCalled();
    release();
    expect(await first).toEqual({ domain: 'one.acme.com', changeRequest: 5 });
  }, 30_000);

  it('gives a process that did not make the change its bots at their new address', async () => {
    const [a, b] = [await process_(), await process_()];
    await a.changeDomain(admin, 'three.acme.com');
    expect((await b.actAs('admin@acme.com', 'ops'))?.email).toBe('ops@three.acme.com');
    expect((await b.choicesFor('admin@acme.com')).map((c) => c.address)).toEqual(['ops@three.acme.com']);
    expect(b.domain()).toBe('three.acme.com');
  });

  it('gives a process that held no bot row the new domain once it reads the rows another process moved', async () => {
    // A process that read its settings before the change and its rows after
    // it: every row it holds is already at the new address, so no held row
    // differs from what it reads.
    const store = deploymentSettingsOver(db);
    await store.load();
    const a = await process_();
    const empty = new BotService(db, store, { definitions: async () => [def('ops')], mayActAs: async () => true });
    // Its rows are read now, its settings were read before the change below.
    await a.changeDomain(admin, 'four.acme.com');
    await empty.load();
    expect(empty.domain()).not.toBe('four.acme.com');
    await empty.sync();
    expect(empty.domain()).toBe('four.acme.com');
    expect((await empty.actAs('admin@acme.com', 'ops'))?.email).toBe('ops@four.acme.com');
  });
});
