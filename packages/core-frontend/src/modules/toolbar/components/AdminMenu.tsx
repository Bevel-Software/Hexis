import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Boxes, CircleUserRound, KeyRound, LibraryBig, Lock, Settings, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAdmin } from '../../admin/state/admin.context';
import { useAppRegistry, type AdminMenuItem } from '../../../core/registry';

const MENU_ID = 'app-settings-menu';

const ITEM_CLASS =
  'flex w-full items-center gap-2 px-3 py-1.5 text-sm text-left text-ink hover:bg-hover';

/** One gear-menu row: shared `role="menuitem"` button shell around icon + label. */
function MenuItem({
  icon,
  onSelect,
  children,
}: {
  icon: React.ReactNode;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" role="menuitem" onClick={onSelect} className={ITEM_CLASS}>
      {icon}
      {children}
    </button>
  );
}

/**
 * The core gear-menu rows. Everything else (Connectors, Watchlist, Routines,
 * Connected apps, feedback, LLM configuration, user accounts, …) is
 * registry-contributed — see `enterprise/admin-menu-items.tsx`. The `order`
 * values interleave the two lists to reproduce the historical row order.
 *
 * All core rows NAVIGATE — the settings surfaces are standalone routed pages
 * below the persistent toolbar, not dialogs. The `dialog` contract on
 * {@link AdminMenuItem} stays supported for registry-contributed rows.
 */
const CORE_MENU_ITEMS: AdminMenuItem[] = [
  {
    id: 'skills-and-tools',
    order: 35,
    icon: <LibraryBig size={14} />,
    label: 'Skills & Tools',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/skills-and-tools');
      closeMenu();
    },
  },
  {
    id: 'external-agent-access',
    order: 40,
    icon: <KeyRound size={14} />,
    label: 'External agent access',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/external-agent-access');
      closeMenu();
    },
  },
  {
    id: 'secrets',
    order: 50,
    icon: <Lock size={14} />,
    label: 'Secrets',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/secrets');
      closeMenu();
    },
  },
  {
    id: 'browse-tools',
    order: 70,
    icon: <Boxes size={14} />,
    label: 'Browse available tools',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/tools');
      closeMenu();
    },
  },
  {
    id: 'account',
    order: 90,
    icon: <CircleUserRound size={14} />,
    label: 'Account',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/account');
      closeMenu();
    },
  },
  {
    id: 'roles-members',
    section: 'admin',
    order: 10,
    icon: <Users size={14} />,
    label: 'Roles & Members',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/roles-and-members');
      closeMenu();
    },
  },
];

/**
 * The single toolbar menu behind the gear icon. Renders the core rows above
 * plus whatever the app registry contributes (`registry.adminMenuItems`),
 * merged by section + order:
 *
 *   - Top section (all users): today that merge yields Connectors, Watchlist,
 *     Routines, External agent access, Secrets, Connected apps, Browse tools,
 *     Give us feedback.
 *   - "Admin only" section (admins): Roles & Members, User accounts,
 *     LLM Configuration, Feedback Inbox.
 *
 * Core rows all navigate (the settings surfaces are standalone routed
 * pages). Registry rows may still be dialog rows: those don't navigate —
 * selecting the row closes the menu and opens the row's dialog. Dialogs are
 * mounted here persistently (driven by an open flag per row) so they survive
 * the (transient) dropdown, exactly as the pre-registry static dialogs did.
 *
 * Open/close mechanics mirror PrHeaderOverflowMenu: click toggles, an outside
 * mousedown or Escape closes. Rendered for all users; the admin section is
 * gated on `isAdmin`, and the trigger's unread badge only shows for admins.
 */
export function AdminMenu() {
  const navigate = useNavigate();
  const { isAdmin, unreadCount } = useAdmin();
  const registry = useAppRegistry();
  const [open, setOpen] = useState(false);
  // Per-row dialog open flags, keyed by item id. A plain map (rather than one
  // "active dialog" slot) preserves the historical behavior where two dialogs
  // opened in sequence can coexist until each is closed on its own.
  const [openDialogs, setOpenDialogs] = useState<Record<string, boolean>>({});
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { defaultItems, adminItems } = useMemo(() => {
    const all = [...CORE_MENU_ITEMS, ...registry.adminMenuItems];
    const bySection = (section: 'default' | 'admin') =>
      all
        .filter((item) => (item.section ?? 'default') === section)
        .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return { defaultItems: bySection('default'), adminItems: bySection('admin') };
  }, [registry]);

  // Only admins have the Feedback Inbox, so the unread badge is admin-only too.
  const showBadge = isAdmin && unreadCount > 0;

  // Close and hand focus back to the trigger, so keyboard/screen-reader users
  // don't get dropped onto document.body when a focused menu item unmounts.
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Open a dialog from a menu row: close the menu first (so focus/scroll state
  // is clean), then flip the dialog open.
  const openDialog = (id: string) => {
    close();
    setOpenDialogs((prev) => ({ ...prev, [id]: true }));
  };
  const closeDialog = (id: string) => {
    setOpenDialogs((prev) => ({ ...prev, [id]: false }));
  };

  const handleSelect = (item: AdminMenuItem) => {
    if (item.dialog) {
      openDialog(item.id);
      return;
    }
    item.onSelect?.({ closeMenu: close, navigate });
  };

  const renderRow = (item: AdminMenuItem) => (
    <MenuItem key={item.id} icon={item.icon} onSelect={() => handleSelect(item)}>
      {item.label}
    </MenuItem>
  );

  const renderDialogs = (items: AdminMenuItem[]) =>
    items
      .filter((item) => item.dialog)
      .map((item) => (
        <Fragment key={item.id}>
          {item.dialog!({
            open: !!openDialogs[item.id],
            onClose: () => closeDialog(item.id),
          })}
        </Fragment>
      ));

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative p-1.5 rounded hover:bg-hover text-ink-muted hover:text-ink"
        title="Menu"
        aria-label={showBadge ? `Menu, ${unreadCount} new feedback` : 'Menu'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
      >
        <Settings size={16} />
        {showBadge && (
          <span
            className="absolute top-0.5 right-0.5 block w-2 h-2 rounded-full bg-red-500 ring-2 ring-white"
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div
          id={MENU_ID}
          role="menu"
          className="absolute right-0 top-full mt-1 z-40 bg-white border border-line rounded shadow-md py-1 flex flex-col items-stretch min-w-[13rem]"
        >
          {defaultItems.map(renderRow)}

          {isAdmin && adminItems.length > 0 && (
            <div role="group" aria-labelledby="admin-menu-admin-section-label">
              <div
                role="presentation"
                id="admin-menu-admin-section-label"
                className="mt-1 pt-1 border-t border-line px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
              >
                Admin only
              </div>
              {adminItems.map(renderRow)}
            </div>
          )}
        </div>
      )}

      {/* Dialogs opened by the menu rows above. Mounted at the menu root so they
          persist independently of the (transient) dropdown. */}
      {renderDialogs(defaultItems)}
      {isAdmin && renderDialogs(adminItems)}
    </div>
  );
}
