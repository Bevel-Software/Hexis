import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { GitService } from '../git.service.js';
import { WorkflowDomainError, WorkflowValidationError } from '../../../../shared/domain-errors.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * `mergeIntoBranch`: the agent's merge, over real git. A conflict is described
 * and undone in one reservation — the working tree is never left mid-merge —
 * and a second call with a resolution per path lands a merge commit with both
 * parents. Nothing is pushed by it.
 */

const TARGET = 'target-company-state';
const DRAFT = 'ada/draft';
const USER = { id: 'u1', email: 'ada@x.io', name: 'Ada Lovelace' };

/** Upstream with a target branch and a draft forked from it, and the draft's workspace clone. */
async function seed(root: string): Promise<{ upstream: string; repo: string; pusher: string }> {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', TARGET, upstream]);
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', TARGET]);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seed, 'shared.md'), 'line 1\nline 2\nline 3\n');
  await fs.writeFile(path.join(seed, 'other.md'), 'other\n');
  await runGit(seed, ['add', '.']);
  await runGit(seed, ['commit', '-m', 'init']);
  await runGit(seed, ['push', 'origin', TARGET]);
  await runGit(seed, ['checkout', '-b', DRAFT]);
  await runGit(seed, ['push', '-u', 'origin', DRAFT]);
  await runGit(upstream, ['symbolic-ref', 'HEAD', `refs/heads/${TARGET}`]);

  const workspaceDir = path.join(root, encodeURIComponent(DRAFT));
  const repo = path.join(workspaceDir, 'knowledge-base');
  await fs.mkdir(workspaceDir, { recursive: true });
  await runGit(root, ['-c', 'core.autocrlf=false', 'clone', '-b', DRAFT, upstream, repo]);
  await runGit(repo, ['config', 'user.email', 'workspace@bevel.test']);
  await runGit(repo, ['config', 'user.name', 'bevel Workspace']);
  await runGit(repo, ['config', 'core.autocrlf', 'false']);
  // A second clone, to move branches on the upstream as someone else would.
  const pusher = path.join(root, '.pusher');
  await runGit(root, ['-c', 'core.autocrlf=false', 'clone', upstream, pusher]);
  await runGit(pusher, ['config', 'user.email', 'bob@x.io']);
  await runGit(pusher, ['config', 'user.name', 'Bob']);
  await runGit(pusher, ['config', 'core.autocrlf', 'false']);
  return { upstream, repo, pusher };
}

/** Commit `files` on `branch` in the pusher clone and push. */
async function pushOn(pusher: string, branch: string, files: Record<string, string | null>, message: string): Promise<string> {
  await runGit(pusher, ['checkout', '-q', branch]);
  await runGit(pusher, ['pull', '-q', '--ff-only', 'origin', branch]).catch(() => undefined);
  for (const [p, content] of Object.entries(files)) {
    if (content === null) await fs.rm(path.join(pusher, p));
    else {
      await fs.mkdir(path.dirname(path.join(pusher, p)), { recursive: true });
      await fs.writeFile(path.join(pusher, p), content);
    }
  }
  await runGit(pusher, ['add', '-A']);
  await runGit(pusher, ['commit', '-q', '-m', message]);
  await runGit(pusher, ['push', '-q', 'origin', branch]);
  return (await gitOut(pusher, ['rev-parse', 'HEAD'])).trim();
}

/** Commit `files` in the draft's own workspace, as a save would (no push). */
async function commitLocally(repo: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [p, content] of Object.entries(files)) await fs.writeFile(path.join(repo, p), content);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-q', '-m', message]);
  return (await gitOut(repo, ['rev-parse', 'HEAD'])).trim();
}

