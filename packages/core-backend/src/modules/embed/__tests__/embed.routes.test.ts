import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbedLinkRoutes, createEmbedRoutes, TOKEN_REQUIRED } from '../embed.routes.js';
import { EmbedAccessError, EmbedNodeNotFoundError, EmbedTokenError } from '../embed.errors.js';

const TOKEN = 'a-valid-token';

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function stubService(overrides: Record<string, unknown> = {}) {
  return {
    sharedSecretConfigured: vi.fn(() => true),
    verifySharedSecret: vi.fn((s?: string) => s === 'shh'),
    mintForUser: vi.fn(async () => ({ token: TOKEN, embedUrl: 'https://hexis.example/embed?token=' + TOKEN })),
    mintToken: vi.fn(async () => ({ token: TOKEN, embedUrl: 'https://hexis.example/embed?token=' + TOKEN })),
    loadFile: vi.fn(async (token: string) => {
      if (token !== TOKEN) throw new EmbedTokenError();
      return { nodeName: 'Thing', content: '# Thing', canWrite: true };
    }),
    readBytes: vi.fn(async () => ({ bytes: Buffer.from([1, 2, 3]), path: 'Data/x.png' })),
    acquireLock: vi.fn(async () => ({ acquired: true })),
    heartbeat: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    propose: vi.fn(async () => ({ branch: 'suggestions/a-1/knowledge', number: 7, url: '/change-requests/7' })),
    linkAccount: vi.fn(async () => undefined),
    listLinkedAccounts: vi.fn(async () => [{ atlassianAccountId: 'acc-1', createdAt: 0 }]),
    unlinkAccount: vi.fn(async () => true),
    ...overrides,
  };
}

/**
 * The app as the server mounts it: the embed routes ahead of the JWT
 * middleware, the link routes behind it, and a static catch-all last — the
 * same order `create-core-server` uses, because the order is what makes the
 * framing headers land before `index.html` is served.
 */
async function serve(service: ReturnType<typeof stubService>, opts: { session?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createEmbedRoutes(service as never));
  const authMiddleware: express.RequestHandler = (req, res, next) => {
    if (!opts.session) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }
    req.userId = 'u-1';
    next();
  };
  app.use('/api', authMiddleware, createEmbedLinkRoutes(service as never));
  app.get('{*path}', (_req, res) => res.type('html').send('<!doctype html><title>SPA</title>'));

  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return {
    base,
    get: (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers }),
    post: (path: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    del: (path: string) => fetch(`${base}${path}`, { method: 'DELETE' }),
  };
}

/**
 * Every route that serves FILE CONTENT or changes a file. The framing rule
 * makes the embed page reachable from any site, so the token is the whole of
 * the security — a session fallback would let a hostile frame read and write
 * as whoever happened to be signed in.
 */
const DATA_ROUTES = [
  ['GET', '/api/embed/load'],
  ['GET', '/api/embed/raw'],
  ['POST', '/api/embed/lock'],
  ['POST', '/api/embed/heartbeat'],
  ['POST', '/api/embed/cancel'],
  ['POST', '/api/embed/save'],
  ['POST', '/api/embed/propose'],
] as const;

