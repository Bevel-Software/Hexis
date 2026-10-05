import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { mergeCommitSubject } from '../merge-commit.js';

const execFileAsync = promisify(execFile);
const BASE = 'current-company-state';
const USER: AuthUser = { id: 'u1', email: 'alice@example.com', name: 'Alice' };

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 's@x.com',
      GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 's@x.com',
    },
  });
}
async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.toString();
}

function stubWorkspaceService(baseWsId: string, baseRepo: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== baseWsId) throw new Error(`unexpected workspace ${id}`);
      return path.dirname(baseRepo);
    },
  } as unknown as WorkspaceService;
}

/**
 * Bare upstream seeded on BASE with `files`, plus a base-branch workspace clone
 * laid out like prod (`<root>/<wsId>/knowledge-base`). Returns handles for
 * building feature branches and inspecting the merged remote.
 */
async function seed(root: string, baseFiles: Record<string, string>) {
  const upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', BASE, upstream]);
  const seedDir = path.join(root, '.seed');
  await fs.mkdir(seedDir);
  await runGit(seedDir, ['init', '-b', BASE]);
  await runGit(seedDir, ['remote', 'add', 'origin', upstream]);
  for (const [name, content] of Object.entries(baseFiles)) {
    await fs.writeFile(path.join(seedDir, name), content);
  }
  await runGit(seedDir, ['add', '-A']);
  await runGit(seedDir, ['commit', '-m', 'base']);
  await runGit(seedDir, ['push', 'origin', BASE]);

  const baseWsId = BASE;
  const baseRepo = path.join(root, baseWsId, 'knowledge-base');
  await fs.mkdir(path.join(root, baseWsId), { recursive: true });
  await runGit(root, ['clone', '-b', BASE, upstream, baseRepo]);
  return { upstream, seedDir, baseWsId, baseRepo };
}

/** Branch `name` off origin/BASE in a throwaway clone, apply `mutate`, push. */
async function pushFeatureBranch(
  root: string,
  upstream: string,
  name: string,
  mutate: (dir: string) => Promise<void>,
) {
  const dir = path.join(root, `feat-${name.replace(/\W/g, '_')}`);
  await runGit(root, ['clone', '-b', BASE, upstream, dir]);
  await runGit(dir, ['checkout', '-b', name]);
  await mutate(dir);
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-m', `work on ${name}`]);
  await runGit(dir, ['push', '-u', 'origin', name]);
}

