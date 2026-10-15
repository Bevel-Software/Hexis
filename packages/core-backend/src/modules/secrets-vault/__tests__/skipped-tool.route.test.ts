import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallTemplate } from '@utcp/sdk';
import { createSecretsVaultRoutes } from '../secrets-vault.routes.js';
import { InMemorySkippedToolsService } from '../skipped-tools.service.js';
import { createToolManualsAgentRoutes } from '../../tool-manuals/tool-manuals.routes.js';
import type { IToolManualService } from '../../tool-manuals/tool-manuals.contract.js';
import { createCatalogRevisionRoutes } from '../../../core/catalog-revision.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * A tool the person skips on the Connect page STAYS skipped.
 *
 * QA unticked `granola` and `qa_userkey`, reloaded, and both were back to
 * "Needs your sign-in" / "Needs a key from you": the skip was a deleted
 * credential plus a flag the page held, so nothing outlived the page — and a
 * person who signed back in anywhere else had the tool on their agent again.
 *
 * The skip is now stored per person. These tests pin the three things that
 * follow from that, over real loopback servers that share ONE store the way
 * every request of a deployment does: the listing reports it on every reload
 * and to every session, the agent catalog leaves the tool out, and Include
 * undoes both.
 */

const MANUALS = [
  {
    slug: 'granola',
    name: 'granola',
    path: 'Plugins/GTM/granola.tool',
    type: 'mcp' as const,
    variables: [{ name: 'TOKEN', scope: 'user' as const, label: 'Granola sign-in', oauth: { scopes: [] } }],
  },
  {
    slug: 'qa-userkey',
    name: 'qa_userkey',
    path: 'Plugins/GTM/qa-userkey.tool',
    type: 'http' as const,
    variables: [{ name: 'API_KEY', scope: 'user' as const, label: null }],
  },
];

/** What the workspace's `.tool` files declare right now; a test may edit one. */
let manuals: { slug: string; name: string; path: string; type: 'mcp' | 'http'; variables: unknown[] }[] = MANUALS;

/** Readable by everyone except the tool `secret` — which nobody here may read. */
const toolManualService = {
  listAccessible: async () => manuals,
  toManualCallTemplates: async () =>
    manuals.map((m) => ({ name: m.name, call_template_type: 'http', url: `https://example.test/${m.slug}` })),
  catalogFingerprints: async () => manuals.map((m) => `${m.slug}\u0000${m.name}`),
} as unknown as IToolManualService;

const secretsVault = {
  statusFor: async (_u: string, keys: string[]) =>
    // The workspace has set every value, each of the kind its var declares.
    keys.map((key) => ({
      key,
      adminConfigured: true,
      adminKind: key.endsWith('_TOKEN') ? ('oauth' as const) : ('static' as const),
      userConfigured: false,
      userKind: null,
    })),
  list: async () => [],
} as unknown as Parameters<typeof createSecretsVaultRoutes>[0]['secretsVault'];

const servers: HttpServer[] = [];

/**
 * One server per "session" — a reload, or a second browser — all over the same
 * store. The user is whoever the `x-user` header names.
 */
async function session(
  skippedTools: InMemorySkippedToolsService,
  resolveUserEmail: (id: string) => Promise<string | undefined> = async (id) => `${id}@x.com`,
): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = String(req.headers['x-user'] ?? 'u-1');
    req.userId = user;
    req.userEmail = `${user}@x.com`;
    next();
  });
  const manualAuth: express.RequestHandler = (req, _res, next) => {
    req.toolAuth = { userId: String(req.headers['x-user'] ?? 'u-1') } as never;
    next();
  };
  app.use(
    '/api',
    createSecretsVaultRoutes({
      kb: testKbContext(),
      skippedTools,
      secretsVault,
      toolManualService: toolManualService as Parameters<typeof createSecretsVaultRoutes>[0]['toolManualService'],
      accessControl: { canWrite: async () => false } as never,
      connectionProbe: { probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }) },
      stateSecret: 'test-secret',
      publicBackendUrl: 'http://localhost:3000',
      publicFrontendUrl: 'http://localhost:5173',
    }),
  );
  app.use(
    '/api',
    createToolManualsAgentRoutes(toolManualService, manualAuth, async (id) => `${id}@x.com`, undefined, skippedTools),
  );
  app.use(
    '/api',
    createCatalogRevisionRoutes({
      toolManuals: toolManualService,
      skills: { listSkills: async () => [] },
      manualAuth,
      resolveUserEmail,
      skippedTools,
    }),
  );
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  manuals = MANUALS;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface Pending {
  tools: { slug: string; skipped: boolean }[];
  toolOAuth: { slug: string; skipped: boolean }[];
}

async function pending(base: string, user = 'u-1'): Promise<Pending> {
  const res = await fetch(`${base}/api/connect/pending`, { headers: { 'x-user': user } });
  expect(res.status).toBe(200);
  return (await res.json()) as Pending;
}