describe('the embed data routes take the token and nothing else', () => {
  it.each(DATA_ROUTES)('%s %s refuses a request with a valid session and no token', async (method, path) => {
    const client = await serve(stubService(), { session: true });
    const res =
      method === 'GET'
        ? await client.get(path, { cookie: 'bevel_token=a-real-session' })
        : await client.post(path, { content: 'x' }, { cookie: 'bevel_token=a-real-session' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe(TOKEN_REQUIRED);
  });

  it.each(DATA_ROUTES)('%s %s answers a request with a token and no session', async (method, path) => {
    const client = await serve(stubService());
    const res =
      method === 'GET'
        ? await client.get(`${path}?token=${TOKEN}`)
        : await client.post(path, { token: TOKEN, content: 'x' });
    expect(res.status).toBeLessThan(400);
  });

  it('refuses an expired or rejected token with 401, so the view can say it expired', async () => {
    const client = await serve(stubService());
    const res = await client.get('/api/embed/load?token=stale');
    expect(res.status).toBe(401);
  });
});

describe('framing', () => {
  /**
   * Any host may frame the embed page — that is what makes it work in every
   * host's sandbox without an admin entry per host, and the token is what
   * secures it. `X-Frame-Options` is REMOVED rather than merely unset, so a
   * header added globally later cannot silently break every host's embed.
   */
  it('sends no framing restriction on the embed page', async () => {
    const client = await serve(stubService());
    const res = await client.get('/embed?token=' + TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBeNull();
    // And it still falls through to the SPA.
    expect(await res.text()).toContain('<!doctype html>');
  });

  /**
   * The account-link page acts under the SIGNED-IN SESSION, so a page that
   * could frame it could link a foreign account to a victim.
   */
  it('refuses every framing ancestor on the account-link page', async () => {
    const client = await serve(stubService());
    const res = await client.get('/embed/link?token=' + TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('the connector mint', () => {
  it('mints from the shared secret, an account id and a reference', async () => {
    const service = stubService();
    const client = await serve(service);
    const res = await client.post(
      '/api/embed/token',
      { accountId: 'acc-1', email: 'a@x.io', reference: 'Data/Thing.md' },
      { 'x-embed-secret': 'shh' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: TOKEN });
    expect(service.mintToken).toHaveBeenCalledWith({
      accountId: 'acc-1',
      email: 'a@x.io',
      reference: 'Data/Thing.md',
    });
  });

  it('refuses a wrong secret and a missing one', async () => {
    const client = await serve(stubService());
    expect((await client.post('/api/embed/token', { accountId: 'a', reference: 'b' }, { 'x-embed-secret': 'no' })).status).toBe(401);
    expect((await client.post('/api/embed/token', { accountId: 'a', reference: 'b' })).status).toBe(401);
  });

  it('refuses an incomplete body', async () => {
    const client = await serve(stubService());
    const res = await client.post('/api/embed/token', { accountId: 'acc-1' }, { 'x-embed-secret': 'shh' });
    expect(res.status).toBe(400);
  });

  /** A deployment with no connector pointed at it has no such route at all. */
  it('is absent when no shared secret is configured', async () => {
    const service = stubService({ sharedSecretConfigured: vi.fn(() => false) });
    const client = await serve(service);
    const res = await client.post('/api/embed/token', { accountId: 'a', reference: 'b' }, { 'x-embed-secret': 'shh' });
    expect(res.status).toBe(404);
    expect(service.verifySharedSecret).not.toHaveBeenCalled();
  });
});

describe('the data routes', () => {
  it('serves the page to render', async () => {
    const client = await serve(stubService());
    const res = await client.get(`/api/embed/load?token=${TOKEN}`);
    expect(await res.json()).toMatchObject({ nodeName: 'Thing' });
  });

  it('serves bytes inline, never as a download, and never from a shared cache', async () => {
    const client = await serve(stubService());
    const res = await client.get(`/api/embed/raw?token=${TOKEN}&path=assets/x.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('saves, and proposes, through the service', async () => {
    const service = stubService();
    const client = await serve(service);
    expect((await client.post('/api/embed/save', { token: TOKEN, content: 'new' })).status).toBe(204);
    expect(service.save).toHaveBeenCalledWith(TOKEN, 'new');
    const proposed = await client.post('/api/embed/propose', { token: TOKEN, content: 'draft' });
    expect(await proposed.json()).toMatchObject({ number: 7 });
  });

  it('refuses a save with no content', async () => {
    const client = await serve(stubService());
    expect((await client.post('/api/embed/save', { token: TOKEN })).status).toBe(400);
  });

  it.each([
    [new EmbedTokenError(), 401],
    [new EmbedAccessError(), 403],
    [new EmbedNodeNotFoundError('gone'), 404],
  ])('maps %s to its status', async (error, status) => {
    const service = stubService({
      loadFile: vi.fn(async () => {
        throw error;
      }),
    });
    const client = await serve(service);
    expect((await client.get(`/api/embed/load?token=${TOKEN}`)).status).toBe(status);
  });

  it('does not leak an unexpected failure message', async () => {
    const service = stubService({
      loadFile: vi.fn(async () => {
        throw new Error('postgres://user:pw@host down');
      }),
    });
    const client = await serve(service);
    const res = await client.get(`/api/embed/load?token=${TOKEN}`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Something went wrong.');
  });
});

describe('the account-link routes', () => {
  it('link, list and unlink need a session', async () => {
    const client = await serve(stubService(), { session: false });
    expect((await client.post('/api/embed/link', { token: TOKEN })).status).toBe(401);
    expect((await client.get('/api/embed/links')).status).toBe(401);
    expect((await client.del('/api/embed/links/acc-1')).status).toBe(401);
  });

  it('links the token account to the signed-in user', async () => {
    const service = stubService();
    const client = await serve(service, { session: true });
    expect((await client.post('/api/embed/link', { token: TOKEN })).status).toBe(204);
    expect(service.linkAccount).toHaveBeenCalledWith(TOKEN, 'u-1');
  });

  it('answers 404 for a link that is not this user own, so it cannot probe others', async () => {
    const service = stubService({ unlinkAccount: vi.fn(async () => false) });
    const client = await serve(service, { session: true });
    expect((await client.del('/api/embed/links/someone-elses')).status).toBe(404);
  });
});
