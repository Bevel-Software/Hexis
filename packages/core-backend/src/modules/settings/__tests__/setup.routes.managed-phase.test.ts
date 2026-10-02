import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import { ManagedRepository } from '../managed-repository.js';
import { RepositorySource } from '../repository-source.js';
import { KbStartupRunner } from '../../workspace/startup/kb-startup-runner.js';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';
import { TemplateFilesStep } from '../../workspace/startup/steps/template-files.step.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { defaultKbTemplateDir } from '../../../assets.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { KbContext } from '../../../shared/kb-context.js';

/**
 * A repository the deployment keeps, and the REAL startup phase, wired the
 * way the composition root wires them: the phase asks the repository source
 * where the repository is, and git runs with what the source presents.
 *
 * A fake phase proves the routes chose the right address. It cannot see
 * whether a bare repository on a disk is something the phase can seed,
 * clone and push to, or what happens to the working copies of a repository
 * the deployment has moved away from. This looks at the disk afterwards.
 */

const execFileAsync = promisify(execFile);
const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const KB_ENV = ['KB_REPO_URL', 'GIT_TOKEN', 'GIT_USERNAME', 'GIT_MODE', 'GITHUB_TOKEN', 'DEFAULT_BRANCH', 'PROTECTED_BRANCHES'] as const;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 't@x.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 't@x.com',
};
const git = async (cwd: string, args: string[]) =>
  (await execFileAsync('git', args, { cwd, env: gitEnv })).stdout.toString().trim();

let root: string;
let server: HttpServer | null = null;
let savedEnv: Partial<Record<(typeof KB_ENV)[number], string | undefined>> = {};

