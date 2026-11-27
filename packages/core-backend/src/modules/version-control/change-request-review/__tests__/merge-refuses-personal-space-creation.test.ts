import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AuthUser, FileApprovalState } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { AccessControlService } from '../../../access/access-control.service.js';
import { NodeFs } from '../../../kb-fs/node-fs.js';
import { personalAccessMd } from '../../../plugins/plugin-provision.service.js';
import { changeRequests, prMergeLog } from '../../../database/index.js';
import type { Database } from '../../../database/index.js';
import type { WorkspaceService } from '../../../workspace/index.js';
import { GitService } from '../../git/git.service.js';
import { gitOut, runGit, stubVersionControlHooks } from '../../git/__tests__/git-test-helpers.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';

/**
 * A change request cannot set up a person's personal plugin folder before the
 * person has.
 *
 * Every write verdict refuses a write into a `Plugins/personal-*` folder that
 * holds no `access.md` yet, so nobody may write such a file, and so nobody is
 * eligible to approve it, and so the approval gate, which binds only files
 * someone could approve, let a request carrying one through: an Admin opened
 * a draft with `Plugins/personal-<id>/access.md` naming themselves and applied
 * it with no approval and no bypass. These cases run the real merge on real
 * repositories with the real access resolver, only the database stubbed.
 */

const ADMIN: AuthUser = { id: 'u-boss', email: 'boss@x.io', name: 'Boss' };
const OWNER = { name: 'Ali Vega', email: 'ali@x.io' };
const BASE = 'main';
const FEATURE = 'boss/pre-seed';
const NUMBER = 41;
const CR_ROW = { id: 'cr-41', number: NUMBER, sourceBranch: FEATURE, targetBranch: BASE, title: 'Set up Ali', state: 'open' };
const ROLES_YAML = 'roles:\n  Admin:\n    - boss@x.io\n';
const ROOT_RULES = '---\nowner:\n  - Admin\n---\nread:\n  - everyone\nwrite:\n  - Admin\n';
const PRE_SEED = '---\nread:\n  - Boss <boss@x.io>\n---\nread:\n  - Boss <boss@x.io>\nowner:\n  - Ali Vega <ali@x.io>\n';

/** A file as the gate is handed it: approved when someone could approve it, else outside the gate. */
const approvalOf = (file: string, approvable: boolean): FileApprovalState => ({
  path: file,
  eligibleApprovers: approvable ? { roles: [], users: [OWNER] } : { roles: [], users: [] },
  approvedBy: approvable
    ? [{ name: OWNER.name, email: OWNER.email, approvedAt: '2026-11-27T10:00:00Z', isStale: false, isSelfApproval: false }]
    : [],
  eligibilityResolved: true,
  isApproved: approvable,
  viewerCanApprove: false,
  inMergeGate: approvable,
});

type LogWrite = { succeeded?: boolean; error?: string | null };

function makeDb(logWrites: LogWrite[]): Database {
  const rows = (data: unknown) => {
    const p = Promise.resolve(data) as Promise<unknown> & { limit: () => Promise<unknown> };
    p.limit = () => Promise.resolve(data);
    return p;
  };
  return {
    select: () => ({ from: (table: unknown) => ({ where: () => rows(table === changeRequests ? [CR_ROW] : []) }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'merge-log-1' }] }) }),
    update: (table: unknown) => ({
      set: (values: LogWrite) => {
        if (table === prMergeLog) logWrites.push(values);
        return {
          where: () => {
            const done = rows(undefined) as unknown as Promise<unknown> & { returning: () => Promise<unknown> };
            done.returning = () => Promise.resolve([{ id: CR_ROW.id }]);
            return done;
          },
        };
      },
    }),
  } as unknown as Database;
}

