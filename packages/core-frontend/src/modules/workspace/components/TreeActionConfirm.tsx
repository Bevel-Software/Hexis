import { useEffect, useRef } from 'react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { Button, Dialog, useLatestRef } from '../../../shared/components';
import { deleteSentence, moveSentence } from '../utils/treeConfirm';

/**
 * What the tree asks before it deletes or moves. Both verbs used to act on
 * the click: Delete removed a file (or a whole folder) with no second chance,
 * and a drop moved a file into another folder without a word about what that
 * means — access is attached to folders, so every cross-folder move is an
 * access change.
 *
 * One request is open at a time, held by `TreeChrome`; the rows only describe
 * what they are about to do and hand over the operation to run on Confirm.
 */
export type TreeConfirmRequest =
  | {
      kind: 'delete';
      entry: FileTreeEntry;
      /** Today's delete, unchanged. */
      run(): void | Promise<void>;
      /** The row to hand focus back to once the dialog is cancelled. */
      returnFocusTo(): HTMLElement | null;
      /**
       * Where focus goes once the operation runs instead: the entry's own row
       * is about to leave the tree, and focus would fall to the page with it.
       */
      focusAfterRun(): HTMLElement | null;
    }
  | {
      kind: 'move';
      /** Workspace-relative path of the entry being moved. */
      sourcePath: string;
      /** Workspace-relative folder it lands in; `''` is the workspace root. */
      targetDir: string;
      /** How the destination reads in the sentence — the drop target's row name. */
      destinationLabel: string;
      /** Today's move, unchanged. */
      run(): void | Promise<void>;
      returnFocusTo(): HTMLElement | null;
      focusAfterRun(): HTMLElement | null;
    };

/**
 * The dialog for one request. Escape and the scrim cancel (the shared
 * `Dialog`); Enter confirms — unless focus sits on Cancel or Close, where
 * Enter presses the focused button like anywhere else. Focus starts on the
 * confirm button so Enter-to-confirm is also what a screen reader announces.
 */
export function TreeActionConfirmDialog({
  request,
  warnings,
  onCancel,
  onConfirm,
}: {
  request: TreeConfirmRequest;
  /** Move warnings, derived by the caller (the writable one arrives late). */
  warnings: string[];
  onCancel(): void;
  onConfirm(): void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const onConfirmRef = useLatestRef(onConfirm);

  // Runs after the Dialog's own open effect (child effects first), so this
  // focus wins over the Dialog's first-focusable default: the header's Close.
  useEffect(() => {
    confirmRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Enter') return;
      const active = document.activeElement;
      if (active instanceof HTMLButtonElement && active !== confirmRef.current) return;
      e.preventDefault();
      onConfirmRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onConfirmRef]);

  const isDelete = request.kind === 'delete';
  const name = isDelete ? request.entry.name : (request.sourcePath.split('/').pop() ?? '');
  return (
    <Dialog
      open
      size="sm"
      onClose={onCancel}
      title={isDelete ? 'Delete' : 'Move'}
      footer={
        <>
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button ref={confirmRef} size="sm" variant={isDelete ? 'danger' : 'primary'} onClick={onConfirm}>
            {isDelete ? 'Delete' : 'Move'}
          </Button>
        </>
      }
    >
      <p className="text-detail text-ink">
        {isDelete ? deleteSentence(request.entry) : moveSentence(name, request.destinationLabel)}
      </p>
      {warnings.length > 0 && (
        <ul className="mt-2 space-y-1">
          {warnings.map((w) => (
            <li key={w} role="note" className="text-detail text-danger">
              {w}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
