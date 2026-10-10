import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { activeAppId, useActiveAppId, useAppRegistry, type AppDef } from '../../../core/registry';
import { useMediaQuery } from '../../layout/hooks/useMediaQuery';
import { TOOLBAR_STACK_QUERY } from '../../layout/breakpoints';
import { cn } from '../../../lib/utils';
import { PRODUCT_NAME, ProductName } from '../../../core/ProductName';

const MENU_ID = 'app-switcher-menu';

/**
 * The most apps the toolbar lays out side by side. Core ships two; a third
 * (an enterprise extension) still fits beside the brand. Past that the row
 * would crowd out the toolbar items, so the list folds back into the menu.
 */
const MAX_SEGMENTS = 3;

/**
 * The toolbar's top-left: the product name and the way between the top-level
 * surfaces (core apps + registry-contributed ones).
 *
 * Switching between Knowledge and Skills & Tools changes everything below the
 * toolbar, so the switch must say where you are without being opened. With
 * few apps on a wide toolbar that is a segmented control — every destination
 * on show, the current one lifted. With more apps, or on a compact toolbar
 * where the row would not fit, it is a menu behind a trigger that names the
 * current app ("Bevel / Knowledge").
 */
export function AppSwitcher() {
  const location = useLocation();
  const registry = useAppRegistry();
  const isCompact = useMediaQuery(TOOLBAR_STACK_QUERY);

  // The shell merges the core apps into the registry (see CoreAppShell), so
  // this list is complete — core Knowledge / Skills & Tools plus extensions.
  const apps = useMemo(
    () => [...registry.apps].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    [registry],
  );
  // The shell's answer first: it folds in surfaces that CLAIM an app beyond
  // the path-prefix rule (a skill page at its canonical /workspace URL claims
  // Skills & Tools — see AppClaimContext). The local computation is the
  // fallback for standalone renders, where the context is undefined and the
  // prefix rule is all there is. Undefined on the standalone settings pages,
  // where no app is active.
  const shellActiveId = useActiveAppId();
  const activeId = shellActiveId ?? activeAppId(apps, location.pathname);

  if (!isCompact && apps.length > 0 && apps.length <= MAX_SEGMENTS) {
    return <AppToggle apps={apps} activeId={activeId} />;
  }
  return <AppMenu apps={apps} activeId={activeId} />;
}

/** A primary-button click with no modifier: the one a link should treat as "go here". */
function isPlainClick(e: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
}

interface SwitcherProps {
  apps: AppDef[];
  activeId: string | undefined;
}

/**
 * The brand as plain text, then one segment per app, styled like the
 * Library sidebar's view switch: on the hover tint, the current app lifted
 * onto the surface.
 *
 * A `nav` of links with `aria-current="page"`, not a tablist: each segment
 * goes somewhere else in the app rather than revealing a panel here, so it
 * is navigation, and links also open in a new tab like any other.
 */
function AppToggle({ apps, activeId }: SwitcherProps) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ProductName className="shrink-0 px-1.5 text-sm font-semibold tracking-wide text-ink" />
      <nav aria-label="Apps" className="flex shrink-0 gap-0.5 rounded-md bg-hover p-0.5">
        {apps.map((app) => {
          const current = app.id === activeId;
          return (
            <Link
              key={app.id}
              to={app.path}
              aria-current={current ? 'page' : undefined}
              title={app.description}
              // Same as choosing the current app in the menu: nothing. A
              // click must not throw a deep link back to the app's root. A
              // modified or middle click is the reader asking for a new tab
              // or window, which the link still does like any other.
              onClick={(e) => {
                if (current && isPlainClick(e)) e.preventDefault();
              }}
              className={cn(
                'whitespace-nowrap rounded-sm px-2.5 py-1 text-detail font-semibold transition-[background-color,color,box-shadow]',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-muted',
                current ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
              )}
            >
              {app.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The clickable brand: names the app you are currently in and opens the list
 * of apps. A brand on its own left the switch invisible, hence the label.
 *
 * Open/close mechanics mirror AdminMenu: click toggles, an outside mousedown
 * or Escape closes, and closing hands focus back to the trigger.
 */
function AppMenu({ apps, activeId }: SwitcherProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Undefined on the standalone settings pages, where the trigger is the
  // brand alone.
  const activeApp = apps.find((a) => a.id === activeId);

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

  const select = (app: AppDef) => {
    close();
    if (app.id !== activeId) navigate(app.path);
  };

  return (
    // `min-w-0` down the chain, and `truncate` on the brand as well as the app
    // label: on the narrowest toolbars the trigger gives up width before the
    // controls on the right are pushed off-screen. Its name is "Switch app"
    // either way, and the menu it opens names every app in full.
    <div ref={ref} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 items-center gap-1 px-1.5 py-1 rounded-sm hover:bg-hover text-ink"
        title={activeApp ? `Switch app. Currently ${activeApp.label}` : 'Switch app'}
        aria-label="Switch app"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
      >
        <span className="min-w-0 truncate text-sm font-semibold tracking-wide">{PRODUCT_NAME}</span>
        {activeApp && (
          <>
            <span aria-hidden="true" className="shrink-0 text-sm text-ink-faint">
              /
            </span>
            <span className="truncate text-sm text-ink-muted">{activeApp.label}</span>
          </>
        )}
        <ChevronDown size={14} className="shrink-0 text-ink-muted" />
      </button>
      {open && (
        <div
          id={MENU_ID}
          role="menu"
          className="absolute left-0 top-full mt-1 w-64 rounded-md border border-line bg-white py-1 shadow-lg z-50"
        >
          <div className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
            Apps
          </div>
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              role="menuitem"
              onClick={() => select(app)}
              className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-hover"
            >
              <span className="w-4 pt-0.5 shrink-0 text-ink">
                {app.id === activeId && <Check size={14} aria-label="Current app" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-ink">{app.label}</span>
                {app.description && (
                  <span className="block text-xs text-ink-muted">{app.description}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
