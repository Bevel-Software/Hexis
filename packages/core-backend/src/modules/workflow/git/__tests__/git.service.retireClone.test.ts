import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { runGit, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * `retireClone` is the one place a clone is removed for being idle, and the
 * guards are the whole point: a clone goes only when NOTHING in it is
 * unpublished. Each case here plants one kind of unpublished work and checks
 * that the removal is refused with the guard's name — and that the caller's
 * `remove` is never reached, since that is the call that would lose the work.
 */

const BRANCH = 'ali/draft';
const WORKSPACE_ID = 'ali%2Fdraft';

async function seedWorkspace(root: string): Promise<{ upstream: string; repo: string }> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', BRANCH, upstream]);

  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', BRANCH]);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seed, 'note.md'), 'published\n');
  await runGit(seed, ['add', '.']);
  await runGit(seed, ['commit', '-m', 'init']);
  await runGit(seed, ['push', 'origin', BRANCH]);
  await runGit(upstream, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);

  const workspaceDir = path.join(root, WORKSPACE_ID);
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['clone', '-b', BRANCH, upstream, repo]);
  await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
  await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
  return { upstream, repo };
}

describe('GitService.retireClone', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-retire-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  function service(): GitService {
    return new GitService(
      stubWorkspaceService({ [WORKSPACE_ID]: path.join(root, WORKSPACE_ID) }),
      stubWorkflowHooks(),
      'knowledge-base',
    );
  }

  it('removes a clone that is clean, pushed and unqueued', async () => {
    await seedWorkspace(root);
    const remove = vi.fn(async () => undefined);

    const verdict = await service().retireClone(WORKSPACE_ID, { queued: async () => false, remove });
    expect(verdict).toBe('retired');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('refuses a clone with a file saved but not yet committed', async () => {
    const { repo } = await seedWorkspace(root);
    await fs.writeFile(path.join(repo, 'note.md'), 'edited, not committed\n');
    const remove = vi.fn(async () => undefined);

    expect(await service().retireClone(WORKSPACE_ID, { queued: async () => false, remove })).toBe('dirty');
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses a clone with a commit its remote does not have', async () => {
    const { repo } = await seedWorkspace(root);
    await fs.writeFile(path.join(repo, 'note.md'), 'committed, not pushed\n');
    await runGit(repo, ['commit', '-am', 'local only']);
    const remove = vi.fn(async () => undefined);

    expect(await service().retireClone(WORKSPACE_ID, { queued: async () => false, remove })).toBe('unpushed');
    expect(remove).not.toHaveBeenCalled();
  });

  it('refuses a clone the commit queue still has rows for', async () => {
    await seedWorkspace(root);
    const remove = vi.fn(async () => undefined);

    expect(await service().retireClone(WORKSPACE_ID, { queued: async () => true, remove })).toBe('queued');
    expect(remove).not.toHaveBeenCalled();
  });

  it('holds the clone for the whole decision, the queue question included', async () => {
    await seedWorkspace(root);
    const svc = service();
    // The queue's answer is a promise made up front, so releasing it works
    // whether or not the git checks before it have finished by then — under a
    // loaded machine they take longer than this test waits.
    let answerQueue!: (queued: boolean) => void;
    const queueAnswer = new Promise<boolean>((resolve) => {
      answerQueue = resolve;
    });
    const queued = () => queueAnswer;
    const remove = vi.fn(async () => undefined);

    // While the retire call waits on the queue's answer, any other operation
    // on this clone — here the worker's own publication check — must queue
    // behind it rather than run alongside, or a commit could land between the
    // checks and the removal.
    const retiring = svc.retireClone(WORKSPACE_ID, { queued, remove });
    let otherRan = false;
    const other = svc.hasUnpushedCommits(WORKSPACE_ID).then(() => {
      otherRan = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(otherRan).toBe(false);

    answerQueue(false);
    expect(await retiring).toBe('retired');
    await other;
    expect(otherRan).toBe(true);
  });
});
