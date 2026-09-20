import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * `GitService.revertPathsAndPush` — the git half of "Delete folder and its
 * proposed changes", against a real git: two proposal branches cloned into
 * their own workspaces, pushing to one bare origin.
 *
 * Each branch changes `Data/Reports/<name>.md` on top of a shared base commit
 * that has the original version; reverting it to that base takes the file out
 * of the proposal.
 */

const USER = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };
const KB = 'knowledge-base';
const BASE_TEXT = 'base\n';

interface Fixture {
  upstream: string;
  base: string;
  repos: Record<string, string>;
  svc: GitService;
}

async function seed(root: string, branches: string[]): Promise<Fixture> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'main', upstream]);

  const seedDir = path.join(root, '.seed');
  await fs.mkdir(path.join(seedDir, 'Data/Reports'), { recursive: true });
  await runGit(seedDir, ['init', '-b', 'main']);
  await runGit(seedDir, ['remote', 'add', 'origin', upstream]);
  for (const b of branches) await fs.writeFile(path.join(seedDir, `Data/Reports/${b}.md`), BASE_TEXT);
  await runGit(seedDir, ['add', '.']);
  await runGit(seedDir, ['commit', '-m', 'base']);
  await runGit(seedDir, ['push', 'origin', 'main']);
  const base = await gitOut(seedDir, ['rev-parse', 'HEAD']);
  for (const b of branches) {
    await runGit(seedDir, ['checkout', '-b', b, base]);
    await fs.writeFile(path.join(seedDir, `Data/Reports/${b}.md`), `proposed in ${b}\n`);
    await runGit(seedDir, ['commit', '-am', `propose ${b}`]);
    await runGit(seedDir, ['push', 'origin', b]);
  }

  const repos: Record<string, string> = {};
  const dirs: Record<string, string> = {};
  for (const b of branches) {
    dirs[b] = path.join(root, 'ws', b);
    const repo = path.join(dirs[b], KB);
    await fs.mkdir(dirs[b], { recursive: true });
    await runGit(root, ['clone', '-b', b, upstream, repo]);
    await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
    await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
    await runGit(repo, ['config', 'core.autocrlf', 'false']);
    repos[b] = repo;
  }
  const svc = new GitService(stubWorkspaceService(dirs), stubWorkflowHooks(), KB);
  return { upstream, base, repos, svc };
}

const planFor = (branch: string, ref: string, over: { subject?: string } = {}) => ({
  workspaceId: branch,
  paths: [
    {
      path: `Data/Reports/${branch}.md`,
      ref,
      subject: over.subject ?? `Revert Data/Reports/${branch}.md`,
      undoSubject: `Undo revert of Data/Reports/${branch}.md`,
    },
  ],
});

const read = (repo: string, file: string) => fs.readFile(path.join(repo, file), 'utf8');
const originFile = (repo: string, branch: string, file: string) =>
  gitOut(repo, ['show', `origin/${branch}:${file}`]).then((t) => `${t}\n`);

