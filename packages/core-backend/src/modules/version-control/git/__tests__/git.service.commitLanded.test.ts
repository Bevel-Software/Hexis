import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FilesChange } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { VersionControlHooks } from '../../version-control-hooks.js';
import { GitService } from '../git.service.js';
import { gitOut, runGit, stubWorkspaceService } from './git-test-helpers.js';

/**
 * Every commit the git service lands is reported once through
 * `VersionControlHooks.onCommitLanded` — the one place a commit is announced
 * from, so no committer can be forgotten. Each way of committing is driven
 * here on a real repository: the one-file `commit`, `commitFile`, a scoped
 * `commitChanges`, a `commitChanges` that finds its scope clean, and a merge.
 * Paths arrive workspace-relative (the notifier sorts them), as the person.
 */
const KB = 'knowledge-base';
const WS = 'ws-landed';
const USER = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };

describe('GitService reports every commit it lands through onCommitLanded', () => {
  let root: string;
  let repo: string;
  let git: GitService;
  let landed: FilesChange[];

  const write = async (rel: string, text: string) => {
    const abs = path.join(repo, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  /** As the notifier will hand it on: paths sorted. */
  const heard = () => landed.map((c) => ({ ...c, paths: [...c.paths].sort() }));

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-landed-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(repo, { recursive: true });
    await runGit(repo, ['init', '-b', 'main']);
    await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
    await runGit(repo, ['config', 'user.name', 'Test Runner']);
    await write('Old.md', 'old\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'seed']);

    const hooks = new VersionControlHooks();
    hooks.onCommitValidation(vi.fn(async () => ({ ok: true, mustFix: [], warnings: [], rawOutput: '' })));
    landed = [];
    hooks.onCommitLanded((change) => landed.push(change));
    git = new GitService(stubWorkspaceService({ [WS]: workspaceDir }), hooks, testKbContext({ kbDirName: KB }));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('commit: the one file the change touched', async () => {
    await write('A.md', 'a\n');
    await git.commit(WS, USER, { summary: 'add A' });
    expect(heard()).toEqual([{ workspaceId: WS, branch: 'main', paths: [`${KB}/A.md`], byUser: USER }]);
  });

  it('commitFile: the file named, once', async () => {
    await write('B.md', 'b\n');
    await git.commitFile(WS, USER, `${KB}/B.md`);
    expect(heard()).toEqual([{ workspaceId: WS, branch: 'main', paths: [`${KB}/B.md`], byUser: USER }]);
  });

  it('commitChanges: exactly the scoped dirty set — a dirty path outside the scope stays out', async () => {
    await write('C.md', 'c\n');
    await write('D.md', 'd\n');
    await write('E.md', 'e\n');
    await git.commitChanges(WS, USER, 'batch', [`${KB}/C.md`, `${KB}/D.md`]);
    expect(heard()).toEqual([{ workspaceId: WS, branch: 'main', paths: [`${KB}/C.md`, `${KB}/D.md`], byUser: USER }]);
    // E is still the caller's uncommitted business.
    expect(await gitOut(repo, ['status', '--porcelain'])).toContain('E.md');
  });

  it('commitChanges on a clean scope lands nothing and reports nothing', async () => {
    expect(await git.commitChanges(WS, USER, 'nothing', [`${KB}/Old.md`])).toBeNull();
    expect(landed).toEqual([]);
  });

  it('a merge: every path the merge brought onto the branch, as the person who merged', async () => {
    await runGit(repo, ['checkout', '-b', 'topic']);
    await write('F.md', 'f\n');
    await write('Old.md', 'old, edited on topic\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'topic work']);
    await runGit(repo, ['checkout', 'main']);
    // Main moves too, so the merge is a real merge commit, not a fast-forward.
    await write('G.md', 'g\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'main work']);
    // The merge reads the other side as `origin/<branch>`: this repository is its own remote.
    await runGit(repo, ['remote', 'add', 'origin', repo]);

    const outcome = await git.mergeIntoBranch(WS, 'main', 'topic', USER, { subject: 'Merge topic', body: '' });
    expect(outcome.kind).toBe('merged');
    expect(heard()).toEqual([{ workspaceId: WS, branch: 'main', paths: [`${KB}/F.md`, `${KB}/Old.md`], byUser: USER }]);
  });

  it('a hook that throws is isolated: the commit stands and the other hooks still hear of it', async () => {
    const hooks = new VersionControlHooks();
    hooks.onCommitValidation(vi.fn(async () => ({ ok: true, mustFix: [], warnings: [], rawOutput: '' })));
    const others: FilesChange[] = [];
    hooks.onCommitLanded(() => {
      throw new Error('reactor exploded');
    });
    hooks.onCommitLanded((change) => others.push(change));
    const loud = new GitService(stubWorkspaceService({ [WS]: path.join(root, WS) }), hooks, testKbContext({ kbDirName: KB }));

    await write('H.md', 'h\n');
    const change = await loud.commitFile(WS, USER, `${KB}/H.md`);
    expect(change?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(others.map((c) => c.paths)).toEqual([[`${KB}/H.md`]]);
  });
});
