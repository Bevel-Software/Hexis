import { DEFAULT_BRANCH, type PullRequestSummary } from '@bevel-software/platform-shared';
import { ChangeRequestDialog } from '../../change-requests/components/ChangeRequestDialog';
import { useLibrary, type LibraryItem } from '../state/library-data';

/**
 * The review surface for a skill or a tool that does not exist yet.
 *
 * A released item opens its own page, and the change requests against it hang
 * off the file they touch. A PROPOSED one has neither — there is no page,
 * because there is nothing on the default branch to build one from — so the
 * card opens the change request itself, which is the whole of what there is to
 * read and the only place the decision can be made. That is also what keeps a
 * proposal from being OPENED AS THE THING: a tool page would try to probe a
 * connection for a manual the catalog has never seen.
 *
 * `ChangeRequestDialog` needs no adapting for this: it always lists every file
 * the request touches and diffs each against the default branch EXCEPT the
 * ones the request adds, and every file of a new skill is added, so it renders
 * the proposal as one green document and its Apply button records the
 * approvals and merges. No scope either — a scope only ADDS a surface's
 * released files to the list, and a proposal has none by definition.
 *
 * A proposed MCP SERVER is the one case whose file is not wholly new: the
 * server is a key added to a plugin's `mcp.json`, which may already exist. The
 * dialog handles that as it handles any other edit — the diff against the
 * default branch — so the reader sees the added entry in its context.
 */
export function PendingItemReview({
  item,
  onClose,
  onResolved,
}: {
  /** A `LibraryItem` carrying `pending` — anything else renders nothing. */
  item: LibraryItem;
  onClose(): void;
  onResolved(): void;
}) {
  const data = useLibrary();
  const pending = item.pending;
  if (!pending) return null;

  // The real summary when the change-request list loaded, a stand-in when it
  // did not. The dialog fetches its own detail and only reads the title,
  // branch and author off this, all of which the pending entry already carries
  // — so a failed list degrades to a plainer header, not to a dead card.
  const cr =
    data.crs.find((c) => c.number === pending.changeRequestNumber) ??
    standInFor(item, pending);

  return <ChangeRequestDialog cr={cr} onClose={onClose} onResolved={onResolved} />;
}

function standInFor(
  item: LibraryItem,
  pending: NonNullable<LibraryItem['pending']>,
): PullRequestSummary {
  return {
    number: pending.changeRequestNumber,
    title: `New ${item.kind === 'skill' ? 'skill' : 'tool'}: ${item.name}`,
    author: { login: '', name: pending.authorName },
    appAuthor: { name: pending.authorName },
    branch: pending.branch,
    base: DEFAULT_BRANCH,
    state: 'open',
    createdAt: '',
    touchedNodePaths: [],
    review: { approvals: 0, changesRequested: 0, pendingLogins: [] },
    url: `/change-requests/${pending.changeRequestNumber}`,
  };
}
