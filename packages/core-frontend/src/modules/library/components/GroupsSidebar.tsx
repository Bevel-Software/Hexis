import type { ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import type { LibraryFilter } from '../utils/status';
import { LockGlyph } from './LockGlyph';

export interface GroupsSidebarProps {
  /** What the URL has selected, or null on a page with no gallery filter. */
  filter: LibraryFilter | null;
  /** A row was clicked — the layout navigates; the sidebar owns no state. */
  onSelect(filter: LibraryFilter): void;
  /** Readable groups, with their item count and how many integrations need setup. */
  groups: { group: string; count: number; attention: number }[];
  /**
   * Groups the caller cannot read, alphabetical. Rendered after a gap, with a
   * lock instead of a count.
   */
  lockedGroups: string[];
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
 *
 * This is the CONTENTS only. Being a sidebar — the width, the background, the
 * collapse animation, the drag handle — belongs to `SidebarFrame`, which
 * Knowledge's file tree renders inside too. That is the whole reason the two
 * navs cannot drift: there is one of them, holding a different list.
 */
export function GroupsSidebar({
  filter,
  onSelect,
  groups,
  lockedGroups,
  ownedCount,
  ownedAttention,
  personalGroupLabel,
  ungroupedCount,
  attentionCount,
  onFinishSetup,
  onCreateGroup,
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

  /**
   * A group the caller cannot read. Same chrome as every other row, because it
   * is the same kind of thing — a place in the workspace — and demoting it
   * visually would undo the reason it is listed at all.
   *
   * The count box holds a lock instead of a number, and holds it in the SAME
   * slot so the column of counts stays a column. Never a count (the caller
   * cannot see inside to count anything) and never the amber attention badge
   * (a non-member has nothing to fix). The accessible name carries the state in
   * words, so the glyph itself can stay decorative.
   */
  const lockedRow = (name: string) => (
    <button
      key={`locked:${name}`}
      type="button"
      aria-label={`${name} (locked)`}
      aria-current={filter?.kind === 'group' && filter.group === name}
      className={rowClass(filter?.kind === 'group' && filter.group === name)}
      onClick={() => onSelect({ kind: 'group', group: name })}
    >
      <span className="truncate">{name}</span>
      <span className="flex h-4.5 shrink-0 basis-5.5 items-center justify-center text-ink-faint">
        <LockGlyph className="size-3" />
      </span>
    </button>
  );

  return (
    <>
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
          {/* Locked groups, after the prototype's 14px `.navgap`. The gap is the
              whole statement: these are in the same list because they are in the
              same workspace, and below a break because you are not in them. */}
          {lockedGroups.length > 0 && <div className="h-3.5" aria-hidden="true" />}
          {lockedGroups.map(lockedRow)}
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
    </>
  );
}

/**
 * The `INCLUDED IN YOUR MCP` heading, and the one way to make a new group —
 * the prototype's `.lbladd` (line 78).
 *
 * The heading says what this list IS rather than what its rows are called:
 * these folders are the set mounted into the caller's MCP — the agent's
 * working context — not merely a directory of groups. (The locked rows that
 * trail the list sit below a gap for exactly that reason: they are in the
 * workspace but not in your MCP, and the break is what keeps the heading
 * honest about them.)
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
