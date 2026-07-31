import {
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from 'react';
import { X } from 'lucide-react';
import { useModalLayer } from './useModalLayer';

/**
 * The one centered-modal primitive for the app. Before this existed every
 * dialog hand-rolled the same `fixed inset-0` overlay, focus trap, Escape
 * handler and header — so they drifted (three different backdrop tints, subtly
 * different a11y). Route everything through here instead.
 *
 * Backdrop is a dark 40%-opacity scrim (`bg-slate-950/40`) — the standard the
 * gear-menu dialogs share. The panel is capped at 90vh and lays out as a flex
 * column: `header` and `footer` stay pinned while `children` scroll, so a long
 * body never pushes the dialog past the top/bottom of the viewport.
 *
 * Sizing: `size` maps to a Tailwind max-width. Use `sm`/`md` for short forms,
 * `2xl`/`4xl`/`5xl` for data-heavy panels (routines, roles).
 */

const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  '4xl': 'max-w-4xl',
  '5xl': 'max-w-5xl',
} as const;

export type DialogSize = keyof typeof SIZE_CLASS;

interface DialogProps {
  open: boolean;
  onClose(): void;
  /** Rendered in the header bar next to the close button. */
  title: ReactNode;
  children: ReactNode;
  /** Pinned footer (e.g. action buttons). Omit for a bodyless dialog. */
  footer?: ReactNode;
  /** Extra controls in the header, left of the close button. */
  headerActions?: ReactNode;
  size?: DialogSize;
  /**
   * When true, clicking the backdrop, pressing Escape, and the X button are all
   * inert — for dialogs that must not be dismissed mid-operation (submitting,
   * a one-time key still being shown, etc.).
   */
  busy?: boolean;
  /**
   * Drop the default padded/scrolling body wrapper and render `children`
   * flush against the panel. For panels that own their own internal layout
   * (their own scroll regions, toolbars, split panes).
   */
  bare?: boolean;
  /** Extra classes for the body wrapper (ignored when `bare`). */
  bodyClassName?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  headerActions,
  size = '2xl',
  busy = false,
  bare = false,
  bodyClassName = '',
}: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Callers pass a fresh `onClose` arrow each render; mirror it into a ref so
  // the trap effect below doesn't re-fire (and re-snapshot focus) every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Only the topmost open modal layer reacts to Escape / backdrop clicks, so a
  // nested modal (its own or a hand-rolled one that opts in) can be dismissed
  // without also closing this dialog behind it.
  const isTopLayer = useModalLayer(open);

  // Dialog a11y: move focus into the panel on open, trap focus + Escape closes
  // + restore focus on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Pull focus into the dialog so keyboard users can't tab straight into the
    // background behind the modal. Prefer the first focusable control; fall back
    // to the panel itself (which carries tabIndex={-1}) when the body is empty.
    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    (firstFocusable ?? panel)?.focus?.();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (busyRef.current || !isTopLayer()) return;
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const enabled = Array.from(focusable).filter((el) => !el.hasAttribute('disabled'));
      if (enabled.length === 0) return;
      const first = enabled[0];
      const last = enabled[enabled.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, isTopLayer]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/40 flex items-center justify-center p-4"
      onClick={() => {
        if (busy || !isTopLayer()) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`bg-white border border-slate-200 rounded-lg shadow-xl w-full ${SIZE_CLASS[size]} max-h-[90vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 shrink-0">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          <div className="flex items-center gap-2">
            {headerActions}
            <button
              onClick={() => {
                if (busy) return;
                onClose();
              }}
              disabled={busy}
              className="p-1 rounded hover:bg-slate-100 text-slate-600 hover:text-slate-900 disabled:opacity-50"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {bare ? (
          children
        ) : (
          <div className={`px-4 py-3 overflow-y-auto ${bodyClassName}`}>{children}</div>
        )}

        {footer && (
          <div className="flex justify-end gap-2 px-4 py-3 border-t border-slate-200 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
