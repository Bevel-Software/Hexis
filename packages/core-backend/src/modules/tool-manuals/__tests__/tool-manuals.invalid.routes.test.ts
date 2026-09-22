import type { Server as HttpServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { KbPluginSource } from '../../plugins/discovery/kb-plugin-source.js';
import { createToolManualsBrowserRoutes } from '../tool-manuals.routes.js';
import { createSecretsVaultRoutes } from '../../secrets-vault/secrets-vault.routes.js';
import { ToolManualService } from '../tool-manuals.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';

/**
 * THE TWO HTTP SURFACES, over a real catalog.
 *
 * `tool-manuals.invalid.test.ts` pins the service and `tool-manuals.tools.test.ts`
 * the MCP tool; these two routes are the remaining way a caller learns that a
 * `.tool` was refused — `GET /api/tools` for the catalog and
 * `GET /api/secrets/tools` for the Library page — and a field that exists in
 * the service but never reaches the wire is not a feature anyone can use.
 *
 * Deliberately NOT stubbed: the service runs against a real temp knowledge base
 * holding a real malformed manual, so what these assert is the whole path from
 * a bad file on disk to the JSON body — including that the route serializes
 * `invalid` at all, which a stubbed service cannot tell us.
 */

const disk = new NodeFs();
const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const READER = 'reader@x.eu';
const OWNER = 'owner@x.eu';

const WEATHER = JSON.stringify({
  name: 'weather',
  type: 'http',
  url: 'https://api.example.com/utcp',
  variables: [{ name: 'WEATHER_KEY', scope: 'admin' }],
});
const BILLING = JSON.stringify({ name: 'billing', type: 'http', url: 'https://api.example.com/b' });
/** A nested mapping under a scalar key: the parser stops at a line and a column. */
const BAD_YAML = '---\nid: broken\ntype: http\nurl: https://api.example.com/x\n  headers: oops\n---\n';

let root: string;
let clock: number;
let httpServer: HttpServer | undefined;

const workspaceService = {
  getOrCreateForBranch: async () => ({ id: wsId }),
  getWorkspacePath: async (id: string) => join(root, id),
  hasBootstrappedWorkspace: async () => false,
} as unknown as WorkspaceService;

/** Everyone reads everything except `broken.tool`, which only its OWNER may read. */
const accessControl = {
  canRead: async (_w: string, email: string, p: string) => email === OWNER || !p.includes('broken'),
  canReadBatch: async (_w: string, email: string, paths: string[]) =>
    new Map(paths.map((p) => [p, email === OWNER || !p.includes('broken')])),
  canWrite: async () => false,
} as unknown as IAccessControl;

const pluginsDir = () => join(root, wsId, KB_DIR, 'Plugins');
const write = (name: string, body: string) => writeFile(join(pluginsDir(), name), body);
/** Past the scan's TTL: "the next listing" to a process nobody restarted. */
const nextListing = () => {
  clock += 120_000;
};

/**
 * Both routers on one app, over ONE service instance — as the composition root
 * wires them, so the Library page and the catalog listing answer from the same
 * catalog rather than two of their own.
 */
async function baseUrlAs(email: string | undefined): Promise<{ base: string; service: ToolManualService }> {
  const service = new ToolManualService(
    workspaceService,
    accessControl,
    KB_DIR,
    disk,
    new KbPluginSource(disk),
    () => clock,
  );
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (email) {
      req.userEmail = email;
      req.userId = `id-${email}`;
    }
    next();
  });
  app.use('/api', createToolManualsBrowserRoutes(service));
  app.use(
    '/api',
    createSecretsVaultRoutes({
      secretsVault: { statusFor: async () => [] } as unknown as Parameters<
        typeof createSecretsVaultRoutes
      >[0]['secretsVault'],
      toolManualService: service,
      accessControl,
      connectionProbe: { probe: async () => ({ status: 'unverifiable' as const, detail: null, checkedAt: new Date() }) } as unknown as Parameters<
        typeof createSecretsVaultRoutes
      >[0]['connectionProbe'],
      stateSecret: 'test-secret',
      publicBackendUrl: 'http://localhost:3000',
      publicFrontendUrl: 'http://localhost:5173',
    }),
  );
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, service };
}

type Body = { tools: { name: string; path: string }[]; invalid: { path: string; reason: string }[] };

