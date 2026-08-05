import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Surface } from '../../../shared/components';
import { ToastContext, type ShowToast, type ToastTone } from './toast.context';

/**
 * Bottom-center toast from the approved mock — one line, auto-dismissing.
 *
 * The chrome is the design system's floating-surface recipe (`Surface` at
 * `overlay` elevation), NOT a second one: this component used to hand-roll a
 * teal border, teal text and a bespoke shadow from raw hex, which made every
 * message in the Library the only teal thing on screen.
 *
 * Tone colours the TEXT, not the surface. A toast floats over arbitrary
 * content, so it needs an opaque surface and a hairline to stay legible —
 * which is exactly what `--color-ok` / `--color-danger` are specified for
 * ("the text/icon colour", `tokens.css`). It also keeps the app's rule that
 * attention comes from weight, not hue.
 *
 * The channel itself — `ToastContext` and `useLibraryToast` — lives in
 * `./toast.context.ts` so this module exports nothing but the component.
 */

/** Tone maps to a text colour only; the surface stays neutral. Kept next to
 *  the markup that consumes it rather than in the context module, because it
 *  is a rendering detail of this component. */
const TONE: Record<ToastTone, string> = {
  neutral: 'text-ink',
  ok: 'text-ok',
  danger: 'text-danger',
};

export function LibraryToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback<ShowToast>((msg, tone = 'neutral') => {
    setToast({ message: msg, tone });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <Surface
        role="status"
        aria-live="polite"
        radius="lg"
        elevation="overlay"
        // The element stays mounted so the slide-out animates; `tone` is read
        // from the last toast shown, which is also the one sliding away.
        className={`fixed left-1/2 bottom-6 -translate-x-1/2 z-[80] pointer-events-none px-5 py-2.5 text-detail font-semibold transition-transform duration-300 ${
          TONE[toast?.tone ?? 'neutral']
        } ${toast ? 'translate-y-0' : 'translate-y-24'}`}
      >
        {toast?.message}
      </Surface>
    </ToastContext.Provider>
  );
}
