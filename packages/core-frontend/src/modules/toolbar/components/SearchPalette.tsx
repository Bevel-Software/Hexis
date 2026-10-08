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
import { FileText, Puzzle, Search, Sparkles, Wrench } from 'lucide-react';
import { MenuPanel, useDismissableMenu, useLatestRef } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useMergedWorkspaceTree } from '../../workspace/hooks/useMergedWorkspaceTree';
import { useFileNav } from '../../workspace/routing/kb-routes';
import { knowledgeFiles } from '../../workspace/utils/fileTree';
import { listSkills } from '../../library/services/library.api';
import { listPlugins } from '../../library/services/plugins.api';
import { listToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import { rankByName } from '../search/rank';
import {
  libraryResults,
  pageResults,
  type LibraryCatalog,
  type SearchResult,
  type SearchResultKind,
} from '../search/sources';

/** Rows per group. Past this the query is too short to be useful, not the list too long. */
const GROUP_LIMIT = 8;

const PLACEHOLDER = 'Search pages, skills, tools and plugins';

/**
 * The shortcut belongs to ⌘ on Apple platforms and to Ctrl everywhere else —
 * and ONLY to that one. Ctrl+K on a Mac is the text fields' "delete to end of
 * line", which nobody pressing it there means as "search".
 */
const APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
const SHORTCUT_LABEL = APPLE ? '⌘K' : 'Ctrl K';
const SHORTCUT_ARIA = APPLE ? 'Meta+K' : 'Control+K';

function isShortcut(e: KeyboardEvent): boolean {
  if (e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return false;
  return APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

const byName = (r: SearchResult) => r.name;

const ICONS: Record<SearchResultKind, ReactNode> = {
  page: <FileText size={15} />,
  skill: <Sparkles size={15} />,
  tool: <Wrench size={15} />,
  plugin: <Puzzle size={15} />,
};

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
 * or a plugin BY NAME, from anywhere in the app. Ctrl+K (⌘K on a Mac) opens it
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
    loadCatalog();
  }, [open, loadCatalog]);

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
    if (!focus) return;
    const previous = restoreFocusRef.current?.isConnected ? restoreFocusRef.current : null;
    const target = focus === 'previous' ? (previous ?? triggerRef.current) : (triggerRef.current ?? previous);
    target?.focus();
  }, []);

  const openRef = useLatestRef(openPalette);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isShortcut(e) || e.defaultPrevented) return;
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
          aria-keyshortcuts={SHORTCUT_ARIA}
        >
          <Search aria-hidden size={14} className="flex-none" />
          <span className="min-w-0 flex-1 truncate">{PLACEHOLDER}</span>
          <kbd
            aria-hidden
            className="flex-none rounded-xs border border-line-strong px-[5px] font-mono text-meta text-ink-faint"
          >
            {SHORTCUT_LABEL}
          </kbd>
        </button>
      )}

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Search"
          // A press anywhere in the panel but the input keeps focus IN the
          // input, as the rows already do for themselves: every key the
          // palette answers — the arrows, Enter, and Escape back to where
          // the reader was — is handled there, and a press on the padding,
          // the status line or the list's scroll area would otherwise blur it
          // and leave the open palette deaf to the keyboard.
          onMouseDown={(e) => {
            if (e.target !== inputRef.current) e.preventDefault();
          }}
          className={cn(
            'z-40',
            compact ? 'fixed inset-x-3 top-[52px]' : 'absolute top-[calc(100%+6px)] left-0 w-full min-w-[320px]',
          )}
        >
          <SearchPanel
            inputRef={inputRef}
            catalogState={catalogState}
            onClose={close}
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
  onClose,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  catalogState: CatalogState;
  onClose: (focus?: 'previous' | 'trigger') => void;
}) {
  const navigate = useNavigate();
  const { openWorkspacePath } = useFileNav();
  const { kbDirName } = useWorkspace();
  const { tree, suggestionOnlyPaths } = useMergedWorkspaceTree();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
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

  const pageHits = useMemo(() => rankByName(pages, query, byName, GROUP_LIMIT), [pages, query]);
  const itemHits = useMemo(() => rankByName(items, query, byName, GROUP_LIMIT), [items, query]);
  const flat = useMemo(() => [...pageHits, ...itemHits], [pageHits, itemHits]);
  // Clamped rather than reset when the rows change under it: the catalog can
  // land while the reader is already arrowing through the pages.
  const active = flat.length === 0 ? -1 : Math.min(activeIndex, flat.length - 1);
  const activeKey = active >= 0 ? flat[active].key : null;

  useEffect(() => {
    if (!activeKey) return;
    document.getElementById(`${listboxId}-${activeKey}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeKey, listboxId]);

  const choose = (result: SearchResult) => {
    onClose('trigger');
    if (result.target.kind === 'workspace') openWorkspacePath(result.target.path);
    else navigate(result.target.url);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (flat.length > 0) setActiveIndex((active + 1) % flat.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (flat.length > 0) setActiveIndex((active - 1 + flat.length) % flat.length);
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

  const renderGroup = (label: string, rows: SearchResult[], offset: number) => {
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
                {ICONS[r.kind]}
              </span>
              <span className="min-w-0 truncate">{r.name}</span>
              <span className="ml-auto max-w-[45%] flex-none truncate pl-2 text-meta text-ink-faint">
                {r.location}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  // One line under the rows for whatever they cannot say themselves: the
  // catalog still on its way, the catalog unreachable, or no match at all.
  // Outside the listbox, which holds options and nothing else.
  // The failure comes before "no match": with the catalog unreachable, only
  // the pages were searched, and "No pages or items match" would claim the
  // skills, tools and plugins were searched too.
  const status = loadingItems
    ? 'Loading skills, tools and plugins…'
    : catalogState.failed && !catalogState.catalog
      ? flat.length === 0 && trimmed
        ? `No pages match “${trimmed}”, and skills, tools and plugins couldn’t be loaded.`
        : 'Couldn’t load skills, tools and plugins.'
      : flat.length === 0
        ? trimmed
          ? `No pages or items match “${trimmed}”`
          : 'Nothing to search yet.'
        : null;

  return (
    <MenuPanel className="flex max-h-[min(480px,calc(100dvh-72px))] flex-col">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={PLACEHOLDER}
        aria-expanded
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
        placeholder={PLACEHOLDER}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActiveIndex(0);
        }}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        className="mb-1 w-full flex-none border-b border-line bg-transparent px-2 pt-1.5 pb-2.5 text-body text-ink placeholder:text-ink-faint focus:outline-none"
      />
      <div id={listboxId} role="listbox" aria-label="Search results" className="min-h-0 overflow-y-auto">
        {renderGroup('Pages', pageHits, 0)}
        {renderGroup('Skills, tools & plugins', itemHits, pageHits.length)}
      </div>
      <div role="status" className={cn('flex-none px-2 text-ui text-ink-muted', status && 'py-2')}>
        {status}
      </div>
    </MenuPanel>
  );
}
