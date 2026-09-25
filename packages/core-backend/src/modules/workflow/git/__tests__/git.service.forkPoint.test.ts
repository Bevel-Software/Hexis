import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GitService } from '../git.service.js';
import { gitOut, runGit, stubWorkflowHooks, stubWorkspaceService } from './git-test-helpers.js';

/**
 * A change request shows only what its author changed. When someone edits the
 * target AFTER the proposal was made, that edit must not appear in the request
 * as a deletion — the request is read against its fork point, not the target
 * tip — and the request must say it needs updating. Update merges the target
 * in; a conflicting Update leaves the proposal branch exactly as it was.
 */

const TARGET = 'current-company-state';
const SOURCE = 'alice/deal';
const WS = 'alice-deal';
const DEAL = 'Sales/Deal.md';
const ORIGINAL = 'price: 100\nterm: 12 months\nregion: EU\nowner: Bob\nstatus: draft\n';
const USER = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

describe('GitService — fork point, behind, and Update', () => {
  let root: string;
  let repo: string; // the proposal branch's workspace clone
  let other: string; // another user's clone, editing the target directly
  let git: GitService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-fork-point-'));
    const upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', TARGET, upstream]);

    other = path.join(root, 'other');
    await runGit(root, ['clone', upstream, other]);
    await runGit(other, ['checkout', '-b', TARGET]);
    await fs.mkdir(path.join(other, 'Sales'));
    await fs.writeFile(path.join(other, DEAL), ORIGINAL);
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'init']);
    await runGit(other, ['push', '-u', 'origin', TARGET]);

    repo = path.join(root, WS, 'knowledge-base');
    await fs.mkdir(path.dirname(repo), { recursive: true });
    await runGit(root, ['clone', upstream, repo]);
    // GitService spawns git with the ambient env — commit identity must be
    // repo-local (see git.service.changedFilesForPr.test.ts).
    await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
    await runGit(repo, ['config', 'user.name', 'Test Runner']);
    await runGit(repo, ['checkout', '-b', SOURCE]);

    git = new GitService(
      stubWorkspaceService({ [WS]: path.dirname(repo) }),
      stubWorkflowHooks(),
      testKbContext(),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  async function propose(line: [string, string]) {
    const text = ORIGINAL.replace(line[0], line[1]);
    await fs.writeFile(path.join(repo, DEAL), text);
    await runGit(repo, ['commit', '-am', 'propose']);
    await runGit(repo, ['push', '-u', 'origin', SOURCE]);
  }

  async function editTargetDirectly(line: [string, string]) {
    const current = await fs.readFile(path.join(other, DEAL), 'utf8');
    await fs.writeFile(path.join(other, DEAL), current.replace(line[0], line[1]));
    await runGit(other, ['commit', '-am', 'direct edit']);
    await runGit(other, ['push', 'origin', TARGET]);
  }

  async function forkPoint() {
    const at = await git.resolvePrShas(WS, TARGET, SOURCE);
    return { at, ...(await git.forkPointForPr(WS, at)) };
  }

  it('reads the request against its fork point: a later target edit never shows as a deletion', async () => {
    await propose(['price: 100', 'price: 120']);
    const forkedFrom = await gitOut(repo, ['rev-parse', `origin/${TARGET}`]);
    await editTargetDirectly(['status: draft', 'status: signed']);

    const fp = await forkPoint();
    expect(fp.mergeBaseSha).toBe(forkedFrom);

    // The "before" side of the dialog's diff is the fork point's text — the
    // one the author edited — not the target tip carrying B's edit.
    const before = await git.readFileAtForkPoint(WS, TARGET, fp.mergeBaseSha!, DEAL);
    expect(before).toBe(ORIGINAL);
    const tip = await gitOut(repo, ['show', `origin/${TARGET}:${DEAL}`]);
    expect(tip).toContain('status: signed');

    // The request's own patch names only the author's line.
    const files = await git.changedFilesForPr(WS, TARGET, SOURCE, { at: fp.at });
    expect(files.map((f) => f.path)).toEqual([DEAL]);
    expect(files[0].patch).toContain('+price: 120');
    expect(files[0].patch).not.toContain('status: signed');
    expect(files[0].patch).not.toMatch(/^-status/m);
    expect(files[0].deletions).toBe(1);

    // A path the fork point did not have reads as null (the request adds it).
    await expect(git.readFileAtForkPoint(WS, TARGET, fp.mergeBaseSha!, 'Sales/New.md')).resolves.toBeNull();
  });

  it('refuses to read a commit that is not on the target — only fork points are served', async () => {
    await propose(['price: 100', 'price: 120']);
    const { at } = await forkPoint();
    await expect(git.readFileAtForkPoint(WS, TARGET, at.headSha, DEAL)).rejects.toMatchObject({
      status: 404,
    });
    await expect(git.readFileAtForkPoint(WS, TARGET, 'origin/x', DEAL)).rejects.toThrow(
      /invalid commit sha/,
    );
  });

  it('behind is false until the target gains a commit the proposal does not contain', async () => {
    await propose(['price: 100', 'price: 120']);
    expect((await forkPoint()).behind).toBe(false);

    await editTargetDirectly(['status: draft', 'status: signed']);
    expect((await forkPoint()).behind).toBe(true);
  });

  it('a proposal with no history in common with the target has no fork point, and is behind', async () => {
    const ORPHAN = 'alice/unrelated';
    await runGit(repo, ['checkout', '--orphan', ORPHAN]);
    await runGit(repo, ['rm', '-rf', '--quiet', '.']);
    await fs.mkdir(path.join(repo, 'Sales'), { recursive: true });
    await fs.writeFile(path.join(repo, DEAL), 'price: 500\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'unrelated root']);
    await runGit(repo, ['push', '-u', 'origin', ORPHAN]);

    const at = await git.resolvePrShas(WS, TARGET, ORPHAN);
    await expect(git.forkPointForPr(WS, at)).resolves.toEqual({ mergeBaseSha: null, behind: true });
  });

  it('Update merges the target in cleanly: pushed, and the request is no longer behind', async () => {
    await propose(['price: 100', 'price: 120']);
    await editTargetDirectly(['status: draft', 'status: signed']);

    const outcome = await git.mergeFromOrigin(WS, SOURCE, TARGET, USER);
    expect(outcome).toEqual({ kind: 'clean', alreadyUpToDate: false });
    await runGit(repo, ['push', 'origin', SOURCE]);

    const fp = await forkPoint();
    expect(fp.behind).toBe(false);
    // Both edits live on the proposal now; its diff is still only the author's line.
    const merged = await fs.readFile(path.join(repo, DEAL), 'utf8');
    expect(merged).toContain('price: 120');
    expect(merged).toContain('status: signed');
    const files = await git.changedFilesForPr(WS, TARGET, SOURCE, { at: fp.at });
    expect(files[0].patch).toContain('+price: 120');
    expect(files[0].patch).not.toContain('status');
  });

  it('names exactly the files the update moved — the approvals on the rest survive it', async () => {
    // Alice proposes two files. Bob then edits one of them on the target and
    // adds one of his own. After the merge, only Bob's two paths differ
    // between the proposal's old head and its new one; the file Alice
    // proposed and nobody else touched does not — which is what lets its
    // approval carry forward (see `carryApprovalsForward`).
    const TERMS = 'Sales/Terms.md';
    const OTHER = 'Sales/Other.md';
    await fs.writeFile(path.join(repo, DEAL), ORIGINAL.replace('price: 100', 'price: 120'));
    await fs.writeFile(path.join(repo, TERMS), 'term: 24 months\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'propose']);
    await runGit(repo, ['push', '-u', 'origin', SOURCE]);

    await editTargetDirectly(['status: draft', 'status: signed']);
    await fs.writeFile(path.join(other, OTHER), 'note: mine\n');
    await runGit(other, ['add', '-A']);
    await runGit(other, ['commit', '-m', 'and another file']);
    await runGit(other, ['push', 'origin', TARGET]);

    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    expect(await git.mergeFromOrigin(WS, SOURCE, TARGET, USER)).toEqual({
      kind: 'clean',
      alreadyUpToDate: false,
    });
    const headAfter = await gitOut(repo, ['rev-parse', 'HEAD']);

    const moved = await git.pathsChangedBetween(WS, headBefore, headAfter);
    expect([...moved].sort()).toEqual([DEAL, OTHER]);
    expect(moved).not.toContain(TERMS);

    // Nothing moved between a commit and itself.
    await expect(git.pathsChangedBetween(WS, headAfter, headAfter)).resolves.toEqual([]);
    // Only real commits are readable — never a ref, never a fragment.
    await expect(git.pathsChangedBetween(WS, 'HEAD', headAfter)).rejects.toThrow(
      /invalid commit sha/,
    );
    await expect(git.pathsChangedBetween(WS, headAfter.slice(0, 12), headAfter)).rejects.toThrow(
      /invalid commit sha/,
    );
  });

  it('a rename the update lands names BOTH paths — the approval on the old one is not kept', async () => {
    // git detects renames by default and would report only the new path,
    // which would leave the approval on the path that no longer exists
    // reading as untouched. What the reviewer approved is gone either way, so
    // both sides have to appear.
    const RENAMED = 'Sales/Deal-2026.md';
    await fs.writeFile(path.join(repo, 'Sales/Terms.md'), 'term: 24 months\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'propose terms']);
    await runGit(repo, ['push', '-u', 'origin', SOURCE]);

    await runGit(other, ['mv', DEAL, RENAMED]);
    await runGit(other, ['commit', '-m', 'rename the deal']);
    await runGit(other, ['push', 'origin', TARGET]);

    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    await git.mergeFromOrigin(WS, SOURCE, TARGET, USER);
    const headAfter = await gitOut(repo, ['rev-parse', 'HEAD']);

    const moved = await git.pathsChangedBetween(WS, headBefore, headAfter);
    expect([...moved].sort()).toEqual([RENAMED, DEAL]);
  });

  it('a conflicting Update leaves the proposal branch untouched and reports the files', async () => {
    await propose(['price: 100', 'price: 120']);
    await editTargetDirectly(['price: 100', 'price: 90']);
    const headBefore = await gitOut(repo, ['rev-parse', 'HEAD']);
    const originBefore = await gitOut(repo, ['rev-parse', `origin/${SOURCE}`]);

    const outcome = await git.mergeFromOrigin(WS, SOURCE, TARGET, USER);
    expect(outcome).toEqual({ kind: 'conflicts', paths: [DEAL] });

    // No partial merge: same commit, clean tree, no MERGE_HEAD, nothing pushed.
    expect(await gitOut(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(await gitOut(repo, ['status', '--porcelain'])).toBe('');
    await expect(gitOut(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, DEAL), 'utf8')).toContain('price: 120');
    await runGit(repo, ['fetch', 'origin']);
    expect(await gitOut(repo, ['rev-parse', `origin/${SOURCE}`])).toBe(originBefore);
    // Still behind — the notice stays until someone resolves it.
    expect((await forkPoint()).behind).toBe(true);
  });
});
