import express, { type Express, type Request } from 'express';
import path from 'node:path';
import { isIP } from 'node:net';
import type { ProcessConfig } from '../core-config.js';
import { GIT_SHA } from '../version.js';
import { logger } from '../shared/logging.js';
import { TenantRuntime, type TenantRuntimeDeps } from './tenant-runtime.js';
import { TENANT_SLUG_PATTERN, normalizeHost, type TenantDescriptor, type TenantSource } from './tenant-source.contract.js';

const log = logger('tenancy');

/**
 * The path prefix under which a process reaches ONE of its own tenants over
 * loopback: `http://127.0.0.1:<port>/_tenant/<slug>/api/...`. The MCP proxy
 * and the UTCP manuals it seeds dial the tenant's own REST surface this way,
 * because a loopback request carries no tenant host name and a header cannot
 * ride a UTCP call (the proxy is a passthrough; it reshapes nothing).
 *
 * The host honours the prefix only for a request that came from this
 * machine AND was forwarded by nobody: the socket peer is loopback and there
 * is no `X-Forwarded-For`. A reverse proxy on the same host (nginx, a
 * Coolify proxy) delivers every public request from a loopback socket, and
 * every such proxy adds that header; the process's own dial never does.
 * What the prefix could grant anyone who got past this is only what the
 * tenant's host name grants already — sessions, keys and tokens are per
 * tenant — but the addressing rule is stated so it can be relied on.
 */
export const LOOPBACK_TENANT_PREFIX = '/_tenant';

/** The base URL a tenant's graph dials itself at — see {@link LOOPBACK_TENANT_PREFIX}. */
export function loopbackTenantBaseUrl(port: number, slug: string): string {
  return `http://127.0.0.1:${port}${LOOPBACK_TENANT_PREFIX}/${slug}`;
}

/** Whether `address` is this machine talking to itself. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  if (bare === '::1') return true;
  return isIP(bare) === 4 && bare.startsWith('127.');
}

/** How a request names its tenant: by the loopback prefix, or by its host. */
export type TenantSelector = { kind: 'slug'; slug: string; rest: string } | { kind: 'host'; host: string };

/**
 * Which tenant a request is for. The loopback prefix wins, but only from a
 * loopback peer that no proxy forwarded (no `X-Forwarded-For`); everything
 * else is decided by the host name (the `X-Forwarded-Host` a trusted proxy
 * set, else `Host`), lowercase and without its port.
 */
