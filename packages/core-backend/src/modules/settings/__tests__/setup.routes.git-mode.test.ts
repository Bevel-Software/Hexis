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
  /** `confirm` is the admin's answer to the question a move is asked, when they have given one. */
  const save = (entries: Record<string, string>, confirm?: 'keep' | 'close') =>
    fetch(`${base}/api/setup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: entries, ...(confirm ? { confirmRepositoryChange: confirm } : {}) }),
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

  /**
   * A move is asked about before anything is stored: the save is refused
   * until the answer comes back, naming the way left and the way moved to.
   * Refused, it has changed nothing — the deployment is where it was.
   */
  it('is asked first, and until it answers nothing has moved', async () => {
    const { save, status, phase, source, settings } = await serving();
    const runsBefore = phase.runs();
    const res = await save({ gitMode: 'managed' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ repositoryChange: { openChangeRequests: 0, from: 'token', to: 'managed' } });
    expect(settings.resolve('gitMode')).toBe('');
    expect(source.mode()).toBe('token');
    expect(source.url()).toBe(HOSTED.kbRepoUrl);
    expect(phase.runs()).toBe(runsBefore);
    expect(await status()).toMatchObject({ complete: true, repository: { mode: 'token', chosen: 'token' } });
  });

  /**
   * Confirmed, the move takes effect ON THE SAVE: the way chosen is the way
   * in effect, the startup phase runs against the repository moved to, and
   * no restart is owed. It once waited for the next start, which an admin of
   * a hosted workspace has no way to give.
   */
  it('moves on the save once confirmed, and owes no restart', async () => {
    const { save, status, phase, ensured, managed, source } = await serving();
    const runsBefore = phase.runs();
    const res = await save({ gitMode: 'managed' }, 'keep');
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      complete: true,
      restartRequired: false,
      repository: { mode: 'managed', chosen: 'managed' },
      repositoryChange: { choice: 'keep' },
    });
    expect(ensured).toHaveLength(1);
    // The phase that sets the old working copies aside ran, against the repository moved to.
    expect(phase.runs()).toBe(runsBefore + 1);
    expect(phase.saw.at(-1)).toBe(managed.path);
    expect(source.url()).toBe(managed.path);
    expect(await status()).toMatchObject({ complete: true, repository: { mode: 'managed', chosen: 'managed' } });
  });

  /** One way's credential is never presented to another way's repository. */
  it('presents the repository moved to nothing of the one that was left', async () => {
    const { save, source } = await serving();
    expect(source.credentials.token()).toBe('the-token');
    await save({ gitMode: 'managed' }, 'keep');
    expect(source.credentials.token()).toBeNull();
  });

  it('owes nothing through later saves about other things, and is not asked again', async () => {
    const { save } = await serving();
    await save({ gitMode: 'managed' }, 'keep');
    const res = await save({ kbSyncSecret: 'a-secret-of-sixteen-or-more' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, restartRequired: false, repository: { mode: 'managed', chosen: 'managed' } });
  });

  it('is asked again to move back: that is a move too', async () => {
    const { save, source } = await serving();
    await save({ gitMode: 'managed' }, 'keep');
    const back = await save({ gitMode: 'token' });
    expect(back.status).toBe(409);
    expect(await back.json()).toMatchObject({ repositoryChange: { from: 'managed', to: 'token' } });
    const done = await save({ gitMode: 'token' }, 'keep');
    expect(await done.json()).toMatchObject({ ok: true, restartRequired: false, repository: { mode: 'token', chosen: 'token' } });
    expect(source.url()).toBe(HOSTED.kbRepoUrl);
  });

  /** Another address under the same way is the same question, with the same answer. */
  it('asks the same of another address under the way it is on', async () => {
    const { save, source, phase } = await serving();
    const moved = { kbRepoUrl: 'https://git.example.com/acme/another.git', gitToken: 'another-token' };
    const asked = await save(moved);
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ repositoryChange: { from: 'token', to: 'token' } });
    const runsBefore = phase.runs();
    const done = await save(moved, 'close');
    expect(await done.json()).toMatchObject({ ok: true, restartRequired: false, repositoryChange: { choice: 'close' } });
    expect(phase.runs()).toBe(runsBefore + 1);
    expect(source.url()).toBe(moved.kbRepoUrl);
  });

  it('asks nothing of a save that only spells the same address another way', async () => {
    const { save } = await serving();
    const res = await save({ kbRepoUrl: 'https://GIT.example.com/acme/kb/' });
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('repositoryChange');
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
 * Behind a shut gate nothing is running on the way in effect, however
 * completely the settings were answered, so a deployment there is got out of
 * a repository that does not work by choosing one that does. One that never
 * served is not even asked: there is no repository anyone worked on to
 * leave. One that served before its boot failed is asked, as any move is.
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

    // It served before this boot, so there may be work on the repository it
    // leaves: it is asked, and nothing moves until it answers.
    const asked = await save({ gitMode: 'managed' });
    expect(asked.status).toBe(409);
    expect(phase.saw).toEqual([]);

    const body = (await (await save({ gitMode: 'managed' }, 'keep')).json()) as Record<string, unknown>;
    expect(phase.saw).toEqual([managed.path]);
    expect(body).toMatchObject({ complete: true, restartRequired: false, repository: { mode: 'managed', chosen: 'managed' } });
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
