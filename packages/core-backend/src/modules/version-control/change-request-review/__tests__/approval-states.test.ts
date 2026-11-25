import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { viewerFinishesApproval, type PullRequestFile } from '@bevel-software/platform-shared';

// mergePr merges locally through GitService now (no `gh`), so we stub the git
// seam and spy on it. `mergeChangeRequestMock` stands in for the real
// merge+push; asserting whether it was called replaces the old `gh`-call checks.
const mergeChangeRequestMock = vi.fn(async () => ({
  kind: 'merged' as const,
  sha: 'merged-sha',
  // The commit the request owns — `sha` and `mergeCommit` coincide whenever the
  // merge wrote one, which is the ordinary case these tests exercise.
  mergeCommit: 'merged-sha',
}));

import { ChangeRequestReviewService } from '../change-request-review.service.js';
import { changeRequests, users } from '../../../database/index.js';
import type { Database } from '../../../database/index.js';
import type { WorkspaceService } from '../../../workspace/index.js';
import type { GitService } from '../../git/git.service.js';
import type { IAccessControl } from '../../../access/index.js';
import { hashEmail as hash } from '../../../../shared/email-identity.js';
import { AccessUnreadableError } from '../../../access-model/index.js';

function file(overrides: Partial<PullRequestFile>): PullRequestFile {
  return {
    path: overrides.path ?? 'Knowledge/Foo.md',
    previousPath: overrides.previousPath,
    status: overrides.status ?? 'modified',
    additions: overrides.additions ?? 1,
    deletions: overrides.deletions ?? 0,
    patch: overrides.patch,
    isBinary: overrides.isBinary ?? false,
    sha: overrides.sha ?? 'blob-sha',
    rawUrl: overrides.rawUrl ?? '',
  };
}

interface ApprovalRow {
  prNumber: number;
  path: string;
  approverEmail: string;
  approverName: string;
  headSha: string;
  approvedAt: Date;
}

/**
 * Minimal drizzle stub: just enough shape that `db.select().from(...).where(eq(...))`
 * resolves to the canned approval rows.
 */
// A minimal open CR row so mergePr's `select(changeRequests)` resolves to
// something with source/target branches to merge.
const CR_ROW = {
  id: 'cr-1',
  number: 1,
  sourceBranch: 'mallory/escalate',
  targetBranch: 'current-company-state',
  title: 'x',
  body: '',
  authorEmail: 'mallory@bevel.software',
  authorName: 'Mallory',
  state: 'open',
};

function makeDb(rows: ApprovalRow[]): Database {
  // A value that's both awaitable (→ data) and `.limit()`-able (→ data), so the
  // same stub serves `getApprovalStates` (awaits `.where()`) and mergePr
  // (`.where().limit(1)`).
  const thenable = (data: unknown) => {
    const p = Promise.resolve(data) as Promise<unknown> & { limit: () => Promise<unknown> };
    p.limit = () => Promise.resolve(data);
    return p;
  };
  // Table-aware: the changeRequests lookup gets the CR row, the approver's
  // account check finds an account; everything else (pr_file_approvals) gets
  // the canned approval rows.
  const select = () => ({
    from: (table: unknown) => ({
      where: () =>
        thenable(table === changeRequests ? [CR_ROW] : table === users ? [{ id: 'account' }] : rows),
    }),
  });
  // An approval write lands in `rows`, so the states read after it see it.
  const insert = () => ({
    values: (values: Omit<ApprovalRow, 'approvedAt'>) => ({
      returning: async () => [{ id: 'merge-log-1' }],
      onConflictDoNothing: async () => {
        rows.push({ ...values, approvedAt: new Date('2026-11-25T00:00:00Z') });
      },
    }),
  });
  return {
    select,
    insert,
    // `approveFile` writes under the approval lock: a transaction whose
    // advisory-lock statements are no-ops here.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => undefined, select, insert }),
    update: () => ({
      set: () => ({
        // `where()` is awaited directly by the prMergeLog updates, and the
        // change-request CAS also chains `.returning()`; expose both so the
        // stub serves either call shape. The CAS returns a non-empty row so
        // the merge finalizes (doesn't hit the concurrent-race branch).
        where: () => {
          const t = thenable(undefined) as unknown as Promise<unknown> & {
            returning: () => Promise<unknown>;
          };
          t.returning = () => Promise.resolve([{ id: CR_ROW.id }]);
          return t;
        },
      }),
    }),
  } as unknown as Database;
}

/**
 * Per-path eligibility map used to stub the access service. The key is the
 * file path; the value lists the emails who'd be eligible to approve at the
 * PR head — typically the union of role members and direct user grants at
 * that path on that ref.
 */
type EligibilityByPath = Record<
  string,
  {
    roles: string[];
    users: { name: string; email: string }[];
    emails: string[];
    excludedEmails?: string[];
  }
>;

