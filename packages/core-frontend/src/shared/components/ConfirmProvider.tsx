import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';
import { Dialog } from './Dialog';
import {
  ConfirmContext,
  type ConfirmAnswer,
  type ConfirmFn,
  type ConfirmRequest,
} from './confirm-context';

interface Pending {
  id: number;
  request: ConfirmRequest;
  resolve(answer: ConfirmAnswer): void;
}

const CANCELLED: ConfirmAnswer = { confirmed: false, dontAskAgain: false };

/**
 * Hosts the app's confirmation dialog; mount it once, near the root. Anything
 * below asks through `useConfirm()`.
 *
 * One question shows at a time. A second request waits behind the first
 * rather than stacking two dialogs, so two closes in quick succession are
 * asked in turn.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const nextId = useRef(0);
  // Mirrors `queue` for the unmount sweep below, which must not depend on it.
  const queueRef = useRef<Pending[]>([]);
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const confirm = useCallback<ConfirmFn>(
    (request) =>
      new Promise<ConfirmAnswer>((resolve) => {
        nextId.current += 1;
        const id = nextId.current;
        setQueue((q) => [...q, { id, request, resolve }]);
      }),
    [],
  );

  // A provider that goes away with questions still open answers them Cancel,
  // so nothing awaiting one hangs forever.
  useEffect(
    () => () => {
      for (const p of queueRef.current) p.resolve(CANCELLED);
    },
    [],
  );

  const current = queue[0];
  const answer = useCallback((id: number, value: ConfirmAnswer) => {
    const head = queueRef.current[0];
    if (!head || head.id !== id) return;
    head.resolve(value);
    setQueue((q) => (q[0]?.id === id ? q.slice(1) : q));
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {/* Portaled to <body> at the moment it opens, so it lands after any
          portaled panel already there (the branch switcher's list is one)
          and draws above it at the same z-index. */}
      {current &&
        createPortal(
          <ConfirmDialog
            key={current.id}
            request={current.request}
            onAnswer={(value) => answer(current.id, value)}
          />,
          document.body,
        )}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer(answer: ConfirmAnswer): void;
}) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const cancel = () => onAnswer(CANCELLED);
  return (
    <Dialog
      open
      size="md"
      title={request.title}
      // Escape, the scrim and the header's X all count as Cancel.
      onClose={cancel}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {request.offerDontAskAgain && (
            <label className="mr-auto flex items-center gap-2 text-detail text-ink-muted">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              Don't ask again
            </label>
          )}
          <Button size="sm" onClick={cancel}>
            {request.cancelLabel ?? 'Cancel'}
          </Button>
          <Button
            size="sm"
            variant={request.destructive ? 'danger' : 'primary'}
            onClick={() =>
              onAnswer({ confirmed: true, dontAskAgain: !!request.offerDontAskAgain && dontAskAgain })
            }
          >
            {request.confirmLabel ?? 'OK'}
          </Button>
        </div>
      }
    >
      {typeof request.message === 'string' ? (
        <p className="text-detail text-ink whitespace-pre-line break-words">{request.message}</p>
      ) : (
        request.message
      )}
    </Dialog>
  );
}
