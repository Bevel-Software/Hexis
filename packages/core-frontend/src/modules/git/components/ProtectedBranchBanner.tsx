import { Info } from 'lucide-react';
import { isProtectedBranch, protectedBranchDisplayName, DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { useGit } from '../state/git.context';

/**
 * "You're reading the shared version" — said in a way that helps.
 *
 * The old copy read: *"You are viewing the Target company state
 * (target-company-state) — most users propose updates by starting a shared
 * draft."* Four things were working against it, and none of them were the
 * layout, which is why this rewrite keeps the strip exactly as it was:
 *
 *  1. It printed the branch SLUG next to the display name. `target-company-state`
 *     is the same fact in the machine's spelling — noise to everyone who is not
 *     debugging, and the one piece of the sentence that made it look like a
 *     system message rather than a note to a person.
 *  2. "most users" hedged. The reader does not care what most users do; they
 *     want to know what THEY should do, and a statistic about other people is
 *     not an instruction.
 *  3. It never said what the thing IS. "Target company state" is only
 *     meaningful if you already know — so the banner explained the mechanism
 *     to people who needed the concept.
 *  4. `AlertTriangle` on a purely informational strip. Nothing is wrong; the
 *     triangle said otherwise, which is how a banner trains people to dismiss
 *     it. Same amber (this IS the read-mostly surface, and the tint is doing
 *     real work), quieter glyph.
 */
export function ProtectedBranchBanner() {
  const git = useGit();
  const branch = git.status?.branch;
  if (git.availability !== 'ready' || !isProtectedBranch(branch)) {
    return null;
  }

  const displayName = protectedBranchDisplayName(branch) ?? branch;
  const defaultDisplayName = protectedBranchDisplayName(DEFAULT_BRANCH) ?? DEFAULT_BRANCH;
  // Two different situations, two different sentences. On the default branch a
  // draft lands back here, so the instruction is about editing. On any other
  // protected branch (Current, which leadership updates by rolling the target
  // in) editing here is the wrong move entirely, so the sentence redirects.
  const explanation =
    branch === DEFAULT_BRANCH
      ? "the version everyone works from. To change something, start a draft — your edits become a change request someone reviews."
      : `a record of how things work today. It changes when the ${defaultDisplayName} rolls in, so propose your edits there instead.`;

  // Informational only: write access is governed by roles.yaml + access.md,
  // not by which branch is checked out. Someone with the role may edit right
  // here; everyone else is refused per-path at commit time with a reason.
  return (
    <div
      role="status"
      className="flex items-center gap-2 px-3 py-1.5 bg-wait-soft border-b border-line text-xs text-ink shrink-0"
    >
      <Info size={13} className="shrink-0" />
      <span className="flex-1">
        You&apos;re reading the <span className="font-semibold">{displayName}</span> —{' '}
        {explanation}
      </span>
    </div>
  );
}

/** Re-exported for call sites that already imported from this component. */
export { isProtectedBranch as isProtectedBranchName } from '@bevel-software/platform-shared';
