import { Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';

/**
 * Somebody asked to join this group — the owner-side face of a join change
 * request.
 *
 * A join request IS a CR (one commit adding the requester to the group's
 * `access.md` body `read:` list), so the two actions here are CR actions
 * wearing friendlier copy: Approve merges it, Dismiss rejects it. `Manage
 * access` stays as the third path — granting somebody in through the dialog
 * makes their CR moot, and merging it afterwards is a harmless no-op diff.
 *
 * The rows come from the caller's CR list filtered by the join-branch
 * convention (`isJoinBranchFor`) — nothing here fetches; the Library's data
 * host already carries every open CR.
 */

export interface JoinRequestRow {
  /** The change request number — what Approve/Dismiss act on. */
  number: number;
  requesterName: string;
}

export interface AccessRequestsBannerProps {
  group: string;
  /** Repo-relative group folder for `Manage access` (single-element today). */
  folders: string[];
  requests: JoinRequestRow[];
  onManage(folder: string): void;
  /** Merge the CR — approving IS merging. */
  onApprove(number: number): void;
  /** Reject the CR. */
  onDismiss(number: number): void;
  className?: string;
}

export function AccessRequestsBanner({
  group,
  folders,
  requests,
  onManage,
  onApprove,
  onDismiss,
  className,
}: AccessRequestsBannerProps) {
  if (requests.length === 0) return null;

  const names = requests.map((r) => r.requesterName);
  const line =
    requests.length === 1
      ? `${names[0]} asked to join ${group} — approving merges their request.`
      : `${requests.length} people asked to join ${group}: ${joinNames(names)}.`;

  return (
    <Banner role="status" tone="wait" className={cn('mb-4', className)}>
      <p>{line}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {requests.map((request) => (
          <span key={request.number} className="inline-flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              aria-label={`Approve request from ${request.requesterName}`}
              onClick={() => onApprove(request.number)}
            >
              Approve
            </Button>
            <Button
              variant="quiet"
              size="sm"
              aria-label={`Dismiss request from ${request.requesterName}`}
              onClick={() => onDismiss(request.number)}
            >
              Dismiss
            </Button>
          </span>
        ))}
        {folders.map((folder) => (
          <Button key={folder} variant="quiet" size="sm" onClick={() => onManage(folder)}>
            Manage access
          </Button>
        ))}
      </div>
    </Banner>
  );
}

/** `A`, `A and B`, `A, B and C` — the way a person lists people out loud. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
