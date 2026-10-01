import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService, parseNameStatusZ, parseNumstatZ, withoutPlaceholderRename } from '../git.service.js';
import { WorkspaceMutex } from '../../../kb-fs/mutex.js';

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
  // Repo-local identity, because `GitService` spawns its own git children
  // with the AMBIENT env — `runGit`'s `GIT_COMMITTER_*` vars never reach
  // them. A dev machine hides this behind a global git config; a CI runner
  // has none, so anything committing through the service (here:
  // `commitFile`) fails with "Committer identity unknown". Same reason
  // `git.service.commitFile.test.ts` configures its fixture this way.
  await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
  await runGit(repo, ['config', 'user.name', 'Test Runner']);
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

describe('withoutPlaceholderRename', () => {
  it('turns a rename onto the placeholder into a removal, and off it into an addition', () => {
    expect(withoutPlaceholderRename({ status: 'renamed', previousPath: 'A/x.md', path: 'A/.gitkeep' })).toEqual({
      status: 'removed',
      path: 'A/x.md',
    });
    expect(withoutPlaceholderRename({ status: 'renamed', previousPath: 'A/.gitkeep', path: 'A/x.md' })).toEqual({
      status: 'added',
      path: 'A/x.md',
    });
  });

  it('leaves every other entry as it is', () => {
    const plain = { status: 'renamed' as const, previousPath: 'A/x.md', path: 'B/x.md' };
    const moved = { status: 'renamed' as const, previousPath: 'A/.gitkeep', path: 'B/.gitkeep' };
    const added = { status: 'added' as const, path: 'A/.gitkeep' };
    expect([plain, moved, added].map(withoutPlaceholderRename)).toEqual([plain, moved, added]);
  });
});

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
      testKbContext(),
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
   * A change-request detail resolves the SHAs (which fetches both refs) and
   * then lists the files. `at` pins that listing to the commits just
   * resolved: no second fetch, and the file list describes exactly the head
   * the approvals pin against even when a newer push has landed on origin in
   * between. The default keeps refreshing first.
   */
  it('`at` pins the diff to the resolved commits; the default refreshes origin/* first', async () => {
    const { upstream, repo } = await seedWorkspace(root, workspaceId);
    // The branch is authored in ANOTHER clone, so this workspace only ever
    // knows it as origin/alice/feature — the production shape, where the
    // base-branch workspace answers for every request without a local copy.
    const other = path.join(root, 'other');
    await runGit(root, ['clone', upstream, other]);
    await runGit(other, ['checkout', '-b', 'alice/feature']);
    await fs.writeFile(path.join(other, 'added.md'), 'hello\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'feature work']);
    await runGit(other, ['push', '-u', 'origin', 'alice/feature']);

    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      testKbContext(),
    );
    // What the detail does first: resolve (and fetch) the two SHAs.
    const pinned = await git.resolvePrShas(workspaceId, 'current-company-state', 'alice/feature');

    // A second push lands on origin after the resolution.
    await fs.writeFile(path.join(other, 'second.md'), 'more\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'more work']);
    await runGit(other, ['push', 'origin', 'alice/feature']);

    const atPinned = await git.changedFilesForPr(
      workspaceId,
      'current-company-state',
      'alice/feature',
      { at: pinned },
    );
    expect(atPinned.map((f) => f.path)).toEqual(['added.md']);

    const refreshed = await git.changedFilesForPr(
      workspaceId,
      'current-company-state',
      'alice/feature',
    );
    expect(refreshed.map((f) => f.path).sort()).toEqual(['added.md', 'second.md']);

    await expect(
      git.changedFilesForPr(workspaceId, 'current-company-state', 'alice/feature', {
        at: { baseSha: pinned.baseSha, headSha: 'origin/alice/feature' },
      }),
    ).rejects.toThrow(/invalid commit sha/);
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
      testKbContext(),
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
   * The empty-folder placeholder is never content, so the change-request file
   * list does not show it, at any depth, and the +/- counts stay aligned. The
   * touched paths keep it: a request that only creates a folder is not empty,
   * and must not be closed as if it were.
   */
  it('excludes the folder placeholder from the changed-file list but not the touched paths', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    await runGit(repo, ['checkout', '-b', 'alice/new-folders']);
    await fs.mkdir(path.join(repo, 'Reports/Empty'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Reports/Empty/.gitkeep'), '');
    await fs.writeFile(path.join(repo, 'Reports/.gitkeep'), '');
    await fs.writeFile(path.join(repo, 'Reports/q3.md'), 'one\ntwo\nthree\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'folders']);
    await runGit(repo, ['push', '-u', 'origin', 'alice/new-folders']);

    const git = new GitService(stubWorkspaceService(workspaceId, repo), new WorkflowHooks(), testKbContext());

    const files = await git.changedFilesForPr(workspaceId, 'current-company-state', 'alice/new-folders');
    expect(files.map((f) => f.path)).toEqual(['Reports/q3.md']);
    expect(files[0].additions).toBe(3);

    const paths = await git.changedPathsForPr(workspaceId, 'current-company-state', 'alice/new-folders');
    expect(paths.sort()).toEqual(['Reports/.gitkeep', 'Reports/Empty/.gitkeep', 'Reports/q3.md']);
  });

  /**
   * Deleting a folder's last file writes the placeholder; when that file was
   * empty too, `-M` sees an identical blob move and pairs them as a rename.
   * The review surface must still show the file's removal.
   */
  it('an empty file replaced by the placeholder is reviewed as a removal, not dropped with it', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    await fs.mkdir(path.join(repo, 'Reports'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Reports/empty.md'), '');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'empty file']);
    await runGit(repo, ['push', 'origin', 'current-company-state']);
    await runGit(repo, ['checkout', '-b', 'alice/emptied']);
    await fs.rm(path.join(repo, 'Reports/empty.md'));
    await fs.writeFile(path.join(repo, 'Reports/.gitkeep'), '');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'emptied']);
    await runGit(repo, ['push', '-u', 'origin', 'alice/emptied']);

    const git = new GitService(stubWorkspaceService(workspaceId, repo), new WorkflowHooks(), testKbContext());

    const files = await git.changedFilesForPr(workspaceId, 'current-company-state', 'alice/emptied');
    expect(files.map((f) => ({ path: f.path, status: f.status, previousPath: f.previousPath }))).toEqual([
      { path: 'Reports/empty.md', status: 'removed', previousPath: undefined },
    ]);

    const paths = await git.changedPathsForPr(workspaceId, 'current-company-state', 'alice/emptied');
    expect(paths.sort()).toEqual(['Reports/.gitkeep', 'Reports/empty.md']);
  });

  it('pathExistsAtRef answers for files and folders at a ref, and false for what is not there', async () => {
    const { repo } = await seedWorkspace(root, workspaceId);
    const git = new GitService(stubWorkspaceService(workspaceId, repo), new WorkflowHooks(), testKbContext());
    await fs.mkdir(path.join(repo, 'Docs'));
    await fs.writeFile(path.join(repo, 'Docs/.gitkeep'), '');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'folder']);

    await expect(git.pathExistsAtRef(workspaceId, 'HEAD', 'base.md')).resolves.toBe(true);
    await expect(git.pathExistsAtRef(workspaceId, 'HEAD', 'Docs/.gitkeep')).resolves.toBe(true);
    await expect(git.pathExistsAtRef(workspaceId, 'HEAD~1', 'Docs/.gitkeep')).resolves.toBe(false);
    await expect(git.pathExistsAtRef(workspaceId, 'HEAD', 'missing.md')).resolves.toBe(false);
    // Not an answer about the path at all: the ref does not resolve.
    await expect(git.pathExistsAtRef(workspaceId, 'deadbeef', 'base.md')).rejects.toThrow();
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
      testKbContext(),
    );

    const mergeBase = await git.mergeBaseForPr(workspaceId, 'current-company-state', 'alice/feature');
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);

    await git.restorePathFromRef(workspaceId, mergeBase!, 'base.md');
    // Normalized: a Windows dev box with core.autocrlf smudges the checkout
    // to CRLF; the blob git commits back is what matters, not the smudge.
    const restored = await fs.readFile(path.join(repo, 'base.md'), 'utf8');
    expect(restored.replace(/\r\n/g, '\n')).toBe('base\n');

    // Simulate the wreckage a previously-failed attempt leaves behind: a
    // STAGED deletion (index entry gone). The restore must self-heal it —
    // without the index realignment, the commit below fatals on `git add`.
    await runGit(repo, ['rm', '--force', '--quiet', '--', 'added.md']);

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

/**
 * `changedPathsForPr` fetches the two refs it is about before diffing them —
 * one network round trip per call. A change-request LIST calls it once per
 * open request, which is where the "very slow loading" reported against the
 * request list came from (~0.55s per additional open request, measured).
 * `fetch: false` lets the list refresh the whole clone once instead and then
 * diff locally; every other caller keeps the fetch.
 */
describe('GitService.changedPathsForPr: who pays for the fetch', () => {
  let root: string;
  const workspaceId = 'current-company-state';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-pr-paths-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Push a change request's head branch to the remote from a DIFFERENT
   * clone, so the workspace clone has never seen it — which is exactly what
   * the flag decides about.
   */
  async function pushedElsewhere(upstream: string, file: string): Promise<string> {
    const other = path.join(root, `.other-${file}`);
    await runGit(root, ['clone', upstream, other]);
    await runGit(other, ['config', 'user.email', 'test@bevel.local']);
    await runGit(other, ['config', 'user.name', 'Test Runner']);
    await runGit(other, ['checkout', '-b', 'biz/proposal']);
    await fs.writeFile(path.join(other, file), 'proposed\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'propose']);
    await runGit(other, ['push', '-u', 'origin', 'biz/proposal']);
    return other;
  }

  it('finds a branch pushed since the last fetch — the default', async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    await pushedElsewhere(upstream, 'brief.pdf');
    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      testKbContext(),
    );
    expect(
      await git.changedPathsForPr(workspaceId, 'current-company-state', 'biz/proposal'),
    ).toEqual(['brief.pdf']);
  });

  it('with fetch: false, reads the refs the clone already has and skips the network', async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    const other = await pushedElsewhere(upstream, 'brief.pdf');
    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      testKbContext(),
    );
    // The clone now knows the branch — this stands in for the one fetch a
    // list does for the whole clone before asking about every request.
    await runGit(repo, ['fetch', '--prune', 'origin']);
    // A second file lands on the branch afterwards.
    await fs.writeFile(path.join(other, 'extra.pdf'), 'more\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'second']);
    await runGit(other, ['push', 'origin', 'biz/proposal']);

    // Skipped: the answer is the clone's own refs, one push behind — which
    // is the trade the flag makes, and why only a caller that has JUST
    // refreshed the clone may pass it.
    expect(
      await git.changedPathsForPr(workspaceId, 'current-company-state', 'biz/proposal', {
        fetch: false,
      }),
    ).toEqual(['brief.pdf']);
    // The default pays for the round trip and sees both.
    expect(
      (await git.changedPathsForPr(workspaceId, 'current-company-state', 'biz/proposal')).sort(),
    ).toEqual(['brief.pdf', 'extra.pdf']);
  });

  /**
   * The one case `fetch: false` must NOT honour. A branch this clone has
   * never heard of does not give a stale diff, it gives NO diff — an empty
   * touched-path set, which is a change request missing from its own
   * author's tree. So the skip only applies to refs that are actually here.
   */
  it('fetches anyway for a branch the clone has never seen', async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    await pushedElsewhere(upstream, 'brief.pdf');
    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      testKbContext(),
    );
    // Nothing has refreshed this clone since the branch was pushed.
    expect(
      await git.changedPathsForPr(workspaceId, 'current-company-state', 'biz/proposal', {
        fetch: false,
      }),
    ).toEqual(['brief.pdf']);
  });

  /**
   * The skip decision and the diff must be ONE reading of the refs. Both
   * fetches in this flow (`ensureRemotesFetched` for the list,
   * `fetchPrRefs` here) run outside the workspace mutex deliberately, so a
   * `fetch --prune origin` CAN land between "the clone knows both branches"
   * and the diff itself. Re-resolving inside the mutex would then fail, and
   * `touchedPathsFor` turns that failure into an empty touched-path set —
   * the request missing from its own author's tree that this whole path
   * exists to prevent.
   */
  it('diffs the commits it decided on, even if a concurrent prune drops the ref', async () => {
    const { repo, upstream } = await seedWorkspace(root, workspaceId);
    await pushedElsewhere(upstream, 'brief.pdf');
    // The list's one fetch for the whole clone.
    await runGit(repo, ['fetch', '--prune', 'origin']);

    /** Runs the race exactly in the window, then the real critical section. */
    class PrunedMidCall extends WorkspaceMutex {
      override async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
        return super.run(key, async () => {
          await runGit(repo, ['update-ref', '-d', 'refs/remotes/origin/biz/proposal']);
          return fn();
        });
      }
    }
    const git = new GitService(
      stubWorkspaceService(workspaceId, repo),
      new WorkflowHooks(),
      testKbContext(),
      new PrunedMidCall(),
    );

    expect(
      await git.changedPathsForPr(workspaceId, 'current-company-state', 'biz/proposal', {
        fetch: false,
      }),
    ).toEqual(['brief.pdf']);
  });
});
