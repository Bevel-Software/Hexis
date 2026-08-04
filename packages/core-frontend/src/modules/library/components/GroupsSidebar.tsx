import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import type { LibraryFilter } from '../utils/status';

export interface GroupsSidebarProps {
  /** What the URL has selected, or null on a page with no gallery filter. */
  filter: LibraryFilter | null;
  /** A row was clicked — the layout navigates; the sidebar owns no state. */
  onSelect(filter: LibraryFilter): void;
  /** Readable groups, with their item count and how many integrations need setup. */
  groups: { group: string; count: number; attention: number }[];
  ownedCount: number;
  /**
   * How many of the caller's OWN items are waiting on them. Drives the amber
   * badge; when zero the row shows `ownedCount` in grey instead.
   */
  ownedAttention: number;
  /** The caller's own space, e.g. `Juan's Group` — see `personalGroupName`. */
  personalGroupLabel: string;
  ungroupedCount: number;
  /** Integrations across the catalog that need setup — the amber count. */
  attentionCount: number;
  /** Send the user to the Connect page to finish those. */
  onFinishSetup(): void;
  /** Start a new group. The layout owns the dialog; this is only the intent. */
  onCreateGroup(): void;
  /**
   * Hidden. The sidebar only knows its own width — `SidebarToggle` and the
   * state behind it belong to the layout, so the button can stay put while
   * this slides out from under it.
   */
  collapsed: boolean;
}

/**
 * The library's nav spine — the prototype's `.side` + `.nav` (lines 55-95).
 *
 * Replaces the loadout rail, which came from a retired mock and has no
 * equivalent in the prototype. Groups ARE the structure here: the sidebar is
 * how you move between them, which is why the page no longer carries
 * Skills/Integrations filter chips. A group is a folder, so this list is
 * derived from the catalog's paths rather than from a registry.
 *
 * It is a pure view of the URL: `filter` comes down, clicks go up as intents,
 * and the layout navigates. Nothing here is state, so the back button, a deep
 * link and the highlighted row can never drift apart.
 */
