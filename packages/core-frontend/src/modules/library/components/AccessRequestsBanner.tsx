import { Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import type { GroupAccessRequestEntry } from '../services/groups.api';
import { joinNames } from './LockedGroupView';

/**
 * The admin half of locked groups: somebody asked to get in.
 *
 * There is no approve button here, and that is the design. Granting read IS
 * approving — the request row retires itself the moment the server sees the
 * requester can read the folder — so the only two actions are the ones that
 * change something: open the access dialog, or say no. A third button that
 * merely marked a row "approved" without granting anything would be a lie with
 * a green tick on it.
 *
 * Who sees this is decided entirely server-side: `GET /api/groups/access-requests`
 * returns only rows for groups the caller can write the `access.md` of, and `[]`
 * (never a 403) for everyone else. So there is no role check in this file, and
 * there must never be one — the wire is the permission.
 *
 * Names only, never the requesters' emails. The endpoint does hand them over —
 * an admin granting access needs one — but the banner is a notice, and the
 * dialog it opens is where an email belongs.
 */

export interface AccessRequestsBannerProps {
  group: string;
  /** The group's constituent folders — two on an unmigrated KB, one after. */
  folders: string[];
  /** Pending requests for THIS group; the banner renders nothing when empty. */
  requests: GroupAccessRequestEntry[];
  onManage(folder: string): void;
  onDismiss(id: string): void;
  /** Spacing from whatever it sits under — the page owns its own rhythm. */
  className?: string;
}

export function AccessRequestsBanner({
  group,
  folders,
  requests,
  onManage,
  onDismiss,
  className,
}: AccessRequestsBannerProps) {
  if (requests.length === 0) return null;

  const names = requests.map((r) => r.requesterName);
  const line =
    requests.length === 1
      ? `${names[0]} asked to join ${group} — grant read access to let them in.`
      : `${requests.length} people asked to join ${group}: ${joinNames(names)}.`;

  return (
    <Banner role="status" tone="wait" className={cn('mb-4', className)}>
      <p>{line}</p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {folders.map((folder) => (
          <Button key={folder} variant="outline" size="sm" onClick={() => onManage(folder)}>
            Manage access
          </Button>
        ))}

        {requests.map((request) => (
          <Button
            key={request.id}
            variant="quiet"
            size="sm"
            aria-label={`Dismiss request from ${request.requesterName}`}
            onClick={() => onDismiss(request.id)}
          >
            Dismiss
          </Button>
        ))}
      </div>
    </Banner>
  );
}

