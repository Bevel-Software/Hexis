import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { users, type Database } from '../../database/index.js';
import { PG_ADMIN_URL, PG_TEST_TIMEOUT, dropScratchDatabases, openMigratedScratchDb } from '../../../__tests__/pg-scratch.js';
import { BotService } from '../bot.service.js';
import { BotAddressBook } from '../bot-address-book.js';
import { botsDomainRefusal, rewriteBotGrants } from '../bot-domain.js';
import { createBotsRoutes } from '../bots.routes.js';
import { isAccessFile } from '../../access-model/index.js';
import type { BotDefinition } from '../index.js';

/**
 * Changing the bots' domain: every bot's address moves at once, one change
 * request rewrites the grants written at the old domain, a grant at the old
 * domain counts until that request is merged, a domain people use or text
 * that is not a domain is refused, and only an admin may change it.
 */

const def = (id: string): BotDefinition => ({ id, name: id, description: '', source: `Agents/${id}.agent`, problem: null, platformTools: null });

function settings() {
  const values = new Map<string, string>();
  return {
    values,
    resolve: (k: string) => values.get(k) ?? '',
    record: async (entries: Record<string, string>) => {
      for (const [k, v] of Object.entries(entries)) values.set(k, v);
    },
  };
}

describe('rewriting grants and refusing domains', () => {
  it('rewrites a bot\'s grants at the old domain in access files and in frontmatter only', () => {
    const access = 'read:\n  - Release helper <release-helper@agent.hexis>\n  - Someone <other@agent.hexis.example>\n';
    expect(rewriteBotGrants('Team/access.md', access, ['release-helper'], 'agent.hexis', 'bots.acme.com', isAccessFile)).toBe(
      'read:\n  - Release helper <release-helper@bots.acme.com>\n  - Someone <other@agent.hexis.example>\n',
    );
    const page = '---\nread:\n  - R <release-helper@agent.hexis>\n---\nMail release-helper@agent.hexis for help.\n';
    expect(rewriteBotGrants('Team/page.md', page, ['release-helper'], 'agent.hexis', 'bots.acme.com', isAccessFile)).toBe(
      '---\nread:\n  - R <release-helper@bots.acme.com>\n---\nMail release-helper@agent.hexis for help.\n',
    );
    expect(rewriteBotGrants('Team/page.md', '# nothing\n', ['release-helper'], 'agent.hexis', 'x.io', isAccessFile)).toBeNull();
    expect(rewriteBotGrants('roles.yaml', 'groups:\n  G:\n    - not-a-bot@agent.hexis\n', ['release-helper'], 'agent.hexis', 'x.io', isAccessFile)).toBeNull();
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
  const store = settings();
  const book = new BotAddressBook();
  let service: BotService;
  const merged = { value: false };
  const rewriter = { open: vi.fn(async () => 42) };
  const admin = { id: '00000000-0000-4000-8000-0000000000aa', email: 'admin@acme.com', name: 'Admin' };

  beforeAll(async () => {
    ({ db, close: closeDb } = await openMigratedScratchDb('hexis_bot_domain'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await db.insert(users).values({ email: 'dana@acme.com', emailBidx: 'dana@acme.com', name: 'Dana' });
    service = new BotService(db, store, { definitions: async () => [def('release-helper')], mayActAs: async () => true }, book, async () => merged.value);
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

    // The rewrite is merged: the next look drops the old spelling.
    merged.value = true;
    await service.sync();
    expect(book.addressesOf('release-helper@bots.acme.com')).toEqual(['release-helper@bots.acme.com']);
    expect(book.isBot('release-helper@agent.hexis')).toBe(false);
    expect((await service.choicesFor('dana@acme.com'))[0]!.address).toBe('release-helper@bots.acme.com');
  });
});
