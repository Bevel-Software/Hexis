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

  it('ignores md files with no eligible approvers — no warning, no block', () => {
    // Files outside the access-controlled surface (no roles/users grant
    // write) are not part of the gate.
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'A.md', isApproved: true, approvedBy: [entry({})] }),
        approval({ path: 'Legacy.md', eligibleApprovers: EMPTY_ELIGIBLE }),
      ],
    });
    expect(result.mergeable).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('ignores non-md files regardless of eligibility', () => {
    // TypeScript sources, JSON, images etc. don't participate in the gate.
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'src/foo.ts', eligibleApprovers: ADMIN_ELIGIBLE }),
        approval({ path: 'assets/logo.png', eligibleApprovers: EMPTY_ELIGIBLE }),
      ],
    });
    expect(result.mergeable).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('treats unapproved md-with-eligible-approvers as a warning, not a hard block', () => {
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
    expect(result.mergeable).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([
      'Waiting on approval for B.md from Product Manager; Bob <bob@bevel.software>.',
    ]);
  });

  it('distinguishes stale approvals from never-approved in warnings', () => {
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
    expect(result.mergeable).toBe(true);
    expect(result.warnings).toContain('Admin need to re-approve A.md after the latest push.');
    expect(result.warnings).toContain('Waiting on approval for B.md from Admin.');
  });

  it('surfaces only the hard block when the PR is closed, not soft warnings', () => {
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
  });

  it('is case-insensitive on the .md extension check', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({
          path: 'Knowledge/FOO.MD',
          eligibleApprovers: ADMIN_ELIGIBLE,
          approvedBy: [],
        }),
      ],
    });
    expect(result.warnings).toContain('Waiting on approval for Knowledge/FOO.MD from Admin.');
  });

  // Regression: roles.yaml is the file that decides Admin membership, but it
  // isn't a `.md` KB node — so before this gate it slipped through with zero
  // warnings, and a roles.yaml-only change request could merge into a protected
  // branch with no approval and no admin check, letting its author self-promote
  // to Admin. The gate must bind roles.yaml (and access.md) like an md node.
  it('treats an unapproved roles.yaml change as a warning (privilege-escalation guard)', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'roles.yaml', eligibleApprovers: ADMIN_ELIGIBLE, approvedBy: [] }),
      ],
    });
    // mergeable stays true (it's a soft warning, bypassable only by an admin in
    // mergePr) — the point is that the warning EXISTS, so a non-admin merge of a
    // roles.yaml-only PR is no longer silently waved through.
    expect(result.warnings).toContain('Waiting on approval for roles.yaml from Admin.');
    // Pin the non-blocking contract: this PR's guarantee is "warn, don't block".
    // If evaluateMergeGate ever starts adding blocking reasons or flipping
    // mergeable to false for an access-config file, these must fail.
    expect(result.mergeable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('treats an unapproved access.md change as a warning, at root and nested', () => {
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'access.md', eligibleApprovers: ADMIN_ELIGIBLE, approvedBy: [] }),
        approval({ path: 'Knowledge/Sales/access.md', eligibleApprovers: ADMIN_ELIGIBLE, approvedBy: [] }),
      ],
    });
    expect(result.warnings).toContain('Waiting on approval for access.md from Admin.');
    expect(result.warnings).toContain('Waiting on approval for Knowledge/Sales/access.md from Admin.');
    // Same non-blocking contract as roles.yaml: warn, never block.
    expect(result.mergeable).toBe(true);
    expect(result.reasons).toEqual([]);
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

  it('does not gate roles.yaml when no one is eligible to approve it', () => {
    // Mirrors the md path: a config file with no eligible approver can't be
    // approved, so it neither warns nor blocks (the merge-gate would otherwise
    // deadlock on an un-approvable file).
    const result = svc.evaluateMergeGate({
      prNumber: 1,
      state: 'open',
      approvals: [
        approval({ path: 'roles.yaml', eligibleApprovers: EMPTY_ELIGIBLE }),
      ],
    });
    expect(result.mergeable).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
