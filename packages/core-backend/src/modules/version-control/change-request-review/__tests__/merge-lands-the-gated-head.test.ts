import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AuthUser, FileApprovalState } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import type { IAccessControl } from '../../../access/index.js';
import { changeRequests, prMergeLog } from '../../../database/index.js';
import type { Database } from '../../../database/index.js';
import type { WorkspaceService } from '../../../workspace/index.js';
import { GitService } from '../../git/git.service.js';
import { gitOut, runGit, stubVersionControlHooks } from '../../git/__tests__/git-test-helpers.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';

/**
 * `mergePr` lands the commit its gate judged, or nothing.
 *
 * The caller reads a request (its head and the approvals on that head), the
 * gate passes them, and the merge then fetches the branch again. A push that
 * lands between the reading and that fetch is a commit nobody approved: the
 * approvals are for the head before it. These cases run the real merge on real
 * repositories, with only the database stubbed, because the property is about
 * what reaches the target branch.
 */

const USER: AuthUser = { id: 'u-alice', email: 'alice@bevel.software', name: 'Alice' };
const BASE = 'current-company-state';
const FEATURE = 'alice/add';
const NUMBER = 12;
const CR_ROW = {
  id: 'cr-1',
  number: NUMBER,
  sourceBranch: FEATURE,
  targetBranch: BASE,
  title: 'Add a note',
  state: 'open',
};

/** One file, approved by its owner on the head the caller read: all the gate needs. */
const APPROVED: FileApprovalState = {
  path: 'approved.md',
  eligibleApprovers: { roles: ['Ops'], users: [] },
  approvedBy: [
    {
      name: 'Olga',
      email: 'olga@bevel.software',
      approvedAt: '2026-11-27T10:00:00Z',
      isStale: false,
      isSelfApproval: false,
    },
  ],
  eligibilityResolved: true,
  isApproved: true,
  viewerCanApprove: false,
  inMergeGate: true,
};

type LogWrite = { succeeded?: boolean; error?: string | null };

/** The request's row, and a merge log that keeps what was written to it. */
function makeDb(logWrites: LogWrite[]): Database {
  const rows = (data: unknown) => {
    const p = Promise.resolve(data) as Promise<unknown> & { limit: () => Promise<unknown> };
    p.limit = () => Promise.resolve(data);
    return p;
  };
  return {
    select: () => ({
      from: (table: unknown) => ({ where: () => rows(table === changeRequests ? [CR_ROW] : []) }),
    }),
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

describe('mergePr: the head the gate judged is the head that lands', () => {
  let root: string;
  let upstream: string;
  let featureDir: string;
  let service: ChangeRequestReviewService;
  let logWrites: LogWrite[];

  const tipOf = (branch: string) => gitOut(upstream, ['rev-parse', `refs/heads/${branch}`]);
  const filesOn = async (branch: string) =>
    (await gitOut(upstream, ['ls-tree', '-r', '--name-only', branch])).split('\n');
  const commitAndPush = async (dir: string, file: string, branch: string) => {
    await fs.writeFile(path.join(dir, file), `${file}\n`);
    await runGit(dir, ['add', '-A']);
    await runGit(dir, ['commit', '-m', `add ${file}`]);
    await runGit(dir, ['push', 'origin', branch]);
  };
  const merge = (headSha: string) =>
    service.mergePr(NUMBER, USER, headSha, [APPROVED], 'open', CR_ROW.title, BASE, 'ws-viewer');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-gated-head-'));
    upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', BASE, upstream]);
    // The target branch, published with one file.
    const seedDir = path.join(root, 'seed');
    await runGit(root, ['clone', upstream, seedDir]);
    await runGit(seedDir, ['checkout', '-b', BASE]);
    await commitAndPush(seedDir, 'base.md', BASE);
    // The request's branch, published with the one file its approval is for.
    featureDir = path.join(root, 'feature');
    await runGit(root, ['clone', '-b', BASE, upstream, featureDir]);
    await runGit(featureDir, ['checkout', '-b', FEATURE]);
    await commitAndPush(featureDir, 'approved.md', FEATURE);
    // The target's own workspace, laid out as production lays it out.
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
      {} as unknown as IAccessControl,
      workspaces,
      new GitService(workspaces, stubVersionControlHooks(), testKbContext()),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('lands the request when its branch is still at the head the gate judged', async () => {
    const gated = await tipOf(FEATURE);

    await merge(gated);

    expect(await filesOn(BASE)).toContain('approved.md');
    expect(logWrites.at(-1)).toMatchObject({ succeeded: true });
  });

  it('refuses a request whose branch was pushed to after the gate read it, and lands none of it', async () => {
    const gated = await tipOf(FEATURE);
    await commitAndPush(featureDir, 'unapproved.md', FEATURE);
    const targetBefore = await tipOf(BASE);

    const refusal = await merge(gated).catch((err: unknown) => err);

    // A gate refusal, as a missing approval is: the status and the reasons the
    // app and the agent tool already answer with. It names no file.
    expect(refusal).toMatchObject({
      status: 422,
      payload: {
        mergeBlockedReasons: [expect.stringContaining('changed after its approvals were checked')],
      },
    });
    expect(JSON.stringify((refusal as { payload: unknown }).payload)).not.toContain('unapproved.md');
    expect(await tipOf(BASE)).toBe(targetBefore);
    expect(await filesOn(BASE)).not.toContain('approved.md');
    expect(logWrites.at(-1)).toMatchObject({ succeeded: false });
  });

  it('lands the later commit once the gate has judged it', async () => {
    const first = await tipOf(FEATURE);
    await commitAndPush(featureDir, 'second.md', FEATURE);
    await merge(first).catch(() => undefined);

    await merge(await tipOf(FEATURE));

    expect(await filesOn(BASE)).toEqual(expect.arrayContaining(['approved.md', 'second.md']));
  });
});
