import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Funnel, RotateCw } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { IconButton } from '../../../shared/components';
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

/**
 * A titled band. The count sits beside — not inside — the heading, so the
 * heading's accessible name stays exactly "Skills" / "Tools".
 *
 * The count and the controls are QUIET: invisible until you hover or focus
 * into the row (proto:145-156). On a band of cards you can already see roughly
 * how many there are, and you only reach for a filter when you want it, so
 * neither earns permanent ink beside a heading. They are hidden with `opacity`
 * rather than `display` so nothing shifts under the cursor as the row lights
 * up. `focus-within` is what keeps that honest for anyone who never hovers.
 *
 * The exceptions are the CALLER's to declare, and they have to be declared
 * here: `opacity` composites, so an `opacity-100` on a control nested inside an
 * `opacity-0` wrapper multiplies to zero and changes nothing. A filter that is
 * switched on has to stay lit — a filter you cannot see is a page lying about
 * what it is showing — so `controlsActive` lifts the whole wrapper instead.
 */
export function GroupSection({
  title,
  count,
  controls,
  controlsActive = false,
  children,
}: {
  title: string;
  count: number;
  /** Filter / refresh, right of the count. Fades with it. */
  controls?: ReactNode;
  /**
   * Keep `controls` visible without hover or focus — for when one of them is
   * doing something the reader has to be able to see (a filter that is on, a
   * refresh in flight).
   */
  controlsActive?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="mt-7">
      <div className="group/band mb-2.5 flex items-center gap-2">
        <h2 className="text-label uppercase text-ink-faint">{title}</h2>
        <span
          className={cn(
            'text-meta tabular-nums text-ink-faint opacity-0 transition-opacity',
            'group-hover/band:opacity-100 group-focus-within/band:opacity-100',
          )}
        >
          {count}
        </span>
        {controls && (
          <span
            className={cn(
              'flex items-center gap-0.5 transition-opacity',
              controlsActive
                ? 'opacity-100'
                : 'opacity-0 group-hover/band:opacity-100 group-focus-within/band:opacity-100',
            )}
          >
            {controls}
          </span>
        )}
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
    <div className={cn('grid gap-2.5', 'grid-cols-[repeat(auto-fill,minmax(236px,1fr))]')}>
      {items.map((item) => (
        // The change-request number is part of the key, not decoration: two
        // people can propose a skill of the same name into different groups,
        // and until one of them merges neither is in the catalog to collide
        // with — so the name alone is not yet unique.
        <LibraryCard
          key={`${item.kind}:${item.id}:${item.pending?.changeRequestNumber ?? ''}`}
          kind={item.kind}
          id={item.id}
          name={item.name}
          description={item.description}
          owned={item.owned}
          status={item.status}
          version={item.version}
          pending={
            item.pending && {
              authorName: item.pending.authorName,
              mine: item.pending.mine,
            }
          }
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
  skillControls,
  skillControlsActive = false,
}: {
  skillItems: LibraryItem[];
  toolItems: LibraryItem[];
  onOpen(item: LibraryItem): void;
  emptySkills: string;
  emptyTools?: string;
  /**
   * Filter / refresh for the Skills band only. Tools deliberately gets none
   * (proto:3078 carries the count alone): a tool that needs setup already says
   * so on its own card, and there is nothing to re-check that the card does not
   * already show.
   */
  skillControls?: ReactNode;
  /** One of `skillControls` is mid-act — keep the row visible. See `GroupSection`. */
  skillControlsActive?: boolean;
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
        <GroupSection
          title="Skills"
          count={skillItems.length}
          controls={skillControls}
          controlsActive={skillControlsActive}
        >
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

/**
 * The two controls that ride the Skills heading (proto:2584-2589).
 *
 * `filter` narrows the band to the items waiting on you, and it STAYS LIT when
 * on — a filter you cannot see is a page lying about what it is showing. The
 * opting-out is `GroupSection`'s `controlsActive`, because that is the element
 * carrying the fade; an `opacity-100` on the button inside it would multiply
 * against the wrapper's zero and do nothing.
 *
 * `refresh` re-reads the library and then says when it last did, because
 * "nothing changed" and "nothing was checked" look identical otherwise. It
 * only appears once there is something to filter — a filter that empties the
 * page is a trap (proto:2579).
 */
export function BandControls({
  attention,
  filterOn,
  onToggleFilter,
  onRefresh,
  refreshState,
}: {
  /** How many items need the reader. Zero hides the filter entirely. */
  attention: number;
  filterOn: boolean;
  onToggleFilter(): void;
  onRefresh(): void;
  refreshState: 'idle' | 'spin' | 'done';
}) {
  return (
    <>
      {attention > 0 && (
        <IconButton
          size={18}
          aria-label={filterOn ? 'Show everything' : 'Show only what needs you'}
          title={filterOn ? 'Show everything' : 'Show only what needs you'}
          aria-pressed={filterOn}
          active={filterOn}
          className={cn(filterOn && 'opacity-100')}
          onClick={onToggleFilter}
        >
          <Funnel size={12} />
        </IconButton>
      )}
      {refreshState === 'done' ? (
        <span className="text-meta text-ink-faint opacity-100">Last updated just now</span>
      ) : (
        <IconButton
          size={18}
          aria-label="Check for updates"
          title="Check for updates"
          className={cn(refreshState === 'spin' && 'opacity-100')}
          onClick={onRefresh}
        >
          <RotateCw size={12} className={cn(refreshState === 'spin' && 'animate-spin')} />
        </IconButton>
      )}
    </>
  );
}
