import { useLayoutEffect, useRef, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { Badge } from '../../../shared/components';
import { changeAuthorName } from '../utils/cr-author';

interface ChangeRequestDockProps {
  crs: PullRequestSummary[];
  onSelect(cr: PullRequestSummary): void;
}

/** How many requests stand fully visible before the rest scroll. */
const VISIBLE_CARDS = 3;

/**
 * Owner-only panel: a minimal name-list of the open change requests touching
 * this skill — nothing else (approved design). Selecting one opens the
 * side-by-side compare.
 *
 * It anchors to the VIEWPORT's right edge. It used to sit at
 * `right: calc(50% + 22.5rem)` — left of a centred dialog — and when the skill
 * detail became a page that put it on top of the group sidebar. A page has no
 * centred panel to hang off, so the edge is the only stable anchor.
 *
 * Two consequences of being fixed-position chrome, both handled here:
 *
 *  - It can sit ON the column it is about. So the `»` in the header folds it
 *    to a slim tab on the edge — count still showing, cards gone — and the
 *    tab unfolds it. The state is per MOUNT, deliberately: a decision queue
 *    that remembers being hidden across visits is one that quietly stops
 *    being seen.
 *  - It grows with its cards, and per-file change requests mean one person
 *    can now fill it. The list stops growing after the third card and scrolls
 *    the rest: three is enough to say "there is work here", which is the
 *    dock's whole job. The cap is MEASURED rather than a fixed height because
 *    titles wrap anywhere from one line to four (`… · scripts/export-pdf.py`),
 *    so any fixed number either beheads the third card or leaves room for a
 *    fourth.
 *
 * Renders nothing when there is nothing to review: an empty box floating beside
 * a skill states, permanently and to the one person who could act, that there
 * is work here — when there isn't.
 *
 * An `<aside>`, not a div: `aria-label` on a generic element is DROPPED (a bare
 * div has the implicit `generic` role, which takes no accessible name), so the
 * label below was dead text and the panel was unreachable by landmark
 * navigation. The name is also what keeps it one: `<aside>` nested inside the
 * page's `<article>` degrades to `generic` UNLESS it is named, so the label and
 * the element depend on each other — do not drop either. The collapsed tab
 * keeps both for the same reason.
 */
export function ChangeRequestDock({ crs, onSelect }: ChangeRequestDockProps) {
  const [collapsed, setCollapsed] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const [listMaxH, setListMaxH] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (collapsed) return; // no list on screen, nothing to measure
    const el = list.current;
    if (!el) return;

    const measure = () => {
      if (crs.length <= VISIBLE_CARDS) {
        setListMaxH(undefined);
        return;
      }
      const third = el.children[VISIBLE_CARDS - 1] as HTMLElement | undefined;
      if (!third) return;
      // The third card's bottom edge in the list's CONTENT coordinates —
      // `scrollTop` folds a mid-scroll re-measure back in. Guarded to > 0
      // because a layout-less environment (tests) answers 0, and a 0 cap
      // would not be "three visible", it would be none.
      const cap =
        third.getBoundingClientRect().bottom - el.getBoundingClientRect().top + el.scrollTop;
      setListMaxH(cap > 0 ? cap : undefined);
    };

    measure();
    // Cards change height after the first paint — fonts arrive, titles
    // re-wrap on zoom — and the cap has to follow the third card's edge.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    for (const card of Array.from(el.children)) ro.observe(card);
    return () => ro.disconnect();
  }, [crs, collapsed]);

  if (crs.length === 0) return null;

  if (collapsed) {
    return (
      <aside
        className="lib-cr-dock fixed right-0 top-1/2 z-[55] -translate-y-1/2"
        aria-label="Change requests for this skill"
      >
        <button
          type="button"
          aria-label="Show the change requests"
          aria-expanded={false}
          title="Show the change requests"
          className="flex items-center gap-1.5 rounded-l-xl border border-r-0 border-line bg-surface py-2.5 pl-2 pr-1.5 text-detail text-ink-muted shadow-overlay transition-colors hover:text-ink"
          onClick={() => setCollapsed(false)}
        >
          <span aria-hidden>«</span>
          <Badge tone="wait" size="xs">
            {crs.length}
          </Badge>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className="lib-cr-dock fixed right-6 top-1/2 z-[55] flex max-h-[72vh] w-56 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-overlay"
      aria-label="Change requests for this skill"
    >
      <div className="flex items-center gap-2 px-4 pb-2.5 pt-3.5 text-label font-semibold uppercase text-ink-muted">
        Change requests
        <Badge tone="wait" size="xs">
          {crs.length}
        </Badge>
        <button
          type="button"
          aria-label="Collapse the change requests"
          aria-expanded={true}
          title="Collapse the change requests"
          className="-mr-2 ml-auto rounded-sm px-1.5 py-0.5 text-detail text-ink-faint transition-colors hover:bg-hover hover:text-ink"
          onClick={() => setCollapsed(true)}
        >
          <span aria-hidden>»</span>
        </button>
      </div>
      <div
        ref={list}
        style={{ maxHeight: listMaxH }}
        className="flex flex-col gap-2 overflow-y-auto px-2.5 pb-3"
      >
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
