import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { GitService } from '../git.service.js';
import { NodeGitRunner } from '../node-git-runner.js';
import type { IGitRunner } from '../../../../shared/git.contract.js';
import { PullRebaseConflictError, WorkflowDomainError, WorkflowValidationError } from '../../../../shared/domain-errors.js';
import { runGit, gitOut, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * `mergeIntoBranch`: the agent's merge, over real git. A conflict is described
 * and undone in one reservation — the working tree is never left mid-merge —
 * and a second call with a resolution per path lands a merge commit with both
 * parents. Pushed only when `publish` is asked for.
 */

const TARGET = 'target-company-state';
const DRAFT = 'ada/draft';
const USER = { id: 'u1', email: 'ada@x.io', name: 'Ada Lovelace' };
/** The authorizer a resolution needs; here every resolution is the caller's to make. */
const allow = async (): Promise<void> => {};

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
      authorizeResolutions: allow,
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
        authorizeResolutions: allow,
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
      svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b', resolutions: [{ path: 'a.md' }], authorizeResolutions: allow }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    await expect(
      svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
        subject: 's',
        body: 'b',
        resolutions: [{ path: 'a.md', content: 'x', choose: 'ours' }],
        authorizeResolutions: allow,
      }),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('refuses resolutions that nobody authorizes, before touching git', async () => {
    const { repo } = await seed(root);
    const head = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim();
    await expect(
      service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
        subject: 's',
        body: 'b',
        resolutions: [{ path: 'shared.md', content: 'x\n' }],
      } as never),
    ).rejects.toThrow(/authorizeResolutions/);
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
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

  it('refuses resolutions when nothing conflicts, so none is dropped behind a clean merge', async () => {
    const { repo, pusher } = await seed(root);
    await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n' }, 'target moves');
    const head = await commitLocally(repo, { 'mine.md': 'mine\n' }, 'draft work');
    await expect(
      service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
        subject: 's',
        body: 'b',
        resolutions: [{ path: 'other.md', content: 'smuggled\n' }],
        authorizeResolutions: allow,
      }),
    ).rejects.toThrow(/nothing conflicted/);
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    await expect(gitOut(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toThrow();
  });

  it('undoes the merge when the commit itself fails, and reports the failure', async () => {
    const { repo, pusher } = await seed(root);
    await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n' }, 'target moves');
    const head = await commitLocally(repo, { 'mine.md': 'mine\n' }, 'draft work');
    // A hook that refuses every commit: the merge is staged, the commit fails.
    const hooks = path.join(repo, '.git', 'hooks');
    await fs.mkdir(hooks, { recursive: true });
    await fs.writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' })).rejects.toThrow();
    await expect(gitOut(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toThrow();
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await fs.readFile(path.join(repo, 'other.md'), 'utf-8')).toBe('other\n');
  });

  it('leaves a binary or oversized side out, named per side, and keeps a chosen side byte for byte', async () => {
    const { repo, pusher } = await seed(root);
    const png = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, seed, 0xff, 0, 1]);
    const big = 'x'.repeat(250_000) + '\n';
    await fs.writeFile(path.join(repo, 'img.png'), png(1));
    await fs.writeFile(path.join(repo, 'big.md'), 'small\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'binary and big']);
    await runGit(repo, ['push', '-q', 'origin', DRAFT]);
    await runGit(pusher, ['fetch', '-q', 'origin']);
    await runGit(pusher, ['checkout', '-q', TARGET]);
    await runGit(pusher, ['merge', '-q', `origin/${DRAFT}`]);
    await fs.writeFile(path.join(pusher, 'img.png'), png(2));
    await fs.writeFile(path.join(pusher, 'big.md'), big);
    await runGit(pusher, ['add', '-A']);
    await runGit(pusher, ['commit', '-q', '-m', 'target changes both']);
    await runGit(pusher, ['push', '-q', 'origin', TARGET]);
    await fs.writeFile(path.join(repo, 'img.png'), png(3));
    await fs.writeFile(path.join(repo, 'big.md'), 'draft small\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'draft changes both']);

    const svc = service();
    const first = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    expect(first.kind).toBe('conflicts');
    if (first.kind !== 'conflicts') return;
    const img = first.files.find((f) => f.path === 'img.png')!;
    expect(img.truncated?.sort()).toEqual(['base', 'merged', 'ours', 'theirs']);
    expect([img.base, img.ours, img.theirs, img.merged]).toEqual([null, null, null, null]);
    const bigFile = first.files.find((f) => f.path === 'big.md')!;
    expect(bigFile.truncated).toEqual(['theirs', 'merged']);
    expect(bigFile.ours).toBe('draft small\n');
    expect(bigFile.base).toBe('small\n');

    const second = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
      subject: 's',
      body: 'b',
      resolutions: [
        { path: 'img.png', choose: 'ours' },
        { path: 'big.md', choose: 'theirs' },
      ],
      authorizeResolutions: allow,
    });
    expect(second.kind).toBe('merged');
    expect(Buffer.compare(await fs.readFile(path.join(repo, 'img.png')), png(3))).toBe(0);
    expect(await fs.readFile(path.join(repo, 'big.md'), 'utf-8')).toBe(big);
  });

  it('leaves a side that is not well-formed UTF-8 out, NUL or no NUL, so it is never written back changed', async () => {
    const { repo, pusher } = await seed(root);
    // Latin-1 bytes: no NUL anywhere, not UTF-8 either.
    const latin1 = (s: string) => Buffer.from(s, 'latin1');
    await fs.writeFile(path.join(repo, 'legacy.txt'), latin1('caf\xe9 base\n'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'legacy encoding']);
    await runGit(repo, ['push', '-q', 'origin', DRAFT]);
    await runGit(pusher, ['fetch', '-q', 'origin']);
    await runGit(pusher, ['checkout', '-q', TARGET]);
    await runGit(pusher, ['merge', '-q', `origin/${DRAFT}`]);
    await fs.writeFile(path.join(pusher, 'legacy.txt'), latin1('caf\xe9 target\n'));
    await runGit(pusher, ['add', '-A']);
    await runGit(pusher, ['commit', '-q', '-m', 'target edits legacy']);
    await runGit(pusher, ['push', '-q', 'origin', TARGET]);
    await fs.writeFile(path.join(repo, 'legacy.txt'), latin1('caf\xe9 draft\n'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'draft edits legacy']);

    const outcome = await service().mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    expect(outcome.kind).toBe('conflicts');
    if (outcome.kind !== 'conflicts') return;
    const legacy = outcome.files.find((f) => f.path === 'legacy.txt')!;
    expect(legacy.truncated?.sort()).toEqual(['base', 'merged', 'ours', 'theirs']);
    expect([legacy.base, legacy.ours, legacy.theirs, legacy.merged]).toEqual([null, null, null, null]);
  });

  it('lets the merged-in side be read at its branch while the merge is unresolved, though its tip is not on the draft\'s history', async () => {
    const { repo, pusher } = await seed(root);
    const theirs = await pushOn(pusher, TARGET, { 'shared.md': 'line 1\nline 2 from target\nline 3\n' }, 'target edits line 2');
    await commitLocally(repo, { 'shared.md': 'line 1\nline 2 from draft\nline 3\n' }, 'draft edits line 2');
    const svc = service();
    const outcome = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    expect(outcome.kind).toBe('conflicts');
    // The target's tip is not an ancestor of the draft: a commit read would
    // refuse it, a branch read serves it.
    await expect(gitOut(repo, ['merge-base', '--is-ancestor', theirs, 'HEAD'])).rejects.toThrow();
    expect(await svc.readFileAtBranch(workspaceId, 'shared.md', TARGET)).toEqual({
      sha: theirs,
      ref: `refs/remotes/origin/${TARGET}`,
      content: 'line 1\nline 2 from target\nline 3\n',
    });
  });

  it('asks the resolution authorizer inside the reservation with the commits fetched, before the merge touches the checkout', async () => {
    const { repo, pusher } = await seed(root);
    const theirs = await pushOn(pusher, TARGET, { 'shared.md': 'line 1\nline 2 from target\nline 3\n' }, 'target edits line 2');
    const ours = await commitLocally(repo, { 'shared.md': 'line 1\nline 2 from draft\nline 3\n' }, 'draft edits line 2');
    const asked: Array<{ merge: unknown; head: string; mergeHead: boolean; sharedOnDisk: string }> = [];
    const svc = service();
    const err = await svc
      .mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
        subject: 's',
        body: 'b',
        resolutions: [{ path: 'shared.md', content: 'resolved\n' }],
        authorizeResolutions: async (merge) => {
          // What the checkout holds while the question is asked: the draft's
          // own commit, clean, nothing of the merge on disk yet — so a rule
          // read from it is the draft's, not a conflict-marked one.
          asked.push({
            merge,
            head: (await gitOut(repo, ['rev-parse', 'HEAD'])).trim(),
            mergeHead: await gitOut(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).then(() => true, () => false),
            sharedOnDisk: await fs.readFile(path.join(repo, 'shared.md'), 'utf-8'),
          });
          throw new WorkflowDomainError('not yours to settle', 403);
        },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowDomainError);
    // Asked with the target's tip as fetched by this very merge.
    expect(asked).toEqual([{ merge: { ours, theirs }, head: ours, mergeHead: false, sharedOnDisk: 'line 1\nline 2 from draft\nline 3\n' }]);
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(ours);
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    await expect(gitOut(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, 'shared.md'), 'utf-8')).toBe('line 1\nline 2 from draft\nline 3\n');
  });

  it('counts a merge as published when the push landed and only the tracking stamp after it failed', async () => {
    const { repo, pusher } = await seed(root);
    await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n' }, 'target moves');
    await commitLocally(repo, { 'mine.md': 'mine\n' }, 'draft work');
    const inner = new NodeGitRunner();
    const gitRunner = {
      defaultTimeoutMs: inner.defaultTimeoutMs,
      credentials: inner.credentials,
      run: async (cwd: string, args: string[], opts?: object) => {
        // The stamp `pushUnlocked` writes right after a push that landed.
        if (args[0] === 'config' && args.includes(`branch.${DRAFT}.remote`)) throw new Error('could not lock config file');
        return inner.run(cwd, args, opts as never);
      },
    } as unknown as IGitRunner;
    const svc = new GitService(
      stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }),
      stubWorkflowHooks(),
      testKbContext(),
      undefined,
      null,
      gitRunner,
    );
    const outcome = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b', publish: true });
    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    expect((await gitOut(pusher, ['ls-remote', 'origin', `refs/heads/${DRAFT}`])).trim()).toContain(outcome.sha);
  });

  // Symbolic links need a privilege on Windows that a test runner does not have.
  it.skipIf(process.platform === 'win32')('never follows a link out of the checkout, reading or writing a conflicted path', async () => {
    const { repo, pusher } = await seed(root);
    for (const dir of [repo, pusher]) await runGit(dir, ['config', 'core.symlinks', 'true']);
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'outside the checkout\n');
    // Both sides turn `shared.md` into a link — the draft's pointing outside
    // the checkout, the target's at a sibling — so git sees one conflicted
    // path of one type (two links with different targets are not merged;
    // the draft's own link is what the checkout holds while it is open).
    await fs.rm(path.join(repo, 'shared.md'));
    await fs.symlink(outside, path.join(repo, 'shared.md'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-q', '-m', 'draft links shared.md outside']);
    await runGit(pusher, ['checkout', '-q', TARGET]);
    await fs.rm(path.join(pusher, 'shared.md'));
    await fs.symlink('other.md', path.join(pusher, 'shared.md'));
    await runGit(pusher, ['add', '-A']);
    await runGit(pusher, ['commit', '-q', '-m', 'target links shared.md at other.md']);
    await runGit(pusher, ['push', '-q', 'origin', TARGET]);

    const svc = service();
    const first = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b' });
    expect(first.kind).toBe('conflicts');
    if (first.kind !== 'conflicts') return;
    expect(first.unresolved).toEqual(['shared.md']);
    const file = first.files.find((f) => f.path === 'shared.md')!;
    // The link is never followed: the working copy is left out, and each
    // side is the link's own target text as git stores it, not the file
    // outside.
    expect(file.truncated).toContain('merged');
    expect(file.merged).toBeNull();
    // (Git stores the target with forward slashes whatever the host's separator.)
    expect(file.ours?.replaceAll('\\', '/')).toBe(outside.replaceAll('\\', '/'));
    expect(file.theirs).toBe('other.md');
    expect(file.base).toBe('line 1\nline 2\nline 3\n');
    expect(await fs.readFile(outside, 'utf-8')).toBe('outside the checkout\n');
    expect((await fs.lstat(path.join(repo, 'shared.md'))).isSymbolicLink()).toBe(true);

    const second = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, {
      subject: 's',
      body: 'b',
      resolutions: [{ path: 'shared.md', content: 'resolved as a file\n' }],
      authorizeResolutions: allow,
    });
    expect(second.kind).toBe('merged');
    // Written as a path inside the checkout; the file outside is untouched.
    expect((await fs.lstat(path.join(repo, 'shared.md'))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(repo, 'shared.md'), 'utf-8')).toBe('resolved as a file\n');
    expect(await fs.readFile(outside, 'utf-8')).toBe('outside the checkout\n');
  });

  it('publishes the merge inside the same reservation, and after a rejected push replays it onto the moved branch', async () => {
    const { repo, pusher } = await seed(root);
    await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n' }, 'target moves');
    await commitLocally(repo, { 'mine.md': 'mine\n' }, 'draft work');
    const svc = service();

    const published = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b', publish: true });
    expect(published.kind).toBe('merged');
    if (published.kind !== 'merged') return;
    expect((await gitOut(pusher, ['ls-remote', 'origin', `refs/heads/${DRAFT}`])).trim()).toContain(published.sha);

    // The draft moves on the host while this workspace holds its next merge.
    const moved = await pushOn(pusher, DRAFT, { 'elsewhere.md': 'pushed elsewhere\n' }, 'draft moves on origin');
    await pushOn(pusher, TARGET, { 'other.md': 'other, changed again\n' }, 'target moves again');
    const again = await svc.mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 'again', body: 'b', publish: true });
    expect(again.kind).toBe('merged');
    if (again.kind !== 'merged') return;
    // Published, on top of the moved branch, still a merge.
    expect((await gitOut(pusher, ['ls-remote', 'origin', `refs/heads/${DRAFT}`])).trim()).toContain(again.sha);
    expect((await gitOut(repo, ['rev-parse', 'HEAD'])).trim()).toBe(again.sha);
    await gitOut(repo, ['merge-base', '--is-ancestor', moved, again.sha]);
    expect((await gitOut(repo, ['log', '-1', '--format=%P', again.sha])).trim().split(' ')).toHaveLength(2);
    expect(await fs.readFile(path.join(repo, 'elsewhere.md'), 'utf-8')).toBe('pushed elsewhere\n');
    expect(await fs.readFile(path.join(repo, 'other.md'), 'utf-8')).toBe('other, changed again\n');
  });

  it('throws the typed pull-conflict error when the replay after a rejected push conflicts, the merge kept and the checkout clean', async () => {
    const { repo, pusher } = await seed(root);
    await pushOn(pusher, TARGET, { 'other.md': 'other, changed on target\n' }, 'target moves');
    // The draft moves on the host with a change the merge will clash with.
    await pushOn(pusher, DRAFT, { 'other.md': 'other, changed on the draft elsewhere\n' }, 'draft moves on origin');
    await commitLocally(repo, { 'mine.md': 'mine\n' }, 'draft work');

    const err = await service()
      .mergeIntoBranch(workspaceId, DRAFT, TARGET, USER, { subject: 's', body: 'b', publish: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullRebaseConflictError);
    expect((err as PullRebaseConflictError).conflictedPaths).toEqual(['other.md']);
    // The merge commit is on the branch locally, nothing is published, and
    // no rebase is in progress: the replay undid itself.
    const head = (await gitOut(repo, ['rev-parse', 'HEAD'])).trim();
    expect((await gitOut(repo, ['log', '-1', '--format=%P', head])).trim().split(' ')).toHaveLength(2);
    expect((await gitOut(pusher, ['ls-remote', 'origin', `refs/heads/${DRAFT}`])).trim()).not.toContain(head);
    expect((await gitOut(repo, ['status', '--porcelain'])).trim()).toBe('');
    await expect(gitOut(repo, ['rev-parse', '-q', '--verify', 'REBASE_HEAD'])).rejects.toThrow();
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

  it('reads the PUBLISHED tip, not a local head that has moved past it', async () => {
    const { repo } = await seed(root);
    const svc = new GitService(stubWorkspaceService({ [workspaceId]: path.join(root, workspaceId) }), stubWorkflowHooks(), testKbContext());
    const published = (await gitOut(repo, ['rev-parse', `origin/${DRAFT}`])).trim();
    await commitLocally(repo, { 'other.md': 'not shared yet\n' }, 'local only');
    const read = await svc.readFileAtBranch(workspaceId, 'other.md', DRAFT);
    expect(read).toEqual({ sha: published, ref: `refs/remotes/origin/${DRAFT}`, content: 'other\n' });
  });
});