describe('GitService.mergeChangeRequest', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-merge-cr-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('merges a feature branch into base and pushes the merge commit', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/add', BASE, { subject: 'Add feature (#1)', body: 'Merged via Bevel' }, USER,
    );

    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') return;
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    // A commit of this request's own was written: it IS the state the target is
    // left at here, and it is what the row may record as the merge commit.
    expect(result.mergeCommit).toBe(result.sha);

    // The merge landed on origin/BASE: a fresh clone sees the feature file and a
    // merge commit authored by the human triggerer.
    const verify = path.join(root, 'verify');
    await runGit(root, ['clone', '-b', BASE, upstream, verify]);
    const merged = await fs.readFile(path.join(verify, 'feature.md'), 'utf8');
    expect(merged.replace(/\r\n/g, '\n')).toBe('new content\n');
    const log = await gitOut(verify, ['log', '-1', '--format=%an <%ae>%n%s']);
    expect(log).toContain('Alice <alice@example.com>');
    expect(log).toContain('Add feature (#1)');
  });

  // cubic P1 on #347. When the target already contains the source there is
  // nothing to merge, so no commit is written and `sha` is the TARGET TIP —
  // whatever landed on the target last, which in a deployment that lands
  // everything through change requests is usually ANOTHER request's merge commit.
  // Answering `mergeCommit: null` is what stops the row recording it as this
  // request's own: a reader that took it would answer with that other request's
  // files under this request's number. The fixture puts request #1's merge commit
  // on the tip for exactly that reason.
  it('owns NO merge commit when there was nothing to merge, not even the one on the tip', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    // Another request lands first, so the target tip is a real merge commit whose
    // subject names #1.
    await pushFeatureBranch(root, upstream, 'bob/first', async (dir) => {
      await fs.writeFile(path.join(dir, 'first.md'), 'first\n');
    });
    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const first = await git.mergeChangeRequest(
      baseWsId, 'bob/first', BASE, { subject: mergeCommitSubject('First', 1), body: 'x' }, USER,
      { appliedChangeNumber: 1 },
    );
    expect(first.kind).toBe('merged');

    // A branch the target already contains: branched and pushed with no commit of
    // its own, so the merge has nothing to do. (`pushFeatureBranch` always
    // commits, which is the one thing this case must not do.)
    const emptyDir = path.join(root, 'feat-empty');
    await runGit(root, ['clone', '-b', BASE, upstream, emptyDir]);
    await runGit(emptyDir, ['checkout', '-b', 'alice/empty']);
    await runGit(emptyDir, ['push', '-u', 'origin', 'alice/empty']);

    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/empty', BASE,
      { subject: mergeCommitSubject('Nothing to do', 2), body: 'Merged via Bevel' }, USER,
      { appliedChangeNumber: 2 },
    );

    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') return;
    // Asked for #2's own merge commit and there is none — the one on the tip is
    // #1's, and it is not offered in its place.
    expect(result.mergeCommit).toBeNull();
    // The sha it reports is the target tip, which is #1's merge commit.
    const verify = path.join(root, 'verify-empty');
    await runGit(root, ['clone', '-b', BASE, upstream, verify]);
    expect((await gitOut(verify, ['rev-parse', 'HEAD'])).trim()).toBe(result.sha);
    expect(await gitOut(verify, ['log', '-1', '--format=%s'])).toContain('(#1)');
  });

  /**
   * cubic P2 on #347. The push and the row update are two steps, and a transient
   * database fault between them leaves the merge commit ON the target with the
   * row still open. The retry then finds nothing to merge — and if that answered
   * "no merge commit", the row would record none, and the request would be
   * permanently fileless (author-only) with the commit holding its files sitting
   * on the target unreferenced.
   */
  it('recovers the merge commit a previous attempt pushed but never recorded', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const merge = () =>
      git.mergeChangeRequest(
        baseWsId, 'alice/add', BASE,
        { subject: mergeCommitSubject('Add feature', 7), body: 'Merged via Bevel' }, USER,
        { appliedChangeNumber: 7 },
      );

    // Attempt one succeeds in git; imagine the row update failing right here.
    const first = await merge();
    expect(first.kind).toBe('merged');
    if (first.kind !== 'merged') return;
    const pushed = first.mergeCommit;
    expect(pushed).toBe(first.sha);

    // Attempt two: the target already contains the source, so nothing is staged
    // and no new commit is written — but #7 does own a merge commit, and it is
    // the one the first attempt pushed.
    const second = await merge();
    expect(second.kind).toBe('merged');
    if (second.kind !== 'merged') return;
    expect(second.mergeCommit).toBe(pushed);

    // Nothing new was pushed: the target is still at that same commit.
    const verify = path.join(root, 'verify-retry');
    await runGit(root, ['clone', '-b', BASE, upstream, verify]);
    expect((await gitOut(verify, ['rev-parse', 'HEAD'])).trim()).toBe(pushed);
  });

  // The same ownership question, asked WITHOUT a merge — the form the approval
  // gate needs, because the gate refuses the retry before any merge runs. It
  // must hold in the two conditions that are true by then: the source branch is
  // retired, and the clone asking is not the clone that pushed.
  it('finds the merge commit a request owns on the target from another clone, with no source branch left', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });
    // Cloned BEFORE the merge, so it can only know the commit by fetching.
    const staleWsId = 'stale';
    const staleRepo = path.join(root, staleWsId, 'knowledge-base');
    await fs.mkdir(path.join(root, staleWsId), { recursive: true });
    await runGit(root, ['clone', '-b', BASE, upstream, staleRepo]);

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const merged = await git.mergeChangeRequest(
      baseWsId, 'alice/add', BASE,
      { subject: mergeCommitSubject('Add feature', 7), body: 'Merged via Bevel' }, USER,
      { appliedChangeNumber: 7 },
    );
    expect(merged.kind).toBe('merged');
    if (merged.kind !== 'merged') return;

    // Retired, as applying a change request retires it.
    await runGit(root, ['-C', upstream, 'branch', '-D', 'alice/add']);

    const stale = new GitService(stubWorkspaceService(staleWsId, staleRepo), new WorkflowHooks(), testKbContext());
    expect(await stale.appliedMergeCommitOnTarget(staleWsId, BASE, 7)).toBe(merged.mergeCommit);
    // A number nothing on the target was merged under owns nothing.
    expect(await stale.appliedMergeCommitOnTarget(staleWsId, BASE, 8)).toBeNull();
  });

  // One variable at a time, because the two halves of the P1 are not the same
  // claim. With the remote REACHABLE, a missing tracking ref is not a hazard at
  // all: the refresh names its destination explicitly, so it recreates the ref
  // and the walk has what it needs. With the remote UNREACHABLE, there is no
  // authority for an answer, and the stale ref the clone still holds must not be
  // scanned — what the caller does with a commit is record it as the request's
  // published state, and a ref it could not refresh may name a commit the
  // published branch no longer carries (cubic P1 on #347).
  it('recreates a missing tracking ref, and refuses to read a stale one', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const merged = await git.mergeChangeRequest(
      baseWsId, 'alice/add', BASE,
      { subject: mergeCommitSubject('Add feature', 7), body: 'Merged via Bevel' }, USER,
      { appliedChangeNumber: 7 },
    );
    expect(merged.kind).toBe('merged');
    if (merged.kind !== 'merged') return;
    // The commit IS in this clone, and origin/BASE names it.
    expect((await gitOut(baseRepo, ['rev-parse', `origin/${BASE}`])).trim()).toBe(merged.mergeCommit);

    // Variable 1: no tracking ref, remote reachable. The refresh brings it back.
    await runGit(baseRepo, ['update-ref', '-d', `refs/remotes/origin/${BASE}`]);
    expect(await git.appliedMergeCommitOnTarget(baseWsId, BASE, 7)).toBe(merged.mergeCommit);
    expect((await gitOut(baseRepo, ['rev-parse', `origin/${BASE}`])).trim()).toBe(merged.mergeCommit);

    // Variable 2: tracking ref present and naming the commit, remote gone. No
    // authority, no answer — the ref is not scanned.
    await runGit(baseRepo, ['remote', 'set-url', 'origin', path.join(root, 'gone.git')]);
    expect(await git.appliedMergeCommitOnTarget(baseWsId, BASE, 7)).toBeNull();
  });

  // The merge commit a later attempt recovers is matched on the number alone, so
  // a request that landed a DIFFERENT change under its own number is not offered
  // another request's commit — and `git log --grep` finding the number in a
  // BODY is not enough either, since the subject check still has to pass.
  it('does not mistake a mention of the number in a merge body for the request\'s own commit', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'bob/first', async (dir) => {
      await fs.writeFile(path.join(dir, 'first.md'), 'first\n');
    });
    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    // #1's merge commit, whose BODY mentions #9 — the shape `--grep` matches and
    // the subject check must reject.
    await git.mergeChangeRequest(
      baseWsId, 'bob/first', BASE,
      { subject: mergeCommitSubject('First', 1), body: 'Supersedes the work in (#9)' }, USER,
      { appliedChangeNumber: 1 },
    );

    const emptyDir = path.join(root, 'feat-empty-9');
    await runGit(root, ['clone', '-b', BASE, upstream, emptyDir]);
    await runGit(emptyDir, ['checkout', '-b', 'alice/empty']);
    await runGit(emptyDir, ['push', '-u', 'origin', 'alice/empty']);

    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/empty', BASE, { subject: mergeCommitSubject('Nothing', 9), body: 'x' }, USER,
      { appliedChangeNumber: 9 },
    );
    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') return;
    expect(result.mergeCommit).toBeNull();
  });

  /**
   * `git commit -m` takes the FIRST PARAGRAPH of the message as the subject, so a
   * blank line inside it pushes `(#N)` into the body — where `%s` never reports
   * it and the applied request's reader cannot find it (cubic P2 on #347).
   * `mergeCommitSubject` flattens the title it builds from; this is the guard
   * against any other caller reintroducing the break.
   */
  it('refuses a subject that is more than one paragraph, before touching the clone', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });
    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    await expect(
      git.mergeChangeRequest(
        baseWsId, 'alice/add', BASE, { subject: 'Add feature\n\nand a note (#3)', body: 'x' }, USER,
      ),
    ).rejects.toThrow(/single paragraph/);

    // Nothing was merged or pushed.
    const verify = path.join(root, 'verify-subject');
    await runGit(root, ['clone', '-b', BASE, upstream, verify]);
    await expect(fs.readFile(path.join(verify, 'feature.md'), 'utf8')).rejects.toThrow();
  });

  // A title with a blank line in it reaches here (titles are stored `.trim()`-ed
  // and the tool schema bounds only their length), and the whole read-back of an
  // applied request hangs on the number being ON the subject git reports.
  it('keeps the number on the subject when the title itself spans paragraphs', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
    await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
      await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
    });
    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/add', BASE,
      { subject: mergeCommitSubject('Add feature\n\nand a note', 4), body: 'x' }, USER,
      { appliedChangeNumber: 4 },
    );
    expect(result.kind).toBe('merged');
    if (result.kind !== 'merged') return;

    const verify = path.join(root, 'verify-flat');
    await runGit(root, ['clone', '-b', BASE, upstream, verify]);
    expect((await gitOut(verify, ['log', '-1', '--format=%s'])).trim())
      .toBe('Add feature and a note (#4)');
    // Which is what lets the request be recognised as the owner of this commit:
    // the same read that would otherwise refuse it as "not the merge commit of
    // change request #4" and leave the applied request fileless.
    expect(await git.appliedChangeShas(baseWsId, { number: 4, mergeSha: result.sha }))
      .toMatchObject({ baseSha: expect.any(String), headSha: expect.any(String) });
  });

  it('returns the conflicting paths when base and source both changed a file', async () => {
    const { upstream, baseWsId, baseRepo } = await seed(root, { 'shared.md': 'original\n' });
    // Source edits shared.md one way…
    await pushFeatureBranch(root, upstream, 'alice/edit', async (dir) => {
      await fs.writeFile(path.join(dir, 'shared.md'), 'source version\n');
    });
    // …and BASE advances with a conflicting edit to the same file.
    await pushFeatureBranch(root, upstream, 'tmp-base-advance', async (dir) => {
      await fs.writeFile(path.join(dir, 'shared.md'), 'base advanced\n');
    });
    // Fast-forward BASE to that commit so origin/BASE conflicts with the source.
    const advancer = path.join(root, 'advancer');
    await runGit(root, ['clone', '-b', 'tmp-base-advance', upstream, advancer]);
    await runGit(advancer, ['push', 'origin', 'tmp-base-advance:' + BASE]);

    const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
    const result = await git.mergeChangeRequest(
      baseWsId, 'alice/edit', BASE, { subject: 'Edit (#2)', body: 'x' }, USER,
    );

    expect(result.kind).toBe('conflicts');
    if (result.kind !== 'conflicts') return;
    expect(result.paths).toContain('shared.md');

    // The base workspace must be left clean (merge aborted) — not stuck mid-merge.
    const status = await gitOut(baseRepo, ['status', '--porcelain=v1']);
    expect(status.trim()).toBe('');
  });

  /**
   * `merge_branch` runs this in the TARGET BRANCH'S OWN workspace — the clone
   * the file tools read and write — where the `reset --hard` discards
   * anything unpublished. A change request's merge never had that problem: it
   * runs in a repo-global clone where only a previous attempt can be dirty.
   *
   * The guard has to live inside this method's workspace reservation. Asked by
   * the caller instead, a save landing in the gap between the question and the
   * reset is destroyed silently, and the gap is the whole git round-trip.
   */
  describe('requireCleanTarget', () => {
    it('refuses, touching nothing, when the target workspace holds an unsaved edit', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      const before = (await gitOut(baseRepo, ['rev-parse', 'HEAD'])).trim();
      // A save that has not been shared yet, exactly as a file tool leaves it.
      await fs.writeFile(path.join(baseRepo, 'base.md'), 'edited but not shared\n');

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
      await expect(
        git.mergeChangeRequest(
          baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
          { requireCleanTarget: true },
        ),
      ).rejects.toMatchObject({ status: 409, payload: { kind: 'merge-target-busy' } });

      // The edit survives and nothing was merged or pushed.
      expect(await fs.readFile(path.join(baseRepo, 'base.md'), 'utf8')).toBe('edited but not shared\n');
      expect((await gitOut(baseRepo, ['rev-parse', 'HEAD'])).trim()).toBe(before);
      const verify = path.join(root, 'verify-dirty');
      await runGit(root, ['clone', '-b', BASE, upstream, verify]);
      await expect(fs.readFile(path.join(verify, 'feature.md'), 'utf8')).rejects.toThrow();
    });

    it('refuses on a commit that was never pushed', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      await fs.writeFile(path.join(baseRepo, 'local.md'), 'committed, never pushed\n');
      await runGit(baseRepo, ['add', '-A']);
      await runGit(baseRepo, ['commit', '-m', 'local only']);

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
      await expect(
        git.mergeChangeRequest(
          baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
          { requireCleanTarget: true },
        ),
      ).rejects.toMatchObject({ status: 409, payload: { kind: 'merge-target-busy' } });
      expect(await fs.readFile(path.join(baseRepo, 'local.md'), 'utf8')).toBe('committed, never pushed\n');
    });

    it('merges a clean target as usual', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
      const result = await git.mergeChangeRequest(
        baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
        { requireCleanTarget: true },
      );
      expect(result.kind).toBe('merged');
    });
  });

  /**
   * The authorization hook. It decides on the tip this merge is BUILT on,
   * inside the same reservation as the fetch — not on a workspace `HEAD` that
   * a failed best-effort pull can have left behind origin, where the roles
   * read are the ones this very merge is about to change.
   */
  describe('authorize', () => {
    it('decides on the freshly fetched target tip, not the clone\'s stale HEAD', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      // BASE moves on origin while this clone stays where it was — the shape a
      // failed post-merge pull leaves behind.
      await pushFeatureBranch(root, upstream, 'tmp-advance', async (dir) => {
        await fs.writeFile(path.join(dir, 'base.md'), 'advanced\n');
      });
      const advancer = path.join(root, 'advancer');
      await runGit(root, ['clone', '-b', 'tmp-advance', upstream, advancer]);
      await runGit(advancer, ['push', 'origin', 'tmp-advance:' + BASE]);
      const staleHead = (await gitOut(baseRepo, ['rev-parse', 'HEAD'])).trim();
      const publishedTip = (await gitOut(advancer, ['rev-parse', 'HEAD'])).trim();
      expect(staleHead).not.toBe(publishedTip);

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
      const seen: { sha: string; changedPaths: string[] }[] = [];
      const result = await git.mergeChangeRequest(
        baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
        { authorize: async (t) => { seen.push(t); } },
      );

      expect(result.kind).toBe('merged');
      expect(seen).toHaveLength(1);
      expect(seen[0].sha).toBe(publishedTip);
      expect(seen[0].changedPaths).toEqual(['feature.md']);
    });

    it('refuses before anything is committed or pushed when the hook throws', async () => {
      const { upstream, baseWsId, baseRepo } = await seed(root, { 'base.md': 'base\n' });
      await pushFeatureBranch(root, upstream, 'alice/add', async (dir) => {
        await fs.writeFile(path.join(dir, 'feature.md'), 'new content\n');
      });
      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
      await expect(
        git.mergeChangeRequest(
          baseWsId, 'alice/add', BASE, { subject: 'Add (#1)', body: 'x' }, USER,
          { authorize: async () => { throw new Error('denied'); } },
        ),
      ).rejects.toThrow('denied');

      const verify = path.join(root, 'verify-denied');
      await runGit(root, ['clone', '-b', BASE, upstream, verify]);
      await expect(fs.readFile(path.join(verify, 'feature.md'), 'utf8')).rejects.toThrow();
    });

    it('reports BOTH sides of a rename, so a deleted roles.yaml is in the decision', async () => {
      // Renaming roles.yaml DELETES roles.yaml. `--name-only` would report only
      // the new name, and the caller would authorize a merge that removes a
      // file it never asked about.
      const { upstream, baseWsId, baseRepo } = await seed(root, {
        'base.md': 'base\n',
        'roles.yaml': 'roles:\n  admin: []\n',
      });
      await pushFeatureBranch(root, upstream, 'alice/rename', async (dir) => {
        await runGit(dir, ['mv', 'roles.yaml', 'people.yaml']);
      });

      const git = new GitService(stubWorkspaceService(baseWsId, baseRepo), new WorkflowHooks(), testKbContext());
      const seen: string[][] = [];
      const result = await git.mergeChangeRequest(
        baseWsId, 'alice/rename', BASE, { subject: 'Rename (#1)', body: 'x' }, USER,
        { authorize: async (t) => { seen.push(t.changedPaths); } },
      );

      expect(result.kind).toBe('merged');
      expect(seen[0]).toContain('roles.yaml');
      expect(seen[0]).toContain('people.yaml');
    });
  });
});
