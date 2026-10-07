import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { WorkflowValidationError } from '../../../../shared/domain-errors.js';
import { mergeCommitSubject } from '../merge-commit.js';
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
  /** The change request the fixture's merge commit belongs to. */
  const CR = 42;
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

    // The subject `mergePr` writes — the reader verifies it, so the fixture must
    // produce it the same way rather than spelling it out.
    await runGit(repo, [
      'merge', '--no-ff', '-m', mergeCommitSubject('Rework the onboarding note', CR), 'juan/proposal',
    ]);
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

  /** The row's pointer at its merge commit: the sha AND the number that proves it. */
  const ref = (mergeSha: string, number = CR) => ({ number, mergeSha });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-applied-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('answers the files the request applied, with their statuses and counts', async () => {
    const { mergeSha } = await seedMerged();
    const files = await git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha));
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
    const files = await git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha));
    expect(files.map((f) => f.path)).not.toContain('OnTarget.md');
  });

  it('generates the patches, and skips them entirely at patchCap 0', async () => {
    const { mergeSha } = await seedMerged();
    const withPatches = await git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha));
    expect(withPatches.find((f) => f.path === 'base.md')?.patch).toContain('+more');
    const without = await git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha), { patchCap: 0 });
    expect(without.every((f) => f.patch === undefined)).toBe(true);
  });

  it('answers the same change as the two path views a summary needs', async () => {
    const { mergeSha } = await seedMerged();
    const { paths, pairs } = await git.changedPathsAndPairsOfAppliedChange(workspaceId, ref(mergeSha));
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
    const files = await git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha), { patchCap: 0 });
    expect(pairs.map((p) => p.path).sort()).toEqual(files.map((f) => f.path).sort());
  });

  it("answers the merge commit's two parents as the request's base and head", async () => {
    const { mergeSha, targetBefore, sourceTip } = await seedMerged();
    expect(await git.appliedChangeShas(workspaceId, ref(mergeSha))).toEqual({
      baseSha: targetBefore,
      headSha: sourceTip,
    });
  });

  // cubic P1 on #347, and the case that makes the whole verification necessary.
  // When the target already contains the source there is nothing to merge, so the
  // merge writes NO commit and reports the target tip. A row that recorded that
  // tip points at an ordinary commit — whatever landed on the target last — and
  // reading its own change would answer with THAT change's files under this
  // request's number. Refused, so the request falls back to author-only.
  it('refuses a commit with no second parent, which no merge of this request wrote', async () => {
    await seedMerged();
    await fs.writeFile(path.join(repo, 'SomebodyElse.md'), 'unrelated work\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'unrelated work on the target']);
    const tip = await gitOut(repo, ['rev-parse', 'HEAD']);
    for (const call of [
      () => git.appliedChangeShas(workspaceId, ref(tip)),
      () => git.changedFilesOfAppliedChange(workspaceId, ref(tip)),
      () => git.changedPathsAndPairsOfAppliedChange(workspaceId, ref(tip)),
    ]) {
      await expect(call()).rejects.toThrow(/is not a merge commit/);
    }
  });

  it('tells a commit the clone does not hold apart from one that is not a merge: the first may arrive, the second never will', async () => {
    await seedMerged();
    const unknown = 'f'.repeat(40);
    await expect(git.appliedChangeShas(workspaceId, ref(unknown))).rejects.toThrow(/is not in this clone/);
    await expect(git.appliedChangeShas(workspaceId, ref(unknown))).rejects.not.toThrow(/is not a merge commit/);
  });

  // The residual of the same P1, and the reason the NUMBER travels with the sha.
  // An empty request merged while the target tip was ANOTHER request's merge
  // commit recorded a sha that is a merge commit — just not this request's. Two
  // parents alone would accept it and publish the other request's files.
  it('refuses a merge commit whose subject names a different request', async () => {
    const { mergeSha } = await seedMerged();
    for (const call of [
      () => git.appliedChangeShas(workspaceId, ref(mergeSha, CR + 1)),
      () => git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha, CR + 1)),
      () => git.changedPathsAndPairsOfAppliedChange(workspaceId, ref(mergeSha, CR + 1)),
    ]) {
      await expect(call()).rejects.toThrow(/is not the merge commit of change request #43/);
    }
    // The same commit under its OWN number still reads, so what guards is the
    // number and not a blanket refusal.
    expect(
      (await git.changedFilesOfAppliedChange(workspaceId, ref(mergeSha), { patchCap: 0 })).length,
    ).toBe(3);
  });

  // The number is matched at the END of the subject, where `mergeCommitSubject`
  // puts it, so a title that happens to contain another request's number is not
  // mistaken for that request's merge commit.
  it('matches the number at the end, not anywhere in the title', async () => {
    await seedMerged();
    await runGit(repo, ['checkout', '-b', 'juan/third']);
    await fs.writeFile(path.join(repo, 'Third.md'), 'x\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'third']);
    await runGit(repo, ['checkout', 'main']);
    await runGit(repo, [
      'merge', '--no-ff', '-m', mergeCommitSubject('Follow-up to (#99)', 7), 'juan/third',
    ]);
    const sha = await gitOut(repo, ['rev-parse', 'HEAD']);
    await expect(git.appliedChangeShas(workspaceId, ref(sha, 99))).rejects.toThrow(
      /is not the merge commit of change request #99/,
    );
    expect(await git.appliedChangeShas(workspaceId, ref(sha, 7))).toMatchObject({
      baseSha: expect.any(String),
    });
  });

  // Fail-closed, and this is the case it protects: a clone that has not fetched
  // the merge yet must answer no files, never somebody else's. Every caller reads
  // the rejection as "the file set could not be resolved" and leaves the request
  // to its author.
  it('refuses a commit this clone does not hold, rather than reaching for it', async () => {
    await seedMerged();
    const absent = 'f'.repeat(40);
    for (const call of [
      () => git.changedFilesOfAppliedChange(workspaceId, ref(absent)),
      () => git.changedPathsAndPairsOfAppliedChange(workspaceId, ref(absent)),
      () => git.appliedChangeShas(workspaceId, ref(absent)),
    ]) {
      await expect(call()).rejects.toThrow(WorkflowValidationError);
    }
  });

  it('refuses anything that is not a sha, so no ref name can be smuggled in', async () => {
    await seedMerged();
    for (const bad of ['main', 'HEAD', '', 'main; rm -rf /', '../../etc/passwd', 'abc']) {
      await expect(
        git.changedFilesOfAppliedChange(workspaceId, ref(bad)),
      ).rejects.toThrow(/invalid commit sha/);
    }
  });

  it('refuses a root commit, which has no parent to read the change against', async () => {
    await seedMerged();
    const rootCommit = await gitOut(repo, ['rev-list', '--max-parents=0', 'HEAD']);
    await expect(
      git.changedFilesOfAppliedChange(workspaceId, ref(rootCommit)),
    ).rejects.toThrow(/is not a merge commit/);
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
    await runGit(repo, [
      'merge', '--no-ff', '-m', mergeCommitSubject('The second proposal', 43), 'juan/second',
    ]);
    const sha = await gitOut(repo, ['rev-parse', 'HEAD']);

    const files = await git.changedFilesOfAppliedChange(workspaceId, ref(sha, 43), { patchCap: 0 });
    expect(files.map((f) => f.path)).toEqual(['Real.md']);
    // The paths view keeps the placeholder (a folder-only request must still
    // reach the folder's owners) and drops roles.yaml, exactly as the
    // branch-pair diff does.
    const { paths, pairs } = await git.changedPathsAndPairsOfAppliedChange(workspaceId, ref(sha, 43));
    expect(paths.sort()).toEqual(['Empty/.gitkeep', 'Real.md']);
    expect(pairs.map((p) => p.path)).toEqual(['Real.md']);
  });
});
