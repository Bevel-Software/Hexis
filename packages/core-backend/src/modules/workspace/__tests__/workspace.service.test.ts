import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService, workspaceIdForBranch } from '../workspace.service.js';

const execFileAsync = promisify(execFile);

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-'));
}

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

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Pre-seed a branch's on-disk workspace so the slow (clone) path isn't
 * exercised in the unit suite. We need the inner `<kbDirName>/.git`
 * directory to exist so `resolveWorkspaceDir` accepts the workspace
 * without trying to clone.
 */
async function seedBranchWorkspace(
  root: string,
  branch: string,
  kbDirName = 'knowledge-base',
): Promise<{ workspaceId: string; workspaceDir: string }> {
  const workspaceId = workspaceIdForBranch(branch);
  const workspaceDir = path.join(root, workspaceId);
  const gitDir = path.join(workspaceDir, kbDirName, '.git');
  await fs.mkdir(gitDir, { recursive: true });
  return { workspaceId, workspaceDir };
}

describe('WorkspaceService — branch-keyed identity', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('workspaceIdForBranch encodes branches with "/" so they fit a single dir segment', () => {
    expect(workspaceIdForBranch('target-company-state')).toBe('target-company-state');
    expect(workspaceIdForBranch('alice/feature')).toBe('alice%2Ffeature');
  });

  it('returns workspace info derived from the branch — no .workspace.json on disk', async () => {
    const { workspaceId, workspaceDir } = await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    const info = await svc.getOrCreateForBranch('target-company-state');

    expect(info.id).toBe(workspaceId);
    expect(info.name).toBe('target-company-state');
    expect(info.absolutePath).toBe(workspaceDir);
    expect(info.kbDirName).toBe('knowledge-base');
    expect(await svc.getWorkspacePath(workspaceId)).toBe(workspaceDir);
  });

  it('two branches map to distinct directories', async () => {
    const a = await seedBranchWorkspace(root, 'target-company-state');
    const b = await seedBranchWorkspace(root, 'alice/feature');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');

    const infoA = await svc.getOrCreateForBranch('target-company-state');
    const infoB = await svc.getOrCreateForBranch('alice/feature');

    expect(infoA.absolutePath).toBe(a.workspaceDir);
    expect(infoB.absolutePath).toBe(b.workspaceDir);
    expect(infoA.absolutePath).not.toBe(infoB.absolutePath);
    // alice%2Ffeature lands in a single dir segment, not nested.
    expect(infoB.absolutePath).toBe(path.join(root, 'alice%2Ffeature'));
  });

  it('rejects invalid branch names before touching disk', async () => {
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    await expect(svc.getOrCreateForBranch('')).rejects.toThrow();
    await expect(svc.getOrCreateForBranch('-bad-leading-dash')).rejects.toThrow();
  });

  it('getOrCreateForUser falls back to target-company-state when no branch is supplied', async () => {
    await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    const info = await svc.getOrCreateForUser({ id: 'u', email: 'a@b.c', name: 'A' });
    expect(info.id).toBe(workspaceIdForBranch('target-company-state'));
  });

  it('getOrCreateForUser respects an explicit branch override', async () => {
    await seedBranchWorkspace(root, 'alice/feature');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    const info = await svc.getOrCreateForUser({ id: 'u', email: 'a@b.c', name: 'A' }, 'alice/feature');
    expect(info.id).toBe(workspaceIdForBranch('alice/feature'));
  });
});

