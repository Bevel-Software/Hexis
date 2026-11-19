import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http, { type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ShellIo, ShellCore } from '../shell.js';

/**
 * `main.ts` boots on import, so the shell and the composition roots are
 * stood in for: what is left is main's own wiring, the `listen` it hands the
 * shell in each boot shape. Both must return a server with the core's
 * keep-alive timeout, or a reverse proxy's pool outlives its idle sockets.
 */
const state = vi.hoisted(() => ({
  io: null as ShellIo<ShellCore> | null,
  tenantsFile: null as string | null,
}));

vi.mock('../shell.js', () => ({
  runShell: (io: ShellIo<ShellCore>) => {
    state.io = io;
    return Promise.resolve();
  },
}));

/** An app whose `listen` starts a real Node server on a free port. */
const fakeApp = () => ({
  listen: (_port: number, cb?: () => void) => http.createServer().listen(0, '127.0.0.1', cb),
});

vi.mock('@bevel-software/platform-core-backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bevel-software/platform-core-backend')>();
  return {
    ...actual,
    tenantHostEnv: () => ({ tenantsFile: state.tenantsFile, port: 0, nodeEnv: 'test' }),
    createCoreServer: async () => fakeApp(),
  };
});

let server: HttpServer | null = null;

async function listenIn(tenantsFile: string | null, core: unknown): Promise<HttpServer> {
  state.tenantsFile = tenantsFile;
  await import('../main.js');
  server = await state.io!.listen(core as ShellCore);
  await new Promise<void>((resolve) => (server!.listening ? resolve() : server!.once('listening', resolve)));
  return server;
}

describe('main — the server each boot shape listens on', () => {
  beforeEach(() => {
    vi.resetModules();
    state.io = null;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('one knowledge base: keeps an idle connection for 120 s', async () => {
    const s = await listenIn(null, { config: { port: 0, nodeEnv: 'test' } });
    expect((s.address() as AddressInfo).port).toBeGreaterThan(0);
    expect(s.keepAliveTimeout).toBe(120_000);
  });

  it('the tenant host: keeps an idle connection for 120 s', async () => {
    const s = await listenIn('/tenants.yaml', { host: { app: fakeApp() } });
    expect(s.keepAliveTimeout).toBe(120_000);
  });
});