describe('GitService.revertPathsAndPush', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-revert-push-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reverts every path to its ref, commits and publishes each branch', async () => {
    const { base, repos, svc } = await seed(root, ['feature-a', 'feature-b']);
    const outcome = await svc.revertPathsAndPush(USER, [planFor('feature-a', base), planFor('feature-b', base)]);

    expect(outcome).toEqual({ pushed: ['feature-a', 'feature-b'], failed: null });
    for (const b of ['feature-a', 'feature-b']) {
      await runGit(repos[b], ['fetch', 'origin']);
      expect(await originFile(repos[b], b, `Data/Reports/${b}.md`)).toBe(BASE_TEXT);
      expect(await gitOut(repos[b], ['log', '-1', '--pretty=%s'])).toBe(`Revert Data/Reports/${b}.md`);
    }
  });

  it('holds its reservation for the whole sequence: a git call made meanwhile runs after it', async () => {
    const { base, svc } = await seed(root, ['feature-a', 'feature-b']);
    const order: string[] = [];
    const revert = svc
      .revertPathsAndPush(USER, [planFor('feature-a', base), planFor('feature-b', base)])
      .then(() => order.push('revert'));
    const statusA = svc.status('feature-a').then(() => order.push('status feature-a'));
    const statusB = svc.status('feature-b').then(() => order.push('status feature-b'));
    await Promise.all([revert, statusA, statusB]);
    expect(order[0]).toBe('revert');
  });

  it('pushes nothing when a later commit fails, puts every file back, and keeps unpushed work', async () => {
    const { base, repos, svc } = await seed(root, ['feature-a', 'feature-b']);
    // Unpushed local work in feature-a that a reset would have destroyed.
    await fs.writeFile(path.join(repos['feature-a'], 'Data/Reports/notes.md'), 'local\n');
    await runGit(repos['feature-a'], ['add', '.']);
    await runGit(repos['feature-a'], ['commit', '-m', 'unpushed local work']);

    await expect(
      svc.revertPathsAndPush(USER, [
        planFor('feature-a', base),
        // commitFile refuses a subject over 200 characters.
        planFor('feature-b', base, { subject: 'x'.repeat(201) }),
      ]),
    ).rejects.toThrow(/200 characters/);

    expect(await read(repos['feature-a'], 'Data/Reports/feature-a.md')).toBe('proposed in feature-a\n');
    expect(await read(repos['feature-b'], 'Data/Reports/feature-b.md')).toBe('proposed in feature-b\n');
    expect(await gitOut(repos['feature-a'], ['log', '--pretty=%s'])).toContain('unpushed local work');
    expect(await read(repos['feature-a'], 'Data/Reports/notes.md')).toBe('local\n');
    // Nothing reached origin.
    await runGit(repos['feature-a'], ['fetch', 'origin']);
    expect(await originFile(repos['feature-a'], 'feature-a', 'Data/Reports/feature-a.md')).toBe(
      'proposed in feature-a\n',
    );
    expect(await gitOut(repos['feature-a'], ['status', '--porcelain'])).toBe('');
    expect(await gitOut(repos['feature-b'], ['status', '--porcelain'])).toBe('');
  });

  it('reports a failed push, keeps the earlier push, and puts the failed branch’s file back', async () => {
    const { upstream, base, repos, svc } = await seed(root, ['feature-a', 'feature-b']);
    // Someone else advances feature-b on origin, so this checkout's push is rejected.
    const other = path.join(root, '.other');
    await runGit(root, ['clone', '-b', 'feature-b', upstream, other]);
    await fs.writeFile(path.join(other, 'elsewhere.md'), 'x\n');
    await runGit(other, ['add', '.']);
    await runGit(other, ['commit', '-m', 'elsewhere']);
    await runGit(other, ['push', 'origin', 'feature-b']);

    const outcome = await svc.revertPathsAndPush(USER, [planFor('feature-a', base), planFor('feature-b', base)]);

    expect(outcome.pushed).toEqual(['feature-a']);
    expect(outcome.failed?.workspaceId).toBe('feature-b');
    await runGit(repos['feature-a'], ['fetch', 'origin']);
    expect(await originFile(repos['feature-a'], 'feature-a', 'Data/Reports/feature-a.md')).toBe(BASE_TEXT);
    expect(await read(repos['feature-b'], 'Data/Reports/feature-b.md')).toBe('proposed in feature-b\n');
    expect(await gitOut(repos['feature-b'], ['log', '-1', '--pretty=%s'])).toBe(
      'Undo revert of Data/Reports/feature-b.md',
    );
  });

  it('changes nothing when a checkout’s HEAD cannot be read', async () => {
    const { base, repos, svc } = await seed(root, ['feature-a', 'feature-b']);
    // An unborn branch: HEAD names no commit.
    await runGit(repos['feature-b'], ['checkout', '--orphan', 'unborn']);

    await expect(
      svc.revertPathsAndPush(USER, [planFor('feature-a', base), planFor('feature-b', base)]),
    ).rejects.toThrow();
    expect(await read(repos['feature-a'], 'Data/Reports/feature-a.md')).toBe('proposed in feature-a\n');
    expect(await gitOut(repos['feature-a'], ['log', '-1', '--pretty=%s'])).toBe('propose feature-a');
  });
});