describe('WorkspaceService.createDirectory', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    // Hydrate the in-memory map so subsequent ops resolve fast.
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a .gitkeep inside a fresh empty folder', async () => {
    await svc.createDirectory(workspaceId, 'a');
    const absDir = path.join(workspaceDir, 'a');
    const dirStat = await fs.stat(absDir);
    expect(dirStat.isDirectory()).toBe(true);
    const gitkeep = await fs.readFile(path.join(absDir, '.gitkeep'), 'utf-8');
    expect(gitkeep).toBe('');
  });

  it('does not add a .gitkeep when the folder already has content', async () => {
    const absDir = path.join(workspaceDir, 'has-content');
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, 'real.md'), 'hello', 'utf-8');

    await svc.createDirectory(workspaceId, 'has-content');

    const entries = await fs.readdir(absDir);
    expect(entries.sort()).toEqual(['real.md']);
  });

  it('does not duplicate a .gitkeep when one already exists', async () => {
    const absDir = path.join(workspaceDir, 'kept');
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, '.gitkeep'), '', 'utf-8');

    await svc.createDirectory(workspaceId, 'kept');

    const entries = await fs.readdir(absDir);
    expect(entries).toEqual(['.gitkeep']);
  });

  it('only writes a .gitkeep in the leaf for nested paths', async () => {
    await svc.createDirectory(workspaceId, 'a/b/c');

    const aEntries = await fs.readdir(path.join(workspaceDir, 'a'));
    const bEntries = await fs.readdir(path.join(workspaceDir, 'a', 'b'));
    const cEntries = await fs.readdir(path.join(workspaceDir, 'a', 'b', 'c'));

    expect(aEntries).toEqual(['b']);
    expect(bEntries).toEqual(['c']);
    expect(cEntries).toEqual(['.gitkeep']);
  });

  it('hides .gitkeep entries from listFiles', async () => {
    await svc.createDirectory(workspaceId, 'visible-empty');
    await fs.writeFile(path.join(workspaceDir, 'visible-empty', '.gitkeep'), '', 'utf-8');
    const mixed = path.join(workspaceDir, 'mixed');
    await fs.mkdir(mixed, { recursive: true });
    await fs.writeFile(path.join(mixed, '.gitkeep'), '', 'utf-8');
    await fs.writeFile(path.join(mixed, 'real.md'), 'hi', 'utf-8');

    const tree = await svc.listFiles(workspaceId);

    const collectNames = (entry: typeof tree): string[] => {
      const own = [entry.name];
      const kids = entry.children?.flatMap(collectNames) ?? [];
      return [...own, ...kids];
    };
    const names = collectNames(tree);
    expect(names).not.toContain('.gitkeep');
    expect(names).toContain('visible-empty');
    expect(names).toContain('real.md');
  });
});