function makeAccessControl(byPath: EligibilityByPath): IAccessControl {
  return {
    canWrite: async () => false,
    canWriteBatch: async () => new Map(),
    canRead: async () => true,
    canReadBatch: async () => new Map(),
    eligibleReaders: async () => ({ restricted: false, roles: [], users: [] }),
    canReadAtRef: async () => null,
    canDownload: async () => false,
    canOwner: async () => false,
    eligibleOwners: async () => ({ roles: [], users: [] }),
    eligibleDownloaders: async () => ({ roles: [], users: [] }),
    eligibleWriters: async () => ({ roles: [], users: [] }),
    eligibleWriterEmails: async () => new Map(),
    eligibleOwnerEmails: async () => new Map(),
    grantSources: async () => ({}),
    invalidate: () => {},
    canWriteAtRef: async (_ws, _ref, email, path) => {
      const e = byPath[path];
      if (!e) return null;
      const canonicalEmail = email.trim().toLowerCase();
      if ((e.excludedEmails ?? []).map((x) => x.toLowerCase()).includes(canonicalEmail)) return false;
      if (e.roles.includes('everyone')) return true;
      return e.emails.map((x) => x.toLowerCase()).includes(canonicalEmail);
    },
    canWriteBatchAtRef: async () => null,
    eligibleWritersAtRef: async () => null,
    eligibleWritersForPathsAtRef: async (_ws, _ref, paths) => {
      const result = new Map<
        string,
        {
          roles: string[];
          users: { name: string; email: string }[];
          emails: Set<string>;
          excludedEmails?: Set<string>;
        }
      >();
      for (const p of paths) {
        const e = byPath[p];
        if (e) {
          result.set(p, {
            roles: e.roles,
            users: e.users,
            emails: new Set(e.emails.map((x) => x.toLowerCase())),
            excludedEmails: new Set((e.excludedEmails ?? []).map((x) => x.toLowerCase())),
          });
        } else {
          result.set(p, { roles: [], users: [], emails: new Set() });
        }
      }
      return result;
    },
    findEmailByHash: async () => null,
    kbPrincipals: async () => ({ plugins: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
  };
}

function makeService(rows: ApprovalRow[], byPath: EligibilityByPath) {
  const workspace = {
    ensureRemotesFetched: vi.fn(async () => undefined),
    getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-base' })),
  } as unknown as WorkspaceService;
  const git = { mergeChangeRequest: mergeChangeRequestMock } as unknown as GitService;
  return new ChangeRequestReviewService(makeDb(rows), makeAccessControl(byPath), workspace, git);
}

describe('ChangeRequestReviewService.getApprovalStates', () => {
  const HEAD = 'head-sha-1';
  const BASE = 'current-company-state';
  const ALICE_EMAIL = 'alice@bevel.software';
  const BOB_EMAIL = 'bob@bevel.software';
  const CAROL_EMAIL = 'carol@example.com';
  const ALICE_ELIGIBLE = {
    roles: ['Admin'],
    users: [] as { name: string; email: string }[],
    emails: [ALICE_EMAIL],
  };
  const BOB_ELIGIBLE = {
    roles: ['Admin'],
    users: [] as { name: string; email: string }[],
    emails: [BOB_EMAIL],
  };
  const EVERYONE_ELIGIBLE = {
    roles: ['everyone'],
    users: [] as { name: string; email: string }[],
    emails: [],
  };
  const EVERYONE_EXCEPT_CAROL_ELIGIBLE = {
    roles: ['everyone'],
    users: [] as { name: string; email: string }[],
    emails: [],
    excludedEmails: [CAROL_EMAIL],
  };

  it('returns empty eligibility when no workspace is provided', async () => {
    // Without a workspace the service can't resolve the access tree — every
    // entry drops to empty eligibility, isApproved: false.
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: ALICE_EMAIL,
          approverName: 'Alice',
          headSha: HEAD,
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': ALICE_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      null,
    );
    expect(states).toHaveLength(1);
    expect(states[0].eligibleApprovers.roles).toEqual([]);
    expect(states[0].eligibleApprovers.users).toEqual([]);
    expect(states[0].isApproved).toBe(false);
    // Empty because it could not be resolved — not because nobody may write.
    expect(states[0].eligibilityResolved).toBe(false);
  });

  it('a failed eligibility lookup is marked unresolved, not "outside the gate"', async () => {
    const svc = makeService([], {});
    const access = (svc as unknown as { accessControl: IAccessControl }).accessControl;
    access.eligibleWritersForPathsAtRef = async () => {
      throw new Error('git show timed out');
    };
    const states = await svc.getApprovalStates(1, [file({ path: 'Knowledge/Foo.md' })], HEAD, BASE, null, 'ws-1');
    expect(states[0].eligibleApprovers.roles).toEqual([]);
    expect(states[0].eligibilityResolved).toBe(false);
  });

  it('marks a file approved when an eligible approver has a non-stale approval', async () => {
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: ALICE_EMAIL,
          approverName: 'Alice',
          headSha: HEAD,
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': ALICE_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    expect(states[0].isApproved).toBe(true);
    expect(states[0].eligibleApprovers.roles).toEqual(['Admin']);
    expect(states[0].approvedBy).toHaveLength(1);
    expect(states[0].approvedBy[0].isStale).toBe(false);
  });

  it('marks a file approved when write: everyone applies and the approver email is not enumerable', async () => {
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: CAROL_EMAIL,
          approverName: 'Carol',
          headSha: HEAD,
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': EVERYONE_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    expect(states[0].isApproved).toBe(true);
    expect(states[0].eligibleApprovers.roles).toEqual(['everyone']);
    expect(states[0].approvedBy[0].email).toBe(CAROL_EMAIL);
  });

  it('does not count a directly denied approver even when write: everyone applies', async () => {
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: CAROL_EMAIL,
          approverName: 'Carol',
          headSha: HEAD,
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': EVERYONE_EXCEPT_CAROL_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    expect(states[0].isApproved).toBe(false);
    expect(states[0].eligibleApprovers.roles).toEqual(['everyone']);
    expect(states[0].approvedBy[0].email).toBe(CAROL_EMAIL);
  });

  it('treats approvals on a different sha as stale (force-push scenario)', async () => {
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: ALICE_EMAIL,
          approverName: 'Alice',
          headSha: 'old-sha',
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': ALICE_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    expect(states[0].approvedBy).toHaveLength(1);
    expect(states[0].approvedBy[0].isStale).toBe(true);
    expect(states[0].isApproved).toBe(false);
  });

  it('treats files with no eligible approvers as unapproved (and out of the gate)', async () => {
    const svc = makeService([], {});
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Legacy.md' })],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    expect(states[0].eligibleApprovers.roles).toEqual([]);
    expect(states[0].eligibleApprovers.users).toEqual([]);
    expect(states[0].isApproved).toBe(false);
    expect(states[0].inMergeGate).toBe(false);
    // The tree answered: nobody may write it, so it truly is outside the gate.
    expect(states[0].eligibilityResolved).toBe(true);
  });

  it('stamps each file with the gate\'s own relevance verdict', async () => {
    const svc = makeService([], {
      'Knowledge/Foo.md': ALICE_ELIGIBLE,
      'assets/shot.png': ALICE_ELIGIBLE,
      'roles.yaml': ALICE_ELIGIBLE,
      'Knowledge/Ops/Makefile': ALICE_ELIGIBLE,
    });
    const states = await svc.getApprovalStates(
      1,
      [
        file({ path: 'Knowledge/Foo.md' }),
        file({ path: 'assets/shot.png', isBinary: true }),
        file({ path: 'roles.yaml' }),
        file({ path: 'Knowledge/Ops/Makefile' }),
        file({ path: 'assets/unowned.bin', isBinary: true }),
      ],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    // Every file with an eligible approver binds the gate, whatever its type;
    // a file nobody can approve does not.
    expect(states.map((s) => s.inMergeGate)).toEqual([true, true, true, true, false]);
  });

  it('flags self-approval via the authorId hash marker', async () => {
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: ALICE_EMAIL,
          approverName: 'Alice',
          headSha: HEAD,
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': ALICE_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      hash(ALICE_EMAIL),
      'ws-1',
    );
    expect(states[0].approvedBy[0].isSelfApproval).toBe(true);
    expect(states[0].isApproved).toBe(true);
  });

  it('does not flag a non-self approval as self', async () => {
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/Foo.md',
          approverEmail: ALICE_EMAIL,
          approverName: 'Alice',
          headSha: HEAD,
          approvedAt: new Date('2026-04-20T12:00:00Z'),
        },
      ],
      { 'Knowledge/Foo.md': ALICE_ELIGIBLE },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/Foo.md' })],
      HEAD,
      BASE,
      hash(BOB_EMAIL),
      'ws-1',
    );
    expect(states[0].approvedBy[0].isSelfApproval).toBe(false);
  });

  it('returns one entry per file in the same order as input', async () => {
    const svc = makeService(
      [],
      {
        'Knowledge/A.md': ALICE_ELIGIBLE,
        'Knowledge/B.md': BOB_ELIGIBLE,
      },
    );
    const states = await svc.getApprovalStates(
      1,
      [
        file({ path: 'Knowledge/B.md' }),
        file({ path: 'Knowledge/A.md' }),
      ],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    expect(states.map((s) => s.path)).toEqual(['Knowledge/B.md', 'Knowledge/A.md']);
  });

  it('scopes approver matching to the file (does not leak across paths)', async () => {
    // Alice approved A but not B. B's state must NOT claim Alice's approval
    // counts for it just because the PR has one Alice row somewhere.
    const svc = makeService(
      [
        {
          prNumber: 1,
          path: 'Knowledge/A.md',
          approverEmail: ALICE_EMAIL,
          approverName: 'Alice',
          headSha: HEAD,
          approvedAt: new Date(),
        },
      ],
      {
        'Knowledge/A.md': ALICE_ELIGIBLE,
        'Knowledge/B.md': ALICE_ELIGIBLE, // Alice is eligible on both
      },
    );
    const states = await svc.getApprovalStates(
      1,
      [file({ path: 'Knowledge/A.md' }), file({ path: 'Knowledge/B.md' })],
      HEAD,
      BASE,
      null,
      'ws-1',
    );
    const a = states.find((s) => s.path === 'Knowledge/A.md')!;
    const b = states.find((s) => s.path === 'Knowledge/B.md')!;
    expect(a.isApproved).toBe(true);
    expect(b.isApproved).toBe(false);
    expect(b.approvedBy).toHaveLength(0);
  });
});

