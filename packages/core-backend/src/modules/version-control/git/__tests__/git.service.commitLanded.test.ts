import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FilesChange } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import type { IGitRunner } from '../../../../shared/git.contract.js';
import { VersionControlHooks } from '../../version-control-hooks.js';
import { GitService } from '../git.service.js';
import { NodeGitRunner } from '../node-git-runner.js';
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

  it('commit: every file of a new folder, and both ends of a rename — the commit, not the status listing, names them', async () => {
    await write('Folder/one.md', '1\n');
    await write('Folder/two.md', '2\n');
    await git.commit(WS, USER, { summary: 'add a folder' });
    expect(heard().map((c) => c.paths)).toEqual([[`${KB}/Folder/one.md`, `${KB}/Folder/two.md`]]);

    landed.length = 0;
    await runGit(repo, ['mv', 'Old.md', 'New.md']);
    await git.commit(WS, USER, { summary: 'rename' });
    expect(heard().map((c) => c.paths)).toEqual([[`${KB}/New.md`, `${KB}/Old.md`]]);
  });

  it('commitChanges without a scope: both ends of a rename', async () => {
    await runGit(repo, ['mv', 'Old.md', 'Moved.md']);
    await write('K.md', 'k\n');
    await git.commitChanges(WS, USER, 'move and add');
    expect(heard().map((c) => c.paths)).toEqual([[`${KB}/K.md`, `${KB}/Moved.md`, `${KB}/Old.md`]]);
  });

  it('commitFile: the file named, once — a non-ASCII name verbatim', async () => {
    await write('B.md', 'b\n');
    await git.commitFile(WS, USER, `${KB}/B.md`);
    await write('Ünïcode ñ.md', 'ü\n');
    await git.commitFile(WS, USER, `${KB}/Ünïcode ñ.md`);
    expect(heard().map((c) => c.paths)).toEqual([[`${KB}/B.md`], [`${KB}/Ünïcode ñ.md`]]);
  });

  describe('when the read of its files fails, a commit is reported from the listing taken before it, which names the same files', () => {
    let fragile: GitService;
    let heardHere: FilesChange[];
    const heardPaths = () => heardHere.map((c) => [...c.paths].sort());
    /** The files each of the last `n` commits holds, oldest first, read by a git whose `diff-tree` works. */
    const lastCommits = async (n: number) => {
      const files: string[][] = [];
      for (let back = n - 1; back >= 0; back--) {
        const out = await gitOut(repo, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', `HEAD~${back}`]);
        files.push(out.split('\0').filter(Boolean).map((p) => `${KB}/${p}`).sort());
      }
      return files;
    };

    beforeEach(() => {
      // A runner like the real one, except that `diff-tree` — the read of a
      // landed commit's files — fails.
      const real = new NodeGitRunner();
      const diffTreeFails: IGitRunner = {
        defaultTimeoutMs: real.defaultTimeoutMs,
        credentials: real.credentials,
        run: ((cwd: string, args: string[], opts?: unknown) =>
          args[0] === 'diff-tree' ? Promise.reject(new Error('diff-tree unavailable')) : real.run(cwd, args, opts as never)) as IGitRunner['run'],
      };
      const hooks = new VersionControlHooks();
      hooks.onCommitValidation(vi.fn(async () => ({ ok: true, mustFix: [], warnings: [], rawOutput: '' })));
      heardHere = [];
      hooks.onCommitLanded((change) => heardHere.push(change));
      fragile = new GitService(stubWorkspaceService({ [WS]: path.join(root, WS) }), hooks, testKbContext({ kbDirName: KB }), undefined, null, diffTreeFails);
    });

    it('the report is still made, each file named', async () => {
      await write('L.md', 'l\n');
      await fragile.commit(WS, USER, { summary: 'add L' });
      await write('M.md', 'm\n');
      await write('N.md', 'n\n');
      await fragile.commitChanges(WS, USER, 'add M and N', [`${KB}/M.md`, `${KB}/N.md`]);
      await write('O.md', 'o\n');
      await fragile.commitFile(WS, USER, `${KB}/O.md`);
      expect(heardPaths()).toEqual([[`${KB}/L.md`], [`${KB}/M.md`, `${KB}/N.md`], [`${KB}/O.md`]]);
      expect(heardPaths()).toEqual(await lastCommits(3));
    });

    it('commit: every file of a new folder, never the folder, a non-ASCII name verbatim; both ends of a rename', async () => {
      await write('Folder/one.md', '1\n');
      await write('Folder/twö ñ.md', '2\n');
      await fragile.commit(WS, USER, { summary: 'add a folder' });
      await runGit(repo, ['mv', 'Old.md', 'New.md']);
      await fragile.commit(WS, USER, { summary: 'rename' });
      expect(heardPaths()).toEqual([
        [`${KB}/Folder/one.md`, `${KB}/Folder/twö ñ.md`],
        [`${KB}/New.md`, `${KB}/Old.md`],
      ]);
      expect(heardPaths()).toEqual(await lastCommits(2));
    });

    it('commitChanges without a scope: both ends of a rename, every file of a new folder, an added file', async () => {
      await runGit(repo, ['mv', 'Old.md', 'Moved.md']);
      await write('K.md', 'k\n');
      await write('Dir/x.md', 'x\n');
      await write('Dir/y.md', 'y\n');
      await fragile.commitChanges(WS, USER, 'move and add');
      expect(heardPaths()).toEqual([[`${KB}/Dir/x.md`, `${KB}/Dir/y.md`, `${KB}/K.md`, `${KB}/Moved.md`, `${KB}/Old.md`]]);
      expect(heardPaths()).toEqual(await lastCommits(1));
    });

    it('commitChanges with a scope: both ends of a rename in it, every file of a new folder in it, nothing outside it', async () => {
      await runGit(repo, ['mv', 'Old.md', 'New.md']);
      await write('Dir/x.md', 'x\n');
      await write('Dir/y.md', 'y\n');
      await write('Outside.md', 'not this batch\n');
      await fragile.commitChanges(WS, USER, 'scoped', [`${KB}/New.md`, `${KB}/Dir/x.md`, `${KB}/Dir/y.md`]);
      expect(heardPaths()).toEqual([[`${KB}/Dir/x.md`, `${KB}/Dir/y.md`, `${KB}/New.md`, `${KB}/Old.md`]]);
      expect(heardPaths()).toEqual(await lastCommits(1));
    });

    it('commitFile: a lock-released save names its one file — each file of a new folder, each end of a move, in its own save', async () => {
      await write('Folder/one.md', '1\n');
      await write('Folder/two.md', '2\n');
      await fragile.commitFile(WS, USER, `${KB}/Folder/one.md`);
      await fragile.commitFile(WS, USER, `${KB}/Folder/two.md`);
      // The lock-aware filesystem moves a file on disk and releases both
      // paths: one save deletes the old path, the other adds the new one.
      await fs.rename(path.join(repo, 'Old.md'), path.join(repo, 'New.md'));
      await fragile.commitFile(WS, USER, `${KB}/Old.md`);
      await fragile.commitFile(WS, USER, `${KB}/New.md`);
      expect(heardPaths()).toEqual([[`${KB}/Folder/one.md`], [`${KB}/Folder/two.md`], [`${KB}/Old.md`], [`${KB}/New.md`]]);
      expect(heardPaths()).toEqual(await lastCommits(4));
    });
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

  it('a commit is reported even when the attribution read after it fails — the commit exists, so the reactors hear of it', async () => {
    // A runner like the real one, except that `git log` fails: what a disk or
    // process fault between the commit and its attribution read looks like.
    const real = new NodeGitRunner();
    const logFails: IGitRunner = {
      defaultTimeoutMs: real.defaultTimeoutMs,
      credentials: real.credentials,
      run: ((cwd: string, args: string[], opts?: unknown) =>
        args[0] === 'log' ? Promise.reject(new Error('git log unavailable')) : real.run(cwd, args, opts as never)) as IGitRunner['run'],
    };
    const hooks = new VersionControlHooks();
    hooks.onCommitValidation(vi.fn(async () => ({ ok: true, mustFix: [], warnings: [], rawOutput: '' })));
    const heardHere: FilesChange[] = [];
    hooks.onCommitLanded((change) => heardHere.push(change));
    const fragile = new GitService(stubWorkspaceService({ [WS]: path.join(root, WS) }), hooks, testKbContext({ kbDirName: KB }), undefined, null, logFails);
    const before = Number(await gitOut(repo, ['rev-list', '--count', 'HEAD']));

    await write('I.md', 'i\n');
    await expect(fragile.commitFile(WS, USER, `${KB}/I.md`)).rejects.toThrow('git log unavailable');
    await write('J.md', 'j\n');
    await expect(fragile.commit(WS, USER, { summary: 'add J' })).rejects.toThrow('git log unavailable');

    // Both commits landed, and both were reported before the read that failed.
    expect(Number(await gitOut(repo, ['rev-list', '--count', 'HEAD']))).toBe(before + 2);
    expect(heardHere.map((c) => c.paths)).toEqual([[`${KB}/I.md`], [`${KB}/J.md`]]);
  });

  it('a hook that throws, or whose promise rejects, is isolated: the commit stands and the other hooks still hear of it', async () => {
    const hooks = new VersionControlHooks();
    hooks.onCommitValidation(vi.fn(async () => ({ ok: true, mustFix: [], warnings: [], rawOutput: '' })));
    const others: FilesChange[] = [];
    hooks.onCommitLanded(() => {
      throw new Error('reactor exploded');
    });
    hooks.onCommitLanded(async () => Promise.reject(new Error('reactor exploded later')));
    hooks.onCommitLanded((change) => others.push(change));
    const loud = new GitService(stubWorkspaceService({ [WS]: path.join(root, WS) }), hooks, testKbContext({ kbDirName: KB }));

    await write('H.md', 'h\n');
    const change = await loud.commitFile(WS, USER, `${KB}/H.md`);
    expect(change?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    expect(others.map((c) => c.paths)).toEqual([[`${KB}/H.md`]]);
  });
});
