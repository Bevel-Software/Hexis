import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Funnel, RotateCw, Trash2 } from 'lucide-react';
import { useAdmin } from '../../admin/state/admin.context';
import { cn } from '../../../lib/utils';
import { Banner, Button, Dialog, IconButton } from '../../../shared/components';
import { pathForGroupsIndex } from '../routes/library-paths';
import type { LibraryItem } from '../state/library-data';
import { removeLibraryItem } from '../services/library.api';
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

/**
 * The auto-filling card track a group's contents sit in.
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
        // people can propose a skill of the same name into different groups,
        // and until one of them merges neither is in the catalog to collide
        // with — so the name alone is not yet unique.
        const key = `${item.kind}:${item.id}:${item.pending?.changeRequestNumber ?? ''}`;
        const card = (
          <LibraryCard
            key={key}
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
 * group takes it from EVERYONE in the group, not from a personal shelf, and
 * there is no undo shortcut — the content survives only in git history.
 */
export function RemoveLibraryItemDialog({
  item,
  place,
  onClose,
  onRemoved,
}: {
  item: LibraryItem;
  /** Where it is being removed from, for the copy: a group name, or "your space". */
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
 * The empty copy differs per page (a group can be filled by an agent; your own
 * space is filled by you), so it arrives as props rather than being derived
 * from a name here.
 */
export function GroupItemSections({
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
  /**
   * A plain sentence, or an `EmptySkillsNudge`. A string still gets the band's
   * standard paragraph; a node is trusted to bring its own — the nudge carries
   * an absolutely-placed arrow, and wrapping it in a second `<p>` would nest
   * flow content inside phrasing content.
   */
  emptySkills: ReactNode;
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
            typeof emptySkills === 'string' ? (
              <p className="text-ui text-ink-faint">{emptySkills}</p>
            ) : (
              emptySkills
            )
          ) : (
            <CardGrid items={skillItems} onOpen={onOpen} onRemove={onRemove} />
          )}
        </GroupSection>
      )}

      {!(hideEmpty && toolItems.length === 0) && (
        <GroupSection title="Tools" count={toolItems.length}>
          {toolItems.length === 0 ? (
            <p className="text-ui text-ink-faint">{emptyTools}</p>
          ) : (
            <CardGrid items={toolItems} onOpen={onOpen} onRemove={onRemove} />
          )}
        </GroupSection>
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
 * A hand-drawn arrow, chalk on the wall — the mark an empty page makes toward
 * the control that fills it. Decorative on purpose: the sentence beside it
 * carries the meaning, so the drawing is `aria-hidden`, takes no pointer, and
 * inherits `currentColor` so it stays as faint as the ink around it.
 */
export function ChalkArrow({ className }: { className?: string }) {
  // Colons stripped: `url(#…)` fragment references are unreliable with them.
  const filterId = `chalk-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      data-testid="chalk-arrow"
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 88 72"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <defs>
        {/* What makes the line chalk instead of vector: a slow noise bends the
            stroke the way a hand does, a fine noise frays its edge the way a
            wall's tooth does, and a mid noise thins the ink where the chalk
            skipped. Displacement can push ~2px past the paths, hence the
            widened filter region. */}
        <filter id={filterId} x="-15%" y="-15%" width="130%" height="130%">
          <feTurbulence type="fractalNoise" baseFrequency="0.04" numOctaves="1" seed="3" result="wobble" />
          <feDisplacementMap in="SourceGraphic" in2="wobble" scale="2.5" result="bent" />
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="11" result="grit" />
          <feDisplacementMap in="bent" in2="grit" scale="1.4" result="rough" />
          <feTurbulence type="fractalNoise" baseFrequency="0.3" numOctaves="3" seed="5" result="dust" />
          <feColorMatrix
            in="dust"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.7 0.55"
            result="patch"
          />
          <feComposite in="rough" in2="patch" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#${filterId})`}>
        {/* One loose curve from the words up toward the `+` — tip stays at
            (76,11), which is what the call sites' offsets aim — plus a short
            second pass beside the shaft, the stroke a hand goes over twice. */}
        <path strokeWidth="2.5" d="M6 66 C 30 63, 53 51, 67 32 C 71 26, 74 19, 76 11" />
        <path strokeWidth="1.5" opacity="0.5" d="M17 64 C 34 61, 49 52.5, 61 40" />
        {/* The head as two separate flicks, not a joined V: drawn strokes
            land past each other at the tip, they do not meet in a corner. */}
        <path strokeWidth="2.5" d="M64 18 Q 70.5 14, 76.4 10.6" />
        <path strokeWidth="2.5" d="M79.6 24.6 Q 78.1 17.5, 76 10.7" />
      </g>
    </svg>
  );
}

