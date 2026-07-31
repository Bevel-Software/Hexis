import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Bottom-center toast from the approved mock — one line, auto-dismissing. */

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
    timer.current = setTimeout(() => setMessage(null), 2600);
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className={`fixed left-1/2 bottom-6 -translate-x-1/2 z-[80] pointer-events-none rounded-xl border border-[#7fd0c4] bg-white px-5 py-2.5 text-[12.5px] font-semibold text-[#0f766e] shadow-[0_10px_30px_rgba(22,35,58,0.18)] transition-transform duration-300 ${
          message ? 'translate-y-0' : 'translate-y-24'
        }`}
      >
        {message}
      </div>
    </ToastContext.Provider>
  );
}
