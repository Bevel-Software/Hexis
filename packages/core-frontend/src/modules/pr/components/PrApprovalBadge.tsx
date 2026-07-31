import { Check, Clock } from 'lucide-react';
import type { FileApprovalState } from '@bevel-software/platform-shared';

interface Props {
  state: FileApprovalState | undefined;
  size?: number;
}

function eligibleSummary(state: FileApprovalState): string {
  const parts: string[] = [];
  if (state.eligibleApprovers.roles.length) parts.push(state.eligibleApprovers.roles.join(', '));
  if (state.eligibleApprovers.users.length) {
    parts.push(
      state.eligibleApprovers.users
        .map((u) => (u.name ? u.name : u.email))
        .join(', '),
    );
  }
  return parts.join('; ') || 'someone with write access';
}

/**
 * Small inline badge for the file row. Only renders for files the merge gate
 * cares about — md files with at least one eligible approver. Non-md files
 * and md files outside the access-controlled surface (no role/user grants
 * write) are outside the gate, so we show no badge at all to keep the file
 * list quiet.
 *
 *   ✓ green   — at least one eligible approver has a non-stale approval.
 *   ⏳ amber  — only stale approvals exist; needs re-review after the latest push.
 *   · grey   — no approval yet; default waiting state.
 */
export function PrApprovalBadge({ state, size = 12 }: Props) {
  if (!state) return null;
  const isMd = state.path.toLowerCase().endsWith('.md');
  const hasEligible =
    state.eligibleApprovers.roles.length > 0 || state.eligibleApprovers.users.length > 0;
  if (!isMd || !hasEligible) return null;

  if (state.isApproved) {
    const label = `Confirmed by ${eligibleSummary(state)}`;
    return (
      <span
        role="img"
        aria-label={label}
        className="flex items-center gap-0.5 text-emerald-600 shrink-0"
        title={label}
      >
        <Check size={size} />
      </span>
    );
  }

  const staleCount = state.approvedBy.filter((a) => a.isStale).length;
  if (staleCount > 0) {
    const label = 'Confirmation outdated — please re-confirm after the latest edits';
    return (
      <span
        role="img"
        aria-label={label}
        className="flex items-center gap-0.5 text-amber-600 shrink-0"
        title={label}
      >
        <Clock size={size} />
      </span>
    );
  }

  const label = `Waiting on ${eligibleSummary(state)}`;
  return (
    <span
      role="img"
      aria-label={label}
      className="flex items-center gap-0.5 text-slate-600 shrink-0"
      title={label}
    >
      <Clock size={size} />
    </span>
  );
}
