import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Surface } from '../../../shared/components';

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
 */

/** Neutral is the default: the message already says what happened. `danger`
 *  exists because half of these are failures, and a failure that renders
 *  identically to a confirmation is worse than no colour at all. */
export type ToastTone = 'neutral' | 'ok' | 'danger';

const TONE: Record<ToastTone, string> = {
  neutral: 'text-ink',
  ok: 'text-ok',
  danger: 'text-danger',
};

type ShowToast = (msg: string, tone?: ToastTone) => void;

const ToastContext = createContext<ShowToast>(() => {});

export function useLibraryToast(): ShowToast {
  return useContext(ToastContext);
}

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
