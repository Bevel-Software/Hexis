import type { FileApprovalState } from '@bevel-software/platform-shared';

/**
 * Whether the viewer's OWN current confirmation is on the file — the undo
 * toggles yours, nobody else's, and stale rows stay for audit without arming
 * it (presplit PrFileRow's rule, kept verbatim).
 */
export function hasOwnApproval(approval: FileApprovalState | undefined, viewerEmail: string) {
  const email = viewerEmail.trim().toLowerCase();
  return (
    !!email &&
    !!approval?.approvedBy.some((a) => a.email.toLowerCase() === email && !a.isStale)
  );
}

/**
 * Whether the merge gate binds this file — the backend's `isGateRelevant`,
 * mirrored: markdown nodes and the access config (`roles.yaml`, any
 * `access.md`) that someone is eligible to approve. Everything else neither
 * warns nor blocks, so it must not hold up Apply or name anyone to wait on.
 */
export function isGateRelevant(approval: FileApprovalState) {
  const hasEligible =
    approval.eligibleApprovers.roles.length > 0 || approval.eligibleApprovers.users.length > 0;
  return (
    hasEligible && (approval.path.toLowerCase().endsWith('.md') || approval.path === 'roles.yaml')
  );
}