/**
 * The inline verb inside an empty state's sentence — underlined, ink-strong
 * against the faint prose around it, and a real `<button>` because it acts
 * rather than navigates. One component so every empty state's doorway looks
 * like the same kind of doorway.
 */
export function EmptyStateAction({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // The same focus ring as `Button`/`IconButton`: an inline action is
      // still a stop on the keyboard's path, and the underline alone does not
      // say "you are here".
      className="rounded-xs font-semibold text-ink underline underline-offset-2 hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-muted"
    >
      {children}
    </button>
  );
}

/**
 * The empty Skills band as a doorway instead of a dead end. The sentence
 * names the fact and hands over a link that DOES the thing — the same thing
 * the title row's `+` does — while a chalk arrow points up at that `+`, so
 * the page itself teaches where "add" lives. No separate tour, no overlay:
 * the arrow exists only because this component only renders when the band is
 * empty, and it leaves the moment the first skill arrives.
 *
 * The arrow overlaps the band heading on its way up. That is intended — it is
 * background, not layout: absolutely placed, `pointer-events-none`, and faint
 * enough to read as a margin note rather than a fourth piece of chrome.
 */
/**
 * Where the nudge's arrow sits so its TIP lands on the `+` icon-button's
 * centre: from the column's right edge that centre sits behind the `⋯` button
 * and two flex gaps (~54px), constant on every page that renders
 * `PageActions` — Share sits on the far side of `+`, so its presence moves
 * nothing.
 *
 * A named constant because these offsets are TUNED, together with the tip the
 * `ChalkArrow` paths aim at (76,11 in its 88×72 viewBox): change the
 * `PageActions` row — button size, gap, order — and this is the one place the
 * aim gets re-tuned, rather than a magic literal scattered per call site.
 */
const ARROW_AT_PAGE_ACTIONS_PLUS =
  'pointer-events-none absolute -top-[74px] right-[45px] h-[68px] w-[84px] text-ink-faint';

export function EmptySkillsNudge({
  lead,
  actionLabel,
  tail,
  agentOnly,
  arrow = true,
  onAction,
}: {
  /** The fact: "No skills yet." */
  lead: string;
  /** The doorway's words, e.g. "Add the first skill". */
  actionLabel: string;
  /** The rest of the sentence — usually pointing at the agent as the other door. */
  tail: string;
  /**
   * The whole sentence a non-admin reads instead — same fact, agent door only.
   * Written out rather than assembled from `lead` + `tail`, because `tail` is
   * a continuation (", or ask your agent…") and cannot stand on its own.
   */
  agentOnly: string;
  /**
   * Whether the chalk arrow may be drawn. The arrow's aim is a fixed offset
   * from THIS component to the title row's `+`, so it only tells the truth
   * when nothing sits between them — a page that knows a banner intervenes
   * (join requests, integration attention) passes false and keeps the
   * sentence, which needs no geometry to be right.
   */
  arrow?: boolean;
  /** Exactly what the title row's `+` does. One intent, two doors. */
  onAction(): void;
}) {
  const { isAdmin, isAdminLoading = false } = useAdmin();

  // While the admin verdict is still in flight, say only the fact. Committing
  // to either door — the inline action or "ask your agent" — would flip the
  // sentence (and the arrow) in front of the reader the moment the verdict
  // lands, and the fact is the one part that is true either way.
  if (isAdminLoading) return <p className="text-ui text-ink-faint">{lead}</p>;

  // Starting a skill in place is an administrator's affordance — the add
  // dialogs already refuse the empty-file half to everyone else. So the
  // doorway, link and chalk arrow both, is admin-only. The band still states
  // the fact and names the agent, which IS the door a non-admin has: the
  // title row's `+` stays where it was for them, just without a mark
  // pointing at it.
  if (!isAdmin) return <p className="text-ui text-ink-faint">{agentOnly}</p>;

  return (
    <div className="relative">
      {arrow && <ChalkArrow className={ARROW_AT_PAGE_ACTIONS_PLUS} />}
      <p className="text-ui text-ink-faint">
        {lead} <EmptyStateAction onClick={onAction}>{actionLabel}</EmptyStateAction>
        {tail}
      </p>
    </div>
  );
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
