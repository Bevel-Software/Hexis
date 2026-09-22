import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';

const execFileAsync = promisify(execFile);
const BASE = 'current-company-state';
const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 's@x.com',
      GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 's@x.com',
    },
  });
}
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.toString();
}

function stubWorkspaceService(baseWsId: string, baseRepo: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== baseWsId) throw new Error(`unexpected workspace ${id}`);
      return path.dirname(baseRepo);
    },
  } as unknown as WorkspaceService;
}

/**
 * Bare upstream seeded on BASE with `files`, plus a base-branch workspace clone
 * laid out like prod (`<root>/<wsId>/knowledge-base`). Returns handles for
 * building feature branches and inspecting the merged remote.
 */
async function seed(root: string, baseFiles: Record<string, string>) {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', BASE, upstream]);
  const seedDir = path.join(root, '.seed');
  await fs.mkdir(seedDir);
  await runGit(seedDir, ['init', '-b', BASE]);
  await runGit(seedDir, ['remote', 'add', 'origin', upstream]);
  for (const [name, content] of Object.entries(baseFiles)) {
    await fs.writeFile(path.join(seedDir, name), content);
  }
  await runGit(seedDir, ['add', '-A']);
  await runGit(seedDir, ['commit', '-m', 'base']);
  await runGit(seedDir, ['push', 'origin', BASE]);

  const baseWsId = BASE;
  const baseRepo = path.join(root, baseWsId, 'knowledge-base');
  await fs.mkdir(path.join(root, baseWsId), { recursive: true });
  await runGit(root, ['clone', '-b', BASE, upstream, baseRepo]);
  return { upstream, seedDir, baseWsId, baseRepo };
}

/** Branch `name` off origin/BASE in a throwaway clone, apply `mutate`, push. */
async function pushFeatureBranch(
  root: string,
  upstream: string,
  name: string,
  mutate: (dir: string) => Promise<void>,
) {
  const dir = path.join(root, `feat-${name.replace(/\W/g, '_')}`);
  await runGit(root, ['clone', '-b', BASE, upstream, dir]);
  await runGit(dir, ['checkout', '-b', name]);
  await mutate(dir);
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-m', `work on ${name}`]);
  await runGit(dir, ['push', '-u', 'origin', name]);
}