beforeEach(async () => {
  savedEnv = {};
  for (const k of KB_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-managed-phase-'));
});

afterEach(async () => {
  server?.close();
  server = null;
  for (const k of KB_ENV) {
    const original = savedEnv[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
  await fs.rm(root, { recursive: true, force: true });
});

/** A deployment: its settings, its repository source, the real phase, and the setup routes over them. */
function boot(kb: KbContext) {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  const managed = new ManagedRepository(path.join(root, 'backups', 'managed-repository'));
  // A deployment reaching a repository by its address has one on a host; here
  // it is a folder, which the source hands over as it would hand a URL.
  const hosted = path.join(root, 'hosted.git');
  const source = new RepositorySource({
    read: (key) => (key === 'kbRepoUrl' && settings.resolve('kbRepoUrl') ? hosted : settings.resolve(key)),
    managed,
  });
  const gitRunner = new NodeGitRunner(60_000, source.credentials);
  const workspacesRoot = path.join(root, 'workspaces');
  const setAsideRoot = path.join(root, 'backups', 'replaced-working-copies');
  const runner = new KbStartupRunner({
    gitRunner,
    kbRepoUrl: () => source.url(),
    workspacesRoot,
    setAsideRoot,
    kbDirName: 'knowledge-base',
    templateDir: defaultKbTemplateDir(),
    defaultBranch: () => kb.defaultBranch,
    protectedBranches: () => [...kb.protectedBranches],
    seedAdminEmails: ['admin@example.com'],
    // A step that works on every branch, so the phase makes each its working copy.
    steps: [new TemplateFilesStep(new NodeFs(), kb)],
    buildSeedTree: async (dir) => {
      await fs.writeFile(path.join(dir, 'WELCOME.md'), 'seeded\n', 'utf8');
      return ['WELCOME.md'];
    },
  });
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
      runner,
      kb,
      undefined,
      async () => ({ outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      { source, ensureManaged: (branch) => managed.ensure(gitRunner, branch) },
    ),
  );
  server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** `confirm` is the admin's answer to the question a move is asked. */
  const save = async (entries: Record<string, string>, confirm?: 'keep' | 'close') => {
    const res = await fetch(`${base}/api/setup/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: entries, ...(confirm ? { confirmRepositoryChange: confirm } : {}) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const workingCopy = (branch: string) => path.join(workspacesRoot, encodeURIComponent(branch), 'knowledge-base');
  return { save, managed, hosted, runner, source, workingCopy, setAsideRoot };
}

describe('the save that chooses a repository the deployment keeps', () => {
  it('creates it, seeds it and clones from it, asking for nothing else', async () => {
    const { save, managed, workingCopy } = boot(testKbContext({ branchModel: null }));
    const { status, body } = await save({ gitMode: 'managed' });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ complete: true, restartRequired: false });

    // The repository is where the source says, bare, and holds the seed on the branch named for it.
    expect(await git(managed.path, ['rev-parse', '--is-bare-repository'])).toBe('true');
    expect(await git(managed.path, ['for-each-ref', '--format=%(refname)'])).toBe('refs/heads/main');
    expect(await git(managed.path, ['ls-tree', '-r', '--name-only', 'main'])).toContain('WELCOME.md');

    // The working copy is a clone of it, and carries no credential helper: there is no credential.
    const copy = workingCopy('main');
    expect(await git(copy, ['config', '--get', 'remote.origin.url'])).toBe(managed.path);
    expect((await fs.readFile(path.join(copy, 'WELCOME.md'), 'utf8')).replace(/\r\n/g, '\n')).toBe('seeded\n');
  });

  it('takes a push from a working copy, like any remote', async () => {
    const { save, managed, workingCopy } = boot(testKbContext({ branchModel: null }));
    await save({ gitMode: 'managed' });
    const copy = workingCopy('main');
    await fs.writeFile(path.join(copy, 'note.md'), 'a change\n', 'utf8');
    await git(copy, ['add', '-A']);
    await git(copy, ['commit', '-m', 'a change']);
    await git(copy, ['push', 'origin', 'main']);
    expect(await git(managed.path, ['ls-tree', '-r', '--name-only', 'main'])).toContain('note.md');
  });
});

describe('a deployment that moves to a repository it keeps', () => {
  it('leaves the repository it had untouched and sets its working copies aside, unpushed work included', async () => {
    const { save, managed, hosted, source, workingCopy, setAsideRoot } = boot(
      testKbContext({ branchModel: { defaultBranch: 'main', protectedBranches: ['main'] } }),
    );
    // A deployment on a repository of its own, set up and serving. The
    // repository has a history of ITS OWN, written here and not by the
    // startup phase: two empty repositories the phase seeds within the
    // same second get the same first commit (same tree, same author, same
    // time), and the phase would then read them, rightly, as one repository
    // at two addresses, and keep the working copy instead of setting it
    // aside. A fast machine did exactly that.
    await git(root, ['init', '--bare', '-b', 'main', hosted]);
    const theirs = path.join(root, 'theirs');
    await fs.mkdir(theirs);
    await git(theirs, ['init', '-b', 'main']);
    await fs.writeFile(path.join(theirs, 'HANDBOOK.md'), 'what this organisation had before\n', 'utf8');
    await git(theirs, ['add', '-A']);
    await git(theirs, ['commit', '-m', 'the handbook']);
    await git(theirs, ['push', hosted, 'main']);
    const first = await save({ kbRepoUrl: 'https://git.example.com/acme/kb.git', gitToken: 'a-token', defaultBranch: 'main', protectedBranches: 'main' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const copy = workingCopy('main');
    expect(await git(copy, ['config', '--get', 'remote.origin.url'])).toBe(hosted);
    // Work that was committed and never pushed.
    await fs.writeFile(path.join(copy, 'unpushed.md'), 'only here\n', 'utf8');
    await git(copy, ['add', '-A']);
    await git(copy, ['commit', '-m', 'never pushed']);
    const hostedBefore = await git(hosted, ['for-each-ref']);

    // Asked first: until the admin answers, the working copy is where it
    // was and so is the deployment.
    const asked = await save({ gitMode: 'managed' });
    expect(asked.status).toBe(409);
    expect(await git(copy, ['config', '--get', 'remote.origin.url'])).toBe(hosted);
    expect(source.url()).toBe(hosted);

    // Confirmed, the move happens on the save, with no restart: the way
    // chosen takes effect and the phase brings the working copies into line.
    const moved = await save({ gitMode: 'managed' }, 'keep');
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ ok: true, complete: true, restartRequired: false });
    expect(source.url()).toBe(managed.path);

    expect(await git(hosted, ['for-each-ref'])).toBe(hostedBefore);
    expect(await git(copy, ['config', '--get', 'remote.origin.url'])).toBe(managed.path);
    expect(await fs.access(path.join(copy, 'unpushed.md')).then(() => true, () => false)).toBe(false);
    const managedHolds = await git(managed.path, ['ls-tree', '-r', '--name-only', 'main']);
    expect(managedHolds).toContain('WELCOME.md');
    // Nothing of one repository was pushed into the other.
    expect(managedHolds).not.toContain('HANDBOOK.md');
    expect(managedHolds).not.toContain('unpushed.md');

    // What was set aside is whole: the commit nobody pushed is in it.
    const [stamp] = await fs.readdir(setAsideRoot);
    const kept = path.join(setAsideRoot, stamp!, encodeURIComponent('main'));
    expect(await git(kept, ['log', '-1', '--format=%s'])).toBe('never pushed');
    expect((await fs.readFile(path.join(kept, 'unpushed.md'), 'utf8')).replace(/\r\n/g, '\n')).toBe('only here\n');
  });
});
