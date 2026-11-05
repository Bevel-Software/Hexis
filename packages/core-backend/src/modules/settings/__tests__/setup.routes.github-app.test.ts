import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { KbContext } from '../../../shared/kb-context.js';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import { ManagedRepository } from '../managed-repository.js';
import { RepositorySource, type GitHubAppRepository } from '../repository-source.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ConnectionCheck, RepositoryConnection } from '../connection-check.js';

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const KB_ENV = ['KB_REPO_URL', 'GIT_TOKEN', 'GIT_USERNAME', 'GIT_MODE', 'GITHUB_TOKEN', 'DEFAULT_BRANCH', 'PROTECTED_BRANCHES', 'GITHUB_APP_REPOSITORY'] as const;

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

type Answer = ConnectionCheck | ((connection: RepositoryConnection) => ConnectionCheck);
const CONNECTED: ConnectionCheck = { outcome: 'connected', branches: ['trunk', 'draft'], defaultBranch: 'trunk', empty: false };

/**
 * The setup router over a deployment that has a GitHub App installed (or
 * not), with GitHub's answer to the connection check given by the suite.
 */
function listen(
  opts: {
    kb?: KbContext;
    installed?: boolean;
    tokenGiven?: boolean;
    offered?: boolean;
    github?: Answer;
    /** What the person who connected GitHub could push to. */
    permitted?: string[];
  } = {},
) {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  const kb = opts.kb ?? testKbContext({ branchModel: null });
  let prepared = 0;
  const githubApp: GitHubAppRepository = {
    url: (read) => (read('githubRepository') ? `https://github.com/${read('githubRepository')}.git` : ''),
    answered: (read) => (opts.installed ?? true) && Boolean(read('githubRepository')),
    prepare: async () => {
      prepared += 1;
      if (opts.tokenGiven === false) throw new Error('GitHub answered 404');
    },
    token: () => (opts.tokenGiven === false || prepared === 0 ? null : 'an-installation-token'),
    permits: (repository) => (opts.permitted ?? ['acme/kb', 'acme/another']).includes(repository),
  };
  const source = new RepositorySource({
    read: (key) => settings.resolve(key),
    managed: new ManagedRepository('/data/backups/managed-repository'),
    githubApp,
  });
  const probed: RepositoryConnection[] = [];
  let phaseRuns = 0;
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
      { runAll: async () => void (phaseRuns += 1) },
      kb,
      undefined,
      async (connection) => {
        probed.push(connection);
        const answer = opts.github ?? CONNECTED;
        return typeof answer === 'function' ? answer(connection) : answer;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      { source, ensureManaged: async () => undefined, ...(opts.offered === false ? {} : { githubApp }) },
    ),
  );
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** `confirm` is the admin's answer to the question a move is asked. */
  const save = async (entries: Record<string, string>, confirm?: 'keep' | 'close') => {
    const res = await fetch(`${base}/api/setup/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: entries, ...(confirm ? { confirmRepositoryChange: confirm } : {}) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { problems?: Record<string, string> } };
  };
  const status = async () => (await fetch(`${base}/api/setup/status`)).json() as Promise<Record<string, unknown>>;
  return { save, status, settings, source, probed, kb, phaseRuns: () => phaseRuns };
}

const CHOICE = { gitMode: 'github-app', githubRepository: 'acme/kb' };

describe('setup status: GitHub as a way of having a repository', () => {
  it('is offered second, by a deployment that can connect to it', async () => {
    expect(await listen().status()).toMatchObject({ repository: { mode: null, modes: ['managed', 'github-app', 'token'] } });
  });

  it('is not offered by one that cannot', async () => {
    expect(await listen({ offered: false }).status()).toMatchObject({ repository: { modes: ['managed', 'token'] } });
  });
});

describe('choosing a repository on GitHub', () => {
  it('finishes setup once GitHub accepts the installation for reading and writing', async () => {
    const { save, probed, settings, kb, phaseRuns, source } = listen();
    const { status, body } = await save(CHOICE);
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, complete: true, restartRequired: false, repository: { mode: 'github-app' } });
    // Asked with what git will present: the installation's token, never a stored one.
    expect(probed).toEqual([{ url: 'https://github.com/acme/kb.git', token: 'an-installation-token', username: 'x-access-token' }]);
    expect(source.url()).toBe('https://github.com/acme/kb.git');
    expect(settings.resolve('githubRepository')).toBe('acme/kb');
    expect(phaseRuns()).toBe(1);
    // The repository said what it calls its trunk.
    expect(kb.defaultBranch).toBe('trunk');
    expect([...kb.protectedBranches]).toEqual(['trunk']);
  });

  it('names the usual branch for a repository that is empty', async () => {
    const { save, kb } = listen({ github: { outcome: 'connected', branches: [], defaultBranch: null, empty: true } });
    expect((await save(CHOICE)).status).toBe(200);
    expect(kb.defaultBranch).toBe('main');
  });

  it('keeps the branches an admin named over the repository trunk', async () => {
    const { save, settings } = listen();
    await save({ ...CHOICE, defaultBranch: 'live', protectedBranches: 'live, draft' });
    expect(settings.resolve('defaultBranch')).toBe('live');
    expect(settings.resolve('protectedBranches')).toBe('live, draft');
  });

  /**
   * The name is the one part of this connection an admin types, and the
   * installation's token would answer for any repository the installation
   * covers. So the name is held to what the person who connected GitHub
   * could push to with their own account, BEFORE that token is used for
   * anything: GitHub is not asked, so nothing about the repository, not
   * even that it exists, comes back.
   */
  it('refuses a repository the person who connected GitHub could not push to, without asking GitHub', async () => {
    const { save, settings, probed, phaseRuns } = listen({ permitted: ['x/docs'] });
    for (const name of ['x/payroll', 'x/handbook', 'someone-else/secrets']) {
      const { status, body } = await save({ gitMode: 'github-app', githubRepository: name });
      expect(status, name).toBe(400);
      expect(body.problems?.githubRepository, name).toMatch(/your own GitHub account can write to/);
    }
    expect(probed).toEqual([]);
    expect(settings.resolve('githubRepository')).toBe('');
    expect(settings.resolve('gitMode')).toBe('');
    expect(phaseRuns()).toBe(0);
    // The one they can push to is theirs to connect.
    expect((await save({ gitMode: 'github-app', githubRepository: 'x/docs' })).status).toBe(200);
  });

  it('refuses a repository the installation no longer reaches, and stores nothing', async () => {
    const { save, settings, phaseRuns } = listen({
      github: { outcome: 'rejected', reason: 'not-found', field: 'kbRepoUrl', error: 'repository not found' },
    });
    const { status, body } = await save({ gitMode: 'github-app', githubRepository: 'acme/kb' });
    expect(status).toBe(400);
    expect(body.problems).toEqual({
      githubRepository: 'The GitHub App cannot reach that repository. Add the repository to the app’s installation on GitHub.',
    });
    expect(settings.resolve('githubRepository')).toBe('');
    expect(settings.resolve('gitMode')).toBe('');
    expect(phaseRuns()).toBe(0);
  });

  it.each([
    [
      'it may read and not write',
      { outcome: 'read-only', field: 'gitToken', error: 'x', branches: ['main'], defaultBranch: 'main', empty: false } as ConnectionCheck,
      /can read that repository but not write/,
    ],
    [
      'GitHub cannot be reached',
      { outcome: 'rejected', reason: 'unreachable', field: 'kbRepoUrl', error: 'x' } as ConnectionCheck,
      /could not be reached/,
    ],
  ])('says so when %s', async (_why, github, said) => {
    const { save } = listen({ github });
    const { status, body } = await save(CHOICE);
    expect(status).toBe(400);
    expect(body.problems?.githubRepository).toMatch(said);
  });

  it('asks for the connection before a repository can be chosen', async () => {
    const { save, probed } = listen({ installed: false });
    const { status, body } = await save(CHOICE);
    expect(status).toBe(400);
    expect(body.problems).toEqual({ githubRepository: 'Connect GitHub before choosing a repository.' });
    expect(probed).toEqual([]);
  });

  it('asks for the repository when only the way was chosen', async () => {
    const { save } = listen();
    const { status, body } = await save({ gitMode: 'github-app' });
    expect(status).toBe(400);
    expect(body.problems).toEqual({ githubRepository: 'Choose the repository the knowledge base lives in.' });
  });

  it('says the app may have been uninstalled when GitHub gives no token', async () => {
    const { save, probed } = listen({ tokenGiven: false });
    const { status, body } = await save(CHOICE);
    expect(status).toBe(400);
    expect(body.problems?.gitMode).toMatch(/may have been uninstalled/);
    expect(probed).toEqual([]);
  });

  it('refuses the way on a deployment that does not offer it', async () => {
    const { save } = listen({ offered: false });
    const { status, body } = await save(CHOICE);
    expect(status).toBe(400);
    expect(body.problems?.gitMode).toMatch(/cannot connect to GitHub/);
  });

  it('refuses a name that is not a repository', async () => {
    const { save, probed } = listen();
    for (const name of ['acme', 'acme/kb.git', '../acme/kb', 'https://github.com/acme/kb', 'acme/kb/extra']) {
      const { status, body } = await save({ gitMode: 'github-app', githubRepository: name });
      expect(status, name).toBe(400);
      expect(body.problems?.githubRepository, name).toBe('Name the repository as owner/name.');
    }
    expect(probed).toEqual([]);
  });
});

describe('a deployment on GitHub that is serving', () => {
  async function serving() {
    const mounted = listen({ kb: testKbContext() });
    await mounted.save({ ...CHOICE, defaultBranch: 'main', protectedBranches: 'main' });
    return mounted;
  }

  it('is not asked about its repository by a save that changes something else', async () => {
    const { save, probed } = await serving();
    const asked = probed.length;
    expect((await save({ kbSyncSecret: 'a-secret-of-sixteen-or-more' })).status).toBe(200);
    expect(probed).toHaveLength(asked);
  });

  /**
   * Another repository on GitHub is a move like any other: GitHub is asked
   * about the new one, the admin is asked about the move, and confirmed it
   * happens on the save.
   */
  it('proves the new repository, asks about the move, and moves on the save once confirmed', async () => {
    const { save, probed, source, phaseRuns } = await serving();
    const before = probed.length;
    const asked = await save({ githubRepository: 'acme/another' });
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ repositoryChange: { from: 'github-app', to: 'github-app' } });
    // The connection is proven before the question is put: nobody agrees to
    // a move only to be told the repository cannot be reached.
    expect(probed).toHaveLength(before + 1);
    expect(probed.at(-1)!.url).toBe('https://github.com/acme/another.git');
    expect(source.url()).toBe('https://github.com/acme/kb.git');

    const runs = phaseRuns();
    const moved = await save({ githubRepository: 'acme/another' }, 'keep');
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ ok: true, restartRequired: false, repositoryChange: { choice: 'keep' } });
    expect(source.url()).toBe('https://github.com/acme/another.git');
    expect(phaseRuns()).toBe(runs + 1);
  });
});
