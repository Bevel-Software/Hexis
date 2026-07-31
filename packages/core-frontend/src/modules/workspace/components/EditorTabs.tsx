import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useWorkspace } from '../state/workspace.context';
import { useFileNav } from '../routing/kb-routes';
import type { OpenTab } from '../state/workspace.context';

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

  // Hide the tabs strip entirely when there are no tabs — keeps the empty
  // state from looking like a chrome-only viewer.
  if (openTabs.length === 0) return null;

  return (
    <div className="border-b border-line bg-sunken shrink-0">
      <div
        role="tablist"
        aria-label="Open files"
        className="flex items-stretch overflow-x-auto"
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
  onContextMenu: (e: React.MouseEvent) => void;
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

  return (
    <div
      role="tab"
      aria-selected={isActive}
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
      className={[
        'group relative flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border-r border-line cursor-pointer select-none whitespace-nowrap shrink-0 min-w-[8rem]',
        isActive
          ? 'bg-sunken text-ink'
          : 'text-ink-muted hover:bg-hover',
        isDragging ? 'opacity-40' : '',
        isDragTarget ? 'border-l-2 border-l-accent' : '',
      ].join(' ')}
    >
      <span className="truncate max-w-[16rem]">{filename}</span>
      {tab.isDirty && (
        <span
          aria-label="Unsaved changes"
          className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
        />
      )}
      {hasPending && (
        <span
          aria-label="Agent has pending changes"
          className="px-1 py-0 rounded bg-emerald-100 text-emerald-700 text-[9px] font-bold shrink-0"
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
        className="ml-0.5 p-0.5 rounded hover:bg-hover text-ink-faint hover:text-ink opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
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
}

function ContextMenu({ state, openTabs, onClose, onCloseTab, onCloseMany }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: state.x, top: state.y });

  // After the menu mounts, measure it and clamp into the viewport so a click
  // near the right/bottom edge doesn't open a menu that's partially off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(0, Math.min(state.x, window.innerWidth - w));
    const top = Math.max(0, Math.min(state.y, window.innerHeight - h));
    setPos({ left, top });
  }, [state.x, state.y]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

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
    <div
      ref={ref}
      role="menu"
      aria-label="Tab actions"
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-[12rem] rounded border border-line bg-white shadow-lg py-1 text-xs"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={item.onClick}
          className="w-full text-left px-3 py-1.5 text-ink hover:bg-hover disabled:text-ink-faint disabled:hover:bg-transparent disabled:cursor-default"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
