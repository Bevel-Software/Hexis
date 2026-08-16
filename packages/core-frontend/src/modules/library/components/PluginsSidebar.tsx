import type { MouseEvent, ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import type { LibraryFilter } from '../utils/status';
import { LockGlyph } from './LockGlyph';

/**
 * Where a right-click landed in the nav, and everything the layout needs to
 * answer it — so the sidebar can report the event without owning a menu.
 *
 * The coordinates and the row element are read from the event SYNCHRONOUSLY
 * here, because `currentTarget` is only itself for the duration of the handler.
 */
export interface SidebarContextTarget {
  /** The row's filter — `null` when the click landed on the nav's empty space. */
  filter: LibraryFilter | null;
  /** What was clicked, by name. The menu uses it for its accessible name. */
  label: string;
  x: number;
  y: number;
  /** The row itself, so Escape can hand focus back to it. `null` for empty space. */
  row: HTMLElement | null;
}

export interface PluginsSidebarProps {
  /** What the URL has selected, or null on a page with no gallery filter. */
  filter: LibraryFilter | null;
  /** A row was clicked — the layout navigates; the sidebar owns no state. */
  onSelect(filter: LibraryFilter): void;
  /** Readable plugins, with their item count and how many integrations need setup. */
  plugins: { plugin: string; count: number; attention: number }[];
  /**
   * Plugins the caller cannot read, alphabetical. Rendered after a gap, with a
   * lock instead of a count.
   */
  lockedPlugins: string[];
  ownedCount: number;
  /**
   * How many of the caller's OWN items are waiting on them. Drives the amber
   * badge; when zero the row shows `ownedCount` in grey instead.
   */
  ownedAttention: number;
  /** The caller's own space, e.g. `Juan's Plugin` — see `personalPluginName`. */
  personalPluginLabel: string;
  ungroupedCount: number;
  /** Integrations across the catalog that need setup — the amber count. */
  attentionCount: number;
  /** Send the user to the Connect page to finish those. */
  onFinishSetup(): void;
  /** Start a new plugin. The layout owns the dialog; this is only the intent. */
  onCreatePlugin(): void;
  /**
   * The all-plugins index is showing. Beside `filter` rather than inside it: the
   * index lists PLACES, not a filtered slice of the catalog, so it is not a
   * `LibraryFilter` and pretending otherwise would put a row in the gallery's
   * vocabulary that no gallery can render.
   */
  pluginsIndexActive: boolean;
  /** Go to the index — the Library's home. */
  onOpenPluginsIndex(): void;
  /**
   * A row — or the nav's empty space — was right-clicked. Like every other
   * handler here this is an INTENT, not a menu: the layout owns the popup,
   * because the verbs in it (add to this plugin, manage its access) need the
   * plugin summaries and the workspace, and the sidebar knows neither.
   *
   * Omitted, the nav does nothing on right-click and the browser's own menu
   * appears — which is the honest default for a view with no actions wired.
   */
  onContextMenu?(target: SidebarContextTarget): void;
}

/**
 * The library's nav spine — the prototype's `.side` + `.nav` (lines 55-95).
 *
 * Replaces the loadout rail, which came from a retired mock and has no
 * equivalent in the prototype. Plugins ARE the structure here: the sidebar is
 * how you move between them, which is why the page no longer carries
 * Skills/Integrations filter chips. A plugin is a folder, so this list is
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
export function PluginsSidebar({
  filter,
  onSelect,
  plugins,
  lockedPlugins,
  ownedCount,
  ownedAttention,
  personalPluginLabel,
  ungroupedCount,
  attentionCount,
  onFinishSetup,
  onCreatePlugin,
  pluginsIndexActive,
  onOpenPluginsIndex,
  onContextMenu,
}: PluginsSidebarProps) {
  const rowClass = (selected: boolean) =>
    cn(
      'flex items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-ui transition-colors',
      selected ? 'bg-hover font-semibold text-ink' : 'text-ink-muted hover:bg-hover hover:text-ink',
    );

  /**
   * Whether a row's filter is the one the URL has selected. Derived from the
   * row's OWN target rather than restated at each call site, so a row cannot
   * light up for a filter it does not navigate to.
   */
  const isCurrent = (target: LibraryFilter) =>
    target.kind === 'group'
      ? filter?.kind === 'group' && filter.plugin === target.plugin
      : filter?.kind === target.kind;

  /**
   * Report a right-click upward. `preventDefault` only when somebody is
   * listening — with no handler the browser's own menu is the right answer.
   * `stopPropagation` is what keeps a row's click from also reaching the nav
   * behind it, which would open the empty-space menu instead.
   */
  const openMenu = (
    e: MouseEvent<HTMLElement>,
    target: LibraryFilter | null,
    label: string,
    row: HTMLElement | null,
  ) => {
    if (!onContextMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onContextMenu({ filter: target, label, x: e.clientX, y: e.clientY, row });
  };

  const row = (
    label: string,
    target: LibraryFilter,
    count: number,
    tone: 'count' | 'pending' = 'count',
  ) => (
    <button
      key={label}
      type="button"
      aria-current={isCurrent(target)}
      className={rowClass(isCurrent(target))}
      onClick={() => onSelect(target)}
      onContextMenu={(e) => openMenu(e, target, label, e.currentTarget)}
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
   * A plugin the caller cannot read. Same chrome as every other row, because it
   * is the same kind of thing — a place in the workspace — and demoting it
   * visually would undo the reason it is listed at all.
   *
   * The count box holds a lock instead of a number, and holds it in the SAME
   * slot so the column of counts stays a column. Never a count (the caller
   * cannot see inside to count anything) and never the amber attention badge
   * (a non-member has nothing to fix). The accessible name carries the state in
   * words, so the glyph itself can stay decorative.
   */
  const lockedRow = (name: string) => {
    const target: LibraryFilter = { kind: 'group', plugin: name };
    return (
      <button
        key={`locked:${name}`}
        type="button"
        aria-label={`${name} (locked)`}
        aria-current={isCurrent(target)}
        className={rowClass(isCurrent(target))}
        onClick={() => onSelect(target)}
        // A locked row gets the SAME menu as a readable one, for the same
        // reason it gets the same click: a plugin you are not in is still a
        // place, and `Manage access` is exactly the item an admin locked out of
        // one needs. Which verbs are actually true is the layout's call.
        onContextMenu={(e) => openMenu(e, target, name, e.currentTarget)}
      >
        <span className="truncate">{name}</span>
        <span className="flex h-4.5 shrink-0 basis-5.5 items-center justify-center text-ink-faint">
          <LockGlyph className="size-3" />
        </span>
      </button>
    );
  };

  return (
    <>
        <nav
          aria-label="Library plugins"
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto"
          // The nav's empty space is a target too — Knowledge's tree gives its
          // ROOT row a menu holding the create verbs, and this is where the
          // Library's equivalent click lands. Rows stop the event before it
          // reaches here, so this only ever fires on the gaps between them.
          onContextMenu={(e) => openMenu(e, null, 'Library', null)}
        >
          {/* The home row, above every section and belonging to none of them:
              it is where the Library opens, and the one place that lists the
              plugins you are NOT in beside the ones you are. Unlabelled and
              first for the same reason — a destination the whole surface
              hangs off does not sit inside a category of lenses.

              Written out rather than built by `row`, because it is the one
              row with no `LibraryFilter` behind it: the index is a list of
              PLACES, not a slice of the catalog. Its menu is therefore the
              nav's own (`filter: null`) — create a plugin, and none of the
              verbs that need a folder to point at. */}
          <button
            type="button"
            aria-current={pluginsIndexActive}
            className={rowClass(pluginsIndexActive)}
            onClick={onOpenPluginsIndex}
            onContextMenu={(e) => openMenu(e, null, 'All plugins', e.currentTarget)}
          >
            <span className="truncate">All plugins</span>
          </button>

          {/* Lenses — the whole catalog, sliced — which is exactly what the
              plugin rows below are not. Naming the section is what keeps that
              distinction visible. `Everything` is a row again now that the
              Library lands on the plugins index instead: without one it would
              be a page with no way in. */}
          <SectionLabel spaced>Library</SectionLabel>
          {row('Everything', { kind: 'all' }, 0)}
          {/* Amber is a summons, not a total. It shows how many of your own
              items need something FROM YOU; when none do, the slot falls back
              to the plain count of what you own, in grey. A permanent amber 26
              beside "Owned by me" trained the eye to ignore the one colour on
              this page that is supposed to mean "look here". */}
          {row(
            'Owned by me',
            { kind: 'owned' },
            ownedAttention > 0 ? ownedAttention : ownedCount,
            ownedAttention > 0 ? 'pending' : 'count',
          )}
          <PluginsLabel onCreate={onCreatePlugin} />

          {/* Your own space leads the plugins, as in the prototype (line 2487):
              it is the one you are always in. */}
          {row(personalPluginLabel, { kind: 'ungrouped' }, ungroupedCount)}
          {plugins.map(({ plugin, count, attention }) =>
            // Amber wins the count slot: a plugin that needs setup is telling you
            // something, and how many items it holds is not the news.
            row(
              plugin,
              { kind: 'group', plugin },
              attention > 0 ? attention : count,
              attention > 0 ? 'pending' : 'count',
            ),
          )}
          {/* Locked plugins, after the prototype's 14px `.navgap`. The gap is the
              whole statement: these are in the same list because they are in the
              same workspace, and below a break because you are not in them. */}
          {lockedPlugins.length > 0 && <div className="h-3.5" aria-hidden="true" />}
          {lockedPlugins.map(lockedRow)}
        </nav>

        {attentionCount > 0 && (
          <button
            type="button"
            onClick={onFinishSetup}
            className="mt-2 rounded-sm border-t border-line px-2.5 pt-3.5 text-left text-meta text-ink-faint hover:text-ink"
          >
            {attentionCount} {attentionCount === 1 ? 'integration needs' : 'integrations need'} setup. Finish now
          </button>
        )}
    </>
  );
}

/**
 * The `INCLUDED IN YOUR MCP` heading, and the one way to make a new plugin —
 * the prototype's `.lbladd` (line 78).
 *
 * The heading says what this list IS rather than what its rows are called:
 * these folders are the set mounted into the caller's MCP — the agent's
 * working context — not merely a directory of plugins. (The locked rows that
 * trail the list sit below a gap for exactly that reason: they are in the
 * workspace but not in your MCP, and the break is what keeps the heading
 * honest about them.)
 *
 * `All plugins` is NOT a row here. It heads the whole nav instead: it is the
 * Library's home rather than one more entry in the set mounted into your MCP,
 * and inside this list it used to collect the clicks meant for the plugins
 * under it.
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

function PluginsLabel({ onCreate }: { onCreate(): void }) {
  return (
    <div className="group/label flex items-center gap-1 px-2.5 pb-1.5 pt-5">
      <span className="text-label uppercase text-ink-faint">Included in your MCP</span>
      <button
        type="button"
        onClick={onCreate}
        title="New plugin"
        aria-label="New plugin"
        className="ml-auto flex size-4.5 items-center justify-center rounded-xs text-ui leading-none text-ink-faint opacity-0 transition-opacity hover:bg-hover hover:text-ink focus-visible:opacity-100 group-hover/label:opacity-100"
      >
        +
      </button>
    </div>
  );
}
