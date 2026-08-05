import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  type PanelImperativeHandle,
  type PanelSize,
} from 'react-resizable-panels';
import { LayoutContext, type LayoutController } from '../state/layout.context';
import { SidebarFrame } from './SidebarFrame';
import { toggleSidebar, useSidebar } from '../state/sidebar';
import type { PaneDef } from '../../../core/registry';

const LAYOUT_ID = 'bevel-shell-v1';
const SEPARATOR_CLASS =
  'w-px bg-sunken hover:bg-accent-hover/60 data-[dragging=true]:bg-accent-hover transition-colors outline-none focus-visible:bg-accent-hover cursor-col-resize';

function getSafeLocalStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const storage = window.localStorage;
    const probeKey = `${LAYOUT_ID}:storage-probe`;
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return undefined;
  }
}

interface ResizableThreePaneLayoutProps {
  header?: ReactNode;
  /**
   * Registry-driven pane list (preferred). When provided, panel ids — and
   * therefore the persisted layout shape — derive from this list.
   */
  panes?: PaneDef[];
  /** Reports the pane controller upward (null on unmount) — see AppLayout. */
  onController?: (controller: LayoutController | null) => void;
  // Legacy named slots, kept as a convenience/compat signature (converted to
  // the same pane list internally with the historical sizing defaults).
  explorer?: ReactNode;
  viewer?: ReactNode;
  chat?: ReactNode;
}

export function ResizableThreePaneLayout({
  header,
  panes,
  onController,
  explorer,
  viewer,
  chat,
}: ResizableThreePaneLayoutProps) {
  const allPanes = useMemo<PaneDef[]>(() => {
    if (panes && panes.length > 0) {
      return [...panes].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    }
    const legacy: PaneDef[] = [];
    if (explorer !== undefined) {
      legacy.push({ id: 'explorer', node: explorer, sidebar: true, collapsible: true });
    }
    if (viewer !== undefined) {
      legacy.push({ id: 'viewer', node: viewer, minSize: '30%' });
    }
    if (chat !== undefined) {
      legacy.push({
        id: 'chat',
        node: chat,
        defaultSize: '26%',
        minSize: '18%',
        maxSize: '50%',
        collapsible: true,
      });
    }
    return legacy;
  }, [panes, explorer, viewer, chat]);

  // The sidebar is pulled OUT of the group: its width is a shared preference
  // that outlives this layout (Skills & Tools has no group at all and the same
  // sidebar), so it cannot be a panel in a per-app persisted layout.
  const sidebarPane = useMemo(() => allPanes.find((p) => p.sidebar), [allPanes]);
  const paneList = useMemo(() => allPanes.filter((p) => !p.sidebar), [allPanes]);

  // The pane *ids* must be referentially stable across renders even though
  // the pane nodes (fresh JSX) are not — useDefaultLayout keys the persisted
  // layout on them.
  const idsKey = paneList.map((p) => p.id).join('|');
  const panelIds = useMemo(() => idsKey.split('|'), [idsKey]);

  // One stable imperative-handle ref per pane id (a plain `{ current }`
  // object satisfies the `panelRef` contract). Created lazily so the map
  // adapts to whatever panes are registered.
  const panelRefs = useRef(
    new Map<string, RefObject<PanelImperativeHandle | null>>(),
  );
  const getPanelRef = (id: string): RefObject<PanelImperativeHandle | null> => {
    let ref = panelRefs.current.get(id);
    if (!ref) {
      ref = { current: null };
      panelRefs.current.set(id, ref);
    }
    return ref;
  };

  const storage = useMemo(() => getSafeLocalStorage(), []);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: LAYOUT_ID,
    panelIds,
    storage,
  });

  const [collapsedById, setCollapsedById] = useState<Record<string, boolean>>(
    {},
  );

  const sidebarId = sidebarPane?.id;
  const { collapsed: sidebarCollapsed } = useSidebar();

  const togglePane = useCallback(
    (id: string) => {
      // The sidebar is not a panel, so its toggle is the shared store rather
      // than an imperative handle. Routing it through the same function keeps
      // the toolbar's `togglePane('explorer')` working either way.
      if (id === sidebarId) {
        toggleSidebar();
        return;
      }
      const panel = panelRefs.current.get(id)?.current;
      if (!panel) return;
      if (panel.isCollapsed()) panel.expand();
      else panel.collapse();
    },
    [sidebarId],
  );

  const handlePaneResize = useCallback((id: string, size: PanelSize) => {
    const isCollapsed = size.asPercentage === 0;
    setCollapsedById((prev) =>
      prev[id] === isCollapsed ? prev : { ...prev, [id]: isCollapsed },
    );
  }, []);

  const collapsibleIds = useMemo(
    () => new Set(allPanes.filter((p) => p.collapsible).map((p) => p.id)),
    [allPanes],
  );

  // One question, two possible answers depending on whether the pane is the
  // sidebar or a panel — asked here so no consumer has to know which it is.
  const isCollapsed = useCallback(
    (id: string) => (id === sidebarId ? sidebarCollapsed : !!collapsedById[id]),
    [collapsedById, sidebarCollapsed, sidebarId],
  );

  const controller = useMemo<LayoutController>(
    () => ({
      isExplorerCollapsed: isCollapsed('explorer'),
      isChatCollapsed: isCollapsed('chat'),
      canToggleExplorer: collapsibleIds.has('explorer'),
      canToggleChat: collapsibleIds.has('chat'),
      toggleExplorer: () => togglePane('explorer'),
      toggleChat: () => togglePane('chat'),
      isPaneCollapsed: isCollapsed,
      canTogglePane: (id: string) => collapsibleIds.has(id),
      togglePane,
    }),
    [collapsibleIds, isCollapsed, togglePane],
  );

  // Mirror the controller to the shell (whose provider wraps the toolbar).
  // The inner provider below still serves this layout's own subtree — same
  // object, so the two are always consistent.
  useEffect(() => {
    onController?.(controller);
    return () => onController?.(null);
  }, [controller, onController]);

  return (
    <LayoutContext.Provider value={controller}>
      <div className="flex flex-col h-full bg-white text-ink">
        {header}
        <div className="flex flex-1 min-h-0">
        {sidebarPane && (
          <SidebarFrame label="File explorer">{sidebarPane.node}</SidebarFrame>
        )}
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
          className="flex flex-1 min-w-0"
        >
          {paneList.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 && <Separator className={SEPARATOR_CLASS} />}
              <Panel
                id={pane.id}
                panelRef={getPanelRef(pane.id)}
                defaultSize={pane.defaultSize}
                minSize={pane.minSize}
                maxSize={pane.maxSize}
                collapsible={pane.collapsible}
                collapsedSize={pane.collapsible ? '0%' : undefined}
                onResize={
                  pane.collapsible
                    ? (size: PanelSize) => handlePaneResize(pane.id, size)
                    : undefined
                }
              >
                {pane.node}
              </Panel>
            </Fragment>
          ))}
        </Group>
        </div>
      </div>
    </LayoutContext.Provider>
  );
}
