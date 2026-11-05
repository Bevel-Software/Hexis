import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { TenantConfig } from '../../core-config.js';
import { createTenantHost, isLoopbackAddress, selectTenant, type TenantHost } from '../tenant-host.js';
import type { TenantGraph } from '../tenant-runtime.js';
import type { TenantDescriptor, TenantSource } from '../tenant-source.contract.js';

/**
 * Two tenants behind one host, with a tiny app standing in for each graph:
 * what these cases pin is the front door — which requests reach which
 * tenant, what an unknown host gets, what happens while a tenant starts —
 * and none of it depends on what a real graph does once it has the request.
 */
const tenants: TenantDescriptor[] = [
  { slug: 'acme', hosts: ['acme.test'], config: {} as TenantConfig },
  { slug: 'globex', hosts: ['globex.test'], config: {} as TenantConfig },
];

const source: TenantSource = {
  async resolveByHost(host) {
    return tenants.find((t) => t.hosts.includes(host)) ?? null;
  },
  async describe(slug) {
    return tenants.find((t) => t.slug === slug) ?? null;
  },
};

function tenantApp(slug: string) {
  const app = express();
  app.get('/api/whoami', (req, res) => {
    res.json({ tenant: slug, path: req.path, query: req.query });
  });
  // Anything else: which tenant got it, and with what path.
  app.use((req, res) => {
    res.status(404).json({ tenant: slug, path: req.path, unhandled: true });
  });
  return app;
}

let server: http.Server | null = null;
let host: TenantHost | null = null;

