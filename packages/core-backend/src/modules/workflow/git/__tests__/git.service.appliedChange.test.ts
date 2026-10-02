import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { WorkflowValidationError } from '../../../../shared/domain-errors.js';
import { runGit, gitOut, stubWorkspaceService } from './git-test-helpers.js';

/**
 * Reading an APPLIED change request back from its merge commit — the three
 * methods behind Razvan's 2026-10-02 decision, against a real git.
 *
 * Why they exist at all: merging a change request retires its source branch, so
 * the branch pair every other diff method takes no longer resolves. Before this,
 * a merged request answered no files — and since an empty file set proves no read
 * access, that left every applied request readable by its author alone. The merge
 * commit is what is left of the change, it is local, and it cannot move.
 *
 * The fixture is the merge `mergeChangeRequest` makes: `--no-ff`, on the target,
 * so the commit has the target as its first parent and the source tip as its
 * second.
 */
describe('GitService reading an applied change from its merge commit', () => {
  const workspaceId = 'ws-applied';
  let root: string;
  let repo: string;
  let git: GitService;

  /** One clone with a merge commit on `main`, and the shas that went into it. */
  async function seedMerged(): Promise<{
    mergeSha: string;
    targetBefore: string;
    sourceTip: string;
  }> {
    repo = path.join(root, workspaceId, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(path.dirname(repo), ['init', '-b', 'main', 'knowledge-base']);
    await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
    await runGit(repo, ['config', 'user.name', 'Test Runner']);

    await fs.writeFile(path.join(repo, 'base.md'), 'base\n');
    await fs.mkdir(path.join(repo, 'Payroll'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Payroll', 'Rates.md'), 'bands\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'init']);

    // The proposal: an add, an edit, a delete and a move out of Payroll.
    await runGit(repo, ['checkout', '-b', 'juan/proposal']);
    await fs.writeFile(path.join(repo, 'Added.md'), 'new\n');
    await fs.writeFile(path.join(repo, 'base.md'), 'base\nmore\n');
    await fs.mkdir(path.join(repo, 'Knowledge'), { recursive: true });
    await fs.rename(path.join(repo, 'Payroll', 'Rates.md'), path.join(repo, 'Knowledge', 'Open.md'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'the proposal']);
    const sourceTip = await gitOut(repo, ['rev-parse', 'HEAD']);

    // The target moves on while the proposal waits, so a three-dot read of the
    // merge commit would report this commit's file too — and must not.
    await runGit(repo, ['checkout', 'main']);
    await fs.writeFile(path.join(repo, 'OnTarget.md'), 'meanwhile\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'unrelated work on the target']);
    const targetBefore = await gitOut(repo, ['rev-parse', 'HEAD']);

    await runGit(repo, ['merge', '--no-ff', '-m', 'apply the proposal', 'juan/proposal']);
    const mergeSha = await gitOut(repo, ['rev-parse', 'HEAD']);
    // Applied: the source branch goes, as `mergeChangeRequest` retires it.
    await runGit(repo, ['branch', '-D', 'juan/proposal']);

    git = new GitService(
      stubWorkspaceService({ [workspaceId]: path.dirname(repo) }),
      new WorkflowHooks(),
      testKbContext(),
    );
    return { mergeSha, targetBefore, sourceTip };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-applied-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('answers the files the request applied, with their statuses and counts', async () => {
    const { mergeSha } = await seedMerged();
    const files = await git.changedFilesAtCommit(workspaceId, mergeSha);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['Added.md', 'Knowledge/Open.md', 'base.md']);
    expect(byPath['Added.md'].status).toBe('added');
    expect(byPath['base.md'].status).toBe('modified');
    expect(byPath['base.md'].additions).toBe(1);
    // The move is reported as one file with both of its names — which is what
    // the read gate needs to judge it on the folder it LEFT as well.
    expect(byPath['Knowledge/Open.md'].status).toBe('renamed');
    expect(byPath['Knowledge/Open.md'].previousPath).toBe('Payroll/Rates.md');
  });

  // The reason the range is two-dot from the FIRST parent. A three-dot diff
  // would be read from the merge base of the two parents, so it would re-report
  // everything that landed on the target while the proposal waited.
  it('reports nothing the target did on its own while the request waited', async () => {
    const { mergeSha } = await seedMerged();
    const files = await git.changedFilesAtCommit(workspaceId, mergeSha);
    expect(files.map((f) => f.path)).not.toContain('OnTarget.md');
  });

  it('generates the patches, and skips them entirely at patchCap 0', async () => {
    const { mergeSha } = await seedMerged();
    const withPatches = await git.changedFilesAtCommit(workspaceId, mergeSha);
    expect(withPatches.find((f) => f.path === 'base.md')?.patch).toContain('+more');
    const without = await git.changedFilesAtCommit(workspaceId, mergeSha, { patchCap: 0 });
    expect(without.every((f) => f.patch === undefined)).toBe(true);
  });

  it('answers the same change as the two path views a summary needs', async () => {
    const { mergeSha } = await seedMerged();
    const { paths, pairs } = await git.changedPathsAndPairsAtCommit(workspaceId, mergeSha);
    // The flat list offers both sides of the move for an access lookup; the pairs
    // say which old name belongs to which file. The file list above and these
    // pairs must agree, or the list of requests and the detail of one would
    // disagree about what is readable.
    expect(paths.sort()).toEqual(['Added.md', 'Knowledge/Open.md', 'base.md']);
    expect(pairs).toEqual(
      expect.arrayContaining([
        { path: 'Knowledge/Open.md', previousPath: 'Payroll/Rates.md' },
        { path: 'Added.md' },
        { path: 'base.md' },
      ]),
    );
    const files = await git.changedFilesAtCommit(workspaceId, mergeSha, { patchCap: 0 });
    expect(pairs.map((p) => p.path).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("answers the merge commit's two parents as the request's base and head", async () => {
    const { mergeSha, targetBefore, sourceTip } = await seedMerged();
    expect(await git.appliedChangeShas(workspaceId, mergeSha)).toEqual({
      baseSha: targetBefore,
      headSha: sourceTip,
    });
  });

  it('answers a single-parent commit as both ends, having no second to offer', async () => {
    await seedMerged();
    // A commit made straight onto the target — a hand-made fast-forward, or a row
    // pointing at something that was never a `--no-ff` merge.
    await fs.writeFile(path.join(repo, 'Direct.md'), 'x\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'straight on']);
    const sha = await gitOut(repo, ['rev-parse', 'HEAD']);
    const parent = await gitOut(repo, ['rev-parse', 'HEAD^1']);
    expect(await git.appliedChangeShas(workspaceId, sha)).toEqual({
      baseSha: parent,
      headSha: sha,
    });
    expect((await git.changedFilesAtCommit(workspaceId, sha)).map((f) => f.path)).toEqual([
      'Direct.md',
    ]);
  });

  // Fail-closed, and this is the case it protects: a clone that has not fetched
  // the merge yet must answer no files, never somebody else's. Every caller reads
  // the rejection as "the file set could not be resolved" and leaves the request
  // to its author.
  it('refuses a commit this clone does not hold, rather than reaching for it', async () => {
    await seedMerged();
    const absent = 'f'.repeat(40);
    for (const call of [
      () => git.changedFilesAtCommit(workspaceId, absent),
      () => git.changedPathsAndPairsAtCommit(workspaceId, absent),
      () => git.appliedChangeShas(workspaceId, absent),
    ]) {
      await expect(call()).rejects.toThrow(WorkflowValidationError);
    }
  });

  it('refuses anything that is not a sha, so no ref name can be smuggled in', async () => {
    await seedMerged();
    for (const bad of ['main', 'HEAD', '', 'main; rm -rf /', '../../etc/passwd', 'abc']) {
      await expect(git.changedFilesAtCommit(workspaceId, bad)).rejects.toThrow(
        /invalid commit sha/,
      );
    }
  });

  it('refuses a root commit, which has no parent to read the change against', async () => {
    await seedMerged();
    const root = await gitOut(repo, ['rev-list', '--max-parents=0', 'HEAD']);
    await expect(git.changedFilesAtCommit(workspaceId, root)).rejects.toThrow(
      /no first parent/,
    );
  });

  it('filters roles.yaml and the folder placeholder, as the branch-pair diff does', async () => {
    await seedMerged();
    // A request that touches roles.yaml and creates an empty folder: neither is
    // content to review, and a merged request must not start listing them when an
    // open one does not.
    await runGit(repo, ['checkout', '-b', 'juan/second']);
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'Admin: [a@b.c]\n');
    await fs.mkdir(path.join(repo, 'Empty'), { recursive: true });
    await fs.writeFile(path.join(repo, 'Empty', '.gitkeep'), '');
    await fs.writeFile(path.join(repo, 'Real.md'), 'content\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'second proposal']);
    await runGit(repo, ['checkout', 'main']);
    await runGit(repo, ['merge', '--no-ff', '-m', 'apply the second', 'juan/second']);
    const sha = await gitOut(repo, ['rev-parse', 'HEAD']);

    const files = await git.changedFilesAtCommit(workspaceId, sha, { patchCap: 0 });
    expect(files.map((f) => f.path)).toEqual(['Real.md']);
    // The paths view keeps the placeholder (a folder-only request must still
    // reach the folder's owners) and drops roles.yaml, exactly as the
    // branch-pair diff does.
    const { paths, pairs } = await git.changedPathsAndPairsAtCommit(workspaceId, sha);
    expect(paths.sort()).toEqual(['Empty/.gitkeep', 'Real.md']);
    expect(pairs.map((p) => p.path)).toEqual(['Real.md']);
  });
});