describe('WorkspaceService.createFolderZip', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function unzipEntries(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(buffer);
    return zip.getEntries().map((e) => ({
      name: e.entryName,
      data: e.getData(),
    }));
  }

  it('zips a folder prefixing entries with the folder name', async () => {
    const dir = path.join(workspaceDir, 'docs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.md'), 'alpha');
    await fs.writeFile(path.join(dir, 'b.md'), 'beta');

    const buf = await svc.createFolderZip(workspaceId, 'docs');
    const entries = await unzipEntries(buf);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['docs/a.md', 'docs/b.md']);
    const a = entries.find((e) => e.name === 'docs/a.md')!;
    expect(a.data.toString()).toBe('alpha');
  });

  it('preserves nested directory structure', async () => {
    const dir = path.join(workspaceDir, 'tree');
    await fs.mkdir(path.join(dir, 'nested', 'deep'), { recursive: true });
    await fs.writeFile(path.join(dir, 'top.md'), 'top');
    await fs.writeFile(path.join(dir, 'nested', 'mid.md'), 'mid');
    await fs.writeFile(path.join(dir, 'nested', 'deep', 'leaf.md'), 'leaf');

    const buf = await svc.createFolderZip(workspaceId, 'tree');
    const names = (await unzipEntries(buf)).map((e) => e.name).sort();
    expect(names).toEqual([
      'tree/nested/deep/leaf.md',
      'tree/nested/mid.md',
      'tree/top.md',
    ]);
  });

  it('omits .git directories and .gitkeep files', async () => {
    const dir = path.join(workspaceDir, 'mixed');
    await fs.mkdir(path.join(dir, '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'config'), 'should-not-ship');
    await fs.writeFile(path.join(dir, '.git', 'objects', 'pack'), 'binary');
    await fs.writeFile(path.join(dir, '.gitkeep'), '');
    await fs.writeFile(path.join(dir, 'real.md'), 'real');

    const buf = await svc.createFolderZip(workspaceId, 'mixed');
    const names = (await unzipEntries(buf)).map((e) => e.name).sort();
    expect(names).toEqual(['mixed/real.md']);
  });

  it('honors .bevelignore rules from inside the folder', async () => {
    const dir = path.join(workspaceDir, 'with-ignore');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.bevelignore'), 'secret.md\n');
    await fs.writeFile(path.join(dir, 'public.md'), 'pub');
    await fs.writeFile(path.join(dir, 'secret.md'), 'shh');

    const buf = await svc.createFolderZip(workspaceId, 'with-ignore');
    const names = (await unzipEntries(buf)).map((e) => e.name).sort();
    expect(names).toContain('with-ignore/public.md');
    expect(names).not.toContain('with-ignore/secret.md');
  });

  it('refuses to zip a file (not a directory)', async () => {
    await fs.writeFile(path.join(workspaceDir, 'lone.md'), 'one');
    await expect(svc.createFolderZip(workspaceId, 'lone.md')).rejects.toThrow('Not a directory');
  });

  it('rejects path traversal outside the workspace', async () => {
    await expect(svc.createFolderZip(workspaceId, '../escape')).rejects.toThrow('Path traversal');
  });

  it('throws FolderTooLargeError when contents exceed the size cap', async () => {
    // The real cap is 500 MB — too big to allocate in a unit test. Spy
    // on `fs.stat` to report a fake oversized file size; createFolderZip
    // checks `stat.size + totalBytes > cap` BEFORE reading the file, so
    // the guard fires without ever allocating the buffer.
    //
    // Spy on the top-level `fs` default import — same pattern that works
    // in diff.service.seed-atomicity.test.ts. A re-imported namespace via
    // `await import('node:fs/promises')` is sealed and `vi.spyOn` can't
    // redefine its properties.
    const dir = path.join(workspaceDir, 'too-big');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'huge.bin');
    await fs.writeFile(filePath, 'x'); // 1 byte real; stat will lie below.

    const { FolderTooLargeError } = await import('../workspace.service.js');
    const realStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p, opts) => {
      const result = await realStat(p as string, opts);
      if (typeof p === 'string' && p === filePath) {
        // Pretend the file is 600 MB — well over the 500 MB cap.
        return { ...result, size: 600 * 1024 * 1024 } as typeof result;
      }
      return result;
    });
    try {
      await expect(svc.createFolderZip(workspaceId, 'too-big'))
        .rejects.toBeInstanceOf(FolderTooLargeError);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('WorkspaceService — clone bootstrap & sibling reference', () => {
  let root: string;
  let workspacesRoot: string;
  let upstream: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    // Keep the bare upstream + seed clone OUTSIDE workspacesRoot so the
    // sibling scan only ever sees real workspace clones.
    workspacesRoot = path.join(root, 'workspaces');
    await fs.mkdir(workspacesRoot, { recursive: true });

    upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);

    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await runGit(seed, ['init', '-b', 'target-company-state']);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await fs.writeFile(path.join(seed, 'marker.txt'), 'on-target', 'utf-8');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init target']);
    await runGit(seed, ['checkout', '-b', 'alice/draft']);
    await fs.writeFile(path.join(seed, 'marker.txt'), 'on-draft', 'utf-8');
    await runGit(seed, ['commit', '-am', 'draft change']);
    await runGit(seed, ['push', 'origin', 'target-company-state', 'alice/draft']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('clones a branch on first bootstrap and checks out the right ref', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    const info = await svc.getOrCreateForBranch('target-company-state');

    const repo = path.join(info.absolutePath, 'knowledge-base');
    expect(await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('target-company-state');
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-target');
  });

  it('uses an existing sibling clone as a --reference and stays dissociated', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    // First branch: plain clone — becomes the sibling for the next bootstrap.
    await svc.getOrCreateForBranch('target-company-state');
    // Second branch: should borrow the first clone's objects, then dissociate.
    const info = await svc.getOrCreateForBranch('alice/draft');
    const repo = path.join(info.absolutePath, 'knowledge-base');

    expect(await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('alice/draft');
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-draft');
    // --dissociate must have dropped the alternates link — the clone is
    // fully independent of the sibling it borrowed objects from.
    await expect(
      fs.access(path.join(repo, '.git', 'objects', 'info', 'alternates')),
    ).rejects.toThrow();
    // Still a real clone of the real remote — every origin ref is present.
    const refs = await gitOut(repo, [
      'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin',
    ]);
    expect(refs).toContain('origin/target-company-state');
    expect(refs).toContain('origin/alice/draft');
  });

  // A clone whose config carries a second `remote.origin.fetch` refspec or a
  // second `branch.<name>.merge` value can no longer be refreshed — git dies
  // with "Cannot rebase onto multiple branches", which is what strands the
  // post-merge pull of a target branch. Every clone this service hands out must
  // therefore track exactly one upstream ref through exactly one refspec.
  it('stamps a single fetch refspec and upstream ref on a fresh clone', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    const info = await svc.getOrCreateForBranch('target-company-state');
    const repo = path.join(info.absolutePath, 'knowledge-base');

    expect(await gitOut(repo, ['config', '--get-all', 'remote.origin.fetch']))
      .toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await gitOut(repo, ['config', '--get-all', 'branch.target-company-state.merge']))
      .toBe('refs/heads/target-company-state');
    expect(await gitOut(repo, ['config', '--get-all', 'branch.target-company-state.remote']))
      .toBe('origin');
  });

  // Migration for the clones already on disk: they were created before the
  // stamp above existed and may have drifted since, so opening the branch
  // repairs them rather than waiting for a failed pull.
  it('repairs a drifted config on a clone that already exists on disk', async () => {
    // A clone that survived a process restart, laid out like prod.
    const workspaceDir = path.join(workspacesRoot, workspaceIdForBranch('alice/draft'));
    const repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(workspaceDir, { recursive: true });
    await runGit(workspacesRoot, ['clone', '-b', 'alice/draft', upstream, repo]);
    await runGit(repo, ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await runGit(repo, ['config', '--add', 'branch.alice/draft.merge', 'refs/heads/target-company-state']);

    const svc = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    await svc.getOrCreateForBranch('alice/draft');

    expect(await gitOut(repo, ['config', '--get-all', 'remote.origin.fetch']))
      .toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await gitOut(repo, ['config', '--get-all', 'branch.alice/draft.merge']))
      .toBe('refs/heads/alice/draft');
    // The working tree is untouched — repairing config never re-checks-out.
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-draft');
  });

  it('notifies the cloned-workspace listener with the workspace id after a clone', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    const cloned: string[] = [];
    svc.setWorkspaceClonedListener((id) => cloned.push(id));

    await svc.getOrCreateForBranch('alice/draft');
    expect(cloned).toEqual([workspaceIdForBranch('alice/draft')]);
  });

  // An upgraded deployment REUSES the persistent clone, so a top-up bound to
  // fresh clones alone never runs a new build's scaffolding or migrations —
  // the Groups→Plugins rename sat out an upgrade exactly this way. Every boot
  // must offer the top-up to an existing clone once.
  it('offers the scaffolding top-up to an existing clone once per process', async () => {
    const seed = {
      ensureRemoteSeeded: vi.fn(async () => {}),
      topUpWorkspace: vi.fn(async () => {}),
    };
    const firstBoot = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    firstBoot.setSeedService(seed);
    await firstBoot.getOrCreateForBranch('target-company-state');
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(1); // the fresh clone

    // A new process over the same workspaces dir — the deployed-upgrade case:
    // the clone exists, and the top-up must still run, once, not per access.
    const nextBoot = new WorkspaceService(workspacesRoot, upstream, 'knowledge-base');
    nextBoot.setSeedService(seed);
    await nextBoot.getOrCreateForBranch('target-company-state');
    await nextBoot.getOrCreateForBranch('target-company-state');
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(2);
  });
});

