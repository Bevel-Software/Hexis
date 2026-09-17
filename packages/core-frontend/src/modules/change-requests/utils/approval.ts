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

