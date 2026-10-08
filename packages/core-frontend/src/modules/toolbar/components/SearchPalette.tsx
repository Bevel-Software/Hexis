import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, FileText, Puzzle, Search, Sparkles, Wrench } from 'lucide-react';
import { MenuPanel, useDismissableMenu, useLatestRef } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useMergedWorkspaceTree } from '../../workspace/hooks/useMergedWorkspaceTree';
import { useFileNav } from '../../workspace/routing/kb-routes';
import { knowledgeFiles } from '../../workspace/utils/fileTree';
import { listSkills } from '../../library/services/library.api';
import { listPlugins } from '../../library/services/plugins.api';
import { listToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import { rankByName, rankByNames } from '../search/rank';
import {
  libraryResults,
  pageResults,
  type LibraryCatalog,
  type SearchResult,
  type SearchResultKind,
} from '../search/sources';
import { actionNames, suggestedActions, type CommandAction, type CommandContext } from '../commands/actions';
import { useCommandActions } from '../commands/useCommandActions';
import { useCommandShortcuts } from '../commands/useCommandShortcuts';
import {
  COMMAND_MENU_SHORTCUT_ARIA,
  COMMAND_MENU_SHORTCUT_LABEL,
  isCommandMenuShortcut,
  onCommandMenuRequest,
} from '../commands/command-menu';
import { useSetupChecklist } from '../../onboarding/state/onboarding';

/** Rows per group. Past this the query is too short to be useful, not the list too long. */
const GROUP_LIMIT = 8;

/**
 * Commands get a little more room: the settings alone are nine rows for an
 * admin, and "settings" should list them all rather than drop one.
 */
const ACTION_LIMIT = 12;

/** No row highlighted — what an empty query opens on (see `activeIndex`). */
const NO_ROW = -1;

/** The box's own words, and the input's (which ends on an ellipsis: it is waiting for you). */
const TRIGGER_LABEL = 'Search or run a command';
const PLACEHOLDER = 'Search or run a command…';

const byName = (r: SearchResult) => r.name;

const ICONS: Record<SearchResultKind, ReactNode> = {
  page: <FileText size={15} />,
  skill: <Sparkles size={15} />,
  tool: <Wrench size={15} />,
  plugin: <Puzzle size={15} />,
};

/** One row of the listbox: a command to run, or a page or item to open. */
type PaletteRow =
  | { key: string; action: CommandAction; result?: never }
  | { key: string; result: SearchResult; action?: never };

const actionRow = (action: CommandAction): PaletteRow => ({ key: `action:${action.id}`, action });
const resultRow = (result: SearchResult): PaletteRow => ({ key: result.key, result });

/** A shortcut as a screen reader should hear it: "C", "G then K". */
const spokenShortcut = (keys: readonly string[]) => keys.join(' then ');

interface CatalogState {
  /** A load is in flight. The previous catalog, if any, stays on screen meanwhile. */
  loading: boolean;
  /** Every source failed. One failing alone (say, plugins) just leaves its rows out. */
  failed: boolean;
  catalog: LibraryCatalog | null;
}

/**
 * The toolbar's search box and the palette it opens — the prototype's
 * `.search-box` and `searchPop()`: one place to find a page, a skill, a tool
 * or a plugin BY NAME, from anywhere in the app — and to run a command ("New
 * page", "Invite people", "Settings: Secrets"; see `commands/actions`), which
 * are listed first. Ctrl+K (⌘K on a Mac) opens it
 * from anywhere too, which is how it is reached on a narrow window, where the
 * box itself does not fit in the toolbar.
 *
 * Name search only, against what the browser already has or can list in one
 * request per source: no full-text index and no endpoint of its own.
 *
 *  - Pages are the files the Knowledge explorer browses (`knowledgeFiles`),
 *    read off the same merged tree the explorer draws — so the palette finds
 *    exactly what the sidebar shows, on the branch on screen.
 *  - Skills, tools and plugins come from the Library's list endpoints. NOT
 *    `useLibraryData`: that hook is the gallery's, and pays an N+1 `getSkill`
 *    for frontmatter, access verdicts and change requests a name search never
 *    reads. And not on page load either: the catalog is fetched when the
 *    palette OPENS, and again on each later open (behind the rows already
 *    shown) so a skill created a minute ago is findable.
 *
 * A combobox driving a listbox (`aria-activedescendant`): focus stays in the
 * input while ↑/↓ move the highlighted row, Enter opens it, Escape closes the
 * palette and hands focus back to where it was before it opened.
 */
export function SearchPalette({ compact }: { compact: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where focus was before the palette opened: the trigger after a click, the
  // editor or row the reader was on after Ctrl+K.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const panelId = useId();

  const [catalogState, setCatalogState] = useState<CatalogState>({
    loading: false,
    failed: false,
    catalog: null,
  });
  // Only the newest load may land: a slow answer from an earlier open must
  // not overwrite a fresher one.
  const loadSeq = useRef(0);
  const loadCatalog = useCallback(() => {
    const seq = ++loadSeq.current;
    setCatalogState((s) => ({ ...s, loading: true }));
    void Promise.allSettled([listSkills(), listToolSecrets(), listPlugins()]).then(
      ([skills, tools, plugins]) => {
        if (seq !== loadSeq.current) return;
        const value = <T,>(r: PromiseSettledResult<T[]>): T[] => (r.status === 'fulfilled' ? r.value : []);
        const failed = [skills, tools, plugins].every((r) => r.status === 'rejected');
        setCatalogState((s) => ({
          loading: false,
          failed,
          // A failed refresh keeps the catalog it had rather than blanking it.
          catalog: failed ? s.catalog : { skills: value(skills), tools: value(tools), plugins: value(plugins) },
        }));
      },
    );
  }, []);

  // Why the last command failed, shown when the palette reopens to say so.
  // Commands run with the palette already shut, and nothing else in core
  // would carry the message (toasts only speak inside the Library).
  const [notice, setNotice] = useState<string | null>(null);

  // Opening it by any route — the box, the shortcut, the Get set up list's
  // "Try it" — ticks that list's "Find or do anything" step.
  const { markCommandMenuOpened } = useSetupChecklist();

  const openPalette = useCallback(() => {
    if (open) {
      // Already open: the shortcut is a way back INTO it, not a toggle.
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setOpen(true);
    markCommandMenuOpened();
    loadCatalog();
  }, [open, loadCatalog, markCommandMenuOpened]);

  /**
   * Close, optionally handing focus back. `'previous'` is Escape — return to
   * where the reader was. `'trigger'` is a chosen row or a Tab out — the page
   * a row opens is about to replace whatever was focused before, so the box
   * is the stable place to land (or, on a narrow window with no box, the
   * previous element). An outside click passes nothing: it already put focus
   * where the reader wanted it.
   */
  const close = useCallback((focus?: 'previous' | 'trigger') => {
    setOpen(false);
    setNotice(null);
    if (!focus) return;
    const previous = restoreFocusRef.current?.isConnected ? restoreFocusRef.current : null;
    const target = focus === 'previous' ? (previous ?? triggerRef.current) : (triggerRef.current ?? previous);
    target?.focus();
  }, []);

  const openRef = useLatestRef(openPalette);

  /**
   * Run a command once the palette has closed. A failure — thrown or
   * rejected — opens the palette again with the reason under the rows, so a
   * command that could not do its job never fails in silence.
   */
  const runAction = useCallback(
    (action: CommandAction, ctx: CommandContext) => {
      const fail = (err: unknown) => {
        setNotice(err instanceof Error ? err.message : String(err));
        // A command that throws synchronously fails inside the click that
        // closed the palette, before that close has rendered: opened at once,
        // `openPalette` would see it still open and only refocus an input on
        // its way out. The reopen waits for the close to commit.
        queueMicrotask(() => openRef.current());
      };
      try {
        void Promise.resolve(action.run(ctx)).catch(fail);
      } catch (err) {
        fail(err);
      }
    },
    [openRef],
  );

  // The commands are read here, not in the panel, because the single-key
  // shortcuts (C, G K, G S) run them while the palette is shut.
  const { actions, ctx } = useCommandActions();
  useCommandShortcuts({ actions, ctx, enabled: !open, run: runAction });

  // `openCommandMenu()` from outside the toolbar opens it as the shortcut does.
  useEffect(() => onCommandMenuRequest(() => openRef.current()), [openRef]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isCommandMenuShortcut(e) || e.defaultPrevented) return;
      // A modal dialog owns the keyboard while it is up; opening a palette
      // underneath its scrim would move focus somewhere nobody can see.
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      openRef.current();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openRef]);

  const panelRef = useDismissableMenu<HTMLDivElement>({
    open,
    onClose: () => close(),
    returnFocusTo: triggerRef,
  });

  return (
    // On a narrow window the box does not fit beside the toolbar essentials,
    // so it is not drawn at all — the shortcut still opens the palette, which
    // then pins itself below the toolbar instead of below the box.
    <div className={cn('relative', !compact && 'ml-1 min-w-0 max-w-[440px] flex-1')}>
      {!compact && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => (open ? close() : openPalette())}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-transparent bg-sunken px-2.5 py-[5px]',
            'text-left text-ui text-ink-faint transition-colors hover:border-line-strong',
            open && 'border-line-strong',
          )}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-keyshortcuts={COMMAND_MENU_SHORTCUT_ARIA}
        >
          <Search aria-hidden size={14} className="flex-none" />
          <span className="min-w-0 flex-1 truncate">{TRIGGER_LABEL}</span>
          <kbd
            aria-hidden
            className="flex-none rounded-xs border border-line-strong px-[5px] font-mono text-meta text-ink-faint"
          >
            {COMMAND_MENU_SHORTCUT_LABEL}
          </kbd>
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Command menu"
          className={cn(
            'z-40',
            compact ? 'fixed inset-x-3 top-[52px]' : 'absolute top-[calc(100%+6px)] left-0 w-full min-w-[320px]',
          )}
        >
          <SearchPanel
            inputRef={inputRef}
            catalogState={catalogState}
            notice={notice}
            actions={actions}
            ctx={ctx}
            onClose={close}
            onRunAction={runAction}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The open palette. A component of its own so that nothing in it — the tree
 * walk, the ranking, the navigation hooks — runs while the palette is shut.
 */
function SearchPanel({
  inputRef,
  catalogState,
  notice,
  actions,
  ctx,
  onClose,
  onRunAction,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  catalogState: CatalogState;
  notice: string | null;
  /** The commands on offer, and the context they run with (`useCommandActions`). */
  actions: readonly CommandAction[];
  ctx: CommandContext;
  onClose: (focus?: 'previous' | 'trigger') => void;
  onRunAction: (action: CommandAction, ctx: CommandContext) => void;
}) {
  const navigate = useNavigate();
  const { openWorkspacePath } = useFileNav();
  const { kbDirName } = useWorkspace();
  const { tree, suggestionOnlyPaths } = useMergedWorkspaceTree();
  const [query, setQuery] = useState('');
  /**
   * The highlighted row. An EMPTY query highlights nothing until ↑/↓ or the
   * pointer picks a row: its first row is a suggested command (New page), and
   * Ctrl+K then Enter must never make a page nobody asked for. Once something
   * is typed, the best match is highlighted and Enter takes it.
   */
  const [activeIndex, setActiveIndex] = useState(NO_ROW);
  const listboxId = useId();
  const optionId = (key: string) => `${listboxId}-${key}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  const pages = useMemo(
    () => pageResults(knowledgeFiles(tree, kbDirName), kbDirName, suggestionOnlyPaths),
    [tree, kbDirName, suggestionOnlyPaths],
  );
  const items = useMemo(
    () => (catalogState.catalog ? libraryResults(catalogState.catalog, kbDirName) : []),
    [catalogState.catalog, kbDirName],
  );

  // Commands first: with nothing typed, a short set of the commonest; with a
  // query, every offered command ranked by its label and keywords.
  const actionHits = useMemo(
    () =>
      (query.trim() ? rankByNames(actions, query, actionNames, ACTION_LIMIT) : suggestedActions(actions, ctx)).map(
        actionRow,
      ),
    [actions, ctx, query],
  );
  const pageHits = useMemo(() => rankByName(pages, query, byName, GROUP_LIMIT).map(resultRow), [pages, query]);
  const itemHits = useMemo(() => rankByName(items, query, byName, GROUP_LIMIT).map(resultRow), [items, query]);
  const flat = useMemo(() => [...actionHits, ...pageHits, ...itemHits], [actionHits, pageHits, itemHits]);
  // Clamped rather than reset when the rows change under it: the catalog can
  // land while the reader is already arrowing through the pages.
  const active = flat.length === 0 || activeIndex === NO_ROW ? NO_ROW : Math.min(activeIndex, flat.length - 1);
  const activeKey = active >= 0 ? flat[active].key : null;

  useEffect(() => {
    if (!activeKey) return;
    document.getElementById(`${listboxId}-${activeKey}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey, listboxId]);

  const choose = (row: PaletteRow) => {
    onClose('trigger');
    if (row.action) {
      onRunAction(row.action, ctx);
      return;
    }
    const { target } = row.result;
    if (target.kind === 'workspace') openWorkspacePath(target.path);
    else navigate(target.url);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (flat.length > 0) setActiveIndex((active + 1) % flat.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        // From no row at all, ↑ starts at the bottom, as ↓ starts at the top.
        if (flat.length > 0) {
          setActiveIndex(active === NO_ROW ? flat.length - 1 : (active - 1 + flat.length) % flat.length);
        }
        break;
      case 'Enter':
        e.preventDefault();
        if (active >= 0) choose(flat[active]);
        break;
      case 'Escape':
        // Stopped here so the dismissable-menu listener on `document` does
        // not close the palette a second time and pull focus to the box.
        e.preventDefault();
        e.stopPropagation();
        onClose('previous');
        break;
      case 'Tab':
        // Leaving the input leaves the palette. Focus is put back on the box
        // BEFORE the browser acts on the Tab, so it moves on from there to
        // the next control — not from an input that has just unmounted, which
        // would restart the tab order at the top of the page.
        onClose('trigger');
        break;
    }
  };

  const trimmed = query.trim();
  const loadingItems = catalogState.loading && !catalogState.catalog;

  const renderGroup = (label: string, rows: PaletteRow[], offset: number) => {
    if (rows.length === 0) return null;
    const labelId = `${listboxId}-${label.replace(/\W+/g, '-')}`;
    return (
      <div role="group" aria-labelledby={labelId}>
        <div id={labelId} role="presentation" className="px-2 pt-2 pb-1 text-label uppercase text-ink-faint">
          {label}
        </div>
        {rows.map((r, i) => {
          const index = offset + i;
          const selected = index === active;
          const shortcut = r.action?.shortcut;
          const location = r.action ? r.action.group : r.result.location;
          return (
            <div
              key={r.key}
              id={optionId(r.key)}
              role="option"
              aria-selected={selected}
              // Keep focus in the input: the row is chosen by click, not focused.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => {
                if (!selected) setActiveIndex(index);
              }}
              onClick={() => choose(r)}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-ui text-ink',
                selected && 'bg-hover',
              )}
            >
              <span aria-hidden className="flex-none text-ink-faint">
                {r.action ? (r.action.icon ?? <ChevronRight size={15} />) : ICONS[r.result.kind]}
              </span>
              <span className="min-w-0 truncate">{r.action ? r.action.label : r.result.name}</span>
              {location && (
                <span className="ml-auto max-w-[45%] flex-none truncate pl-2 text-meta text-ink-faint">
                  {location}
                </span>
              )}
              {shortcut && shortcut.length > 0 && (
                <>
                  {/* Drawn as keys for the eye, said as words for the ear:
                      `aria-keyshortcuts` cannot express a sequence like G K. */}
                  <span aria-hidden className={cn('flex flex-none items-center gap-1 pl-2', !location && 'ml-auto')}>
                    {shortcut.map((key, k) => (
                      <kbd
                        key={k}
                        className="rounded-xs border border-line-strong px-[5px] font-mono text-meta text-ink-faint"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                  <span className="sr-only"> (shortcut {spokenShortcut(shortcut)})</span>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // One line under the rows for whatever they cannot say themselves: the
  // catalog still on its way, the catalog unreachable, or no match at all.
  // Outside the listbox, which holds options and nothing else.
  // A failed catalog is said whether or not there are rows: with nothing
  // typed the suggested commands fill the list, and the person would never
  // learn that skills and tools could not be found.
  const emptiness = flat.length === 0 ? (trimmed ? `Nothing matches “${trimmed}”.` : 'Nothing to search yet.') : null;
  const failure = catalogState.failed && !catalogState.catalog ? 'Couldn’t load skills and tools.' : null;
  const status = loadingItems ? 'Loading skills and tools…' : [emptiness, failure].filter(Boolean).join(' ') || null;

  return (
    <MenuPanel className="flex max-h-[min(480px,calc(100dvh-72px))] flex-col">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={TRIGGER_LABEL}
        aria-expanded
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
        placeholder={PLACEHOLDER}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(e.target.value.trim() ? 0 : NO_ROW);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        className="mb-1 w-full flex-none border-b border-line bg-transparent px-2 pt-1.5 pb-2.5 text-body text-ink placeholder:text-ink-faint focus:outline-none"
      />
      <div id={listboxId} role="listbox" aria-label="Commands and results" className="min-h-0 overflow-y-auto">
        {renderGroup('Actions', actionHits, 0)}
        {renderGroup('Pages', pageHits, actionHits.length)}
        {renderGroup('Skills & tools', itemHits, actionHits.length + pageHits.length)}
      </div>
      {notice && (
        <div role="alert" className="flex-none px-2 pt-2 text-ui text-danger">
          {notice}
        </div>
      )}
      <div role="status" className={cn('flex-none px-2 text-ui text-ink-muted', status && 'py-2')}>
        {status}
      </div>
    </MenuPanel>
  );
}