describe('WorkspaceService — scaffolding top-up on restart-survivor clones', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    // The fake `.git` in seedBranchWorkspace makes normalizeCloneTracking's
    // git calls fail; that path only warns, which is noise here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  // The top-up MOVES files (the Groups→Plugins migration runs inside it), so a
  // caller handed the workspace mid-run reads a tree with both halves missing.
  it('makes a concurrent opener wait out the in-flight top-up instead of returning mid-migration', async () => {
    await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seed = {
      ensureRemoteSeeded: vi.fn(async () => {}),
      topUpWorkspace: vi.fn(() => gate),
    };
    svc.setSeedService(seed);

    let aDone = false;
    let bDone = false;
    const a = svc.getOrCreateForBranch('target-company-state').then((v) => { aDone = true; return v; });
    const b = svc.getOrCreateForBranch('target-company-state').then((v) => { bDone = true; return v; });
    // Wait until the top-up has started (the fake clone makes the preceding
    // git-config repair fail slowly, so poll rather than sleep), then give
    // both callers time to settle against the gate.
    await vi.waitFor(() => expect(seed.topUpWorkspace).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    // Neither caller has been handed the workspace while the top-up runs —
    // and the second did not start a rival run.
    expect(aDone).toBe(false);
    expect(bDone).toBe(false);
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(1);

    release();
    const [infoA, infoB] = await Promise.all([a, b]);
    expect(infoA.id).toBe(infoB.id);
  });

  it('re-offers the top-up after deleteWorkspace — the claim died with the clone', async () => {
    await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    const seed = {
      ensureRemoteSeeded: vi.fn(async () => {}),
      topUpWorkspace: vi.fn(async () => {}),
    };
    svc.setSeedService(seed);

    await svc.getOrCreateForBranch('target-company-state');
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(1);

    await svc.deleteWorkspace(workspaceIdForBranch('target-company-state'));
    // A later bootstrap re-creates the clone (seeded by hand here); it must
    // be offered the top-up afresh — the old claim was about a clone that no
    // longer exists.
    await seedBranchWorkspace(root, 'target-company-state');
    await svc.getOrCreateForBranch('target-company-state');
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(2);
  });

  it('re-offers the top-up after the orphan sweep removes the clone — same eviction rule', async () => {
    await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    const seed = {
      ensureRemoteSeeded: vi.fn(async () => {}),
      topUpWorkspace: vi.fn(async () => {}),
    };
    svc.setSeedService(seed);

    await svc.getOrCreateForBranch('target-company-state');
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(1);

    // The branch vanishes from the known set; the sweep reclaims its clone.
    const { removed } = await svc.sweepOrphanedWorkspaces([]);
    expect(removed).toContain(workspaceIdForBranch('target-company-state'));

    // Re-created before any restart: the fresh clone must still get its one
    // top-up — the claim died with the directory the sweep removed.
    await seedBranchWorkspace(root, 'target-company-state');
    await svc.getOrCreateForBranch('target-company-state');
    expect(seed.topUpWorkspace).toHaveBeenCalledTimes(2);
  });
});

