import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { Badge } from '../../../shared/components';
import { changeAuthorName } from '../../change-requests/utils/author';

interface ChangeRequestDockProps {
  crs: PullRequestSummary[];
  onSelect(cr: PullRequestSummary): void;
}

/**
 * Owner-only panel: a minimal name-list of the open change requests touching
 * this skill — nothing else (approved design). Selecting one opens the
 * side-by-side compare.
 *
 * It anchors to the VIEWPORT's right edge. It used to sit at
 * `right: calc(50% + 22.5rem)` — left of a centred dialog — and when the skill
 * detail became a page that put it on top of the plugin sidebar. A page has no
 * centred panel to hang off, so the edge is the only stable anchor.
 *
 * Renders nothing when there is nothing to review: an empty box floating beside
 * a skill states, permanently and to the one person who could act, that there
 * is work here — when there isn't.
 *
 * It sits in the app's PAGE-FURNITURE band (`z-30`), not the overlay bands: it
 * is ambient — always there while you read the skill — and nothing ambient may
 * cover something the user just opened. The bands, as used across the app, are
 * page content < 30 furniture < 40 anchored dropdowns < 50 modals < 60
 * full-screen surfaces. `Toolbar` establishes no stacking context, so its
 * `z-40` menus compete with this panel directly at the root: at its previous
 * `z-55` the dock won, and the open profile menu was covered by a list of
 * change requests (and so was any `z-50` dialog).
 *
 * An `<aside>`, not a div: `aria-label` on a generic element is DROPPED (a bare
 * div has the implicit `generic` role, which takes no accessible name), so the
 * label below was dead text and the panel was unreachable by landmark
 * navigation. The name is also what keeps it one: `<aside>` nested inside the
 * page's `<article>` degrades to `generic` UNLESS it is named, so the label and
 * the element depend on each other — do not drop either.
 */
export function ChangeRequestDock({ crs, onSelect }: ChangeRequestDockProps) {
  if (crs.length === 0) return null;

  return (
    <aside
      className="lib-cr-dock fixed right-6 top-1/2 z-30 flex max-h-[72vh] w-56 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay"
      aria-label="Change requests for this skill"
    >
      <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5 text-label font-semibold uppercase text-ink-muted">
        Change requests
        <Badge tone="wait" size="xs">
          {crs.length}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto px-2.5 pb-3">
        {crs.map((cr) => (
          <button
            key={cr.number}
            type="button"
            className="rounded-md border border-line bg-sunken px-3 py-2.5 text-left text-detail font-semibold text-ink transition-colors hover:border-line-strong"
            onClick={() => onSelect(cr)}
          >
            {cr.title}
            <span className="mt-0.5 block text-meta font-normal text-ink-faint">
              {changeAuthorName(cr)}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