async function listen(h: TenantHost): Promise<number> {
  host = h;
  server = await new Promise<http.Server>((resolve) => {
    const s = h.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return (server.address() as AddressInfo).port;
}

/** A request with an explicit Host header — which `fetch` refuses to set. */
function request(
  port: number,
  path: string,
  hostHeader: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { ...headers, host: hostHeader } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

afterEach(async () => {
  await host?.stop();
  host = null;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('selectTenant', () => {
  it('picks the tenant by host name, however the header spells it', () => {
    expect(selectTenant({ hostname: 'Acme.Test', url: '/api/x', peer: '10.0.0.5' })).toEqual({ kind: 'host', host: 'acme.test' });
  });

  it('honours the loopback prefix only from a loopback peer, and strips it from the path', () => {
    expect(selectTenant({ hostname: 'localhost', url: '/_tenant/acme/api/x?y=1', peer: '127.0.0.1' })).toEqual({
      kind: 'slug',
      slug: 'acme',
      rest: '/api/x?y=1',
    });
    expect(selectTenant({ hostname: 'localhost', url: '/_tenant/acme', peer: '::ffff:127.0.0.1' })).toEqual({
      kind: 'slug',
      slug: 'acme',
      rest: '/',
    });
    // From outside, the prefix is just a path nobody serves.
    expect(selectTenant({ hostname: 'acme.test', url: '/_tenant/globex/api/x', peer: '10.0.0.5' })).toEqual({
      kind: 'host',
      host: 'acme.test',
    });
    // From a loopback peer that is a reverse proxy on the same machine — it
    // forwarded someone, and says so — the prefix is not honoured either.
    expect(
      selectTenant({ hostname: 'acme.test', url: '/_tenant/globex/api/x', peer: '127.0.0.1', forwardedFor: '203.0.113.9' }),
    ).toEqual({ kind: 'host', host: 'acme.test' });
    expect(
      selectTenant({ hostname: 'acme.test', url: '/_tenant/globex/api/x', peer: '127.0.0.1', forwardedFor: ['203.0.113.9'] }),
    ).toEqual({ kind: 'host', host: 'acme.test' });
    // An empty header is no header.
    expect(selectTenant({ hostname: 'localhost', url: '/_tenant/acme/api/x', peer: '127.0.0.1', forwardedFor: '' })).toEqual({
      kind: 'slug',
      slug: 'acme',
      rest: '/api/x',
    });
    // A prefix that names nothing a slug could be is not a selector either.
    expect(selectTenant({ hostname: 'localhost', url: '/_tenant/../etc', peer: '127.0.0.1' })).toEqual({
      kind: 'host',
      host: 'localhost',
    });
  });

  it('knows which peers are this machine', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.9.9.9')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.5')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.5')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe('createTenantHost', () => {
  it('hands each host name to its own tenant, and activates each tenant once', async () => {
    const activations: string[] = [];
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        runtime: {
          activate: async (d) => {
            activations.push(d.slug);
            return { core: {}, app: tenantApp(d.slug) } as unknown as TenantGraph;
          },
          stop: async () => undefined,
        },
      }),
    );
    const a = await request(port, '/api/whoami', 'acme.test');
    const b = await request(port, '/api/whoami', 'globex.test:443');
    const again = await request(port, '/api/whoami', 'ACME.TEST');
    expect(JSON.parse(a.body)).toMatchObject({ tenant: 'acme' });
    expect(JSON.parse(b.body)).toMatchObject({ tenant: 'globex' });
    expect(JSON.parse(again.body)).toMatchObject({ tenant: 'acme' });
    expect(activations).toEqual(['acme', 'globex']);
    expect([...host!.runtimes().keys()]).toEqual(['acme', 'globex']);
  });

  it('answers 404 for a host no tenant claims, JSON under /api and a plain page elsewhere, building nothing', async () => {
    let activations = 0;
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        runtime: {
          activate: async () => {
            activations += 1;
            return { core: {}, app: tenantApp('x') } as unknown as TenantGraph;
          },
        },
      }),
    );
    const api = await request(port, '/api/whoami', 'nobody.test');
    expect(api.status).toBe(404);
    expect(JSON.parse(api.body)).toEqual({ error: 'No workspace at this address' });
    const page = await request(port, '/some/page', 'nobody.test');
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toContain('text/plain');
    expect(activations).toBe(0);
  });

  it('answers process health itself, whatever the host, and per-tenant paths through the tenant', async () => {
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        runtime: { activate: async (d) => ({ core: {}, app: tenantApp(d.slug) }) as unknown as TenantGraph, stop: async () => undefined },
      }),
    );
    const health = await request(port, '/api/health', 'nobody.test');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: 'ok', tenants: 0 });
  });

  it('reaches a tenant over loopback by the path prefix, with the prefix stripped', async () => {
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        runtime: { activate: async (d) => ({ core: {}, app: tenantApp(d.slug) }) as unknown as TenantGraph, stop: async () => undefined },
      }),
    );
    const res = await request(port, '/_tenant/globex/api/whoami?k=v', '127.0.0.1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ tenant: 'globex', path: '/api/whoami', query: { k: 'v' } });
    const unknown = await request(port, '/_tenant/nobody/api/whoami', '127.0.0.1');
    expect(unknown.status).toBe(404);
    // The same path through a same-machine reverse proxy: decided by host.
    const proxied = await request(port, '/_tenant/globex/api/whoami', 'acme.test', { 'x-forwarded-for': '203.0.113.9' });
    expect(JSON.parse(proxied.body)).toEqual({ tenant: 'acme', path: '/_tenant/globex/api/whoami', unhandled: true });
  });

  it('does not count a client that dropped while its tenant was being looked up', async () => {
    // A registry-backed source: the lookup is a real round trip, and the
    // client is gone before it answers.
    const slowSource: TenantSource = {
      resolveByHost: async (host) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return source.resolveByHost(host);
      },
      describe: (slug) => source.describe(slug),
    };
    const port = await listen(
      createTenantHost({
        source: slowSource,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        runtime: { activate: async (d) => ({ core: {}, app: tenantApp(d.slug) }) as unknown as TenantGraph, stop: async () => undefined },
      }),
    );
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    socket.write('GET /api/whoami HTTP/1.1\r\nHost: acme.test\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const runtime = host!.runtimes().get('acme');
    expect(runtime?.open).toBe(0);
    // ...and a client that stays is still counted, and left once it goes.
    const served = await request(port, '/api/whoami', 'acme.test');
    expect(served.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime?.open).toBe(0);
  });

  it('keeps a tenant with an open response alive through the sweep, and lets it go once that response closes', async () => {
    const events: string[] = [];
    const streams: import('express').Response[] = [];
    let now = 0;
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        idleMinutes: 1,
        sweepIntervalMs: 10,
        runtime: {
          activate: async (d) => {
            events.push(`activate:${d.slug}`);
            const app = express();
            // An event stream: headers sent, body held open until told.
            app.get('/api/events', (_req, res) => {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.write(': hello\n\n');
              streams.push(res);
            });
            return { core: {}, app } as unknown as TenantGraph;
          },
          stop: async (g) => {
            events.push('stop');
            void g;
          },
          busy: async () => false,
          now: () => now,
        },
      }),
    );
    const opened = new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: 'acme.test' } }, resolve);
      req.on('error', reject);
      req.end();
    });
    const stream = await opened;
    expect(stream.statusCode).toBe(200);
    expect(streams).toHaveLength(1);
    expect(host!.runtimes().get('acme')?.open).toBe(1);
    // An hour with no new request, and several sweeps: the stream keeps it.
    now += 3_600_000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host!.runtimes().get('acme')?.state).toBe('active');
    expect(events).toEqual(['activate:acme']);
    // The stream ends; idleness counts from here, so it is not evicted yet...
    streams[0]!.end();
    await new Promise<void>((resolve) => stream.on('end', resolve).resume());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host!.runtimes().get('acme')?.state).toBe('active');
    // ...and a minute after it closed, it is.
    now += 61_000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host!.runtimes().get('acme')?.state).toBe('idle');
    expect(events).toEqual(['activate:acme', 'stop']);
  });

  it('answers 503 with Retry-After while a tenant is still starting, and when its start failed', async () => {
    let fail = true;
    let release: (() => void) | null = null;
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        activationWaitMs: 50,
        runtime: {
          // No retry window here: the second request must try again at once.
          retry: { initialMs: 0 },
          activate: async (d) => {
            if (fail) throw new Error('no');
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return { core: {}, app: tenantApp(d.slug) } as unknown as TenantGraph;
          },
          stop: async () => undefined,
        },
      }),
    );
    const failed = await request(port, '/api/whoami', 'acme.test');
    expect(failed.status).toBe(503);
    expect(failed.headers['retry-after']).toBe('5');

    fail = false;
    const slow = await request(port, '/api/whoami', 'acme.test');
    expect(slow.status).toBe(503);
    // The activation keeps going behind the 503; once it lands, the next request is served.
    release!();
    const served = await request(port, '/api/whoami', 'acme.test');
    expect(served.status).toBe(200);
  });

  it('evicts every tenant on stop, and an idle tenant on the sweep, then reactivates on demand', async () => {
    const events: string[] = [];
    let now = 0;
    const port = await listen(
      createTenantHost({
        source,
        process: { port: 0, nodeEnv: 'test', trustProxy: '' },
        idleMinutes: 1,
        sweepIntervalMs: 10,
        runtime: {
          activate: async (d) => {
            events.push(`activate:${d.slug}`);
            return { core: {}, app: tenantApp(d.slug) } as unknown as TenantGraph;
          },
          stop: async (g) => {
            events.push(`stop:${(g.app as unknown as { slug?: string }).slug ?? ''}`);
          },
          busy: async () => false,
          now: () => now,
        },
      }),
    );
    await request(port, '/api/whoami', 'acme.test');
    expect(events).toEqual(['activate:acme']);
    // A minute passes with no request: the sweep stops the graph.
    now += 61_000;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(host!.runtimes().get('acme')?.state).toBe('idle');
    // ...and the next request brings it back.
    await request(port, '/api/whoami', 'acme.test');
    expect(events.filter((e) => e === 'activate:acme')).toHaveLength(2);
    await host!.stop();
    expect(host!.runtimes().get('acme')?.state).toBe('idle');
  });
});
