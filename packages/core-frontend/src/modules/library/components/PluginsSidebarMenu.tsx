import type { RefObject } from 'react';
import { FilePlus, FolderPlus, Link2, Trash2, Users } from 'lucide-react';
import { MenuItem, MenuPanel, useDismissableMenu } from '../../../shared/components';

/**
 * The Library sidebar's right-click menu — Knowledge's `ContextMenu`
 * (`FileExplorer.tsx:126`) with the Library's verbs in it.
 *
 * The two navs are one frame holding two lists (see `PluginsSidebar`'s
 * docstring), so a right-click has to BEHAVE the same in both: the panel opens
 * at the pointer, an outside click or Escape closes it, and Escape hands focus
 * back to the row it came from. None of that is `MenuPanel`'s job — its own
 * docstring says it is presentation only — so the wiring is `useDismissableMenu`
 * and the fixed wrapper is the caller's, exactly as in the file tree.
 *
 * The ITEMS differ, because the things differ. A plugin is not a file: there is
 * no Rename and no Download here, because no endpoint stands behind either for
 * a plugin, and a menu item that cannot do its job is worse than one that is
 * not there (the same call `PageActions` already makes about Leave
 * subscription). Delete DOES have an endpoint now — `DELETE /api/plugins/:name`,
 * the owner's verb — so it appears exactly when the caller owns the plugin and
 * not otherwise. What carries over is the pairing that matters — a create
 * verb, a copy verb, and access below the rule — wearing the SAME lucide
 * glyphs the file tree gives each, so the two menus read as one product
 * rather than two.
 *
 * Every action is optional, and an absent one is simply not rendered — the same
 * contract `ContextMenu` uses for `onCreateFile` / `onDownload`. That is what
 * lets one component serve a plugin row, a lens row and the nav's empty space
 * with no `kind` switch inside it: the layout is the one that knows which verbs
 * are true for what was clicked, and it says so by passing them.
 */
export interface PluginsSidebarMenuProps {
  x: number;
  y: number;
  /** What was right-clicked, by name — the menu's accessible name. */
  label: string;
  onClose(): void;
  /** Opens "Add a skill or tool to {label}". Absent for a lens or empty space. */
  onAdd?(): void;
  /** The one verb every target has: the nav's own create affordance. */
  onCreatePlugin(): void;
  /** Copies a link to the row's page. Absent on the nav's empty space. */
  onCopyLink?(): void;
  /** Absent when there is no folder behind the row to manage. */
  onManageAccess?(): void;
  /** Opens the delete confirmation. Present ONLY for a plugin the caller owns. */
  onDelete?(): void;
  /** The row this menu was opened from — Escape hands focus back to it. */
  returnFocusTo?: RefObject<HTMLElement | null>;
}

export function PluginsSidebarMenu({
  x,
  y,
  label,
  onClose,
  onAdd,
  onCreatePlugin,
  onCopyLink,
  onManageAccess,
  onDelete,
  returnFocusTo,
}: PluginsSidebarMenuProps) {
  const ref = useDismissableMenu<HTMLDivElement>({ open: true, onClose, returnFocusTo });

  return (
    // Positioning stays with the caller — `MenuPanel` is presentation only, so
    // the fixed-to-the-pointer wrapper is ours and the panel inside is the
    // shared one. Same shape as the file tree's.
    <div
      ref={ref}
      className="fixed z-50"
      style={{ left: x, top: y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <MenuPanel role="menu" aria-label={`Actions for ${label}`} className="min-w-[180px]">
        {onAdd && (
          <MenuItem
            role="menuitem"
            onClick={() => {
              onAdd();
              onClose();
            }}
          >
            <span className="flex items-center gap-2">
              <FilePlus size={14} />
              Add a skill or tool
            </span>
          </MenuItem>
        )}
        <MenuItem
          role="menuitem"
          onClick={() => {
            onCreatePlugin();
            onClose();
          }}
        >
          <span className="flex items-center gap-2">
            <FolderPlus size={14} />
            New plugin
          </span>
        </MenuItem>
        {onCopyLink && (
          <MenuItem
            role="menuitem"
            onClick={() => {
              onCopyLink();
              onClose();
            }}
          >
            <span className="flex items-center gap-2">
              <Link2 size={14} />
              Copy link
            </span>
          </MenuItem>
        )}
        {onManageAccess && (
          <>
            {/* Access sits below a rule in the file tree's menu too — it is the
                item that changes who else can be here, not what is here. */}
            <div className="my-1 border-t border-line" />
            <MenuItem
              role="menuitem"
              onClick={() => {
                onManageAccess();
                onClose();
              }}
            >
              <span className="flex items-center gap-2">
                <Users size={14} />
                Manage access
              </span>
            </MenuItem>
          </>
        )}
        {onDelete && (
          <>
            {/* Destructive and last, below its own rule — the file tree's menu
                puts Delete in the same place, so the gesture reads the same. */}
            <div className="my-1 border-t border-line" />
            <MenuItem
              role="menuitem"
              tone="danger"
              onClick={() => {
                onDelete();
                onClose();
              }}
            >
              <span className="flex items-center gap-2">
                <Trash2 size={14} />
                Delete plugin
              </span>
            </MenuItem>
          </>
        )}
      </MenuPanel>
    </div>
  );
}
