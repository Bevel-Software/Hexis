import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { Boxes, ChevronDown, KeyRound, LibraryBig, Lock, LogOut, Users } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AuthUser } from '@bevel-software/platform-shared';
import { useAuth } from '../../auth/state/auth.context';
import { useAdmin } from '../../admin/state/admin.context';
import { useAppRegistry, type AdminMenuItem } from '../../../core/registry';
import {
  MenuItem,
  MenuLabel,
  MenuPanel,
  useDismissableMenu,
} from '../../../shared/components';
import { cn } from '../../../lib/utils';

const MENU_ID = 'app-profile-menu';

/**
 * The core menu rows. Everything else (Connectors, Watchlist, Routines,
 * Connected apps, feedback, LLM configuration, user accounts, …) is
 * registry-contributed — see the enterprise shell's `adminMenuItems`. The
 * `order` values interleave the two lists to reproduce the historical row
 * order. In THIS repo the registry is empty (`makeRegistry({})`), so the menu
 * is these five rows and no more; the enterprise app gets all twelve.
 *
 * All core rows NAVIGATE — the settings surfaces are standalone routed pages
 * below the persistent toolbar, not dialogs. The `dialog` contract on
 * {@link AdminMenuItem} stays supported for registry-contributed rows.
 */
const CORE_MENU_ITEMS: AdminMenuItem[] = [
  {
    id: 'skills-and-tools',
    order: 35,
    icon: <LibraryBig size={15} />,
    label: 'Skills & Tools',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/skills-and-tools');
      closeMenu();
    },
  },
  {
    id: 'external-agent-access',
    order: 40,
    icon: <KeyRound size={15} />,
    label: 'External agent access',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/external-agent-access');
      closeMenu();
    },
  },
  {
    id: 'secrets',
    order: 50,
    icon: <Lock size={15} />,
    label: 'Secrets',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/secrets');
      closeMenu();
    },
  },
  {
    id: 'browse-tools',
    order: 70,
    icon: <Boxes size={15} />,
    label: 'Browse available tools',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/tools');
      closeMenu();
    },
  },
  {
    id: 'roles-members',
    section: 'admin',
    order: 10,
    icon: <Users size={15} />,
    label: 'Roles & Members',
    onSelect: ({ navigate, closeMenu }) => {
      navigate('/roles-and-members');
      closeMenu();
    },
  },
];

/** First letters of the first two words — the prototype's `initials` (proto:2315). */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const mark = ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase();
  return mark || '?';
}

/**
 * A person, as a circle. Falls back to initials rather than to nothing: the
 * avatar is the menu's trigger, and a trigger that vanishes for anyone without
 * a profile picture is not a trigger.
 */
function Avatar({ user, className }: { user: AuthUser; className?: string }) {
  const base = cn('flex-none rounded-full object-cover', className);
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        aria-hidden
        referrerPolicy="no-referrer"
        className={cn(base, 'border border-line')}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        base,
        'inline-flex items-center justify-center border border-line bg-sunken',
        'font-bold text-ink-muted',
      )}
    >
      {initials(user.name)}
    </span>
  );
}

/**
 * One button in the top bar's right edge, holding everything about you —
 * the prototype's `.tbme` trigger and `.pmenu` panel (proto:3397-3462).
 *
 * It replaces THREE separate controls that used to sit here in a row: an inert
 * name, a gear, and a sign-out arrow. The prototype's objection is that all
 * three answer the same question — "me, and the settings that follow me" — so
 * splitting them makes you learn three places to look for one thing. The name
 * was the worst of the three: it sat between two buttons looking pressable and
 * did nothing.
 *
 * Order inside the panel is an argument: identity first, so the menu states
 * who you are before it offers to change anything; then the settings anyone
 * has; then the admin-only set; then the way out — destructive last, and the
 * only red thing in it.
 *
 * The prototype's "Viewing as" person-switcher is deliberately absent. It says
 * so itself: "switching person is a demo affordance, not a product one."
 *
 * Open/close mechanics are `useDismissableMenu` (outside click, Escape,
 * focus back to the trigger) rather than the bespoke pair of document
 * listeners this component used to carry.
 */
