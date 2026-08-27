import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PullRequestFile } from '@bevel-software/platform-shared';

// mergePr merges locally through GitService now (no `gh`), so we stub the git
// seam and spy on it. `mergeChangeRequestMock` stands in for the real
// merge+push; asserting whether it was called replaces the old `gh`-call checks.
const mergeChangeRequestMock = vi.fn(async () => ({ kind: 'merged' as const, sha: 'merged-sha' }));

import { ReviewWorkflowService } from '../review-workflow.service.js';
import { changeRequests } from '../../../database/schema.js';
import type { Database } from '../../../database/connection.js';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import type { GitService } from '../../git/git.service.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { hashEmail as hash } from '../../../../shared/hash-email.js';
import { AccessUnreadableError } from '../../../access-model/access-errors.js';

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
  return {
    // Table-aware: the changeRequests lookup gets the CR row; everything else
    // (pr_file_approvals) gets the canned approval rows.
    select: () => ({
      from: (table: unknown) => ({
        where: () => thenable(table === changeRequests ? [CR_ROW] : rows),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: 'merge-log-1' }],
      }),
    }),
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
  return new ReviewWorkflowService(makeDb(rows), makeAccessControl(byPath), workspace, git);
}

describe('ReviewWorkflowService.getApprovalStates', () => {
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
 * An access tree that could not be READ is not the same as "no eligible
 * writers": the latter drops a file out of the merge gate, so answering it for
 * a lost git read would let a change merge past a deny nobody managed to
 * load. The unreadable case propagates (the caller fails closed, 503); any
 * other lookup failure still degrades to empty eligibility as documented.
 */
describe('ReviewWorkflowService.getApprovalStates — unreadable access tree', () => {
  const FILES = [file({ path: 'Knowledge/Foo.md' })];
  function serviceWith(overrides: Partial<IAccessControl>) {
    const workspace = {
      ensureRemotesFetched: vi.fn(async () => undefined),
      getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-base' })),
    } as unknown as WorkspaceService;
    const git = { mergeChangeRequest: mergeChangeRequestMock } as unknown as GitService;
    return new ReviewWorkflowService(makeDb([]), { ...makeAccessControl({}), ...overrides }, workspace, git);
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
