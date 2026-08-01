import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../../lib/utils';
import { pathForGroupsIndex } from '../routes/library-paths';
import type { LibraryItem } from '../state/library-data';
import { LibraryCard } from './LibraryCard';

/**
 * The furniture a group page is made of, shared by the two pages that are one.
 *
 * `GroupPage` (a folder in the KB) and `PersonalGroupPage` (the items in no
 * folder at all) are different QUERIES over the same catalog, and the user
 * asked for the second to look like the first. Shared components rather than a
 * copy: a group page is a promise about layout, and two implementations of one
 * promise drift the first time either is touched.
 */

/** `All groups › {name}` — the page's place in the Library, and the way back. */
export function GroupBreadcrumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-detail text-ink-faint">
      <Link to={pathForGroupsIndex()} className="rounded-xs hover:text-ink">
        All groups
      </Link>
      <span aria-hidden="true">›</span>
      <span aria-current="page" className="truncate text-ink-muted">
        {name}
      </span>
    </nav>
  );
}

/** A titled band with the count beside — not inside — the heading, so the
 *  heading's accessible name stays exactly "Skills" / "Tools". */
export function GroupSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mt-7">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-label uppercase text-ink-faint">{title}</h2>
        <span className="text-meta tabular-nums text-ink-faint">{count}</span>
      </div>
      {children}
    </section>
  );
}

export function CardGrid({
  items,
  onOpen,
}: {
  items: LibraryItem[];
  onOpen(item: LibraryItem): void;
}) {
  return (
    <div className={cn('grid gap-2.5', 'grid-cols-[repeat(auto-fill,minmax(248px,1fr))]')}>
      {items.map((item) => (
        <LibraryCard
          key={`${item.kind}:${item.id}`}
          kind={item.kind}
          id={item.id}
          name={item.name}
          description={item.description}
          owned={item.owned}
          status={item.status}
          version={item.version}
          onOpen={() => onOpen(item)}
        />
      ))}
    </div>
  );
}

/**
 * The Skills and Tools bands, in that order, with their empty states.
 *
 * The empty copy differs per page (a group can be filled by an agent; your own
 * space is filled by you), so it arrives as props rather than being derived
 * from a name here.
 */
export function GroupItemSections({
  skillItems,
  toolItems,
  onOpen,
  emptySkills,
  emptyTools = 'No tools yet.',
  hideEmpty = false,
}: {
  skillItems: LibraryItem[];
  toolItems: LibraryItem[];
  onOpen(item: LibraryItem): void;
  emptySkills: string;
  emptyTools?: string;
  /**
   * Drop a band with nothing in it instead of showing its empty state.
   *
   * A GROUP says "No skills yet" because the absence is a fact about that
   * group and an invitation to fix it. A SEARCH RESULT says nothing, because
   * "No tools yet" under a query for `rfi` is not a fact about your library.
   */
  hideEmpty?: boolean;
}) {
  return (
    <>
      {!(hideEmpty && skillItems.length === 0) && (
        <GroupSection title="Skills" count={skillItems.length}>
          {skillItems.length === 0 ? (
            <p className="text-ui text-ink-faint">{emptySkills}</p>
          ) : (
            <CardGrid items={skillItems} onOpen={onOpen} />
          )}
        </GroupSection>
      )}

      {!(hideEmpty && toolItems.length === 0) && (
        <GroupSection title="Tools" count={toolItems.length}>
          {toolItems.length === 0 ? (
            <p className="text-ui text-ink-faint">{emptyTools}</p>
          ) : (
            <CardGrid items={toolItems} onOpen={onOpen} />
          )}
        </GroupSection>
      )}
    </>
  );
}

export function PageNote({ children }: { children: ReactNode }) {
  return <div className="py-16 text-center text-ui text-ink-faint">{children}</div>;
}

/**
 * Three nodes and the lines between them — the prototype's `SHARE_SVG`
 * (line 1640), unchanged. Inline for the same reason as `LockGlyph`: it
 * inherits `currentColor` from the button it sits in.
 */
export function ShareGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
    >
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="3.5" r="2" />
      <circle cx="12" cy="12.5" r="2" />
      <path d="m5.8 7 4.4-2.4M5.8 9l4.4 2.4" />
    </svg>
  );
}