beforeEach(async () => {
  clock = 1_000_000;
  root = await mkdtemp(join(tmpdir(), 'tools-invalid-routes-'));
  await mkdir(pluginsDir(), { recursive: true });
  await write('weather.tool', WEATHER);
  await write('billing.tool', BILLING);
  await write('broken.tool', BAD_YAML);
});

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/tools — the catalog carries its refusals', () => {
  it('lists every valid tool and names the refused file with a located reason', async () => {
    const { base } = await baseUrlAs(OWNER);

    const res = await fetch(`${base}/api/tools`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    // The refusal costs that file and nothing else.
    expect(body.tools.map((t) => t.name).sort()).toEqual(['billing', 'weather']);
    // …and the file that did not make it is on the wire, with where to look.
    expect(body.invalid).toHaveLength(1);
    expect(body.invalid[0].path).toBe('Plugins/broken.tool');
    expect(body.invalid[0].reason).toMatch(/line \d+, column \d+/);
  });

  it('withholds the refusal from a caller who may not read that file', async () => {
    // A path is a fact about the knowledge base: default-deny applies to
    // "there is a broken tool here" exactly as it does to the tool itself.
    const { base } = await baseUrlAs(READER);

    const body = (await (await fetch(`${base}/api/tools`)).json()) as Body;
    expect(body.tools.map((t) => t.name).sort()).toEqual(['billing', 'weather']);
    expect(body.invalid).toEqual([]);
  });

  it('restores the tool on the NEXT listing once the file is fixed, with no reconnect', async () => {
    const { base } = await baseUrlAs(OWNER);
    expect(((await (await fetch(`${base}/api/tools`)).json()) as Body).invalid).toHaveLength(1);

    // The same server, the same service object — nothing restarted.
    await write('broken.tool', JSON.stringify({ name: 'fixed', type: 'http', url: 'https://api.example.com/u' }));
    nextListing();

    const body = (await (await fetch(`${base}/api/tools`)).json()) as Body;
    expect(body.tools.map((t) => t.name).sort()).toEqual(['billing', 'fixed', 'weather']);
    expect(body.invalid).toEqual([]);
  });

  it('clears the refusal when the file is DISABLED — deleted — instead of fixed', async () => {
    const { base } = await baseUrlAs(OWNER);
    expect(((await (await fetch(`${base}/api/tools`)).json()) as Body).invalid).toHaveLength(1);

    await unlink(join(pluginsDir(), 'broken.tool'));
    nextListing();

    const body = (await (await fetch(`${base}/api/tools`)).json()) as Body;
    expect(body.tools.map((t) => t.name).sort()).toEqual(['billing', 'weather']);
    expect(body.invalid).toEqual([]);
  });

  it('refuses an unauthenticated call rather than listing anything', async () => {
    const { base } = await baseUrlAs(undefined);
    const res = await fetch(`${base}/api/tools`);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/secrets/tools — the Library page carries them too', () => {
  it('lists every valid tool and names the refused file', async () => {
    const { base } = await baseUrlAs(OWNER);

    const res = await fetch(`${base}/api/secrets/tools`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;

    expect(body.tools.map((t) => t.name).sort()).toEqual(['billing', 'weather']);
    expect(body.invalid).toEqual([
      { path: 'Plugins/broken.tool', reason: expect.stringMatching(/line \d+, column \d+/) },
    ]);
  });

  it('narrows `invalid` with ?path= exactly as it narrows the manuals', async () => {
    const { base } = await baseUrlAs(OWNER);

    // The editor sidebar asking about the broken file gets THAT file's verdict.
    const bad = (await (
      await fetch(`${base}/api/secrets/tools?path=${encodeURIComponent('Plugins/broken.tool')}`)
    ).json()) as Body;
    expect(bad.tools).toEqual([]);
    expect(bad.invalid.map((i) => i.path)).toEqual(['Plugins/broken.tool']);

    // …and asking about a healthy one gets a tool and no refusal at all.
    const good = (await (
      await fetch(`${base}/api/secrets/tools?path=${encodeURIComponent('Plugins/weather.tool')}`)
    ).json()) as Body;
    expect(good.tools.map((t) => t.name)).toEqual(['weather']);
    expect(good.invalid).toEqual([]);
  });

  it('withholds the refusal from a caller who may not read that file', async () => {
    const { base } = await baseUrlAs(READER);
    const body = (await (await fetch(`${base}/api/secrets/tools`)).json()) as Body;
    expect(body.tools.map((t) => t.name).sort()).toEqual(['billing', 'weather']);
    expect(body.invalid).toEqual([]);
  });

  it('refuses an unauthenticated call rather than listing anything', async () => {
    const { base } = await baseUrlAs(undefined);
    const res = await fetch(`${base}/api/secrets/tools`);
    expect(res.status).toBe(401);
  });
});

describe('both surfaces answer from one catalog', () => {
  it('reports the same refused file, with the same reason, on the same snapshot', async () => {
    const { base } = await baseUrlAs(OWNER);

    const [catalog, library] = (await Promise.all([
      fetch(`${base}/api/tools`).then((r) => r.json()),
      fetch(`${base}/api/secrets/tools`).then((r) => r.json()),
    ])) as [Body, Body];

    expect(catalog.invalid).toEqual(library.invalid);
    expect(catalog.tools.map((t) => t.path).sort()).toEqual(library.tools.map((t) => t.path).sort());
  });
});
