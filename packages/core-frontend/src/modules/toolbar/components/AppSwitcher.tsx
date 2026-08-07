import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { activeAppId, useAppRegistry, type AppDef } from '../../../core/registry';

const MENU_ID = 'app-switcher-menu';

/**
 * The clickable brand in the toolbar's top-left: shows the product name, the
 * app you are currently in, and opens the app switcher — the list of
 * top-level surfaces (core apps + registry-contributed ones) you can move
 * between.
 *
 * Switching between Knowledge and Skills & Tools changes everything below the
 * toolbar, so the trigger names the destination it landed on ("Bevel /
 * Knowledge"); a brand on its own left the switch invisible.
 *
 * Open/close mechanics mirror AdminMenu: click toggles, an outside mousedown
 * or Escape closes, and closing hands focus back to the trigger.
 */
export function AppSwitcher() {
  const navigate = useNavigate();
  const location = useLocation();
  const registry = useAppRegistry();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // The shell merges the core apps into the registry (see CoreAppShell), so
  // this list is complete — core Knowledge / Skills & Tools plus extensions.
  const apps = useMemo(
    () => [...registry.apps].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
    [registry],
  );
  const activeId = activeAppId(apps, location.pathname);
  // Named next to the brand so the toolbar answers "which app am I in?"
  // without opening the menu. Undefined on the standalone settings pages,
  // where no app is active and the trigger is the brand alone.
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
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 items-center gap-1 px-1.5 py-1 rounded hover:bg-hover text-ink"
        title={activeApp ? `Switch app. Currently ${activeApp.label}` : 'Switch app'}
        aria-label="Switch app"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? MENU_ID : undefined}
      >
        <span className="shrink-0 text-sm font-semibold tracking-wide">Bevel</span>
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