describe('GitService.mergeChangeRequest', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-merge-cr-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('merges a feature branch into base and pushes the merge commit', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/add', BASE, { subject: 'Add feature (#1)', body: 'Merged via Bevel' }, USER,
    );

    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') return;
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    // The merge landed on origin/BASE: a fresh clone sees the feature file and a
    // merge commit authored by the human triggerer.
    const verify = path.join(root, 'verify');
    await runGit(root, ['clone', '-b', BASE, upstream, verify]);
    const merged = await fs.readFile(path.join(verify, 'feature.md'), 'utf8');
    expect(merged.replace(/\r\n/g, '\n')).toBe('new content\n');
    const log = await gitOut(verify, ['log', '-1', '--format=%an <%ae>%n%s']);
    expect(log).toContain('Alice <alice@example.com>');
    expect(log).toContain('Add feature (#1)');
  });

  it('returns the conflicting paths when base and source both changed a file', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'shared.md': 'original\n' });
    // Source edits shared.md one way…
    await pushFeatureBranch(root, upstream, 'alice/edit', async (dir) => {
      await fs.writeFile(path.join(dir, 'shared.md'), 'source version\n');
    });
    // …and BASE advances with a conflicting edit to the same file.
    await pushFeatureBranch(root, upstream, 'tmp-base-advance', async (dir) => {
      await fs.writeFile(path.join(dir, 'shared.md'), 'base advanced\n');
    });
    // Fast-forward BASE to that commit so origin/BASE conflicts with the source.
    const advancer = path.join(root, 'advancer');
    await runGit(root, ['clone', '-b', 'tmp-base-advance', upstream, advancer]);
    await runGit(advancer, ['push', 'origin', 'tmp-base-advance:' + BASE]);

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/edit', BASE, { subject: 'Edit (#2)', body: 'x' }, USER,
    );

    expect(result.kind).toBe('conflicts');
    if (result.kind !== 'conflicts') return;
    expect(result.paths).toContain('shared.md');

    // The base workspace must be left clean (merge aborted) — not stuck mid-merge.
    const status = await gitOut(baseRepo, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('');
  });

  /**
   * `merge_branch` runs this in the TARGET BRANCH'S OWN workspace — the clone
   * the file tools read and write — where the `reset --hard` discards
   * anything unpublished. A change request's merge never had that problem: it
   * runs in a repo-global clone where only a previous attempt can be dirty.
   *
   * The guard has to live inside this method's workspace reservation. Asked by
   * the caller instead, a save landing in the gap between the question and the
   * reset is destroyed silently, and the gap is the whole git round-trip.
   */
  describe('requireCleanTarget', () => {
    it('refuses, touching nothing, when the target workspace holds an unsaved edit', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      const before = (await gitOut(baseRepo, ['rev-parse', 'HEAD'])).trim();
      // A save that has not been shared yet, exactly as a file tool leaves it.
      await fs.writeFile(path.join(baseRepo, 'base.md'), 'edited but not shared\n');

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
      await expect(
        git.mergeChangeRequest(
          baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
          { requireCleanTarget: true },
        ),
      ).rejects.toMatchObject({ status: 409, payload: { kind: 'merge-target-busy' } });

      // The edit survives and nothing was merged or pushed.
      expect(await fs.readFile(path.join(baseRepo, 'base.md'), 'utf8')).toBe('edited but not shared\n');
      expect((await gitOut(baseRepo, ['rev-parse', 'HEAD'])).trim()).toBe(before);
      const verify = path.join(root, 'verify-dirty');
      await runGit(root, ['clone', '-b', BASE, upstream, verify]);
      await expect(fs.readFile(path.join(verify, 'feature.md'), 'utf8')).rejects.toThrow();
    });

    it('refuses on a commit that was never pushed', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      await fs.writeFile(path.join(baseRepo, 'local.md'), 'committed, never pushed\n');
      await runGit(baseRepo, ['add', '-A']);
      await runGit(baseRepo, ['commit', '-m', 'local only']);

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
      await expect(
        git.mergeChangeRequest(
          baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
          { requireCleanTarget: true },
        ),
      ).rejects.toMatchObject({ status: 409, payload: { kind: 'merge-target-busy' } });
      expect(await fs.readFile(path.join(baseRepo, 'local.md'), 'utf8')).toBe('committed, never pushed\n');
    });

    it('merges a clean target as usual', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
      const result = await git.mergeChangeRequest(
        baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
        { requireCleanTarget: true },
      );
      expect(result.kind).toBe('merged');
    });
  });

  /**
   * The authorization hook. It decides on the tip this merge is BUILT on,
   * inside the same reservation as the fetch — not on a workspace `HEAD` that
   * a failed best-effort pull can have left behind origin, where the roles
   * read are the ones this very merge is about to change.
   */
  describe('authorize', () => {
    it('decides on the freshly fetched target tip, not the clone\'s stale HEAD', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      // BASE moves on origin while this clone stays where it was — the shape a
      // failed post-merge pull leaves behind.
      await pushFeatureBranch(root, upstream, 'tmp-advance', async (dir) => {
        await fs.writeFile(path.join(dir, 'base.md'), 'advanced\n');
      });
      const advancer = path.join(root, 'advancer');
      await runGit(root, ['clone', '-b', 'tmp-advance', upstream, advancer]);
      await runGit(advancer, ['push', 'origin', 'tmp-advance:' + BASE]);
      const staleHead = (await gitOut(baseRepo, ['rev-parse', 'HEAD'])).trim();
      const publishedTip = (await gitOut(advancer, ['rev-parse', 'HEAD'])).trim();
      expect(staleHead).not.toBe(publishedTip);

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
      const seen: { sha: string; changedPaths: string[] }[] = [];
      const result = await git.mergeChangeRequest(
        baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
        { authorize: async (t) => { seen.push(t); } },
      );

      expect(result.kind).toBe('merged');
      expect(seen).toHaveLength(1);
      expect(seen[0].sha).toBe(publishedTip);
      expect(seen[0].changedPaths).toEqual(['feature.md']);
    });

    it('refuses before anything is committed or pushed when the hook throws', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
      await expect(
        git.mergeChangeRequest(
          baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
          { authorize: async () => { throw new Error('denied'); } },
        ),
      ).rejects.toThrow('denied');

      const verify = path.join(root, 'verify-denied');
      await runGit(root, ['clone', '-b', BASE, upstream, verify]);
      await expect(fs.readFile(path.join(verify, 'feature.md'), 'utf8')).rejects.toThrow();
    });

    it('reports BOTH sides of a rename, so a deleted roles.yaml is in the decision', async () => {
      // Renaming roles.yaml DELETES roles.yaml. `--name-only` would report only
      // the new name, and the caller would authorize a merge that removes a
      // file it never asked about.
      const { upstream, baseWsId, baseRepo } = await seed(root, {
        'base.md': 'base\n',
        'roles.yaml': 'roles:\n  admin: []\n',
      });
      await pushFeatureBranch(root, upstream, 'alice/rename', async (dir) => {
        await runGit(dir, ['mv', 'roles.yaml', 'people.yaml']);
      });

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), 'knowledge-base');
      const seen: string[][] = [];
      const result = await git.mergeChangeRequest(
        baseWsId, 'alice/rename', BASE, { subject: 'Rename (#1)', body: 'x' }, USER,
        { authorize: async (t) => { seen.push(t.changedPaths); } },
      );

      expect(result.kind).toBe('merged');
      expect(seen[0]).toContain('roles.yaml');
      expect(seen[0]).toContain('people.yaml');
    });
  });
});
