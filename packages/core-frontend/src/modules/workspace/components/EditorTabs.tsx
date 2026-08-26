import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { MenuPanel, MenuItem } from '../../../shared/components';
import { useDismissableMenu, usePointerMenuPosition } from '../../../shared/components';
import { useOpenChangeRequests } from '../hooks/useOpenChangeRequests';
import { useWorkspace } from '../state/workspace.context';
import { useFileNav } from '../routing/kb-routes';
import type { OpenTab } from '../state/workspace.context';
import '../workspace.css';

const DRAG_MIME = 'application/x-bevel-tab-path';

const UNSAVED_TABS_BULK_WARNING = (filenames: string[]) =>
  `You have unsaved changes in:\n  - ${filenames.join('\n  - ')}\nClose anyway?`;

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

interface MenuState {
  tab: OpenTab;
  x: number;
  y: number;
}

export function EditorTabs() {
  const {
    openTabs,
    activeTab,
    closeTab,
    reorderTab,
  } = useWorkspace();
  const { openFile: navigateToFile, closeFile: navigateToBranchRoot } = useFileNav();

  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // The tab the menu was opened from. A ref rather than part of `MenuState`
  // because `useDismissableMenu` wants a ref box, and because the tabs are a
  // list — there is no single element a `useRef` on the tab could name.
  const menuTriggerRef = useRef<HTMLElement | null>(null);

  // Hide the tabs strip entirely when there are no tabs — keeps the empty
  // state from looking like a chrome-only viewer.
  if (openTabs.length === 0) return null;

  return (
    // The prototype's `.kbtabs` (proto:712-723): transparent, one hairline
    // under it, an 18px gap to the content, and no scrollbar drawn over the
    // labels. It sits INSIDE the document column, so its left edge is the
    // title's left edge.
    <div className="shrink-0">
      <div
        role="tablist"
        aria-label="Open files"
        className="kb-tabstrip mb-[18px] flex items-center gap-0.5 overflow-x-auto border-b border-line"
      >
        {openTabs.map((tab) => (
          <TabPill
            key={tab.path}
            tab={tab}
            isActive={activeTab?.path === tab.path}
            isDragging={draggingPath === tab.path}
            isDragTarget={dragOverPath === tab.path && draggingPath !== tab.path}
            onActivate={() => navigateToFile(tab.path)}
            onClose={async () => {
              const wasActive = tab.path === activeTab?.path;
              const { closed, newActivePath } = await closeTab(tab);
              if (!closed) return;
              if (wasActive) {
                // Drive the URL ourselves so FileRoute's URL→state effect sees
                // matching state and no-ops — no state→URL feedback loop.
                if (newActivePath) {
                  navigateToFile(newActivePath);
                } else {
                  navigateToBranchRoot();
                }
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              menuTriggerRef.current = e.currentTarget;
              setMenu({ tab, x: e.clientX, y: e.clientY });
            }}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, tab.path);
              e.dataTransfer.effectAllowed = 'move';
              setDraggingPath(tab.path);
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDragEnter={() => {
              if (draggingPath && draggingPath !== tab.path) setDragOverPath(tab.path);
            }}
            onDragLeave={(e) => {
              // Only clear if leaving outside this element, not entering a child.
              const related = e.relatedTarget as Node | null;
              if (!related || !(e.currentTarget as Node).contains(related)) {
                setDragOverPath((prev) => (prev === tab.path ? null : prev));
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              const draggedPath = e.dataTransfer.getData(DRAG_MIME);
              if (!draggedPath || draggedPath === tab.path) {
                setDraggingPath(null);
                setDragOverPath(null);
                return;
              }
              const dragged = openTabs.find((t) => t.path === draggedPath);
              const targetIdx = openTabs.findIndex((t) => t.path === tab.path);
              if (dragged && targetIdx >= 0) {
                reorderTab(dragged, targetIdx);
              }
              setDraggingPath(null);
              setDragOverPath(null);
            }}
            onDragEnd={() => {
              setDraggingPath(null);
              setDragOverPath(null);
            }}
          />
        ))}
      </div>
      {menu && (
        <ContextMenu
          state={menu}
          openTabs={openTabs}
          returnFocusTo={menuTriggerRef}
          onClose={() => setMenu(null)}
          onCloseTab={async (tab) => {
            const wasActive = tab.path === activeTab?.path;
            const { closed, newActivePath } = await closeTab(tab);
            if (!closed || !wasActive) return;
            if (newActivePath) navigateToFile(newActivePath);
            else navigateToBranchRoot();
          }}
          onCloseMany={async (tabs) => {
            const dirty = tabs.filter((t) => t.isDirty);
            if (dirty.length > 0) {
              const ok = window.confirm(
                UNSAVED_TABS_BULK_WARNING(dirty.map((t) => basename(t.path))),
              );
              if (!ok) return;
            }
            // Pass skipConfirm so the per-tab dirty prompt doesn't fire again
            // (we already collected one bulk confirm). Run each close in a
            // try/catch so a single failure doesn't strand the UI mid-bulk:
            // we navigate based only on the last successfully-closed tab and
            // surface the failure to the user via console + alert.
            const activePath = activeTab?.path ?? null;
            const closingActive = activePath !== null && tabs.some((t) => t.path === activePath);
            let lastActivePath = activePath;
            // Store only the path + error metadata — the full OpenTab carries
            // file content/pendingFileContent which we don't want in logs or
            // any future telemetry sink.
            const failures: { path: string; message: string; stack?: string }[] = [];
            for (const t of tabs) {
              try {
                const { closed, newActivePath } = await closeTab(t, { skipConfirm: true });
                if (closed) lastActivePath = newActivePath;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const stack = err instanceof Error ? err.stack : undefined;
                failures.push({ path: t.path, message, stack });
              }
            }
            if (closingActive) {
              if (lastActivePath) navigateToFile(lastActivePath);
              else navigateToBranchRoot();
            }
            if (failures.length > 0) {
              console.error('[EditorTabs] Failed to close tabs', failures);
              window.alert(
                `Failed to close ${failures.length} tab(s): ${failures
                  .map((f) => basename(f.path))
                  .join(', ')}`,
              );
            }
          }}
        />
      )}
    </div>
  );
}

interface TabPillProps {
  tab: OpenTab;
  isActive: boolean;
  isDragging: boolean;
  isDragTarget: boolean;
  onActivate: () => void;
  onClose: () => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnter: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

function TabPill(props: TabPillProps) {
  const {
    tab,
    isActive,
    isDragging,
    isDragTarget,
    onActivate,
    onClose,
    onContextMenu,
    onDragStart,
    onDragOver,
    onDragEnter,
    onDragLeave,
    onDrop,
    onDragEnd,
  } = props;

  const filename = basename(tab.path);
  const hasPending = tab.pendingFileContent !== null;
  const hasChangeRequest = useOpenChangeRequests().paths.has(tab.path);
  const ref = useRef<HTMLDivElement>(null);

  // Suppressing the scrollbar removes the one cue that more strip exists, so
  // activation has to bring the tab to the user instead. There was no
  // scroll-into-view here before — with 20 tabs, activating one that was
  // scrolled off-screen simply left it off-screen.
  useEffect(() => {
    if (isActive) ref.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [isActive]);

  return (
    <div
      ref={ref}
      role="tab"
      aria-selected={isActive}
      aria-current={isActive}
      tabIndex={isActive ? 0 : -1}
      title={tab.path}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onMouseDown={(e) => {
        // Middle-click closes the tab (matches VS Code behavior).
        if (e.button === 1) {
          e.preventDefault();
          onClose();
        }
      }}
      className={cn(
        'group relative flex shrink-0 cursor-pointer select-none items-center gap-[7px]',
        'whitespace-nowrap rounded-t-sm px-2.5 pt-[7px] pb-2.5 text-detail transition-colors',
        // Active is weight and a 2px underline, not a filled pill: the tab is
        // part of the page, and a pill would make the strip its own object.
        isActive
          ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-ink)]'
          : 'text-ink-faint hover:bg-hover hover:text-ink-muted',
        isDragging && 'opacity-40',
        isDragTarget && 'border-l-2 border-l-accent',
      )}
    >
      {/* The accent dot marks the file you ARE looking at as having an open
          request; the tree's amber one marks files you are not (proto:723). */}
      {hasChangeRequest && (
        <span
          title="Open change request"
          className="h-1.5 w-1.5 flex-none rounded-full bg-accent"
        />
      )}
      <span className="truncate max-w-[16rem]">{filename}</span>
      {tab.isDirty && (
        <span
          aria-label="Unsaved changes"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-wait-dot"
        />
      )}
      {hasPending && (
        <span
          aria-label="Agent has pending changes"
          className="shrink-0 rounded-xs bg-ok-soft px-1 text-micro font-bold text-ok"
        >
          AI
        </span>
      )}
      <button
        type="button"
        aria-label={`Close ${filename}`}
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        // `focus-visible:` rather than `focus:` so the control does not pop
        // open on a mouse click — it should appear for the keyboard, which is
        // the case that cannot hover.
        className="ml-0.5 shrink-0 rounded-xs p-0.5 text-ink-faint opacity-0 transition-opacity hover:bg-line hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
      >
        <X size={11} />
      </button>
    </div>
  );
}

interface ContextMenuProps {
  state: MenuState;
  openTabs: OpenTab[];
  onClose: () => void;
  onCloseTab: (tab: OpenTab) => void | Promise<void>;
  onCloseMany: (tabs: OpenTab[]) => void | Promise<void>;
  /** The tab this menu was opened from — Escape hands focus back to it. */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

function ContextMenu({
  state,
  openTabs,
  onClose,
  onCloseTab,
  onCloseMany,
  returnFocusTo,
}: ContextMenuProps) {
  const ref = useDismissableMenu<HTMLDivElement>({ open: true, onClose, returnFocusTo });
  // This menu measured and clamped itself, which the file tree's did not, and
  // the two drifting apart is what left a right-click low in the tree with a
  // menu running off the bottom of the window. One hook now, so a pointer
  // menu's placement cannot depend on which surface opened it. The tab strip
  // sits at the top of the window, so what changes here is only the inset from
  // the right edge: the flip has nothing to flip away from.
  const pos = usePointerMenuPosition(ref, state.x, state.y);

  const targetIdx = openTabs.findIndex((t) => t.path === state.tab.path);
  // If the target tab is gone (closed under us between menu open and click),
  // treat all derived ranges as empty so we never operate on the wrong tabs.
  // Without this, slice(-1 + 1) === slice(0) would close every open tab.
  const targetMissing = targetIdx === -1;
  const others = targetMissing ? [] : openTabs.filter((t) => t.path !== state.tab.path);
  const toRight = targetMissing ? [] : openTabs.slice(targetIdx + 1);

  const items: Array<{ label: string; onClick: () => void; disabled?: boolean }> = [
    {
      label: 'Close',
      onClick: () => {
        onClose();
        void onCloseTab(state.tab);
      },
    },
    {
      label: 'Close others',
      disabled: others.length === 0,
      onClick: () => {
        onClose();
        void onCloseMany(others);
      },
    },
    {
      label: 'Close tabs to the right',
      disabled: toRight.length === 0,
      onClick: () => {
        onClose();
        void onCloseMany(toRight);
      },
    },
    {
      label: 'Close all',
      onClick: () => {
        onClose();
        void onCloseMany(openTabs);
      },
    },
  ];

  return (
    // Positioning is the caller's — `MenuPanel` is presentation only.
    <div ref={ref} style={{ left: pos.left, top: pos.top }} className="fixed z-50">
      <MenuPanel role="menu" aria-label="Tab actions" className="min-w-[12rem]">
        {items.map((item) => (
          <MenuItem
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={item.onClick}
          >
            {item.label}
          </MenuItem>
        ))}
      </MenuPanel>
    </div>
  );
}
