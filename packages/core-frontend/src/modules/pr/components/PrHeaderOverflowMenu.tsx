import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

interface Props {
  children: ReactNode;
}

/**
 * Container-query-friendly overflow menu for the change-request header. When
 * the header runs out of horizontal space, secondary actions collapse into
 * this "⋯" dropdown instead of spilling under the chat panel.
 *
 * Children are rendered as stacked rows in the popover — pass the existing
 * action buttons (PrRefreshFromTargetButton, PrCancelButton) and they keep
 * their existing dialog/callback behavior unchanged.
 */
export function PrHeaderOverflowMenu({ children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center px-2 py-1 text-xs rounded text-slate-700 hover:bg-slate-100"
        aria-label="More actions"
        aria-expanded={open}
        title="More actions"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 bg-white border border-slate-200 rounded shadow-md py-1 flex flex-col items-stretch min-w-[14rem]">
          {children}
        </div>
      )}
    </div>
  );
}