export function GroupsSidebar({
  filter,
  onSelect,
  groups,
  ownedCount,
  ownedAttention,
  personalGroupLabel,
  ungroupedCount,
  attentionCount,
  onFinishSetup,
  onCreateGroup,
  collapsed,
}: GroupsSidebarProps) {
  const rowClass = (selected: boolean) =>
    cn(
      'flex items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-ui transition-colors',
      selected ? 'bg-hover font-semibold text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink',
    );

  const row = (
    label: string,
    selected: boolean,
    onClick: () => void,
    count: number,
    tone: 'count' | 'pending' = 'count',
  ) => (
    <button
      key={label}
      type="button"
      aria-current={selected}
      className={rowClass(selected)}
      onClick={onClick}
    >
      <span className="truncate">{label}</span>
      {/* An empty count is not a count — show nothing rather than a grey 0. */}
      {count > 0 && (
        <span
          className={cn(
            'h-4.5 shrink-0 basis-5.5 rounded-md text-center text-meta leading-[18px] tabular-nums',
            tone === 'pending' ? 'bg-wait-soft font-bold text-wait' : 'text-ink-faint',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  return (
    <aside
      id="library-sidebar"
      // Collapsing is a WIDTH change on the frame, never a layout change on
      // the contents: the inner column keeps its own `w-53` and is clipped, so
      // the rows slide out intact instead of reflowing to nothing on the way.
      // The border goes transparent rather than away — a border that stops
      // existing would jump the main column by a pixel at the end of a
      // 200ms animation.
      //
      // `inert` is what makes "hidden" true rather than merely narrow. Zero
      // width still leaves every row focusable and still reads it out, so a
      // keyboard user would tab into a nav nobody can see. Clipping is a
      // picture; `inert` is the fact.
      inert={collapsed}
      className={cn(
        'h-full shrink-0 overflow-hidden border-r bg-sidebar transition-[width] duration-200 ease-out',
        collapsed ? 'w-0 border-r-transparent' : 'w-53 border-line',
      )}
    >
      {/* `pt-6` matches the main column's `py-6`, so the first label and the
          page heading start on the same line. (The old `pt-14` was a landing
          strip for a toggle that floated here; the toggle lives in the top
          bar now, so the strip went with it.) */}
      <div className="flex h-full w-53 flex-col px-3.5 pb-4 pt-6">
        <nav
          aria-label="Library groups"
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto"
        >
          {/* "Owned by me" is a LENS — the whole catalog, sliced to yours —
              which is exactly what the group rows below are not. Naming the
              section is what keeps that distinction visible. `Everything` had
              a row here once and went: the Library already LANDS on
              everything, so the row was a second name for "here". */}
          <SectionLabel>Library</SectionLabel>
          {/* Amber is a summons, not a total. It shows how many of your own
              items need something FROM YOU; when none do, the slot falls back
              to the plain count of what you own, in grey. A permanent amber 26
              beside "Owned by me" trained the eye to ignore the one colour on
              this page that is supposed to mean "look here". */}
          {row(
            'Owned by me',
            filter?.kind === 'owned',
            () => onSelect({ kind: 'owned' }),
            ownedAttention > 0 ? ownedAttention : ownedCount,
            ownedAttention > 0 ? 'pending' : 'count',
          )}
          <GroupsLabel onCreate={onCreateGroup} />

          {/* Your own space leads the groups, as in the prototype (line 2487):
              it is the one you are always in. */}
          {row(
            personalGroupLabel,
            filter?.kind === 'ungrouped',
            () => onSelect({ kind: 'ungrouped' }),
            ungroupedCount,
          )}
          {groups.map(({ group, count, attention }) =>
            // Amber wins the count slot: a group that needs setup is telling you
            // something, and how many items it holds is not the news.
            row(
              group,
              filter?.kind === 'group' && filter.group === group,
              () => onSelect({ kind: 'group', group }),
              attention > 0 ? attention : count,
              attention > 0 ? 'pending' : 'count',
            ),
          )}
        </nav>

        {attentionCount > 0 && (
          <button
            type="button"
            onClick={onFinishSetup}
            className="mt-2 rounded-sm border-t border-line px-2.5 pt-3.5 text-left text-meta text-ink-faint hover:text-ink"
          >
            {attentionCount} {attentionCount === 1 ? 'integration needs' : 'integrations need'} setup
            — finish now
          </button>
        )}
      </div>
    </aside>
  );
}

/**
 * The `INCLUDED IN YOUR MCP` heading, and the one way to make a new group —
 * the prototype's `.lbladd` (line 78).
 *
 * The heading says what this list IS rather than what its rows are called:
 * these folders are the set mounted into the caller's MCP — the agent's
 * working context — not merely a directory of groups.
 *
 * `All groups` used to be a row here. It went: the index is where you go to
 * find a group you are NOT in, which is a rare errand, and it sat above the
 * groups themselves collecting clicks meant for them. The breadcrumb on every
 * group page still leads there, which is the moment you actually want it.
 *
 * The `+` is always in the DOM and always reachable by keyboard; only its
 * opacity follows hover, so the nav stays quiet without the control being
 * conditional. `focus-visible:opacity-100` is what keeps that honest for
 * anyone who never hovers anything.
 */
/**
 * A nav section's name. The first one has no top padding — the sidebar's own
 * `pt-6` already placed it — so the two labels are the same component with
 * their spacing decided by where they sit, not by which one they are.
 */
function SectionLabel({ children, spaced = false }: { children: ReactNode; spaced?: boolean }) {
  return (
    <div className={cn('px-2.5 pb-1.5 text-label uppercase text-ink-faint', spaced && 'pt-5')}>
      {children}
    </div>
  );
}

function GroupsLabel({ onCreate }: { onCreate(): void }) {
  return (
    <div className="group/label flex items-center gap-1 px-2.5 pb-1.5 pt-5">
      <span className="text-label uppercase text-ink-faint">Included in your MCP</span>
      <button
        type="button"
        onClick={onCreate}
        title="New group"
        aria-label="New group"
        className="ml-auto flex size-4.5 items-center justify-center rounded-xs text-ui leading-none text-ink-faint opacity-0 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/label:opacity-100"
      >
        +
      </button>
    </div>
  );
}
