import { describe, it, expect } from 'vitest';
import type { FileApprovalEntry, FileApprovalState, PullRequestState } from '@bevel-software/platform-shared';
import { ReviewWorkflowService } from '../review-workflow.service.js';

function makeService(): ReviewWorkflowService {
  // evaluateMergeGate is pure — it never touches the DB, access service, or
  // workspace. Constructing with `undefined as any` for unused deps keeps the
  // test focused on the gate logic and avoids pulling in fixture scaffolding.
  return new ReviewWorkflowService(undefined as any, undefined as any, undefined as any, undefined as any);
}

const ADMIN_ELIGIBLE = {
  roles: ['Admin'],
  users: [] as { name: string; email: string }[],
};
const EMPTY_ELIGIBLE = {
  roles: [] as string[],
  users: [] as { name: string; email: string }[],
};

// Spread-after-defaults so explicit empty eligibility (e.g. ownerless legacy
// file) passes through instead of being overwritten by the default.
function approval(overrides: Partial<FileApprovalState>): FileApprovalState {
  return {
    path: 'Knowledge/Foo.md',
    eligibleApprovers: ADMIN_ELIGIBLE,
    approvedBy: [],
    isApproved: false,
    viewerCanApprove: false,
    inMergeGate: true,
    ...overrides,
  };
}

function entry(overrides: Partial<FileApprovalEntry>): FileApprovalEntry {
  return {
    email: 'alice@bevel.software',
    name: 'Alice',
    approvedAt: '2026-04-20T12:00:00Z',
    isStale: false,
    isSelfApproval: false,
    ...overrides,
  };
}

