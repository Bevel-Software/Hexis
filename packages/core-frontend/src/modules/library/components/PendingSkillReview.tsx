import { DEFAULT_BRANCH, type PullRequestSummary } from '@bevel-software/platform-shared';
import { CompareView } from './CompareView';
import { useLibrary, type LibraryItem } from '../state/library-data';
import type { LibrarySkill } from '../services/library.api';

/**
 * The review surface for a skill that does not exist yet.
 *
 * A released skill opens its own page, and the change requests against it hang
 * off the file they touch. A PROPOSED skill has neither — there is no page,
 * because there is no skill on the default branch to build one from — so the
 * card opens the change request itself, which is the whole of what there is to
 * read and the only place the decision can be made.
 *
 * `CompareView` needs no adapting for this: it diffs each file against the
 * default branch EXCEPT the ones the request adds, and every file of a new
 * skill is added, so it renders the proposal as one green document and its
 * Apply button records the approvals and merges. The `skill` it takes is only
 * ever read for `path` and `files`, and a proposal's released file list is
 * empty by definition — the request's own `added` files supply the rest.
 */
export function PendingSkillReview({
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
  // did not. `CompareView` fetches its own detail and only reads the title,
  // branch and author off this, all of which the pending entry already carries
  // — so a failed list degrades to a plainer header, not to a dead card.
  const cr =
    data.crs.find((c) => c.number === pending.changeRequestNumber) ??
    standInFor(item, pending);

  const skill: LibrarySkill = {
    name: item.name,
    description: item.description,
    version: item.version,
    path: item.path,
    // Nothing is released yet: no body to read on the default branch, and no
    // released files to list beside the proposed ones.
    body: '',
    files: [],
  };

  return <CompareView skill={skill} cr={cr} onClose={onClose} onResolved={onResolved} />;
}

function standInFor(
  item: LibraryItem,
  pending: NonNullable<LibraryItem['pending']>,
): PullRequestSummary {
  return {
    number: pending.changeRequestNumber,
    title: `New skill — ${item.name}`,
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
