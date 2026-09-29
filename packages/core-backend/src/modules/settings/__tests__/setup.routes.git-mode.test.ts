import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { KbContext } from '../../../shared/kb-context.js';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import { ManagedRepository } from '../managed-repository.js';
import { RepositorySource } from '../repository-source.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ConnectionCheck, RepositoryConnection } from '../connection-check.js';

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const KB_ENV = ['KB_REPO_URL', 'GIT_TOKEN', 'GIT_USERNAME', 'GIT_MODE', 'GITHUB_TOKEN', 'DEFAULT_BRANCH', 'PROTECTED_BRANCHES'] as const;

let server: HttpServer | null = null;
let savedEnv: Partial<Record<(typeof KB_ENV)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of KB_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  server?.close();
  server = null;
  for (const k of KB_ENV) {
    const original = savedEnv[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

/**
 * The setup router with the choice of repository, over settings that are
 * stored in memory. The managed repository is a stand-in that records being
 * asked for; the startup phase and the remote are stand-ins that count.
 */
function listen(opts: { kb?: KbContext; ensureFails?: boolean; stored?: Record<string, string> } = {}) {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  const kb = opts.kb ?? testKbContext({ branchModel: null });
  const managed = new ManagedRepository('/data/backups/managed-repository');
  const source = new RepositorySource({ read: (key) => settings.resolve(key), managed });
  const ensured: string[] = [];
  const probed: RepositoryConnection[] = [];
  let phaseRuns = 0;
  /** The address the startup phase found configured when it ran. */
  const phaseSaw: string[] = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userEmail = 'root@example.com';
    req.userId = 'user-1';
    next();
  });
  app.use(
    '/api',
    createSetupRoutes(
      settings,
      { isAdmin: async () => true } as IAdminAccessService,
      {
        runAll: async () => {
          phaseRuns += 1;
          phaseSaw.push(source.url());
        },
      },
      kb,
      undefined,
      async (connection): Promise<ConnectionCheck> => {
        probed.push(connection);
        return { outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false };
      },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        source,
        ensureManaged: async (branch) => {
          if (opts.ensureFails) throw new Error('EACCES: permission denied, mkdir /data/backups');
          ensured.push(branch);
        },
      },
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const save = (entries: Record<string, string>) =>
    fetch(`${base}/api/setup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: entries }),
    });
  const status = async () => (await fetch(`${base}/api/setup/status`)).json() as Promise<Record<string, unknown>>;
  return { save, status, settings, source, managed, ensured, probed, kb, phase: { runs: () => phaseRuns, saw: phaseSaw } };
}

const HOSTED = { kbRepoUrl: 'https://git.example.com/acme/kb.git', gitToken: 'the-token' };
const BRANCHES = { defaultBranch: 'main', protectedBranches: 'main' };

describe('setup status: the choice of repository', () => {
  it('offers the ways there are, and says none is chosen on a new deployment', async () => {
    const { status } = listen();
    expect(await status()).toMatchObject({ complete: false, repository: { mode: null, modes: ['managed', 'token'] } });
  });

  it('says a deployment configured before there was a choice is on the way it has', async () => {
    const { status, save } = listen({ kb: testKbContext() });
    await save({ ...HOSTED, ...BRANCHES });
    expect(await status()).toMatchObject({ repository: { mode: 'token' } });
  });
});

describe('choosing a repository the deployment keeps', () => {
  it('finishes setup on that choice alone', async () => {
    const { save, ensured, probed, phase, managed, kb } = listen();
    const res = await save({ gitMode: 'managed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, complete: true, restartRequired: false, repository: { mode: 'managed' } });
    // The repository was there before the save pointed everything at it,
    expect(ensured).toEqual(['main']);
    // no host was asked anything,
    expect(probed).toEqual([]);
    // and the startup phase ran against it, on the branches named for it.
    expect(phase.runs()).toBe(1);
    expect(phase.saw).toEqual([managed.path]);
    expect(kb.defaultBranch).toBe('main');
    expect([...kb.protectedBranches]).toEqual(['main']);
  });

  it('keeps the branches an admin named over its own', async () => {
    const { save, ensured, settings } = listen();
    const res = await save({ gitMode: 'managed', defaultBranch: 'live', protectedBranches: 'live, draft' });
    expect(res.status).toBe(200);
    expect(ensured).toEqual(['live']);
    expect(settings.resolve('defaultBranch')).toBe('live');
    expect(settings.resolve('protectedBranches')).toBe('live, draft');
  });

  it('names no branches for any other way: a repository that exists is asked for its own', async () => {
    const { save, settings } = listen();
    await save({ ...HOSTED, gitMode: 'token' });
    expect(settings.resolve('defaultBranch')).toBe('');
    expect(settings.resolve('protectedBranches')).toBe('');
  });

  it('refuses the choice when the repository cannot be created, and stores nothing', async () => {
    const { save, settings, phase } = listen({ ensureFails: true });
    const res = await save({ gitMode: 'managed' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; problems: Record<string, string> };
    expect(body.problems.gitMode).toMatch(/could not be created/);
    // What the disk said stays in the log.
    expect(JSON.stringify(body)).not.toMatch(/EACCES|\/data\/backups/);
    expect(settings.resolve('gitMode')).toBe('');
    expect(phase.runs()).toBe(0);
  });

  it('refuses a way it does not know', async () => {
    const { save } = listen();
    const res = await save({ gitMode: 'carrier-pigeon' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { problems: Record<string, string> }).problems.gitMode).toMatch(/managed, github-app, token/);
  });
});

describe('a deployment that is serving moves to another repository', () => {
  async function serving() {
    const mounted = listen({ kb: testKbContext() });
    await mounted.save({ ...HOSTED, ...BRANCHES });
    return mounted;
  }

  it('owes a restart, and leaves the working copies to the startup phase', async () => {
    const { save, phase, ensured } = await serving();
    const runsBefore = phase.runs();
    const res = await save({ gitMode: 'managed' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, restartRequired: true, repository: { mode: 'managed' } });
    expect(ensured).toHaveLength(1);
    // Sessions may be live: the phase that moves working copies waits for the restart.
    expect(phase.runs()).toBe(runsBefore);
  });

  it('owes none for naming the way it was already on', async () => {
    const { save, probed } = await serving();
    const asked = probed.length;
    const body = (await (await save({ gitMode: 'token' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, restartRequired: false, repository: { mode: 'token' } });
    // Nothing about the connection changed, so the host is not asked again.
    expect(probed).toHaveLength(asked);
  });

  it('stops presenting the token it had to the repository it keeps', async () => {
    const { save, source } = await serving();
    expect(source.credentials.token()).toBe('the-token');
    await save({ gitMode: 'managed' });
    expect(source.credentials.token()).toBeNull();
  });
});

describe('a mount without the choice', () => {
  it('is the one way there was: an address and a token', async () => {
    const db = {
      select: () => ({ from: () => Promise.resolve([]) }),
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
      delete: () => ({ where: () => Promise.resolve() }),
    } as unknown as Database;
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userEmail = 'root@example.com';
      next();
    });
    app.use('/api', createSetupRoutes(settings, { isAdmin: async () => true } as IAdminAccessService, { runAll: async () => {} }, testKbContext()));
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const status = (await (await fetch(`http://127.0.0.1:${port}/api/setup/status`)).json()) as Record<string, unknown>;
    expect(status).not.toHaveProperty('repository');
    expect(status.complete).toBe(false);
  });
});
