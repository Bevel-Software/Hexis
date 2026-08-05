import { useCallback, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../../lib/utils';
import { toastDuration } from '../utils/toast-duration';
import { ToastContext, type ShowToast, type ToastTone } from './toast.context';

/**
 * Bottom-center toast — the prototype's `#toast` (proto:719).
 *
 * An INK pill: dark plate, canvas text, fully round, no border and no shadow.
 * It was a teal-on-white card built from four raw hex values left over from a
 * retired mock, which made the one element that appears over every screen the
 * one element belonging to no theme. The prototype's answer is better and
 * simpler — the only inverted surface in the app, so it reads as the app
 * speaking rather than as a panel that wandered in.
 *
 * Tone colours the PLATE, not the text. That is the opposite of `Banner`
 * (`bg-*-soft text-*`) and it is forced by the inversion: `--color-ok` on
 * `--color-ink` is a 2.4:1 contrast ratio and `--color-danger` on it is
 * 1.9:1, so tone-as-text is unreadable here however well it works on a light
 * surface. Against canvas text the three plates run 12.3:1 (ink), 5.1:1 (ok)
 * and 6.5:1 (danger) — all clear of 4.5:1 — and the pill stays one inverted
 * shape across every tone instead of flipping to a light card for errors.
 *
 * The channel itself — `ToastContext` and `useLibraryToast` — lives in
 * `./toast.context.ts` so this module exports nothing but the component;
 * `utils/toast-duration.ts` is split out for the same fast-refresh reason.
 */

/** Kept next to the markup that consumes it rather than in the context
 *  module, because which plate a tone maps to is a rendering detail. */
const TONE: Record<ToastTone, string> = {
  neutral: 'bg-ink',
  ok: 'bg-ok',
  danger: 'bg-danger',
};

export function LibraryToastProvider({ children }: { children: ReactNode }) {
  // `visible` rather than dropping the toast to null on expiry: the element
  // stays mounted so the exit animates, so its tone has to outlive the message.
  const [toast, setToast] = useState<{
    message: string;
    tone: ToastTone;
    visible: boolean;
  } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback<ShowToast>((msg, tone = 'neutral') => {
    setToast({ message: msg, tone, visible: true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setToast((prev) => (prev ? { ...prev, visible: false } : null)),
      toastDuration(msg),
    );
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'pointer-events-none fixed bottom-7 left-1/2 z-[80] -translate-x-1/2',
          'max-w-[82vw] rounded-full px-[18px] py-2.5',
          'text-center text-ui font-medium text-canvas',
          // Read from the toast on its way out, not reset to neutral. The
          // transition covers opacity and transform but NOT background-color,
          // so dropping the tone on expiry would snap a danger toast from red
          // to ink the instant it starts leaving — a jump, not a fade.
          TONE[toast?.tone ?? 'neutral'],
          // Opacity AND an 8px lift, as the prototype does: a pill that only
          // slid would be readable while it was still arriving.
          'transition-[opacity,transform] duration-200 ease-out',
          toast?.visible ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        )}
      >
        {/* Cleared on expiry even though the plate lingers: the pill is only
            transparent, not unmounted, so a stale message would stay readable
            to a screen reader long after it left the screen. */}
        {toast?.visible ? toast.message : null}
      </div>
    </ToastContext.Provider>
  );
}