export function ProfileMenu() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const { isAdmin, unreadCount } = useAdmin();
  const registry = useAppRegistry();
  const [open, setOpen] = useState(false);
  // Per-row dialog open flags, keyed by item id. A plain map (rather than one
  // "active dialog" slot) preserves the historical behavior where two dialogs
  // opened in sequence can coexist until each is closed on its own.
  const [openDialogs, setOpenDialogs] = useState<Record<string, boolean>>({});
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Two ways to shut it, because they want different focus behaviour. Picking
  // a row hands focus back to the trigger (the row it was on is about to
  // unmount, and focus must not fall to document.body). An outside click has
  // already moved focus somewhere the person chose — dragging it back to the
  // avatar would undo their click.
  const dismiss = useCallback(() => setOpen(false), []);
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);
  const panelRef = useDismissableMenu<HTMLDivElement>({
    open,
    onClose: dismiss,
    returnFocusTo: triggerRef,
  });

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
    <MenuItem
      key={item.id}
      role="menuitem"
      className="group"
      onClick={() => handleSelect(item)}
    >
      <span className="flex items-center gap-2.5">
        <span className="flex-none text-ink-faint transition-colors group-hover:text-ink-muted">
          {item.icon}
        </span>
        {item.label}
      </span>
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

  // No user, no menu. Everything in it is either about a person or an action
  // taken as one; signed out there is nobody to be.
  if (!user) return null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex items-center gap-[7px] rounded-full py-[3px] pr-[9px] pl-[3px]',
          'text-detail text-ink-muted transition-colors hover:bg-hover hover:text-ink',
          open && 'bg-hover text-ink',
        )}
        title="You and your settings"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
        /* The full name, where the pill shows only the first — an accessible
           name that CONTAINS the visible one, which is what WCAG's
           label-in-name asks for and what keeps voice control working. It has
           to be an attribute rather than the button's text because the pill
           drops to just the avatar on a narrow window, and a button whose
           name disappears with the viewport has no name at all. */
        aria-label={
          showBadge ? `${user.name}, ${unreadCount} new feedback` : user.name
        }
      >
        <span className="relative flex-none">
          <Avatar user={user} className="size-[22px] text-micro" />
          {showBadge && (
            <span
              className="absolute -top-0.5 -right-0.5 block size-2 rounded-full bg-danger ring-2 ring-surface"
              aria-hidden
            />
          )}
        </span>
        {/* First name only (proto:3726). The full one is on the button and in
            the panel's identity block; a top bar does not need your surname. */}
        <span aria-hidden className="hidden truncate sm:inline">
          {user.name.trim().split(/\s+/)[0]}
        </span>
        <ChevronDown
          aria-hidden
          size={12}
          className={cn(
            'hidden flex-none text-ink-faint transition-transform sm:block',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* The ref goes on a positioning wrapper rather than on MenuPanel:
          MenuPanel is presentation only and takes no ref, which is the same
          reason PageActions wraps it. */}
      {open && (
        <div ref={panelRef} className="absolute right-0 top-[calc(100%+5px)] z-40">
        <MenuPanel
          id={MENU_ID}
          role="menu"
          className="w-[274px] max-h-[calc(100dvh-62px)] overflow-y-auto"
        >
          {/* Who you are, stated once at the top so no row below has to
              repeat it. The email is real here — the prototype fabricates it
              from the first name (proto:3440). */}
          <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2.5 pt-1.5 pb-3">
            <Avatar user={user} className="size-[26px] text-meta" />
            <span className="min-w-0">
              <span className="block truncate text-ui font-semibold text-ink">
                {user.name}
              </span>
              <span className="block truncate text-meta text-ink-faint">{user.email}</span>
            </span>
          </div>

          {defaultItems.map(renderRow)}

          {isAdmin && adminItems.length > 0 && (
            <div role="group" aria-labelledby="profile-menu-admin-section-label">
              <MenuLabel role="presentation" id="profile-menu-admin-section-label">
                Admin only
              </MenuLabel>
              {adminItems.map(renderRow)}
            </div>
          )}

          <div className="mt-1.5 border-t border-line pt-1.5">
            <MenuItem role="menuitem" tone="danger" onClick={logout}>
              <span className="flex items-center gap-2.5">
                <LogOut size={15} className="flex-none opacity-80" />
                Sign out
              </span>
            </MenuItem>
          </div>
        </MenuPanel>
        </div>
      )}

      {/* Dialogs opened by the menu rows above. Mounted at the menu root so they
          persist independently of the (transient) dropdown. */}
      {renderDialogs(defaultItems)}
      {isAdmin && renderDialogs(adminItems)}
    </div>
  );
}
