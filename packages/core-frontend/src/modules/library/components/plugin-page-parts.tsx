import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Funnel, RotateCw, Trash2 } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Banner, Button, Dialog, IconButton } from '../../../shared/components';
import { pathForPluginsIndex } from '../routes/library-paths';
import type { LibraryItem } from '../state/library-data';
import { removeLibraryItem } from '../services/library.api';
import { LibraryCard } from './LibraryCard';

/**
 * The furniture a plugin page is made of, shared by the two pages that are one.
 *
 * `PluginPage` (a folder in the KB) and `PersonalPluginPage` (the items in no
 * folder at all) are different QUERIES over the same catalog, and the user
 * asked for the second to look like the first. Shared components rather than a
 * copy: a plugin page is a promise about layout, and two implementations of one
 * promise drift the first time either is touched.
 */

/** `All plugins › {name}` — the page's place in the Library, and the way back. */
export function PluginBreadcrumb({ name }: { name: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-detail text-ink-faint">
      <Link to={pathForPluginsIndex()} className="rounded-xs hover:text-ink">
        All plugins
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
export function PluginSection({
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

/**
 * The auto-filling card track a plugin's contents sit in.
 *
 * The track floor is `min(236px, 100%)` rather than a flat 236px so a
 * container narrower than one card still gets a single column that fits,
 * instead of one card overflowing its own grid on a phone.
 */
export function CardGrid({
  items,
  onOpen,
  onRemove,
}: {
  items: LibraryItem[];
  onOpen(item: LibraryItem): void;
  /**
   * The manager's "remove from this place". Present only when the caller
   * runs the page the grid is on — the pages decide that, not the grid.
   * Rendered as an overlay SIBLING of the card, never inside it: the whole
   * card is one <button>, and a button inside a button is not HTML.
   */
  onRemove?(item: LibraryItem): void;
}) {
  return (
    <div
      className={cn(
        'grid gap-2.5',
        'grid-cols-[repeat(auto-fill,minmax(min(236px,100%),1fr))]',
      )}
    >
      {items.map((item) => {
        // The change-request number is part of the key, not decoration: two
        // people can propose a skill of the same name into different plugins,
        // and until one of them merges neither is in the catalog to collide
        // with — so the name alone is not yet unique.
        const key = `${item.kind}:${item.id}:${item.pending?.changeRequestNumber ?? ''}`;
        const card = (
          <LibraryCard
            key={key}
            kind={item.kind}
            flavor={
              item.kind === 'integration'
                ? item.path.endsWith('/mcp.json')
                  ? 'mcp'
                  : 'utcp'
                : undefined
            }
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
        );
        // A pending proposal is not IN the place yet — there is nothing to
        // remove; declining it lives with the review.
        if (!onRemove || item.pending) return card;
        return (
          // `grid`, not a plain block: the wrapper takes the card's place as
          // the grid item, and only a grid (or flex) container stretches its
          // child the way the outer grid stretched the bare card — without it
          // the <button> shrinks to its content and the overlay floats in the
          // leftover width, off the card's own edge.
          <div key={key} className="group/removable relative grid">
            {card}
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              title={`Remove ${item.name}`}
              onClick={() => onRemove(item)}
              className={cn(
                'absolute right-1.5 top-1.5 rounded-sm border border-line bg-surface p-1 text-ink-faint',
                'opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/removable:opacity-100',
              )}
            >
              <Trash2 size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The "are you sure" a removal deserves: deleting a skill or tool from a
 * plugin takes it from EVERYONE in the plugin, not from a personal shelf, and
 * there is no undo shortcut — the content survives only in git history.
 */
export function RemoveLibraryItemDialog({
  item,
  place,
  onClose,
  onRemoved,
}: {
  item: LibraryItem;
  /** Where it is being removed from, for the copy: a plugin name, or "your space". */
  place: string;
  onClose(): void;
  /** Fired after the delete lands; the host page reloads and says so. */
  onRemoved(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const what = item.kind === 'skill' ? 'skill' : 'tool';

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await removeLibraryItem(item.path);
      onRemoved();
      onClose();
    } catch (err) {
      // The backend's refusal names the rule (access, a held lock); a
      // generic apology would hide the one thing worth reading.
      setError(err instanceof Error ? err.message : `Couldn't remove the ${what}.`);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Remove ${item.name}?`}
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className="text-ui text-ink-muted">
        {item.kind === 'skill'
          ? `This deletes the skill and its files from ${place}. Everyone here loses it the next time their agent connects.`
          : `This deletes the tool and its connection settings from ${place}. Skills here that need it will ask for setup again.`}
      </p>
      {error && (
        <Banner tone="danger" role="alert" className="mt-3">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

/**
 * The Skills and Tools bands, in that order, with their empty states.
 *
 * The empty copy differs per page (a plugin can be filled by an agent; your own
 * space is filled by you), so it arrives as props rather than being derived
 * from a name here.
 */
export function PluginItemSections({
  skillItems,
  toolItems,
  onOpen,
  onRemove,
  emptySkills,
  emptyTools = 'No tools yet.',
  hideEmpty = false,
  skillControls,
  skillControlsActive = false,
}: {
  skillItems: LibraryItem[];
  toolItems: LibraryItem[];
  onOpen(item: LibraryItem): void;
  /** See {@link CardGrid} — present only when the caller manages this place. */
  onRemove?(item: LibraryItem): void;
  emptySkills: string;
  emptyTools?: string;
  /**
   * Filter / refresh for the Skills band only. Tools deliberately gets none
   * (proto:3078 carries the count alone): a tool that needs setup already says
   * so on its own card, and there is nothing to re-check that the card does not
   * already show.
   */
  skillControls?: ReactNode;
  /** One of `skillControls` is mid-act — keep the row visible. See `PluginSection`. */
  skillControlsActive?: boolean;
  /**
   * Drop a band with nothing in it instead of showing its empty state.
   *
   * A PLUGIN says "No skills yet" because the absence is a fact about that
   * plugin and an invitation to fix it. A SEARCH RESULT says nothing, because
   * "No tools yet" under a query for `rfi` is not a fact about your library.
   */
  hideEmpty?: boolean;
}) {
  return (
    <>
      {!(hideEmpty && skillItems.length === 0) && (
        <PluginSection
          title="Skills"
          count={skillItems.length}
          controls={skillControls}
          controlsActive={skillControlsActive}
        >
          {skillItems.length === 0 ? (
            <p className="text-ui text-ink-faint">{emptySkills}</p>
          ) : (
            <CardGrid items={skillItems} onOpen={onOpen} onRemove={onRemove} />
          )}
        </PluginSection>
      )}

      {!(hideEmpty && toolItems.length === 0) && (
        <PluginSection title="Tools" count={toolItems.length}>
          {toolItems.length === 0 ? (
            <p className="text-ui text-ink-faint">{emptyTools}</p>
          ) : (
            <CardGrid items={toolItems} onOpen={onOpen} onRemove={onRemove} />
          )}
        </PluginSection>
      )}
    </>
  );
}

/**
 * The centred, quiet line a page shows when it has nothing else to say —
 * empty, loading, or unreachable. One component so those three states are
 * spaced and toned identically instead of each page inventing its own.
 */
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
 * opting-out is `PluginSection`'s `controlsActive`, because that is the element
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
