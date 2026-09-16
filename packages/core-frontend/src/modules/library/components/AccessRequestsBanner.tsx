import type { ReactNode } from 'react';
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

  const accept = (request: JoinRequest, proposal: JoinProposal) => (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Grant ${proposal.verb} to ${proposal.label}`}
      onClick={() => onAccept(request, proposal)}
    >
      Accept
    </Button>
  );

  // One line per request, naming the requester and ending in its answers. A
  // request proposing ONE grant says which on that line, so Accept and Decline
  // sit together; a request proposing several gives each its own line and
  // Accept, and keeps Decline — which answers the whole request — on the
  // requester's line.
  const lines: { key: string; text: ReactNode; actions: ReactNode; nested?: boolean }[] = [];
  for (const request of requests) {
    const single = request.proposals.length === 1 ? request.proposals[0] : null;
    lines.push({
      key: `request:${request.number}`,
      text: single ? (
        <>
          {`${request.requesterName} asked for access to ${plugin}: `}
          {single.label !== request.requesterName && `${single.label}, `}
          <span className="font-semibold">{single.verb}</span>
        </>
      ) : (
        `${request.requesterName} asked for access to ${plugin}.`
      ),
      actions: (
        <>
          {single && accept(request, single)}
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Decline the request from ${request.requesterName}`}
            onClick={() => onDecline(request)}
          >
            Decline
          </Button>
        </>
      ),
    });
    if (single) continue;
    for (const proposal of request.proposals) {
      lines.push({
        key: `proposal:${request.number}:${proposal.verb}:${proposal.id}`,
        text: (
          <>
            {`${proposal.label}: `}
            <span className="font-semibold">{proposal.verb}</span>
          </>
        ),
        actions: accept(request, proposal),
        nested: true,
      });
    }
  }

  return (
    <Banner role="status" tone="wait" className={cn('mb-4', className)}>
      <div className="flex flex-col gap-1.5">
        {lines.map((line, i) => (
          <div
            key={line.key}
            className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', line.nested && 'pl-4')}
          >
            <span className="min-w-0 flex-1">{line.text}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              {line.actions}
              {/* The third path, said as a link rather than a button of its
                  own: the manager who wants something other than what was
                  proposed. It closes the banner's last line. */}
              {i === lines.length - 1 &&
                folders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className="ml-1 rounded-xs text-detail text-ink-muted underline underline-offset-2 hover:text-ink"
                    onClick={() => onManage(folder)}
                  >
                    Manage access
                  </button>
                ))}
            </span>
          </div>
        ))}
      </div>
    </Banner>
  );
}
