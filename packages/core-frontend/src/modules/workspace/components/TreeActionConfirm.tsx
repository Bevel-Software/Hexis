import { useEffect, useRef } from 'react';
import type { FileTreeEntry, FolderChangeRequest } from '@bevel-software/platform-shared';
import { Button, Dialog, useLatestRef } from '../../../shared/components';
import { deleteSentence, folderRequestLine, moveSentence, withdrawSentence } from '../utils/treeConfirm';

/**
 * What the tree asks before it deletes or moves. Both verbs used to act on
 * the click: Delete removed a file (or a whole folder) with no second chance,
 * and a drop moved a file into another folder without a word about what that
 * means — access is attached to folders, so every cross-folder move is an
 * access change.
 *
 * A third verb joined them: Withdraw, on a proposed row, which cancels the
 * change request the row stands for — destructive in the same way, and asked
 * in the same place rather than in a confirm() the tree has nowhere else.
 *
 * One request is open at a time, held by `TreeChrome`; the rows only describe
 * what they are about to do and hand over the operation to run on Confirm.
 */
export type TreeConfirmRequest =
  | {
      kind: 'delete';
      entry: FileTreeEntry;
      /**
       * Today's delete, unchanged: this branch's copy of the entry. For a
       * folder with proposed files it is "Delete folder only" — the change
       * requests proposing them stay open.
       */
      run(): void | Promise<void>;
      /**
       * "Delete folder and its proposed changes": the delete above, then every
       * open change request proposing files under the folder loses them.
       * Offered only for a folder that has proposed files.
       */
      runWithProposals?(): void | Promise<void>;
      /** Rows that are only proposed — not on this branch, so not counted. */
      isProposed?(path: string): boolean;
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
    }
  | {
      /**
       * The author takes their own suggestion back — the same cancel the file
       * page's change box calls its Withdraw, reached from the proposed row
       * in the sidebar instead. Only ever asked for a request the caller
       * authored; an owner's "no" on someone else's is Decline, in the dialog.
       */
      kind: 'withdraw';
      /** The request being cancelled — withdrawal is per request, not per file. */
      crNumber: number;
      /**
       * Every file the request carries. One row was right-clicked, but the
       * whole request goes, so the sentence counts them.
       */
      files: string[];
      run(): void | Promise<void>;
      returnFocusTo(): HTMLElement | null;
      focusAfterRun(): HTMLElement | null;
    };

/**
 * What a folder delete knows about the change requests proposing files in the
 * folder: nothing to ask (`none`), still asking, the answer, or no answer —
 * in which case the delete is offered as it always was, with a note.
 */
export type FolderProposals =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; requests: FolderChangeRequest[] }
  | { status: 'failed' };

/** Which delete a Confirm runs. */
export type DeleteMode = 'folder-only' | 'with-proposals';

/**
 * The dialog for one request. Escape and the scrim cancel (the shared
 * `Dialog`); Enter confirms — unless focus sits on Cancel or Close, where
 * Enter presses the focused button like anywhere else. Focus starts on the
 * confirm button so Enter-to-confirm is also what a screen reader announces.
 */
export function TreeActionConfirmDialog({
  request,
  warnings,
  proposals = { status: 'none' },
  onCancel,
  onConfirm,
}: {
  request: TreeConfirmRequest;
  /** Move warnings, derived by the caller (the writable one arrives late). */
  warnings: string[];
  /** A folder delete's open change requests, looked up by the caller. */
  proposals?: FolderProposals;
  onCancel(): void;
  onConfirm(mode: DeleteMode): void;
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
      if (confirmRef.current?.disabled) return;
      e.preventDefault();
      onConfirmRef.current('folder-only');
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onConfirmRef]);

  const isDelete = request.kind === 'delete';
  const isWithdraw = request.kind === 'withdraw';
  const name = request.kind === 'move' ? (request.sourcePath.split('/').pop() ?? '') : '';
  const requests = isDelete && proposals.status === 'ready' ? proposals.requests : [];
  if (isDelete && requests.length > 0) {
    // The three-way question: this branch only, or its proposals too. The
    // second verb needs the caller to be allowed on EVERY listed request.
    const refused = requests.flatMap((r) => (r.mayRemove ? [] : [r]));
    return (
      <Dialog
        open
        // Three actions: at `md` the footer ran wider than the dialog and
        // pushed Cancel past its left edge. They also wrap, so a narrow
        // viewport stacks them instead of cutting one off.
        size="lg"
        onClose={onCancel}
        title="Delete folder"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button ref={confirmRef} size="sm" onClick={() => onConfirm('folder-only')}>
              Delete folder only
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={refused.length > 0 || !request.runWithProposals}
              aria-describedby={refused.length > 0 ? 'delete-proposals-refused' : undefined}
              onClick={() => onConfirm('with-proposals')}
            >
              Delete folder and its proposed changes
            </Button>
          </div>
        }
      >
        <p className="text-detail text-ink">{deleteSentence(request.entry, request.isProposed)}</p>
        <p className="mt-2 text-detail text-ink">
          {requests.length === 1 ? 'An open change request proposes' : 'Open change requests propose'} files in it:
        </p>
        <ul className="mt-1 space-y-1">
          {requests.map((r) => (
            <li key={r.number} className="text-detail text-ink">
              {folderRequestLine(r)}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-detail text-ink-muted">
          Delete folder only keeps {requests.length === 1 ? 'that request' : 'those requests'} open, and
          their proposed files stay listed. Deleting the proposed changes too takes those files out of
          each request; a request left with nothing in it is withdrawn.
        </p>
        {refused.length > 0 && (
          <ul id="delete-proposals-refused" className="mt-2 space-y-1">
            {refused.map((r) => (
              <li key={r.number} role="note" className="text-detail text-danger">
                {r.reason}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    );
  }
  const checking = isDelete && proposals.status === 'loading';
  return (
    <Dialog
      open
      size="sm"
      onClose={onCancel}
      title={isDelete ? 'Delete' : isWithdraw ? 'Withdraw suggestion' : 'Move'}
      footer={
        <>
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            size="sm"
            // A withdraw takes the request away from the owners reviewing it:
            // the same danger tone a delete gets, for the same reason.
            variant={isDelete || isWithdraw ? 'danger' : 'primary'}
            disabled={checking}
            onClick={() => onConfirm('folder-only')}
          >
            {isDelete ? 'Delete' : isWithdraw ? 'Withdraw' : 'Move'}
          </Button>
        </>
      }
    >
      <p className="text-detail text-ink">
        {request.kind === 'delete'
          ? deleteSentence(request.entry, request.isProposed)
          : request.kind === 'withdraw'
            ? withdrawSentence(request.files)
            : moveSentence(name, request.destinationLabel)}
      </p>
      {checking && <p className="mt-2 text-detail text-ink-muted">Checking open change requests…</p>}
      {isDelete && proposals.status === 'failed' && (
        <p role="note" className="mt-2 text-detail text-ink-muted">
          Couldn't check which change requests propose files here. Delete removes only this branch's
          files; any proposals stay open.
        </p>
      )}
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
