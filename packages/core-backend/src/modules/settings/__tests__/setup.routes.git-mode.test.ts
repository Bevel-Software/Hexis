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
function listen(
  opts: {
    kb?: KbContext;
    ensureFails?: boolean;
    stored?: Record<string, string>;
    /** The addresses the startup phase cannot reach. */
    unreachable?: (url: string) => boolean;
    /** The deployment booted onto a repository it could not reach, and came up gated. */
    bootFailed?: boolean;
  } = {},
) {
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
  /** Stands until the deployment is pointed somewhere the phase can reach. */
  let bootFailed = opts.bootFailed ?? false;
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
          if (opts.unreachable?.(source.url())) throw new Error(`fatal: repository '${source.url()}' not found`);
          bootFailed = false;
        },
        // A boot that survived an unreachable repository, as the runner reports it.
        ...(opts.bootFailed ? { lastFailure: () => (bootFailed ? 'fatal: unable to access the repository' : null) } : {}),
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

  it('owes a restart, and says both where it is and where it is going', async () => {
    const { save, status, phase, ensured } = await serving();
    const runsBefore = phase.runs();
    const res = await save({ gitMode: 'managed' });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, complete: true, restartRequired: true, repository: { mode: 'token', chosen: 'managed' } });
    expect(await status()).toMatchObject({ complete: true, repository: { mode: 'token', chosen: 'managed' } });
    expect(ensured).toHaveLength(1);
    // Sessions may be live: the phase that moves working copies waits for the restart.
    expect(phase.runs()).toBe(runsBefore);
  });

  /**
   * The move is a fact about the NEXT start. Until then every working copy
   * is a clone of the repository the deployment had, so that is the
   * repository git is handed the address of, and its token is the one
   * presented. Reading the mode live moved the process at the save: pushes
   * went out with no credential, and a branch opened in between was cloned
   * from a repository nothing had prepared.
   */
  it('goes on working against the repository it has until it is started again', async () => {
    const { save, source } = await serving();
    await save({ gitMode: 'managed' });
    expect(source.mode()).toBe('token');
    expect(source.url()).toBe(HOSTED.kbRepoUrl);
    expect(source.credentials.token()).toBe('the-token');
    expect(source.credentials.username()).toBe('x-access-token');
    // A token rotated meanwhile is still the one the next push carries.
    await save({ gitToken: 'a-rotated-token' });
    expect(source.credentials.token()).toBe('a-rotated-token');
  });

  it('is on the repository it chose once it is started again, and presents it nothing of the old one', async () => {
    const { save, source, managed } = await serving();
    await save({ gitMode: 'managed' });
    // What a restart does: the source is built on the mode chosen.
    source.takeEffect();
    expect(source.mode()).toBe('managed');
    expect(source.url()).toBe(managed.path);
    expect(source.credentials.token()).toBeNull();
  });

  it('goes on owing the restart through saves about other things', async () => {
    const { save } = await serving();
    await save({ gitMode: 'managed' });
    const body = (await (await save({ kbSyncSecret: 'a-secret-of-sixteen-or-more' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, restartRequired: true, repository: { mode: 'token', chosen: 'managed' } });
  });

  it('owes nothing once the move is taken back', async () => {
    const { save, probed } = await serving();
    await save({ gitMode: 'managed' });
    const asked = probed.length;
    const body = (await (await save({ gitMode: 'token' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, restartRequired: false, repository: { mode: 'token', chosen: 'token' } });
    // Nothing about the connection changed, so the host is not asked again.
    expect(probed).toHaveLength(asked);
  });

  it('owes none for naming the way it was already on', async () => {
    const { save, probed } = await serving();
    const asked = probed.length;
    const body = (await (await save({ gitMode: 'token' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, restartRequired: false, repository: { mode: 'token', chosen: 'token' } });
    expect(probed).toHaveLength(asked);
  });
});

/**
 * The pin protects what is running on the mode in effect. Behind a shut
 * gate nothing is, however completely the settings were answered, and a
 * deployment pinned there could not be got out of a repository that does
 * not work by choosing one that does.
 */
describe('a deployment that answered everything and serves nobody', () => {
  const isHosted = (url: string) => url === HOSTED.kbRepoUrl;

  it('is got going by choosing another way, when its first initialisation failed', async () => {
    const { save, status, phase, managed, source } = listen({ kb: testKbContext(), unreachable: isHosted });
    // First run: an address and a token, accepted, and a first clone that fails.
    const first = await save({ ...HOSTED, ...BRANCHES });
    expect(first.status).toBe(500);
    expect(await status()).toMatchObject({ complete: false, kbInit: expect.any(Object), repository: { mode: 'token' } });

    const second = await save({ gitMode: 'managed' });
    const body = (await second.json()) as Record<string, unknown>;
    expect(second.status, JSON.stringify(body)).toBe(200);
    // The retry ran against the repository that was chosen, not the one that had just failed,
    expect(phase.saw).toEqual([HOSTED.kbRepoUrl, managed.path]);
    // nothing is owed, and the gate is open.
    expect(body).toMatchObject({ complete: true, restartRequired: false, repository: { mode: 'managed', chosen: 'managed' } });
    expect(source.credentials.token()).toBeNull();
    expect(await status()).toMatchObject({ complete: true });
    expect(await status()).not.toHaveProperty('kbInit');
  });

  it('is got going the same way when it booted onto a repository it could not reach', async () => {
    Object.assign(process.env, { KB_REPO_URL: HOSTED.kbRepoUrl, GIT_TOKEN: HOSTED.gitToken, DEFAULT_BRANCH: 'main', PROTECTED_BRANCHES: 'main' });
    const { save, status, phase, managed } = listen({ kb: testKbContext(), bootFailed: true, unreachable: isHosted });
    expect(await status()).toMatchObject({ complete: false, repository: { mode: 'token' } });

    const body = (await (await save({ gitMode: 'managed' })).json()) as Record<string, unknown>;
    expect(phase.saw).toEqual([managed.path]);
    expect(body).toMatchObject({ complete: true, restartRequired: false, repository: { mode: 'managed', chosen: 'managed' } });
  });

  it('is still asked for a restart once it IS serving: the same save, a different deployment', async () => {
    const { save, phase } = listen({ kb: testKbContext() });
    await save({ ...HOSTED, ...BRANCHES });
    const runs = phase.runs();
    const body = (await (await save({ gitMode: 'managed' })).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ complete: true, restartRequired: true, repository: { mode: 'token', chosen: 'managed' } });
    expect(phase.runs()).toBe(runs);
  });
});

describe('a deployment whose way is chosen by the environment', () => {
  it('says which variable chose', async () => {
    process.env.GIT_MODE = 'managed';
    const { status } = listen();
    expect(await status()).toMatchObject({ repository: { mode: 'managed', chosen: 'managed', pinned: 'GIT_MODE' } });
  });

  it('says nothing of the kind when the admin chose', async () => {
    const { save, status } = listen();
    await save({ gitMode: 'managed' });
    expect(((await status()) as { repository: object }).repository).not.toHaveProperty('pinned');
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
