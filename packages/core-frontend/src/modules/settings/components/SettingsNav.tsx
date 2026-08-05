import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AdminMenuItem } from '../../../core/registry';
import { cn } from '../../../lib/utils';

/** A row the nav can render: one that declares where it goes. */
export type LinkableItem = AdminMenuItem & { path: string };

/**
 * `rail` is the sidebar column; `strip` is the horizontal row it becomes below
 * the `md` breakpoint. The rows are identical in both — only the axis and the
 * section label change, because a label that introduces a group beneath it is
 * a vertical-list device and reads as noise inline.
 */
export type SettingsNavOrientation = 'rail' | 'strip';

/**
 * The settings nav's CONTENTS — a pure view of the URL, in the same sense
 * `GroupsSidebar` is. It holds no state, decides no membership and fetches
 * nothing; the layout works out which rows exist and which one is current,
 * and this renders them.
 *
 * Row styling is `GroupsSidebar`'s declaration token for token, minus the
 * count slot it has no use for, plus `FileExplorer`'s inset focus ring — the
 * more complete of the two treatments. The two sidebars must not read as two
 * products, and the class string is what that rule actually protects.
 *
 * Two things here differ from both existing sidebars, deliberately, and
 * neither is a style choice:
 *
 *  - `<Link>`, not `<button onClick>`. Every row here HAS a URL (that is the
 *    membership rule), so cmd-click, middle-click and copy-link-address all
 *    work — which matters more for settings than for anything else in the app.
 *    The existing sidebars use buttons because their destinations are filter
 *    states and tree nodes reached by callback, not because buttons are the
 *    house style for navigation.
 *  - `aria-current="page"`, not `aria-current={boolean}` (which serialises to
 *    `"true"`). These rows go to pages, and `"page"` is the token for that.
 *
 * No icons, also deliberately: neither existing sidebar shows any, and
 * `AdminMenuItem.icon` is optional — so an icon column would be ragged the
 * moment the enterprise shell contributes a row without one. The icons stay in
 * the dropdown, where a short vertical scan benefits from them.
 */
export function SettingsNav({
  defaultItems,
  adminItems,
  currentPath,
  orientation = 'rail',
}: {
  defaultItems: LinkableItem[];
  adminItems: LinkableItem[];
  currentPath: string;
  orientation?: SettingsNavOrientation;
}) {
  const strip = orientation === 'strip';

  const row = (item: LinkableItem) => {
    const current = item.path === currentPath;
    return (
      <Link
        key={item.id}
        to={item.path}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'flex items-center gap-2 rounded-sm px-2.5 py-1.5 text-ui transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          // Inline, a row must not shrink to an ellipsis just because the next
          // one wants room — the strip scrolls instead.
          strip && 'shrink-0',
          current
            ? 'bg-hover font-semibold text-ink'
            : 'text-ink-muted hover:bg-hover hover:text-ink',
        )}
      >
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <nav
      aria-label="Settings"
      className={cn(
        'flex min-h-0',
        strip ? 'flex-row items-center gap-1' : 'flex-col overflow-y-auto',
      )}
    >
      {defaultItems.map(row)}
      {adminItems.length > 0 && (
        <>
          {/* Inline, the rows simply continue — see the orientation docblock. */}
          {!strip && <SectionLabel spaced>Admin only</SectionLabel>}
          {adminItems.map(row)}
        </>
      )}
    </nav>
  );
}

/**
 * Copied from `GroupsSidebar`'s `SectionLabel` rather than extracted into a
 * shared component — the same call `FileExplorer` made about its own row
 * class. Three sidebars agreeing on a label's padding is not yet an
 * abstraction, and hoisting it would put a shared dependency between two
 * modules that otherwise know nothing about each other.
 */
function SectionLabel({ children, spaced = false }: { children: ReactNode; spaced?: boolean }) {
  return (
    <div className={cn('px-2.5 pb-1.5 text-label uppercase text-ink-faint', spaced && 'pt-5')}>
      {children}
    </div>
  );
}