describe('GitService.mergeIntoBranch', () => {
  let root: string;
  const workspaceId = encodeURIComponent(DRAFT);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-merge-into-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const service = () =>
    new GitService(stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }), stubWorkflowHooks(), testKbContext());

  it('merges a target that moved into the draft as a merge commit by the user, and pushes nothing', async () => {
    const { repo, pusher } = await seed(root);
    const theirs = await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n' }, 'target moves');
    const ours = await commitLocally(repo, { 'mine.md': 'mine\n' }, 'draft work');

    const outcome = await service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 'Merge target', body: 'b' });

    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    expect(outcome.resolvedPaths).toEqual([]);
    const parents = (await gitOut(repo, ['log', '-1', '--format=%P', outcome.sha])).trim().split(' ');
    expect(parents).toEqual([ours, theirs]);
    expect((await gitOut(repo, ['log', '-1', '--format=%an <%ae>', outcome.sha])).trim()).toBe('Ada Lovelace <ada@x.io>');
    expect(await fs.readFile(path.join(repo, 'other.md'), 'utf-8')).toBe('other, changed on target\n');
    // Local only: the shared draft is where it was.
    expect((await gitOut(pusher, ['ls-remote', 'origin', `refs/heads/${DRAFT}`])).trim()).not.toContain(outcome.sha);
  });

  it('answers nothing-to-merge, with the tip, when the draft already holds the target', async () => {
    const { repo } = await seed(root);
    const tip = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim();
    const outcome = await service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    expect(outcome).toEqual({ kind: 'nothing-to-merge', sha: tip, from: TARGET });
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('describes a conflict — base, both sides, the marked-up copy — and leaves the branch exactly as it was', async () => {
    const { repo, pusher } = await seed(root);
    const theirs = await pushOn(pusher, TARGET, { 'shared.md': 'line 1\nline 2 from target\nline 3\n' }, 'target edits line 2');
    const ours = await commitLocally(repo, { 'shared.md': 'line 1\nline 2 from draft\nline 3\n' }, 'draft edits line 2');
    const outcome = await service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    // The target's commit is known to the workspace only once the merge fetched it.
    const base = (await gitOut(repo, ['merge-base', ours, theirs])).trim();

    expect(outcome.kind).toBe('conflicts');
    if (outcome.kind !== 'conflicts') return;
    expect(outcome).toMatchObject({ from: TARGET, mergeBase: base, ours, theirs, unresolved: ['shared.md'] });
    expect(outcome.files).toHaveLength(1);
    const [file] = outcome.files;
    expect(file.path).toBe('shared.md');
    expect(file.base).toBe('line 1\nline 2\nline 3\n');
    expect(file.ours).toBe('line 1\nline 2 from draft\nline 3\n');
    expect(file.theirs).toBe('line 1\nline 2 from target\nline 3\n');
    expect(file.merged).toContain('<<<<<<<');
    expect(file.merged).toContain('line 2 from draft');
    expect(file.merged).toContain('line 2 from target');
    expect(file.truncated).toBeUndefined();
    // Undone: no merge in progress, the working copy is the draft's own, HEAD unmoved.
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    await expect(gitOut(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, 'shared.md'), 'utf-8')).toBe('line 1\nline 2 from draft\nline 3\n');
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(ours);
  });

  it('lands the merge once every conflicted path has a resolution: content, a side, or deletion', async () => {
    const { repo, pusher } = await seed(root);
    // Three conflicts of three kinds: an edit/edit, one the draft deleted
    // while the target edited, and one both added differently.
    const theirs = await pushOn(
      pusher,
      TARGET,
      { 'shared.md': 'line 1\nline 2 from target\nline 3\n', 'other.md': 'other, changed on target\n', 'new.md': 'new from target\n' },
      'target edits',
    );
    await fs.rm(path.join(repo, 'other.md'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'draft deletes other']);
    const ours = await commitLocally(repo, { 'shared.md': 'line 1\nline 2 from draft\nline 3\n', 'new.md': 'new from draft\n' }, 'draft edits');

    const svc = service();
    const first = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    expect(first.kind).toBe('conflicts');
    if (first.kind !== 'conflicts') return;
    expect(first.unresolved.sort()).toEqual(['new.md', 'other.md', 'shared.md']);
    const other = first.files.find((f) => f.path === 'other.md')!;
    expect(other.ours).toBeNull();
    expect(other.theirs).toBe('other, changed on target\n');

    const second = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
      subject: 'Merge target into draft',
      body: 'resolved',
      resolutions: [
        { path: 'shared.md', content: 'line 1\nline 2 from draft and target\nline 3\n' },
        { path: 'knowledge-base/other.md', choose: 'theirs' },
        { path: 'new.md', choose: 'delete' },
      ],
    });
    expect(second.kind).toBe('merged');
    if (second.kind !== 'merged') return;
    expect(second.resolvedPaths.sort()).toEqual(['new.md', 'other.md', 'shared.md']);
    const parents = (await gitOut(repo, ['log', '-1', '--format=%P', second.sha])).trim().split(' ');
    expect(parents).toEqual([ours, theirs]);
    expect(await fs.readFile(path.join(repo, 'shared.md'), 'utf-8')).toBe('line 1\nline 2 from draft and target\nline 3\n');
    expect(await fs.readFile(path.join(repo, 'other.md'), 'utf-8')).toBe('other, changed on target\n');
    await expect(fs.access(path.join(repo, 'new.md'))).rejects.toThrow();
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    expect((await gitOut(repo, ['show', `${second.sha}:other.md`])).trim()).toBe('other, changed on target');
    await expect(gitOut(repo, ['show', `${second.sha}:new.md`])).rejects.toThrow();
  });

  it('refuses a resolution for a path that is not conflicted, before anything is written', async () => {
    const { repo, pusher } = await seed(root);
    await pushOn(pusher, TARGET, { 'shared.md': 'line 1\nline 2 from target\nline 3\n' }, 'target edits');
    await commitLocally(repo, { 'shared.md': 'line 1\nline 2 from draft\nline 3\n' }, 'draft edits');
    const head = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim();

    await expect(
      service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
        subject: 's',
        body: 'b',
        resolutions: [
          { path: 'shared.md', content: 'resolved\n' },
          { path: 'other.md', content: 'an ordinary edit smuggled in\n' },
        ],
      }),
    ).rejects.toThrow(/not conflicted.*other\.md/);
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    expect(await fs.readFile(path.join(repo, 'other.md'), 'utf-8')).toBe('other\n');
  });

  it('refuses a resolution that says both content and a side, or neither, before touching git', async () => {
    await seed(root);
    const svc = service();
    await expect(
      svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b', resolutions: [{ path: 'a.md' }] }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    await expect(
      svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
        subject: 's',
        body: 'b',
        resolutions: [{ path: 'a.md', content: 'x', choose: 'ours' }],
      }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('refuses while the working tree holds edits not committed yet', async () => {
    const { repo } = await seed(root);
    await fs.writeFile(path.join(repo, 'shared.md'), 'unsaved edit\n');
    const err = await service()
      .mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowDomainError);
    expect((err as WorkflowDomainError).status).toBe(409);
    expect((err as WorkflowDomainError).payload).toMatchObject({ kind: 'branch-busy' });
    expect(await fs.readFile(path.join(repo, 'shared.md'), 'utf-8')).toBe('unsaved edit\n');
  });

  it('brings the branch\'s own shared state in when it moved while the workspace held commits (from = branch)', async () => {
    const { repo, pusher } = await seed(root);
    const theirs = await pushOn(pusher, DRAFT, { 'other.md': 'pushed from elsewhere\n' }, 'draft moves on origin');
    const ours = await commitLocally(repo, { 'mine.md': 'mine\n' }, 'local save');

    const outcome = await service().mergeIntoBranch(workspaceId, DRAFT, DRAFT, USER, { subject: 'Merge shared', body: 'b' });

    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    const parents = (await gitOut(repo, ['log', '-1', '--format=%P', outcome.sha])).trim().split(' ');
    expect(parents).toEqual([ours, theirs]);
    expect(await fs.readFile(path.join(repo, 'other.md'), 'utf-8')).toBe('pushed from elsewhere\n');
    expect(await fs.readFile(path.join(repo, 'mine.md'), 'utf-8')).toBe('mine\n');
  });
});

describe('GitService.readFileAtBranch', () => {
  let root: string;
  const workspaceId = encodeURIComponent(DRAFT);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-read-at-branch-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reads the file at the other branch\'s published tip, null when absent, and refuses a folder', async () => {
    const { repo, pusher } = await seed(root);
    const theirs = await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n', 'docs/a.md': 'a\n' }, 'target edits');
    await runGit(repo, ['fetch', '-q', 'origin']);
    const svc = new GitService(stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }), stubWorkflowHooks(), testKbContext());

    expect(await svc.readFileAtBranch(workspaceId, 'knowledge-base/other.md', TARGET)).toEqual({
      sha: theirs,
      ref: `refs/remotes/origin/${TARGET}`,
      content: 'other, changed on target\n',
    });
    expect((await svc.readFileAtBranch(workspaceId, 'missing.md', TARGET)).content).toBeNull();
    await expect(svc.readFileAtBranch(workspaceId, 'docs', TARGET)).rejects.toThrow(/directory/);
    await expect(svc.readFileAtBranch(workspaceId, 'other.md', 'no/such/branch')).rejects.toThrow(/unknown branch/);
  });
});
