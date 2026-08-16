import { Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import type { JoinProposal, JoinRequest } from '../services/plugins.api';

/**
 * Somebody asked for access to this plugin — the manager-side face of a join change
 * request.
 *
 * It shows what the request PROPOSES, one row per grant, because that is what
 * accepting acts on: each Accept writes exactly that one grant onto the
 * default branch through the ordinary access path. The request's branch is
 * never merged, so a request naming five people can be answered with two
 * yeses and three ignores, and nothing the branch happens to carry besides
 * the grants can ride in on a click.
 *
 * Naming the verb is not pedantry: a request may propose `write` or `owner`
 * rather than `read`, and "asked for access to" would hide that. Whatever the
 * branch asks for is what the row says.
 *
 * Decline rejects the whole request. Manage access is the third path — a
 * manager who wants to do something other than what was proposed opens the
 * dialog, and the request settles itself if that covers it.
 */

export interface AccessRequestsBannerProps {
  plugin: string;
  /** Repo-relative plugin folder for `Manage access` (single-element today). */
  folders: string[];
  requests: JoinRequest[];
  onManage(folder: string): void;
  onAccept(request: JoinRequest, proposal: JoinProposal): void;
  onDecline(request: JoinRequest): void;
  className?: string;
}

export function AccessRequestsBanner({
  plugin,
  folders,
  requests,
  onManage,
  onAccept,
  onDecline,
  className,
}: AccessRequestsBannerProps) {
  if (requests.length === 0) return null;

  return (
    <Banner role="status" tone="wait" className={cn('mb-4', className)}>
      <p>
        {requests.length === 1
          ? `${requests[0].requesterName} asked for access to ${plugin}.`
          : `${requests.length} people asked for access to ${plugin}.`}
      </p>

      <div className="mt-2 flex flex-col gap-2">
        {requests.map((request) => (
          <div key={request.number} className="flex flex-col gap-1">
            {requests.length > 1 && (
              <span className="text-meta font-semibold text-ink">{request.requesterName}</span>
            )}
            {request.proposals.map((proposal) => (
              <div
                key={`${proposal.verb}:${proposal.id}`}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="min-w-0 flex-1 truncate">
                  {proposal.label}: <span className="font-semibold">{proposal.verb}</span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Grant ${proposal.verb} to ${proposal.label}`}
                  onClick={() => onAccept(request, proposal)}
                >
                  Accept
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Decline the request from ${request.requesterName}`}
                onClick={() => onDecline(request)}
              >
                Decline
              </Button>
            </div>
          </div>
        ))}
        {folders.map((folder) => (
          <div key={folder}>
            <Button variant="quiet" size="sm" onClick={() => onManage(folder)}>
              Manage access
            </Button>
          </div>
        ))}
      </div>
    </Banner>
  );
}
