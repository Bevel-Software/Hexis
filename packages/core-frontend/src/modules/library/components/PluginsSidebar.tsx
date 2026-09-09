import { useState, type MouseEvent, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import type { LibraryFilter } from '../utils/status';
import { ChalkArrow } from './plugin-page-parts';

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

/**
 * The two views of what sits below the lenses: by TEAM (who can use what),
 * or the ADVANCED view — the two roots as they are on disk.
 */
export type SidebarView = 'teams' | 'advanced';

export interface PluginsSidebarProps {
  /** What the URL has selected, or null on a page with no gallery filter. */
  filter: LibraryFilter | null;
  /** A row was clicked — the layout navigates; the sidebar owns no state. */
  onSelect(filter: LibraryFilter): void;
  ownedCount: number;
  /**
   * How many of the caller's OWN items are waiting on them. Drives the amber
   * badge; when zero the row shows `ownedCount` in grey instead.
   */
  ownedAttention: number;
  /** The caller's own space, e.g. `Juan's Plugin` — see `personalPluginName`. */
  personalPluginLabel: string;
  ungroupedCount: number;
  /**
   * The teams — groups from the access rules — each with how much of the
   * catalog it can use, and how many of its plugins' links lock its members
   * out of a skill right now. Orange wins the count slot: it is other
   * people's problem, and the count is not the news.
   */
  teams: { name: string; count: number; urgent: number }[];
  /** Integrations across the catalog that need setup — the amber count. */
  attentionCount: number;
  /** Send the user to the Connect page to finish those. */
  onFinishSetup(): void;
  /** Start a new plugin. The layout owns the dialog; this is only the intent. */
  onCreatePlugin(): void;
  /**
   * Whether to spell the first plugin out in words, with the chalk arrow. The
   * hover-revealed `+` is unchanged for everyone; this is only the teaching
   * mark, and it is an administrator's — see the row itself below.
   *
   * The caller passes a SETTLED verdict, not just a role: the layout derives
   * it from `workspaceHasNoPlugins`, which stays false while plugin discovery
   * is loading or has failed. Without that, an admin whose plugins were still
   * arriving would briefly read "Create a plugin" over a workspace that has
   * twenty.
   *
   * Optional, defaulting to OFF: this props type is public, and a host
   * application rendering the nav must stay source-compatible across the
   * upgrade. Omitting it reproduces the nav with no written-out CTA at all.
   */
  canCreatePlugin?: boolean;
  /**
   * A row — or the nav's empty space — was right-clicked. Like every other
   * handler here this is an INTENT, not a menu: the layout owns the popup.
   *
   * Omitted, the nav does nothing on right-click and the browser's own menu
   * appears — which is the honest default for a view with no actions wired.
   */
  onContextMenu?(target: SidebarContextTarget): void;
  /**
   * The two roots as file trees, in the Advanced view — the shared `Skills/`
   * root and the `Plugins/` root, exactly as they are on disk. SLOTS rather
   * than components this nav names: each tree reads the workspace and
   * navigates on its own, and the sidebar stays what it is, a pure view of
   * names and counts. Omitted, the view has no trees, which keeps a host
   * rendering the shipped nav source-compatible.
   */
  skillsTree?: ReactNode;
  pluginsTree?: ReactNode;
}

/**
 * The library's nav spine — the prototype's `.side` + `.nav` (lines 55-95).
 *
 * The two LENSES on the whole catalog first — Everything (the Library's
 * home) and Owned by me — then ONE switch between the two views of what is
 * below them:
 *
 *  - TEAMS — the caller's own space first (the one team they are always
 *    in), then every group from the access rules: a team's page is what
 *    being in that group lets a person use;
 *  - ADVANCED — `Skills/` and `Plugins/` as they are on disk.
 *
 * Plugins have no rows of their own here. They are reached through the
 * pages that list them — Everything, a team — and through their folders in
 * the Plugins tree; a nav that listed every plugin beside every team said
 * the same thing twice and grew with the workspace.
 *
 * The switch is the one piece of state the nav holds, and it is VIEW state,
 * not selection: which rows are on screen, not which one is current. The
 * URL still owns selection, so the back button, a deep link and the
 * highlighted row can never drift apart — whichever view is showing. The
 * choice is remembered in the browser so a reload lands on the view the
 * person left; the Teams view is the default.
 *
 * This is the CONTENTS only. Being a sidebar — the width, the background, the
 * collapse animation, the drag handle — belongs to `SidebarFrame`, which
 * Knowledge's file tree renders inside too. That is the whole reason the two
 * navs cannot drift: there is one of them, holding a different list.
 */
export function PluginsSidebar({
  filter,
  onSelect,
  ownedCount,
  ownedAttention,
  personalPluginLabel,
  ungroupedCount,
  teams,
  attentionCount,
  onFinishSetup,
  onCreatePlugin,
  canCreatePlugin = false,
  onContextMenu,
  skillsTree,
  pluginsTree,
}: PluginsSidebarProps) {
  const [view, setView] = useState<SidebarView>(readStoredView);
  const switchView = (next: SidebarView) => {
    setView(next);
    storeView(next);
  };

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
  const isCurrent = (target: LibraryFilter) => {
    if (!filter) return false;
    switch (target.kind) {
      case 'team':
        return filter.kind === 'team' && filter.group === target.group;
      case 'group':
        return filter.kind === 'group' && filter.plugin === target.plugin;
      default:
        return filter.kind === target.kind;
    }
  };

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
    tone: 'count' | 'pending' | 'urgent' = 'count',
  ) => (
    <button
      // Keyed by what the row IS (its target), never by what it says.
      key={target.kind === 'team' ? `team:${target.group}` : target.kind}
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
            tone === 'urgent'
              ? 'bg-urgent-soft font-bold text-urgent'
              : tone === 'pending'
                ? 'bg-wait-soft font-bold text-wait'
                : 'text-ink-faint',
          )}
        >
          {count}
        </span>
      )}
    </button>
  );

  /**
   * A tablist is ONE tab stop: the chosen tab takes focus, the arrows move
   * between the tabs and choose as they go (Home/End to the ends), so a
   * keyboard user is not made to Tab through both views to reach the rows.
   * Roving `tabIndex` is what makes the unchosen tab reachable by arrow and
   * not by Tab.
   */
  const onTablistKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const order: SidebarView[] = ['teams', 'advanced'];
    const at = order.indexOf(view);
    let next: SidebarView | null = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = order[(at + 1) % order.length]!;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = order[(at - 1 + order.length) % order.length]!;
    else if (e.key === 'Home') next = order[0]!;
    else if (e.key === 'End') next = order[order.length - 1]!;
    if (next === null) return;
    e.preventDefault();
    switchView(next);
    e.currentTarget.querySelector<HTMLElement>(`#library-view-tab-${next}`)?.focus();
  };

  const tab = (id: SidebarView, label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      id={`library-view-tab-${id}`}
      aria-selected={view === id}
      aria-controls={`library-view-${id}`}
      tabIndex={view === id ? 0 : -1}
      className={cn(
        'flex-1 rounded-sm px-2 py-1 text-center text-meta font-semibold transition-[background-color,color,box-shadow]',
        view === id ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
      )}
      onClick={() => switchView(id)}
    >
      {label}
    </button>
  );

  return (
    <>
      <nav
        aria-label="Library navigation"
        className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto"
        // The nav's empty space is a target too — Knowledge's tree gives its
        // ROOT row a menu holding the create verbs, and this is where the
        // Library's equivalent click lands. Rows stop the event before it
        // reaches here, so this only ever fires on the gaps between them.
        onContextMenu={(e) => openMenu(e, null, 'Library', null)}
      >
        {/* The two lenses on the whole catalog, unlabelled and first:
            Everything is where the Library opens, and a destination the
            whole surface hangs off does not sit inside a category. */}
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

        {/* The switch — a segmented control as quiet as the rows, on the
            nav's own hover tint, the chosen half lifted onto the surface. */}
        <div
          role="tablist"
          aria-label="Sidebar view"
          className="mt-4 mb-2 flex gap-0.5 rounded-md bg-hover p-0.5"
          onKeyDown={onTablistKeyDown}
          // The switch is a control, not empty nav space: a right-click on it
          // is nobody's to answer, so it must not reach the nav behind it.
          onContextMenu={(e) => e.stopPropagation()}
        >
          {tab('teams', 'IdP Groups')}
          {tab('advanced', 'Advanced')}
        </div>

        {/* Both panels stay MOUNTED and the inactive one is hidden, not
            dropped: a tab's `aria-controls` always names a panel that exists,
            and the trees keep what a person opened in them (expanded folders,
            a rename in progress) across a switch and back. */}
        <div
          role="tabpanel"
          id="library-view-teams"
          aria-labelledby="library-view-tab-teams"
          hidden={view !== 'teams'}
          className="flex flex-col gap-px"
        >
          {/* Your own space leads the teams: it is the one you are always in. */}
          {row(personalPluginLabel, { kind: 'ungrouped' }, ungroupedCount)}
          {teams.map(({ name, count, urgent }) =>
            // Orange wins the count slot: members locked out of a skill outrank
            // how much the team can use, which is not the news.
            row(
              name,
              { kind: 'team', group: name },
              urgent > 0 ? urgent : count,
              urgent > 0 ? 'urgent' : 'count',
            ),
          )}
        </div>
        <div
          role="tabpanel"
          id="library-view-advanced"
          aria-labelledby="library-view-tab-advanced"
          hidden={view !== 'advanced'}
          className="flex flex-col gap-px"
        >
            {/* The usual ways to a new plugin are a right-click — on the nav's
                empty space, or on a folder in the Plugins tree — and a person
                with no plugins yet is exactly the person who has not learned
                either. While the workspace holds no plugins AT ALL, the way to
                the first one is said in words, as a row above the trees —
                with a chalk arrow from the empty space beneath, the same
                margin-note voice as the empty plugin page. Administrators
                only: on an untouched workspace the first plugin is theirs to
                make, and telling everyone else to make it points them at a
                decision that is not theirs. (Everything says the same in its
                plugin band, for whoever never opens this view.) */}
            {canCreatePlugin && (
              <div className="relative">
                <button
                  type="button"
                  onClick={onCreatePlugin}
                  className="flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-ui text-ink-faint transition-colors hover:bg-hover hover:text-ink"
                >
                  <span aria-hidden="true">+</span>
                  <span className="truncate">Create a plugin</span>
                </button>
                {/* Mirrored, so the tip points up-left at the row's words from
                    the room beneath it. */}
                <ChalkArrow className="pointer-events-none absolute left-[22px] top-[30px] h-[52px] w-[64px] -scale-x-100 text-ink-faint" />
              </div>
            )}
            {skillsTree}
            {pluginsTree}
        </div>
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
 * The remembered view. Browser storage is a per-viewer convenience: it can
 * be absent, refused or cleared, and the nav must render either way — so
 * every read and write is guarded and the default is the Teams view.
 */
const VIEW_STORAGE_KEY = 'bevel-library-sidebar-view';

function readStoredView(): SidebarView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === 'advanced' ? 'advanced' : 'teams';
  } catch {
    return 'teams';
  }
}

function storeView(view: SidebarView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // A browser that refuses storage still gets the view for this session.
  }
}

/**
 * A nav section's name, with an optional row of actions at its right edge.
 * The first one has no top padding — the sidebar's own `pt-6` already placed
 * it — so every label is the same component with its spacing decided by where
 * it sits, not by which one it is.
 *
 * The actions are always in the DOM and always reachable by keyboard; only
 * their opacity follows hover, so the nav stays quiet without the controls
 * being conditional. `focus-within:opacity-100` is what keeps that honest for
 * anyone who never hovers anything.
 */
export function SectionLabel({
  children,
  spaced = false,
  actions,
}: {
  children: ReactNode;
  spaced?: boolean;
  actions?: ReactNode;
}) {
  return (
    <div className={cn('group/label flex items-center gap-1 px-2.5 pb-1.5', spaced && 'pt-5')}>
      <span className="text-label uppercase text-ink-faint">{children}</span>
      {actions && (
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/label:opacity-100">
          {actions}
        </span>
      )}
    </div>
  );
}
