import type { ReactNode } from 'react';
import { Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import type { AccessProposal, AccessRequestRow } from '../requests.api';

/**
 * Somebody asked for access to this item — the editor-side face of an access
 * request, wherever the item lives: a plugin's page, a skill's page, or the
 * Manage access dialog of any file or folder.
 *
 * It shows what the request PROPOSES, one row per grant, because that is what
 * accepting acts on: each Accept writes exactly that one grant onto the
 * default branch through the ordinary access path. The request's branch is
 * never merged, so a request naming five people can be answered with two
 * yeses and three ignores, and nothing the branch happens to carry besides
 * the grants can ride in on a click.
 *
 * Naming the level is not pedantry: a request may propose `write` or `owner`
 * rather than `read`, and "asked for access to" would hide that. Whatever the
 * branch asks for is what the row says — in the caller's vocabulary, since a
 * dialog that calls it "Can edit" everywhere else must not suddenly say
 * "write" here.
 *
 * Decline rejects the whole request. Manage access is the third path — an
 * editor who wants to do something other than what was proposed opens the
 * dialog, and the request settles itself if that covers it. Inside that
 * dialog there is nothing to link to, so `folders` is empty there and the
 * link does not render.
 */

export interface AccessRequestsBannerProps {
  /** What the item is called on the line: a plugin, a skill, a file, a folder. */
  itemName: string;
  /** Repo-relative folders for `Manage access`. Empty ⇒ no link (the dialog). */
  folders: string[];
  requests: AccessRequestRow[];
  onManage(folder: string): void;
  onAccept(request: AccessRequestRow, proposal: AccessProposal): void;
  onDecline(request: AccessRequestRow): void;
  /** How to spell a verb. Defaults to the verb itself (the Library's wording). */
  verbLabel?(verb: AccessProposal['verb']): string;
  /** What went wrong answering this request, shown on its own line. */
  errorFor?(request: AccessRequestRow): string | null | undefined;
  /** Requests being answered right now — their buttons wait. */
  busyFor?(request: AccessRequestRow): boolean;
  className?: string;
}

export function AccessRequestsBanner({
  itemName,
  folders,
  requests,
  onManage,
  onAccept,
  onDecline,
  verbLabel = (verb) => verb,
  errorFor,
  busyFor,
  className,
}: AccessRequestsBannerProps) {
  if (requests.length === 0) return null;

  const accept = (request: AccessRequestRow, proposal: AccessProposal) => (
    <Button
      variant="outline"
      size="sm"
      disabled={busyFor?.(request) ?? false}
      aria-label={`Grant ${verbLabel(proposal.verb)} to ${proposal.label}`}
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
    const note = request.note?.trim();
    const failure = errorFor?.(request);
    lines.push({
      key: `request:${request.number}`,
      text: (
        <>
          {single ? (
            <>
              {`${request.requesterName} asked for access to ${itemName}: `}
              {single.label !== request.requesterName && `${single.label}, `}
              <span className="font-semibold">{verbLabel(single.verb)}</span>
            </>
          ) : (
            `${request.requesterName} asked for access to ${itemName}.`
          )}
          {/* The requester's own words, under the line they belong to and as
              plain text — it is someone else's writing, not markup. */}
          {note && (
            <span className="mt-0.5 block whitespace-pre-line text-detail text-ink-muted">
              {note}
            </span>
          )}
          {/* A refusal belongs to the request it refused, never only to a
              toast: this banner lives inside a dialog that has no toast host,
              and an error shown there would simply vanish. */}
          {failure && (
            <span role="alert" className="mt-0.5 block text-detail text-danger">
              {failure}
            </span>
          )}
        </>
      ),
      actions: (
        <>
          {single && accept(request, single)}
          <Button
            variant="quiet"
            size="sm"
            disabled={busyFor?.(request) ?? false}
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
            <span className="font-semibold">{verbLabel(proposal.verb)}</span>
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
                  own: the editor who wants something other than what was
                  proposed. It closes the banner's last line. */}
              {i === lines.length - 1 &&
                folders.map((folder) => (
                  <button
                    key={folder}
                    type="button"
                    className="ml-1 rounded-xs text-detail text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-muted"
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
