import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService, parseNameStatusZ, parseNumstatZ } from '../git.service.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}


/** Bare upstream + one clone on `current-company-state`, mirroring prod layout. */
async function seedWorkspace(root: string, workspaceId: string) {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', 'current-company-state', upstream]);
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', 'current-company-state']);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seed, 'base.md'), 'base\n');
  await runGit(seed, ['add', '-A']);
  await runGit(seed, ['commit', '-m', 'init']);
  await runGit(seed, ['push', 'origin', 'current-company-state']);
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
  return { upstream, repo };
}

function stubWorkspaceService(workspaceId: string, repo: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return path.dirname(repo);
    },
  } as unknown as WorkspaceService;
}

describe('parseNameStatusZ', () => {
  it('parses adds/mods/deletes and rename pairs', () => {
    const out = ['A', 'a.md', 'M', 'b.md', 'D', 'c.md', 'R100', 'old.md', 'new.md', ''].join('\0');
    expect(parseNameStatusZ(out)).toEqual([
      { status: 'added', path: 'a.md' },
      { status: 'modified', path: 'b.md' },
      { status: 'removed', path: 'c.md' },
      { status: 'renamed', path: 'new.md', previousPath: 'old.md' },
    ]);
  });
});

describe('parseNumstatZ', () => {
  it('parses counts, binary markers, and rename entries in order', () => {
    // normal, binary, rename (empty path segment then two names)
    const out = ['3\t1\ta.md', '-\t-\tlogo.png', '5\t2\t', 'old.md', 'new.md', ''].join('\0');
    expect(parseNumstatZ(out)).toEqual([
      { additions: 3, deletions: 1, isBinary: false },
      { additions: 0, deletions: 0, isBinary: true },
      { additions: 5, deletions: 2, isBinary: false },
    ]);
  });
});

describe('GitService.changedFilesForPr / resolvePrShas', () => {
  let root: string;
  const workspaceId = 'current-company-state';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-pr-files-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('computes the changed-file list + patches for a feature branch vs base', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    // Build a feature branch with an add, a modify, and a delete.
    await runGit(repo, ['checkout', '-b', 'alice/feature']);
    await fs.writeFile(path.join(repo, 'added.md'), 'hello\nworld\n');
    await fs.writeFile(path.join(repo, 'base.md'), 'base changed\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'feature work']);
    await runGit(repo, ['push', '-u', 'origin', 'alice/feature']);

    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const files = await git.changedFilesForPr(
      workspaceId,
      'current-company-state',
      'alice/feature',
    );
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath['added.md'].status).toBe('added');
    expect(byPath['added.md'].additions).toBe(2);
    expect(byPath['added.md'].patch).toContain('+hello');
    expect(byPath['base.md'].status).toBe('modified');

    const { baseSha, headSha } = await git.resolvePrShas(
      workspaceId,
      'current-company-state',
      'alice/feature',
    );
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(baseSha).not.toBe(headSha);
  });

  /**
   * roles.yaml can never change through a merge — `preserveBaseRolesYaml`
   * restores the base copy onto the source before every merge — so the review
   * surface must not list it as changed: the claim would be false, the empty
   * diff reads as a bug, and its per-file approval would gate the merge on a
   * change that cannot land. Counts stay aligned with the surviving files.
   */
  it('excludes roles.yaml from the changed-file list and the touched paths', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    await runGit(repo, ['checkout', '-b', 'mallory/self-promote']);
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - mallory@x.com\n');
    await fs.writeFile(path.join(repo, 'honest.md'), 'real change\nsecond line\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'work + attempted escalation']);
    await runGit(repo, ['push', '-u', 'origin', 'mallory/self-promote']);

    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const files = await git.changedFilesForPr(
      workspaceId,
      'current-company-state',
      'mallory/self-promote',
    );
    expect(files.map((f) => f.path)).toEqual(['honest.md']);
    // The counts filter moved in step with the statuses filter.
    expect(files[0].additions).toBe(2);

    const paths = await git.changedPathsForPr(
      workspaceId,
      'current-company-state',
      'mallory/self-promote',
    );
    expect(paths).toEqual(['honest.md']);
  });

  /**
   * The per-file revert's two primitives: the merge-base a revert restores
   * from, and the restore itself — byte-exact via git, with "absent at the
   * merge-base" meaning deletion (the revert of an added file).
   */
  it('mergeBaseForPr + restorePathFromRef restore a modified file and delete an added one', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    await runGit(repo, ['checkout', '-b', 'alice/feature']);
    await fs.writeFile(path.join(repo, 'base.md'), 'rewritten\n');
    await fs.writeFile(path.join(repo, 'added.md'), 'brand new\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'feature work']);
    await runGit(repo, ['push', '-u', 'origin', 'alice/feature']);

    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const mergeBase = await git.mergeBaseForPr(workspaceId, 'current-company-state', 'alice/feature');
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);

    await git.restorePathFromRef(workspaceId, mergeBase!, 'base.md');
    // Normalized: a Windows dev box with core.autocrlf smudges the checkout
    // to CRLF; the blob git commits back is what matters, not the smudge.
    const restored = await fs.readFile(path.join(repo, 'base.md'), 'utf8');
    expect(restored.replace(/\r\n/g, '\n')).toBe('base\n');

    await git.restorePathFromRef(workspaceId, mergeBase!, 'added.md');
    await expect(fs.access(path.join(repo, 'added.md'))).rejects.toThrow();

    // The chain that actually failed in production: committing the DELETION
    // through commitFile, whose `git add -- <path>` can only stage it while
    // the index still tracks the path — a `git rm`-based restore broke here
    // with "pathspec did not match any files".
    const committed = await git.commitFile(
      workspaceId,
      { id: 'u1', email: 'reviewer@x.com', name: 'Reviewer' },
      'added.md',
      'Revert added.md (declined in change request #1)',
      true,
    );
    expect(committed).not.toBeNull();
    await expect(
      execFileAsync('git', ['-C', repo, 'cat-file', '-e', 'HEAD:added.md']),
    ).rejects.toThrow();
  });
});