describe('evaluateMergeGate', () => {
  const svc = makeService();

  it('passes cleanly when every gate-relevant file has a non-stale approval', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'A.md', isApproved: true, approvedBy: [entry({})] }),
        approval({ path: 'B.md', isApproved: true, approvedBy: [entry({})] }),
      ],
    });
    expect(result).toEqual({ mergeable: true, reasons: [], warnings: [] });
  });

  it('rejects merged PRs as a hard block', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'merged' as PullRequestState,
      approvals: [approval({ isApproved: true })],
    });
    expect(result.mergeable).toBe(false);
    expect(result.reasons[0]).toMatch(/already been merged/i);
  });

  it('rejects closed PRs as a hard block', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'closed',
      approvals: [approval({ isApproved: true })],
    });
    expect(result.mergeable).toBe(false);
    expect(result.reasons[0]).toMatch(/closed/i);
  });

  it('rejects PRs with no files to approve as a hard block', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [],
    });
    expect(result.mergeable).toBe(false);
    expect(result.reasons[0]).toMatch(/no file changes/i);
  });

  it('ignores files with no eligible approvers, of any type — no warning, no block', () => {
    // Nobody could approve these, so counting them would deadlock the request.
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'A.md', isApproved: true, approvedBy: [entry({})] }),
        approval({ path: 'Legacy.md', eligibleApprovers: EMPTY_ELIGIBLE }),
        approval({ path: 'assets/logo.png', eligibleApprovers: EMPTY_ELIGIBLE }),
        approval({ path: 'Makefile', eligibleApprovers: EMPTY_ELIGIBLE }),
      ],
    });
    expect(result).toEqual({ mergeable: true, reasons: [], warnings: [] });
  });

  it('reports an unapproved file with eligible approvers as a blocking reason and a warning', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({
          path: 'B.md',
          eligibleApprovers: {
            roles: ['Product Manager'],
            users: [{ name: 'Bob', email: 'bob@bevel.software' }],
          },
          approvedBy: [],
        }),
      ],
    });
    const message = 'Waiting on approval for B.md from Product Manager; Bob <bob@bevel.software>.';
    expect(result.mergeable).toBe(false);
    expect(result.reasons).toEqual([message]);
    // The warning list is what an admin bypass merges past and records.
    expect(result.warnings).toEqual([message]);
  });

  it('distinguishes stale approvals from never-approved', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({
          path: 'A.md',
          eligibleApprovers: ADMIN_ELIGIBLE,
          approvedBy: [entry({ email: 'alice@bevel.software', isStale: true })],
        }),
        approval({
          path: 'B.md',
          eligibleApprovers: ADMIN_ELIGIBLE,
          approvedBy: [],
        }),
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.warnings).toContain('Admin need to re-approve A.md after the latest push.');
    expect(result.warnings).toContain('Waiting on approval for B.md from Admin.');
    expect(result.reasons).toEqual(result.warnings);
  });

  it('lists the hard block before the missing approvals when the PR is closed', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'closed',
      approvals: [
        approval({ path: 'A.md', eligibleApprovers: EMPTY_ELIGIBLE }),
        approval({ path: 'B.md' }),
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.reasons[0]).toMatch(/closed/i);
    expect(result.reasons).toContain('Waiting on approval for B.md from Admin.');
  });

  // Regression: roles.yaml is the file that decides Admin membership. Before it
  // was gated, a roles.yaml-only change request could merge into a protected
  // branch with no approval and no admin check, letting its author self-promote.
  it('blocks an unapproved roles.yaml change (privilege-escalation guard)', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'roles.yaml', eligibleApprovers: ADMIN_ELIGIBLE, approvedBy: [] }),
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.reasons).toEqual(['Waiting on approval for roles.yaml from Admin.']);
    expect(result.warnings).toEqual(['Waiting on approval for roles.yaml from Admin.']);
  });

  it('blocks an unapproved access.md change, at root and nested', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'access.md', eligibleApprovers: ADMIN_ELIGIBLE, approvedBy: [] }),
        approval({ path: 'Knowledge/Sales/access.md', eligibleApprovers: ADMIN_ELIGIBLE, approvedBy: [] }),
      ],
    });
    expect(result.mergeable).toBe(false);
    expect(result.reasons).toContain('Waiting on approval for access.md from Admin.');
    expect(result.reasons).toContain('Waiting on approval for Knowledge/Sales/access.md from Admin.');
  });

  it('a roles.yaml change WITH a non-stale eligible approval passes cleanly', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'roles.yaml', isApproved: true, approvedBy: [entry({})] }),
      ],
    });
    expect(result).toEqual({ mergeable: true, reasons: [], warnings: [] });
  });

  // The gate is extension-blind: a Markdown note, a binary and an extensionless
  // file with owners all need an approval, and all pass once they have one.
  describe('every file type', () => {
    const KINDS = [
      ['an extensionless file', 'Knowledge/Ops/Makefile'],
      ['a binary file', 'Knowledge/Finance/report.pdf'],
      ['a Markdown file', 'Knowledge/Foo.md'],
      ['an upper-case Markdown file', 'Knowledge/FOO.MD'],
    ] as const;

    for (const [kind, path] of KINDS) {
      it(`blocks ${kind} that lacks an approval`, () => {
        const result = svc.evaluateMergeGate({
          prNumber: 1,
          state: 'open',
          approvals: [approval({ path, approvedBy: [] })],
        });
        expect(result.mergeable).toBe(false);
        expect(result.reasons).toEqual([`Waiting on approval for ${path} from Admin.`]);
        expect(result.warnings).toEqual([`Waiting on approval for ${path} from Admin.`]);
      });

      it(`passes ${kind} that has an approval`, () => {
        const result = svc.evaluateMergeGate({
          prNumber: 1,
          state: 'open',
          approvals: [approval({ path, isApproved: true, approvedBy: [entry({})] })],
        });
        expect(result).toEqual({ mergeable: true, reasons: [], warnings: [] });
      });
    }

    it('names exactly the unapproved files in a mixed request', () => {
      const result = svc.evaluateMergeGate({
        prNumber: 1,
        state: 'open',
        approvals: [
          approval({ path: 'Knowledge/Foo.md', isApproved: true, approvedBy: [entry({})] }),
          approval({ path: 'Knowledge/Finance/report.pdf', approvedBy: [] }),
          approval({ path: 'Knowledge/Ops/Makefile', approvedBy: [] }),
          approval({ path: 'Knowledge/Unowned.bin', eligibleApprovers: EMPTY_ELIGIBLE }),
        ],
      });
      expect(result.mergeable).toBe(false);
      expect(result.reasons).toEqual([
        'Waiting on approval for Knowledge/Finance/report.pdf from Admin.',
        'Waiting on approval for Knowledge/Ops/Makefile from Admin.',
      ]);
      expect(result.warnings).toEqual(result.reasons);
    });

    it('passes a mixed request once every owned file is approved', () => {
      const result = svc.evaluateMergeGate({
        prNumber: 1,
        state: 'open',
        approvals: [
          approval({ path: 'Knowledge/Foo.md', isApproved: true, approvedBy: [entry({})] }),
          approval({ path: 'Knowledge/Finance/report.pdf', isApproved: true, approvedBy: [entry({})] }),
          approval({ path: 'Knowledge/Ops/Makefile', isApproved: true, approvedBy: [entry({})] }),
        ],
      });
      expect(result).toEqual({ mergeable: true, reasons: [], warnings: [] });
    });
  });
});