async function catalog(base: string, user = 'u-1'): Promise<string[]> {
  const res = await fetch(`${base}/api/agent/all-tools`, { headers: { 'x-user': user } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { manuals: CallTemplate[] }).manuals.map((m) => String(m.name));
}

async function revision(base: string, user = 'u-1'): Promise<string> {
  const res = await fetch(`${base}/api/agent/catalog-revision`, { headers: { 'x-user': user } });
  return ((await res.json()) as { revision: string }).revision;
}

function setSkipped(base: string, slug: string, skip: boolean, user = 'u-1'): Promise<Response> {
  return fetch(`${base}/api/connect/skipped/${slug}`, { method: skip ? 'PUT' : 'DELETE', headers: { 'x-user': user } });
}

describe('a skipped tool stays skipped', () => {
  it('is reported skipped after a reload and in a second session, until it is included', async () => {
    const store = new InMemorySkippedToolsService();
    const first = await session(store);

    expect((await pending(first)).toolOAuth).toEqual([expect.objectContaining({ slug: 'granola', skipped: false })]);

    expect((await setSkipped(first, 'granola', true)).status).toBe(204);
    expect((await setSkipped(first, 'qa-userkey', true)).status).toBe(204);

    // A reload is a fresh request; a second session is another server over the
    // same store. Both see the choice.
    const reloaded = await pending(first);
    const second = await pending(await session(store));
    for (const view of [reloaded, second]) {
      expect(view.toolOAuth).toEqual([expect.objectContaining({ slug: 'granola', skipped: true })]);
      // Still LISTED — skipped is a standing state on the page, not an absence.
      expect(view.tools).toEqual([expect.objectContaining({ slug: 'qa-userkey', skipped: true })]);
    }

    expect((await setSkipped(first, 'granola', false)).status).toBe(204);
    const after = await pending(first);
    expect(after.toolOAuth).toEqual([expect.objectContaining({ slug: 'granola', skipped: false })]);
    expect(after.tools).toEqual([expect.objectContaining({ slug: 'qa-userkey', skipped: true })]);
  });

  it('is one person’s choice — nobody else’s listing or catalog changes', async () => {
    const base = await session(new InMemorySkippedToolsService());
    await setSkipped(base, 'granola', true, 'u-1');

    expect((await pending(base, 'u-2')).toolOAuth).toEqual([expect.objectContaining({ skipped: false })]);
    expect(await catalog(base, 'u-2')).toContain('granola');
  });

  it('keeps the tool out of the agent’s catalog until it is included again', async () => {
    const base = await session(new InMemorySkippedToolsService());
    expect(await catalog(base)).toEqual(expect.arrayContaining(['granola', 'qa_userkey']));
    const before = await revision(base);

    await setSkipped(base, 'qa-userkey', true);
    const skipped = await catalog(base);
    expect(skipped).not.toContain('qa_userkey');
    expect(skipped).toContain('granola');
    // A running local server learns the catalog changed under it.
    expect(await revision(base)).not.toBe(before);

    await setSkipped(base, 'qa-userkey', false);
    expect(await catalog(base)).toContain('qa_userkey');
    expect(await revision(base)).toBe(before);
  });

  it('still offers Include once the tool has no key of the reader’s left to show', async () => {
    const store = new InMemorySkippedToolsService();
    const base = await session(store);
    await setSkipped(base, 'qa-userkey', true);

    // The `.tool` is edited after the skip: its key becomes the workspace's,
    // and the workspace has set it — nothing left for a key row to ask for.
    manuals = MANUALS.map((m) =>
      m.slug === 'qa-userkey' ? { ...m, variables: [{ name: 'API_KEY', scope: 'admin' as const, label: null }] } : m,
    );
    const view = await pending(base);
    expect(view.tools).toEqual([expect.objectContaining({ slug: 'qa-userkey', skipped: true, variables: [] })]);
    expect(await catalog(base)).not.toContain('qa_userkey');

    // Included, it has nothing to show again, so it leaves the page — and is
    // back on the agent.
    await setSkipped(base, 'qa-userkey', false);
    expect((await pending(base)).tools).toEqual([]);
    expect(await catalog(base)).toContain('qa_userkey');
  });

  it('a skipped sign-in tool is carried by its sign-in row, not by an empty key card too', async () => {
    const base = await session(new InMemorySkippedToolsService());
    await setSkipped(base, 'granola', true);

    const view = await pending(base);
    expect(view.toolOAuth).toEqual([expect.objectContaining({ slug: 'granola', skipped: true })]);
    expect(view.tools.map((t) => t.slug)).not.toContain('granola');
  });

  it('does not move the revision for a caller with no catalog for a skip to change', async () => {
    const base = await session(new InMemorySkippedToolsService(), async () => undefined);
    const before = await revision(base);

    await setSkipped(base, 'qa-userkey', true);
    expect(await revision(base)).toBe(before);
  });

  it('answers 404 for a tool the caller cannot read, and records nothing', async () => {
    const store = new InMemorySkippedToolsService();
    const base = await session(store);

    expect((await setSkipped(base, 'blackbox', true)).status).toBe(404);
    expect([...(await store.skippedBy('u-1'))]).toEqual([]);
  });
});