export function selectTenant(req: {
  hostname: string;
  url: string;
  peer: string | undefined;
  forwardedFor?: string | string[] | undefined;
}): TenantSelector {
  const forwarded = Array.isArray(req.forwardedFor) ? req.forwardedFor.length > 0 : Boolean(req.forwardedFor);
  if (isLoopbackAddress(req.peer) && !forwarded && req.url.startsWith(`${LOOPBACK_TENANT_PREFIX}/`)) {
    const afterPrefix = req.url.slice(LOOPBACK_TENANT_PREFIX.length + 1);
    const end = afterPrefix.search(/[/?#]/);
    const slug = end === -1 ? afterPrefix : afterPrefix.slice(0, end);
    if (TENANT_SLUG_PATTERN.test(slug)) {
      const rest = end === -1 ? '/' : afterPrefix.slice(end).replace(/^(?=[?#])/, '/');
      return { kind: 'slug', slug, rest };
    }
  }
  return { kind: 'host', host: normalizeHost(req.hostname || '') };
}

export interface TenantHostOptions {
  source: TenantSource;
  process: ProcessConfig;
  /** The built SPA, served once for every resolved tenant. */
  staticDir?: string;
  /** Minutes without a request after which a tenant's graph is stopped. Default 30; 0 never evicts. */
  idleMinutes?: number;
  /** How long a request waits for an activation in flight before answering 503. Default 60s. */
  activationWaitMs?: number;
  /** Seams for the runtimes the host builds — a suite's fake graphs. */
  runtime?: TenantRuntimeDeps;
  /** How often idle tenants are looked for. Default: once a minute. */
  sweepIntervalMs?: number;
}

export interface TenantHost {
  /** The app the process listens on. */
  app: Express;
  /** The runtimes built so far, by slug. */
  runtimes(): ReadonlyMap<string, TenantRuntime>;
  /** Stop every active tenant; the host keeps serving and reactivates on demand. */
  evictAll(): Promise<void>;
  /** Stop the idle sweep and every tenant: the process's shutdown. */
  stop(): Promise<void>;
}

const DEFAULT_ACTIVATION_WAIT_MS = 60_000;
const DEFAULT_IDLE_MINUTES = 30;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** `promise`, or `null` once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * One Express app in front of many tenants' apps. It answers process health
 * itself, resolves each request to a tenant (see {@link selectTenant}),
 * activates that tenant's graph on first use, hands the request to the
 * tenant's app, and serves the SPA for whatever the tenant's app leaves
 * unhandled. Nothing below it knows there are other tenants: each graph was
 * built by the same composition root a single-tenant deployment uses.
 */
export function createTenantHost(opts: TenantHostOptions): TenantHost {
  const runtimes = new Map<string, TenantRuntime>();
  const activationWaitMs = opts.activationWaitMs ?? DEFAULT_ACTIVATION_WAIT_MS;
  const idleMs = (opts.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000;

  const runtimeFor = (descriptor: TenantDescriptor): TenantRuntime => {
    let runtime = runtimes.get(descriptor.slug);
    if (!runtime) {
      runtime = new TenantRuntime(descriptor, opts.runtime);
      runtimes.set(descriptor.slug, runtime);
    }
    return runtime;
  };

  const app = express();
  // Forwarded headers are honoured exactly as a single-tenant deployment
  // honours them, and for the same reason: `req.hostname` is what picks the
  // tenant, and behind a proxy it lives in `X-Forwarded-Host`.
  if (opts.process.trustProxy) {
    const raw = opts.process.trustProxy;
    app.set('trust proxy', /^\d+$/.test(raw) ? Number(raw) : raw);
  }

  // The process's own health, before any tenant is involved: a load balancer
  // asks with whatever host name it likes, and a process with no active
  // tenant is still a healthy process.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', sha: GIT_SHA, timestamp: Date.now(), tenants: runtimes.size });
  });

  app.use(async (req: Request, res, next) => {
    const selector = selectTenant({
      hostname: req.hostname,
      url: req.url,
      peer: req.socket.remoteAddress,
      forwardedFor: req.headers['x-forwarded-for'],
    });
    let descriptor: TenantDescriptor | null;
    try {
      descriptor =
        selector.kind === 'slug'
          ? await opts.source.describe(selector.slug)
          : await opts.source.resolveByHost(selector.host);
    } catch (err) {
      log.error('tenant lookup failed:', { err });
      res.status(503).set('Retry-After', '5').json({ error: 'Tenant lookup failed' });
      return;
    }
    if (!descriptor) {
      if (req.path.startsWith('/api/') || req.path.startsWith(LOOPBACK_TENANT_PREFIX)) {
        res.status(404).json({ error: 'No workspace at this address' });
      } else {
        res.status(404).type('text/plain').send('No workspace at this address.');
      }
      return;
    }
    if (selector.kind === 'slug') req.url = selector.rest;

    const runtime = runtimeFor(descriptor);
    // Counted from here, before the graph is even asked for, until the
    // response closes however it ends — a 503 below included. An open
    // response is what keeps a tenant from being evicted from under it.
    runtime.enter();
    res.on('close', () => runtime.leave());
    let graph: Awaited<ReturnType<TenantRuntime['handle']>> | null;
    try {
      graph = await within(runtime.handle(), activationWaitMs);
    } catch {
      // Logged by the runtime; the caller learns only that it may try again.
      res.status(503).set('Retry-After', '5').json({ error: 'This workspace could not be started; try again shortly' });
      return;
    }
    if (!graph) {
      res.status(503).set('Retry-After', '5').json({ error: 'This workspace is starting; try again shortly' });
      return;
    }
    graph.app(req, res, next);
  });

  // Whatever a tenant's app left unhandled: the SPA, with the same rule a
  // single-tenant deployment applies to the namespaces that must never
  // resolve to `index.html` (see `createCoreServer`).
  if (opts.staticDir) {
    const frontendDist = opts.staticDir;
    app.use(express.static(frontendDist));
    app.get('{*path}', (req, res) => {
      if (
        req.path.startsWith('/.well-known/') ||
        req.path.startsWith('/api/') ||
        req.path.startsWith('/login/oauth/')
      ) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  // Idle tenants are stopped on a timer, never on the request that would
  // have been their last: a graph whose last response closed `idleMs` ago,
  // with none still open and no queued commit, is not worth its pool and
  // its lease. `busy()` is what keeps an event stream's tenant alive.
  const sweep = async () => {
    for (const runtime of runtimes.values()) {
      if (runtime.state !== 'active' || runtime.idleFor() < idleMs) continue;
      if (await runtime.busy()) continue;
      await runtime.evict().catch((err: unknown) => log.warn(`evicting tenant "${runtime.slug}" failed:`, { err }));
    }
  };
  const sweeper =
    idleMs > 0
      ? setInterval(() => void sweep(), Math.min(opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS, idleMs))
      : null;
  sweeper?.unref();

  const evictAll = async () => {
    await Promise.all([...runtimes.values()].map((runtime) => runtime.evict().catch(() => undefined)));
  };

  return {
    app,
    runtimes: () => runtimes,
    evictAll,
    async stop() {
      if (sweeper) clearInterval(sweeper);
      await evictAll();
    },
  };
}