/**
 * End-to-end privilege-escalation regression. A non-admin who edits roles.yaml
 * on a feature branch and opens a change request to a protected branch must NOT
 * be able to merge it without an admin approval/bypass. Before the fix,
 * roles.yaml (not a `.md` file) was excluded from the approval gate, so a
 * roles.yaml-only change request produced zero warnings, the admin bypass check
 * (gated on `warnings.length > 0`) never ran, and `mergePr` shelled `gh pr
 * merge` unguarded — landing the attacker's Admin grant on the protected branch.
 *
 * These tests drive the real path: getApprovalStates (eligibility resolved
 * against origin/<base>, the OLD roles.yaml) → evaluateMergeGate → mergePr. The
 * security property is that mergePr REFUSES before ever invoking `gh`, so we
 * assert on the thrown error — `gh` is never reached.
 */
describe('mergePr — roles.yaml privilege-escalation guard', () => {
  beforeEach(() => {
    mergeChangeRequestMock.mockClear();
  });
  afterEach(() => {
    mergeChangeRequestMock.mockClear();
  });

  const HEAD = 'head-sha-1';
  const BASE = 'current-company-state';
  const ATTACKER = { id: 'u-mallory', name: 'Mallory', email: 'mallory@bevel.software' };
  const ADMIN = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };
  // Eligibility is resolved against origin/<base> — the OLD roles.yaml — where
  // only the real admin (Alice) can write roles.yaml. The attacker is not in it.
  const ADMIN_ONLY = {
    roles: ['Admin'],
    users: [] as { name: string; email: string }[],
    emails: ['alice@bevel.software'],
  };

  async function approvalsFor(
    svc: ReturnType<typeof makeService>,
    actorEmail: string,
  ) {
    // No approval rows: nobody has approved the roles.yaml change yet.
    return svc.getApprovalStates(
      1,
      [file({ path: 'roles.yaml' })],
      HEAD,
      BASE,
      null,
      'ws-1',
      actorEmail,
    );
  }

  it('blocks a non-admin merging a roles.yaml-only change request (no bypass)', async () => {
    const svc = makeService([], { 'roles.yaml': ADMIN_ONLY });
    const approvals = await approvalsFor(svc, ATTACKER.email);
    // The roles.yaml change is now gate-relevant and unapproved → a warning.
    expect(approvals[0].isApproved).toBe(false);

    await expect(
      svc.mergePr(1, ATTACKER, HEAD, approvals, 'open', 'Add myself to Admin', BASE, 'ws-1'),
    ).rejects.toMatchObject({ name: 'MergeBlockedError' });
    expect(mergeChangeRequestMock).not.toHaveBeenCalled();
  });

  it('refuses bypass for a non-admin (BypassAuthError, gh never reached)', async () => {
    const svc = makeService([], { 'roles.yaml': ADMIN_ONLY });
    const approvals = await approvalsFor(svc, ATTACKER.email);

    await expect(
      svc.mergePr(1, ATTACKER, HEAD, approvals, 'open', 'Add myself to Admin', BASE, 'ws-1', {
        bypass: true,
      }),
    ).rejects.toMatchObject({ name: 'BypassAuthError' });
    expect(mergeChangeRequestMock).not.toHaveBeenCalled();
  });

  it('lets a real admin bypass the warning and reach the merge', async () => {
    const svc = makeService([], { 'roles.yaml': ADMIN_ONLY });
    const approvals = await approvalsFor(svc, ADMIN.email);

    // The admin authority check (canWriteAtRef on roles.yaml at origin/<base>)
    // passes for Alice, so mergePr clears the gate and performs the local merge.
    const result = await svc.mergePr(
      1, ADMIN, HEAD, approvals, 'open', 'Promote Mallory', BASE, 'ws-1', { bypass: true },
    );
    expect(result.prNumber).toBe(1);

    // Assert the authorization gate actually let the merge through: the local
    // merge was invoked (not just that no auth error was thrown).
    expect(mergeChangeRequestMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The gate is extension-blind. Driven through the real path — getApprovalStates
 * → evaluateMergeGate → mergePr — for an extensionless file, a binary file, a
 * Markdown file and a mix: a missing approval makes the request non-mergeable
 * and refuses a plain merge, an approval clears it, and an admin bypass merges
 * past it with the bypassed files recorded in the merge commit body.
 */
describe('merge gate — every file type', () => {
  beforeEach(() => {
    mergeChangeRequestMock.mockClear();
  });

  const HEAD = 'head-sha-1';
  const BASE = 'current-company-state';
  const ADMIN = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };
  const OWNER = { id: 'u-olga', name: 'Olga', email: 'olga@bevel.software' };
  const AUTHOR = { id: 'u-mallory', name: 'Mallory', email: 'mallory@bevel.software' };
  // Olga owns every Knowledge file; only Alice can write roles.yaml (admin).
  const OWNED = { roles: ['Finance'], users: [], emails: [OWNER.email] };
  const ELIGIBILITY = {
    'roles.yaml': { roles: ['Admin'], users: [], emails: [ADMIN.email] },
    'Knowledge/Ops/Makefile': OWNED,
    'Knowledge/Finance/report.pdf': OWNED,
    'Knowledge/Foo.md': OWNED,
  };

  const KINDS = {
    extensionless: [file({ path: 'Knowledge/Ops/Makefile' })],
    binary: [file({ path: 'Knowledge/Finance/report.pdf', isBinary: true, patch: undefined })],
    markdown: [file({ path: 'Knowledge/Foo.md' })],
    mixed: [
      file({ path: 'Knowledge/Ops/Makefile' }),
      file({ path: 'Knowledge/Finance/report.pdf', isBinary: true, patch: undefined }),
      file({ path: 'Knowledge/Foo.md' }),
    ],
  } as const;

  function approvalRows(files: readonly PullRequestFile[]): ApprovalRow[] {
    return files.map((f) => ({
      prNumber: 1,
      path: f.path,
      approverEmail: OWNER.email,
      approverName: OWNER.name,
      headSha: HEAD,
      approvedAt: new Date('2026-09-17T12:00:00Z'),
    }));
  }

  for (const [kind, files] of Object.entries(KINDS)) {
    describe(`${kind} request`, () => {
      it('without approvals: not mergeable, every file named, plain merge refused', async () => {
        const svc = makeService([], ELIGIBILITY);
        const approvals = await svc.getApprovalStates(1, [...files], HEAD, BASE, null, 'ws-1');
        const gate = svc.evaluateMergeGate({ prNumber: 1, state: 'open', approvals });

        const expected = files.map((f) => `Waiting on approval for ${f.path} from Finance.`);
        expect(gate.mergeable).toBe(false);
        expect(gate.reasons).toEqual(expected);
        expect(gate.warnings).toEqual(expected);

        await expect(
          svc.mergePr(1, AUTHOR, HEAD, approvals, 'open', 'Update', BASE, 'ws-1'),
        ).rejects.toMatchObject({
          name: 'MergeBlockedError',
          // The files the refusal waits on, by path alone, for a caller that rewords it.
          payload: { awaitingApprovals: true, waitingPaths: files.map((f) => f.path) },
        });
        expect(mergeChangeRequestMock).not.toHaveBeenCalled();
      });

      it('with approvals: mergeable, no reasons, merges without bypass', async () => {
        const svc = makeService(approvalRows(files), ELIGIBILITY);
        const approvals = await svc.getApprovalStates(1, [...files], HEAD, BASE, null, 'ws-1');
        const gate = svc.evaluateMergeGate({ prNumber: 1, state: 'open', approvals });
        expect(gate).toEqual({ mergeable: true, reasons: [], warnings: [] });

        await svc.mergePr(1, AUTHOR, HEAD, approvals, 'open', 'Update', BASE, 'ws-1');
        expect(mergeChangeRequestMock).toHaveBeenCalledTimes(1);
        const [, , , message] = mergeChangeRequestMock.mock.calls[0] as unknown as [
          string, string, string, { subject: string; body: string },
        ];
        expect(message.body).not.toMatch(/bypassed/);
      });

      it('with the bypass: an admin merges past the missing approvals, recorded in the commit', async () => {
        const svc = makeService([], ELIGIBILITY);
        const approvals = await svc.getApprovalStates(1, [...files], HEAD, BASE, null, 'ws-1');

        await svc.mergePr(1, ADMIN, HEAD, approvals, 'open', 'Update', BASE, 'ws-1', { bypass: true });
        expect(mergeChangeRequestMock).toHaveBeenCalledTimes(1);
        const [, , , message] = mergeChangeRequestMock.mock.calls[0] as unknown as [
          string, string, string, { subject: string; body: string },
        ];
        expect(message.body).toContain('Approval requirements bypassed:');
        for (const f of files) {
          expect(message.body).toContain(`- Waiting on approval for ${f.path} from Finance.`);
        }
      });

      it('with the bypass: a non-admin is refused', async () => {
        const svc = makeService([], ELIGIBILITY);
        const approvals = await svc.getApprovalStates(1, [...files], HEAD, BASE, null, 'ws-1');

        await expect(
          svc.mergePr(1, OWNER, HEAD, approvals, 'open', 'Update', BASE, 'ws-1', { bypass: true }),
        ).rejects.toMatchObject({ name: 'BypassAuthError' });
        expect(mergeChangeRequestMock).not.toHaveBeenCalled();
      });
    });
  }

  it('a partly approved mix names only the unapproved files, and bypass records only those', async () => {
    const files = KINDS.mixed;
    const svc = makeService(approvalRows([files[2]]), ELIGIBILITY);
    const approvals = await svc.getApprovalStates(1, [...files], HEAD, BASE, null, 'ws-1');
    const gate = svc.evaluateMergeGate({ prNumber: 1, state: 'open', approvals });
    expect(gate.mergeable).toBe(false);
    expect(gate.reasons).toEqual([
      'Waiting on approval for Knowledge/Ops/Makefile from Finance.',
      'Waiting on approval for Knowledge/Finance/report.pdf from Finance.',
    ]);

    await svc.mergePr(1, ADMIN, HEAD, approvals, 'open', 'Update', BASE, 'ws-1', { bypass: true });
    const [, , , message] = mergeChangeRequestMock.mock.calls[0] as unknown as [
      string, string, string, { subject: string; body: string },
    ];
    expect(message.body).toContain('- Waiting on approval for Knowledge/Ops/Makefile from Finance.');
    expect(message.body).toContain('- Waiting on approval for Knowledge/Finance/report.pdf from Finance.');
    expect(message.body).not.toContain('Knowledge/Foo.md');
  });

  it('bypass never overrides a hard block, whatever the file type', async () => {
    const svc = makeService([], ELIGIBILITY);
    const approvals = await svc.getApprovalStates(1, [...KINDS.binary], HEAD, BASE, null, 'ws-1');
    await expect(
      svc.mergePr(1, ADMIN, HEAD, approvals, 'closed', 'Update', BASE, 'ws-1', { bypass: true }),
    ).rejects.toMatchObject({ name: 'MergeBlockedError', message: 'Merge gate rejected: This pull request is closed.' });
    expect(mergeChangeRequestMock).not.toHaveBeenCalled();
  });
});

/**
 * An access tree that could not be READ is not the same as "no eligible
 * writers": the latter drops a file out of the merge gate, so answering it for
 * a lost git read would let a change merge past a deny nobody managed to
 * load. The unreadable case propagates (the caller fails closed, 503); any
 * other lookup failure still degrades to empty eligibility as documented.
 */
describe('ChangeRequestReviewService.getApprovalStates — unreadable access tree', () => {
  const FILES = [file({ path: 'Knowledge/Foo.md' })];
  function serviceWith(overrides: Partial<IAccessControl>) {
    const workspace = {
      ensureRemotesFetched: vi.fn(async () => undefined),
      getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-base' })),
    } as unknown as WorkspaceService;
    const git = { mergeChangeRequest: mergeChangeRequestMock } as unknown as GitService;
    return new ChangeRequestReviewService(makeDb([]), { ...makeAccessControl({}), ...overrides }, workspace, git);
  }

  it('propagates AccessUnreadableError from the eligibility lookup', async () => {
    const svc = serviceWith({
      eligibleWritersForPathsAtRef: async () => {
        throw new AccessUnreadableError('origin/current-company-state', 'Knowledge/access.md');
      },
    });
    await expect(
      svc.getApprovalStates(1, FILES, 'head-sha-1', 'current-company-state', null, 'ws-base', 'alice@bevel.software'),
    ).rejects.toBeInstanceOf(AccessUnreadableError);
  });

  it('propagates AccessUnreadableError from the viewer batch too', async () => {
    const svc = serviceWith({
      canWriteBatchAtRef: async () => {
        throw new AccessUnreadableError('origin/current-company-state', 'Knowledge/access.md');
      },
    });
    await expect(
      svc.getApprovalStates(1, FILES, 'head-sha-1', 'current-company-state', null, 'ws-base', 'alice@bevel.software'),
    ).rejects.toBeInstanceOf(AccessUnreadableError);
  });

  it('still degrades any other lookup failure to empty eligibility', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const svc = serviceWith({
        eligibleWritersForPathsAtRef: async () => {
          throw new Error('origin not fetched yet');
        },
      });
      const states = await svc.getApprovalStates(1, FILES, 'head-sha-1', 'current-company-state', null, 'ws-base');
      expect(states).toHaveLength(1);
      expect(states[0].eligibleApprovers).toEqual({ roles: [], users: [] });
      expect(states[0].isApproved).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * A MOVE out of a folder the person may not write. Reported against v0.28.0:
 * a Business user who writes `Open/` but not `Locked/` moved `Locked/s2.md` to
 * `Open/s2-moved.md`, was offered "Approve this file" and the apply, and the
 * file left `Locked/` with no approval from anyone who may write there — the
 * gate asked about the destination only. A move is a deletion at its previous
 * path too, and is gated on that folder's owners as a deletion is.
 *
 * Driven through the service calls the REST routes make (`files/approve` →
 * `approveFile`, `merge` → `getApprovalStates` + `mergePr`) and the per-file
 * flags the app renders its controls from (`viewerCanApprove`, `isApproved`,
 * `eligibleApprovers`).
 */
describe('a move out of a folder the person may not write', () => {
  beforeEach(() => {
    mergeChangeRequestMock.mockClear();
  });

  const HEAD = 'head-sha-1';
  const BASE = 'current-company-state';
  const LOCKED = 'QA-Apply/Locked/s2.md';
  const MOVED = 'QA-Apply/Open/s2-moved.md';
  const USER = { id: 'u-business', name: 'Business user', email: 'business@example.com' };
  const ADMIN = { id: 'u-admin', name: 'Admin', email: 'admin@bevel.software' };
  // Writes `Locked/` only — the folder's owner who is no admin.
  const OWNER = { id: 'u-owner', name: 'Locked owner', email: 'owner@example.com' };
  const AUTHOR_HASH = hash(USER.email);

  const byPath: EligibilityByPath = {
    [LOCKED]: {
      roles: ['Admin'],
      users: [{ name: OWNER.name, email: OWNER.email }],
      emails: [ADMIN.email, OWNER.email],
    },
    [MOVED]: {
      roles: ['Admin'],
      users: [{ name: USER.name, email: USER.email }],
      emails: [ADMIN.email, USER.email],
    },
    'QA-Apply/Open/a.md': {
      roles: ['Admin'],
      users: [{ name: USER.name, email: USER.email }],
      emails: [ADMIN.email, USER.email],
    },
    'QA-Apply/Open/b.md': {
      roles: ['Admin'],
      users: [{ name: USER.name, email: USER.email }],
      emails: [ADMIN.email, USER.email],
    },
  };

  /**
   * The service over `rows`, with the viewer batch answering as the single
   * lookup does. Everyone reads everything unless `reads` says otherwise.
   */
  function makeMoveService(rows: ApprovalRow[], reads: (email: string, path: string) => boolean = () => true) {
    const base = makeAccessControl(byPath);
    const access: IAccessControl = {
      ...base,
      canWriteBatchAtRef: async (ws, ref, email, paths) => {
        const out = new Map<string, boolean>();
        for (const p of paths) out.set(p, (await base.canWriteAtRef(ws, ref, email, p)) === true);
        return out;
      },
      canReadAtRef: async (_ws, _ref, email, path) => reads(email, path),
      canReadBatchAtRef: async (_ws, _ref, email, paths) => new Map(paths.map((p) => [p, reads(email, p)])),
    };
    const workspace = {
      ensureRemotesFetched: vi.fn(async () => undefined),
      getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-base' })),
    } as unknown as WorkspaceService;
    const git = { mergeChangeRequest: mergeChangeRequestMock } as unknown as GitService;
    return new ChangeRequestReviewService(makeDb(rows), access, workspace, git);
  }

  const moveOut = [file({ path: MOVED, previousPath: LOCKED, status: 'renamed' })];
  const states = (svc: ChangeRequestReviewService, viewer: string, files = moveOut) =>
    svc.getApprovalStates(1, files, HEAD, BASE, AUTHOR_HASH, 'ws-1', viewer);
  const approve = (svc: ChangeRequestReviewService, who: typeof USER, files = moveOut) =>
    svc.approveFile(1, files[0].path, who, files, HEAD, BASE, AUTHOR_HASH, 'ws-1');

  it('names the source folder’s owners among the moved file’s approvers', async () => {
    const [state] = await states(makeMoveService([]), USER.email);
    expect(state.eligibleApprovers.roles).toEqual(['Admin']);
    expect(state.eligibleApprovers.users.map((u) => u.email)).toEqual([USER.email, OWNER.email]);
    expect(state.inMergeGate).toBe(true);
  });

  it('offers the Business user no approve control and no apply (app)', async () => {
    const [state] = await states(makeMoveService([]), USER.email);
    // The app shows "Approve this file" and the apply only when every gated
    // file is approved or `viewerCanApprove`: neither holds.
    expect(state.viewerCanApprove).toBe(false);
    expect(state.isApproved).toBe(false);
  });

  it('refuses the Business user’s approval of it, and records none (REST files/approve)', async () => {
    const rows: ApprovalRow[] = [];
    const svc = makeMoveService(rows);
    await expect(approve(svc, USER)).rejects.toMatchObject({ name: 'ApprovalAuthError', status: 403 });
    expect(rows).toEqual([]);
  });

  it('refuses the merge even with the Business user’s own approval on it, and the file stays (REST merge)', async () => {
    // A self-approval recorded before the fix, or by any route that skipped it.
    const rows: ApprovalRow[] = [
      { prNumber: 1, path: MOVED, approverEmail: USER.email, approverName: USER.name, headSha: HEAD, approvedAt: new Date() },
    ];
    const svc = makeMoveService(rows);
    const approvals = await states(svc, USER.email);
    expect(approvals[0].isApproved).toBe(false);
    expect(svc.evaluateMergeGate({ prNumber: 1, state: 'open', approvals }).mergeable).toBe(false);
    await expect(
      svc.mergePr(1, USER, HEAD, approvals, 'open', 'Move s2', BASE, 'ws-1'),
    ).rejects.toMatchObject({
      name: 'MergeBlockedError',
      status: 422,
      message: expect.stringContaining(`Waiting on approval for ${MOVED}`),
    });
    // Nor past it: the bypass is an admin's.
    await expect(
      svc.mergePr(1, USER, HEAD, approvals, 'open', 'Move s2', BASE, 'ws-1', { bypass: true }),
    ).rejects.toMatchObject({ name: 'BypassAuthError' });
    expect(mergeChangeRequestMock).not.toHaveBeenCalled();
  });

  it('applies once an admin — who may write both folders — has approved it', async () => {
    const rows: ApprovalRow[] = [];
    const svc = makeMoveService(rows);
    await approve(svc, ADMIN);
    const approvals = await states(svc, USER.email);
    expect(approvals[0].isApproved).toBe(true);
    await svc.mergePr(1, USER, HEAD, approvals, 'open', 'Move s2', BASE, 'ws-1');
    expect(mergeChangeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('lets the source folder’s owner approve their side, and the Business user complete it after', async () => {
    const rows: ApprovalRow[] = [];
    const svc = makeMoveService(rows);
    // The owner may write `Locked/` but not `Open/`: their approval settles the
    // source side and leaves the destination's to its own writers.
    expect((await states(svc, OWNER.email))[0].viewerCanApprove).toBe(true);
    const afterOwner = await approve(svc, OWNER);
    expect(afterOwner[0].isApproved).toBe(false);
    await expect(
      svc.mergePr(1, USER, HEAD, await states(svc, USER.email), 'open', 'Move s2', BASE, 'ws-1'),
    ).rejects.toMatchObject({ name: 'MergeBlockedError' });

    // An approver of the source has approved: now the move is the Business
    // user's to approve, and their approval completes it.
    expect((await states(svc, USER.email))[0].viewerCanApprove).toBe(true);
    const afterUser = await approve(svc, USER);
    expect(afterUser[0].isApproved).toBe(true);
    await svc.mergePr(1, USER, HEAD, afterUser, 'open', 'Move s2', BASE, 'ws-1');
    expect(mergeChangeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('does not count an approval of an earlier head for the source side', async () => {
    const rows: ApprovalRow[] = [
      { prNumber: 1, path: MOVED, approverEmail: OWNER.email, approverName: OWNER.name, headSha: 'old-head', approvedAt: new Date() },
    ];
    const svc = makeMoveService(rows);
    expect((await states(svc, USER.email))[0].viewerCanApprove).toBe(false);
    await expect(approve(svc, USER)).rejects.toMatchObject({ status: 403 });
  });

  it('still lets the Business user approve and apply a move between folders they may write', async () => {
    const files = [file({ path: 'QA-Apply/Open/b.md', previousPath: 'QA-Apply/Open/a.md', status: 'renamed' })];
    const rows: ApprovalRow[] = [];
    const svc = makeMoveService(rows);
    expect((await states(svc, USER.email, files))[0].viewerCanApprove).toBe(true);
    const approvals = await approve(svc, USER, files);
    expect(approvals[0].isApproved).toBe(true);
    await svc.mergePr(1, USER, HEAD, approvals, 'open', 'Rename a', BASE, 'ws-1');
    expect(mergeChangeRequestMock).toHaveBeenCalledTimes(1);
  });

  it('tells the source owner their approval leaves the move waiting on the destination', async () => {
    const svc = makeMoveService([]);
    const [owner] = await states(svc, OWNER.email);
    // Theirs to approve, as the source's consent — but not theirs to finish,
    // so the app offers them Approve and not Apply.
    expect(owner.viewerCanApprove).toBe(true);
    expect(owner.viewerApprovalLeavesWaiting).toBe(true);
    expect(viewerFinishesApproval(owner)).toBe(false);
    // An admin writes both ends: their approval finishes it.
    const [admin] = await states(svc, ADMIN.email);
    expect(admin.viewerApprovalLeavesWaiting).toBeUndefined();
    expect(viewerFinishesApproval(admin)).toBe(true);
    // Once the owner has approved, the Business user's approval finishes it.
    await approve(svc, OWNER);
    const [user] = await states(svc, USER.email);
    expect(user.viewerApprovalLeavesWaiting).toBeUndefined();
    expect(viewerFinishesApproval(user)).toBe(true);
  });

  it('lets the source owner finish a move into a folder nobody can approve', async () => {
    const files = [file({ path: 'Ungoverned/s2.md', previousPath: LOCKED, status: 'renamed' })];
    const [owner] = await states(makeMoveService([]), OWNER.email, files);
    expect(owner.viewerCanApprove).toBe(true);
    expect(viewerFinishesApproval(owner)).toBe(true);
  });

  describe('a viewer who may not read the source', () => {
    const notLocked = (email: string, path: string) => !(email === USER.email && path === LOCKED);

    it('is shown the destination’s approvers alone, and the gate still binds the file', async () => {
      const svc = makeMoveService([], notLocked);
      const [state] = await states(svc, USER.email);
      expect(state.eligibleApprovers.users.map((u) => u.email)).toEqual([USER.email]);
      expect(state.inMergeGate).toBe(true);
      // Into a folder nobody can approve: nothing is shown, and the gate
      // still waits on the source's owners.
      const files = [file({ path: 'Ungoverned/s2.md', previousPath: LOCKED, status: 'renamed' })];
      const approvals = await states(svc, USER.email, files);
      expect(approvals[0].eligibleApprovers).toEqual({ roles: [], users: [] });
      expect(approvals[0].inMergeGate).toBe(true);
      expect(svc.evaluateMergeGate({ prNumber: 1, state: 'open', approvals }).mergeable).toBe(false);
    });

    it('gets the same answer before and after the source owner approves (app and REST)', async () => {
      const rows: ApprovalRow[] = [];
      const svc = makeMoveService(rows, notLocked);
      expect((await states(svc, USER.email))[0].viewerCanApprove).toBe(false);
      await expect(approve(svc, USER)).rejects.toMatchObject({ name: 'ApprovalAuthError', status: 403 });

      await approve(svc, OWNER);
      // The owner's consent is not told to them: still not theirs to approve.
      expect((await states(svc, USER.email))[0].viewerCanApprove).toBe(false);
      await expect(approve(svc, USER)).rejects.toMatchObject({ name: 'ApprovalAuthError', status: 403 });
      expect(rows.map((r) => r.approverEmail)).toEqual([OWNER.email]);
    });
  });

  it('treats a move out of a folder nobody can approve as the destination alone', async () => {
    const files = [file({ path: MOVED, previousPath: 'Ungoverned/s2.md', status: 'renamed' })];
    const svc = makeMoveService([]);
    expect((await states(svc, USER.email, files))[0].viewerCanApprove).toBe(true);
    const approvals = await approve(svc, USER, files);
    expect(approvals[0].isApproved).toBe(true);
    expect(approvals[0].eligibleApprovers.users.map((u) => u.email)).toEqual([USER.email]);
  });
});