describe('mergePr: a change request cannot create a personal plugin folder', () => {
  let root: string;
  let upstream: string;
  let seedDir: string;
  let featureDir: string;
  let service: ChangeRequestReviewService;
  let logWrites: LogWrite[];

  const tipOf = (branch: string) => gitOut(upstream, ['rev-parse', `refs/heads/${branch}`]);
  const filesOn = async (branch: string) =>
    (await gitOut(upstream, ['ls-tree', '-r', '--name-only', branch])).split('\n');
  const commitAndPush = async (dir: string, files: Record<string, string>, branch: string) => {
    for (const [rel, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    }
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-m', `add ${Object.keys(files).join(', ')}`]);
    await runGit(dir, ['push', 'origin', branch]);
  };
  /** Cut the request's branch from the published target and push `files` on it. */
  const propose = async (files: Record<string, string>) => {
    featureDir = path.join(root, `feature-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await runGit(root, ['clone', '-b', BASE, upstream, featureDir]);
    await runGit(featureDir, ['checkout', '-B', FEATURE]);
    await commitAndPush(featureDir, files, FEATURE);
  };
  const apply = async (approvals: FileApprovalState[], opts: { bypass?: boolean } = {}) =>
    service.mergePr(NUMBER, ADMIN, await tipOf(FEATURE), approvals, 'open', CR_ROW.title, BASE, 'ws-viewer', opts);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-personal-cr-'));
    upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', BASE, upstream]);
    seedDir = path.join(root, 'seed');
    await runGit(root, ['clone', upstream, seedDir]);
    await runGit(seedDir, ['checkout', '-b', BASE]);
    await commitAndPush(seedDir, { 'roles.yaml': ROLES_YAML, 'access.md': ROOT_RULES, 'base.md': 'base\n' }, BASE);
    // The target's workspace: where the merge runs and where the resolver reads the target commit.
    const baseRepo = path.join(root, 'ws-base', 'knowledge-base');
    await fs.mkdir(path.dirname(baseRepo), { recursive: true });
    await runGit(root, ['clone', '-b', BASE, upstream, baseRepo]);

    const workspaces = {
      getWorkspacePath: async () => path.dirname(baseRepo),
      getOrCreateForBranch: async () => ({ id: 'ws-base' }),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    logWrites = [];
    service = new ChangeRequestReviewService(
      makeDb(logWrites),
      new AccessControlService(workspaces, 'knowledge-base', new NodeFs()),
      workspaces,
      new GitService(workspaces, stubVersionControlHooks(), testKbContext()),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  for (const [label, files] of [
    ['its access.md', { 'Plugins/personal-ali/access.md': PRE_SEED }],
    ['a skill in it', { 'Plugins/personal-ali/skills/diary/SKILL.md': '# Diary\n' }],
    ['another spelling of it', { 'plugins/Personal-Ali/access.md': PRE_SEED }],
  ] as const) {
    it(`refuses a request that would create one through ${label}, with no approval or with a bypass, and lands none of it`, async () => {
      await propose({ ...files, 'note.md': 'note\n' });
      const targetBefore = await tipOf(BASE);
      const approvals = [approvalOf('note.md', true), ...Object.keys(files).map((f) => approvalOf(f, false))];

      for (const opts of [{}, { bypass: true }]) {
        const refusal = await apply(approvals, opts).catch((err: unknown) => err);
        expect(refusal).toMatchObject({
          status: 422,
          payload: { mergeBlockedReasons: [expect.stringContaining('personal plugin folder')] },
        });
        // Names no file: the folder's name is not the merger's to learn from a refusal.
        expect(JSON.stringify((refusal as { payload: unknown }).payload)).not.toMatch(/personal-ali|Personal-Ali/);
      }
      expect(await tipOf(BASE)).toBe(targetBefore);
      expect(await filesOn(BASE)).not.toContain('note.md');
      expect(logWrites.at(-1)).toMatchObject({ succeeded: false, error: expect.stringContaining('personal plugin folder') });
    });
  }

  it('lands a request into a personal folder its owner has already set up, and one that touches none', async () => {
    await commitAndPush(seedDir, { 'Plugins/personal-ali/access.md': personalAccessMd(OWNER) }, BASE);
    await propose({ 'Plugins/personal-ali/skills/diary/SKILL.md': '# Diary\n', 'Plugins/personalities/x.md': 'x\n' });

    await apply([
      approvalOf('Plugins/personal-ali/skills/diary/SKILL.md', true),
      approvalOf('Plugins/personalities/x.md', true),
    ]);

    expect(await filesOn(BASE)).toEqual(
      expect.arrayContaining(['Plugins/personal-ali/skills/diary/SKILL.md', 'Plugins/personalities/x.md']),
    );
    expect(logWrites.at(-1)).toMatchObject({ succeeded: true });
  });
});
