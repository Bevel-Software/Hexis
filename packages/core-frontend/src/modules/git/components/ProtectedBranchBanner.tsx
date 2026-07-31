import { AlertTriangle } from 'lucide-react';
import { isProtectedBranch, protectedBranchDisplayName, DEFAULT_BRANCH } from '@bevel-software/shared';
import { useGit } from '../state/git.context';

export function ProtectedBranchBanner() {
  const git = useGit();
  const branch = git.status?.branch;
  if (git.availability !== 'ready' || !isProtectedBranch(branch)) {
    return null;
  }

  const displayName = protectedBranchDisplayName(branch) ?? branch;
  // On the default branch, drafts naturally land back on it, so the call-to-
  // action is generic. On any other protected branch, point users at the
  // default branch as the usual propose target (e.g. Current is updated
  // separately by leadership rolling the Target company state in).
  const defaultDisplayName = protectedBranchDisplayName(DEFAULT_BRANCH) ?? DEFAULT_BRANCH;
  const callToAction =
    branch === DEFAULT_BRANCH
      ? 'most users propose updates by starting a shared draft'
      : `most users propose updates by starting a shared draft against the ${defaultDisplayName}`;

  // The banner is now informational only: write access is governed by
  // roles.yaml + access.md, not by which branch is checked out. Users who
  // hold the right role (Admin) may edit directly; others will be refused
  // by the backend with a per-path AccessDenied message at commit time.
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 shrink-0"
    >
      <AlertTriangle size={13} className="shrink-0" />
      <span className="flex-1">
        You are viewing the <span className="font-semibold">{displayName}</span> (
        <span className="font-mono font-semibold">{branch}</span>) — {callToAction}.
      </span>
    </div>
  );
}

/** Re-exported for call sites that already imported from this component. */
export { isProtectedBranch as isProtectedBranchName } from '@bevel-software/shared';
