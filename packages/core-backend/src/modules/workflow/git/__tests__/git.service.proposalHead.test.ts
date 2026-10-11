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
 * The files an applied change request proposed when its apply made no merge
 * commit of its own (hx-finished-request-says-so): request #8 carried the
 * same change as #7, #7 landed first, so applying #8 staged nothing and wrote
 * no commit. Nothing on the target names #8's files; the source head its
 * merge-log row recorded still does.
 */
describe('GitService.changedFilesOfProposalHead', () => {
  const workspaceId = 'ws-proposal-head';
  let root: string;
  let repo: string;
  let git: GitService;

  async function seed(): Promise<{ headOf8: string; headOf7: string }> {
    repo = path.join(root, workspaceId, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(path.dirname(repo), ['init', '-b', 'main', 'knowledge-base']);
    await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
    await runGit(repo, ['config', 'user.name', 'Test Runner']);
    await fs.writeFile(path.join(repo, 'Pricing.md'), 'basic\n');
    await fs.writeFile(path.join(repo, 'Other.md'), 'other\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'init']);

    // #7 and #8: the same edit, on two branches, as two different commits.
    for (const branch of ['robin/seven', 'robin/eight']) {
      await runGit(repo, ['checkout', '-b', branch, 'main']);
      await fs.writeFile(path.join(repo, 'Pricing.md'), 'premium\n');
      await runGit(repo, ['add', '-A']);
      await runGit(repo, ['commit', '-m', `edit on ${branch}`]);
    }
    const headOf7 = await gitOut(repo, ['rev-parse', 'robin/seven']);
    const headOf8 = await gitOut(repo, ['rev-parse', 'robin/eight']);

    // #7 lands with a merge commit of its own; the target moves on in an
    // unrelated file afterwards.
    await runGit(repo, ['checkout', 'main']);
    await runGit(repo, ['merge', '--no-ff', '-m', mergeCommitSubject('Raise the price', 7), 'robin/seven']);
    await fs.writeFile(path.join(repo, 'Other.md'), 'changed later\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'unrelated work on the target']);
    // Both branches retire with their requests.
    await runGit(repo, ['branch', '-D', 'robin/seven', 'robin/eight']);

    git = new GitService(
      stubWorkspaceService({ [workspaceId]: path.dirname(repo) }),
      new WorkflowHooks(),
      testKbContext(),
    );
    return { headOf8, headOf7 };
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-proposal-head-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('answers the files the request proposed, though the target already holds them', async () => {
    const { headOf8 } = await seed();
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf8);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['Pricing.md', 'modified', 1, 1],
    ]);
  });

  it("reports nothing the target did on its own, and none of another request's work", async () => {
    const { headOf8 } = await seed();
    const files = await git.changedFilesOfProposalHead(workspaceId, 'main', headOf8);
    expect(files.map((f) => f.path)).not.toContain('Other.md');
  });

  it('answers nothing for a head that is already part of the target', async () => {
    const { headOf7 } = await seed();
    expect(await git.changedFilesOfProposalHead(workspaceId, 'main', headOf7)).toEqual([]);
  });

  it('refuses a head this clone does not hold, rather than reaching for it', async () => {
    await seed();
    await expect(
      git.changedFilesOfProposalHead(workspaceId, 'main', 'e'.repeat(40)),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('refuses anything that is not a sha', async () => {
    await seed();
    await expect(git.changedFilesOfProposalHead(workspaceId, 'main', 'main')).rejects.toBeInstanceOf(
      WorkflowValidationError,
    );
  });
});
