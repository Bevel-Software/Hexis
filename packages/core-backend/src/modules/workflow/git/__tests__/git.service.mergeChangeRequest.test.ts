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
});
