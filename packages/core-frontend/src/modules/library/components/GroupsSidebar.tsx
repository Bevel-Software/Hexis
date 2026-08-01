import { cn } from '../../../lib/utils';
import type { LibraryFilter } from '../utils/status';

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
  /** The all-groups index (or the propose page) is the current route. */
  groupsIndexActive: boolean;
  onOpenGroupsIndex(): void;
  ownedCount: number;
  ungroupedCount: number;
  /** Integrations across the catalog that need setup — the amber count. */
  attentionCount: number;
  /** Send the user to the Connect page to finish those. */
  onFinishSetup(): void;
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
  // `lockedGroups` is deliberately not read yet — see the WP7 note in the nav.
  groupsIndexActive,
  onOpenGroupsIndex,
  ownedCount,
  ungroupedCount,
  attentionCount,
  onFinishSetup,
}: GroupsSidebarProps) {
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
      className={cn(
        'flex items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-ui transition-colors',
        selected ? 'bg-hover font-semibold text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink',
      )}
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
    <aside className="flex h-full w-53 shrink-0 flex-col border-r border-line bg-sidebar px-3.5 pb-4 pt-5.5">
      <div className="flex items-center gap-2.5 px-2.5 pb-5.5">
        <span
          aria-hidden="true"
          className="flex size-5.5 shrink-0 items-center justify-center rounded-sm bg-ink text-meta font-bold text-canvas"
        >
          B
        </span>
        <span className="min-w-0">
          <span className="block truncate text-strong font-semibold">Bevel</span>
          <span className="block truncate text-label text-ink-faint">Skills &amp; tools</span>
        </span>
      </div>

      <nav aria-label="Library groups" className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto">
        {row('Owned by me', filter?.kind === 'owned', () => onSelect({ kind: 'owned' }), ownedCount, 'pending')}
        {row('Everything', filter?.kind === 'all', () => onSelect({ kind: 'all' }), 0)}

        <div className="px-2.5 pb-1.5 pt-4 text-label uppercase text-ink-faint">Groups</div>
        {row('All groups', groupsIndexActive, onOpenGroupsIndex, 0)}
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
        {ungroupedCount > 0 &&
          row('Yours alone', filter?.kind === 'ungrouped', () => onSelect({ kind: 'ungrouped' }), ungroupedCount)}
        {/* WP7 (locked groups): the prototype's 14px `.navgap` and one row per
            `lockedGroups` entry go here — same chrome, a lock glyph in the count
            box instead of a number, `aria-label="{name} (locked)"`, click
            navigating to the group route. The prop is already plumbed; the
            layout passes `[]` until that work package lands. */}

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
    </aside>
  );
}
