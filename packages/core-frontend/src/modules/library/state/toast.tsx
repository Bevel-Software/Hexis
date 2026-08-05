import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '../../../lib/utils';
import { toastDuration } from '../utils/toast-duration';

/**
 * Bottom-center toast — the prototype's `#toast` (proto:719).
 *
 * An INK pill: dark plate, canvas text, fully round, no border and no shadow.
 * It was a teal-on-white card built from four raw hex values left over from a
 * retired mock, which made the one element that appears over every screen the
 * one element belonging to no theme. The prototype's answer is better and
 * simpler — the only inverted surface in the app, so it reads as the app
 * speaking rather than as a panel that wandered in.
 */

const ToastContext = createContext<(msg: string) => void>(() => {});

export function useLibraryToast(): (msg: string) => void {
  return useContext(ToastContext);
}

export function LibraryToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback((msg: string) => {
    setMessage(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), toastDuration(msg));
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'pointer-events-none fixed bottom-7 left-1/2 z-[80] -translate-x-1/2',
          'max-w-[82vw] rounded-full bg-ink px-[18px] py-2.5',
          'text-center text-ui font-medium text-canvas',
          // Opacity AND an 8px lift, as the prototype does: a pill that only
          // slid would be readable while it was still arriving.
          'transition-[opacity,transform] duration-200 ease-out',
          message ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0',
        )}
      >
        {message}
      </div>
    </ToastContext.Provider>
  );
}