describe('WorkspaceService.readAllKbFiles', () => {
  let root: string;
  let svc: WorkspaceService;
  let repoRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    repoRoot = path.join(seeded.workspaceDir, 'knowledge-base');
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeRepoFile(rel: string, content: string): Promise<void> {
    const abs = path.join(repoRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }

  it('returns every .md keyed by repo-root path, skipping non-.md and .git', async () => {
    await writeRepoFile('Product/NodeTypes/ServiceCommitment.md', '# SC');
    await writeRepoFile('Product/Knowledge/Foo.md', '# Foo');
    await writeRepoFile('README.md', 'readme');
    await writeRepoFile('Product/Knowledge/data.json', '{}');
    // a stray .md under the seeded .git dir must never be returned
    await fs.writeFile(path.join(repoRoot, '.git', 'note.md'), 'gitnote', 'utf-8');

    const files = await svc.readAllKbFiles(workspaceId);

    expect(Object.keys(files).sort()).toEqual([
      'Product/Knowledge/Foo.md',
      'Product/NodeTypes/ServiceCommitment.md',
      'README.md',
    ]);
    expect(files['Product/Knowledge/Foo.md']).toBe('# Foo');
    expect(Object.keys(files).some((k) => k.startsWith('.git/'))).toBe(false);
  });

  it('honors .bevelignore', async () => {
    await writeRepoFile('Product/Knowledge/Public.md', 'pub');
    await writeRepoFile('Product/Knowledge/Secret.md', 'shh');
    await writeRepoFile('Product/Knowledge/.bevelignore', 'Secret.md\n');

    const files = await svc.readAllKbFiles(workspaceId);

    expect(files['Product/Knowledge/Public.md']).toBe('pub');
    expect(files['Product/Knowledge/Secret.md']).toBeUndefined();
  });
});

describe('WorkspaceService.unzipFile — ontology-session write guard', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', 'knowledge-base');
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeZip(rel: string, files: Record<string, string>): Promise<void> {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
    await fs.writeFile(path.join(workspaceDir, rel), zip.toBuffer());
  }

  it('skips entries the write guard rejects and never writes them to disk', async () => {
    await writeZip('a.zip', { 'keep.md': 'ok', 'blocked.md': 'no' });
    const res = await svc.unzipFile(workspaceId, 'a.zip', 'out', async (wsPath) => {
      if (wsPath.endsWith('blocked.md')) throw new Error('Blocked by the ontology-session boundary');
    });
    expect(res.extracted).toEqual(['out/keep.md']);
    expect(res.skipped).toContainEqual({ path: 'blocked.md', reason: 'Blocked by the ontology-session boundary' });
    expect((await fs.readFile(path.join(workspaceDir, 'out', 'keep.md'))).toString()).toBe('ok');
    await expect(fs.readFile(path.join(workspaceDir, 'out', 'blocked.md'))).rejects.toThrow();
  });

  it('skips a guard-rejected directory entry without creating it on disk', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('blocked-dir/', Buffer.alloc(0)); // bare directory entry
    zip.addFile('keep.md', Buffer.from('ok'));
    await fs.writeFile(path.join(workspaceDir, 'c.zip'), zip.toBuffer());

    const res = await svc.unzipFile(workspaceId, 'c.zip', 'out', async (wsPath) => {
      if (wsPath.includes('blocked-dir')) throw new Error('Blocked by the ontology-session boundary');
    });

    expect(res.extracted).toEqual(['out/keep.md']);
    expect(res.skipped).toContainEqual({ path: 'blocked-dir/', reason: 'Blocked by the ontology-session boundary' });
    await expect(fs.stat(path.join(workspaceDir, 'out', 'blocked-dir'))).rejects.toThrow();
  });

  it('does not create the destination directory when every entry is blocked', async () => {
    await writeZip('d.zip', { 'a.md': '1', 'b.md': '2' });
    const res = await svc.unzipFile(workspaceId, 'd.zip', 'out', async () => {
      throw new Error('Blocked by the ontology-session boundary');
    });
    expect(res.extracted).toEqual([]);
    expect(res.skipped).toHaveLength(2);
    await expect(fs.stat(path.join(workspaceDir, 'out'))).rejects.toThrow();
  });

  it('extracts everything when no guard is supplied (human / non-agent path)', async () => {
    await writeZip('b.zip', { 'x.md': '1', 'y.md': '2' });
    const res = await svc.unzipFile(workspaceId, 'b.zip', 'out');
    expect(res.extracted.sort()).toEqual(['out/x.md', 'out/y.md']);
    expect(res.skipped).toEqual([]);
  });
});
