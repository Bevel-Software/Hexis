import { useEffect, useRef } from 'react';
import type { FileTreeEntry, FolderChangeRequest } from '@bevel-software/platform-shared';
import { Button, Dialog, useLatestRef } from '../../../shared/components';
import {
  ACCESS_CHANGE_UNKNOWN,
  NO_ACCESS_CHANGE,
  deleteSentence,
  folderRequestLine,
  moveQuestion,
  moveSentence,
  type AccessChange,
} from '../utils/treeConfirm';

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
      /**
       * Is the thing being dragged a folder? A folder's access is its own
       * `access.md` plus every file under it — a different question from one
       * file's, and not one this dialog answers, so it asks nothing and says
       * only what it has always said.
       */
      sourceIsDirectory: boolean;
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
 * What a folder delete knows about the change requests proposing files in the
 * folder: nothing to ask (`none`), still asking, the answer, or no answer —
 * in which case the delete is offered as it always was, with a note.
 */
export type FolderProposals =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ready'; requests: FolderChangeRequest[] }
  | { status: 'failed' };

/**
 * What a move knows about the access it is about to change.
 *
 * The lookup decorates the confirmation; it never gates it. `loading` and
 * `failed` both leave Move enabled — a dialog that waited on an access
 * resolution would be a dialog a slow resolver could hang.
 *
 *   - `unavailable`: nothing to resolve. The move is not governed by the KB
 *     access tree (one end sits outside the KB clone), so the dialog claims
 *     nothing about access beyond the sentence it always said.
 *   - `loading`: asked, still waiting — up to two seconds, then `failed`.
 *   - `ready`: answered. Empty on both sides means nobody's access changes.
 *   - `failed`: refused, errored, or out of time.
 */
export type MoveAccessChange =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | ({ status: 'ready' } & AccessChange)
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
  accessChange = { status: 'unavailable' },
  proposals = { status: 'none' },
  onCancel,
  onConfirm,
}: {
  request: TreeConfirmRequest;
  /** Move warnings, derived by the caller (the writable one arrives late). */
  warnings: string[];
  /** Who a move costs and gains access, looked up by the caller. */
  accessChange?: MoveAccessChange;
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
  const name = isDelete ? request.entry.name : (request.sourcePath.split('/').pop() ?? '');
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
      title={isDelete ? 'Delete' : 'Move'}
      footer={
        <>
          <Button size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            size="sm"
            variant={isDelete ? 'danger' : 'primary'}
            disabled={checking}
            onClick={() => onConfirm('folder-only')}
          >
            {isDelete ? 'Delete' : 'Move'}
          </Button>
        </>
      }
    >
      <p className="text-detail text-ink">
        {isDelete
          ? deleteSentence(request.entry, request.isProposed)
          : moveHeadline(name, request.destinationLabel, accessChange)}
      </p>
      {!isDelete && accessChange.status === 'loading' && (
        <p className="mt-2 text-detail text-ink-muted">Working out who this changes access for…</p>
      )}
      {!isDelete && accessChange.status === 'ready' && (
        <>
          <AccessBlock title="Will lose access:" lines={accessChange.lose} />
          <AccessBlock title="Will gain access:" lines={accessChange.gain} />
        </>
      )}
      {!isDelete && accessChange.status === 'failed' && (
        <p role="note" className="mt-2 text-detail text-ink-muted">
          {ACCESS_CHANGE_UNKNOWN}
        </p>
      )}
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

/**
 * The move's first line. A resolved lookup that found nothing says so outright;
 * one that found something leaves the blocks below to say it. An unanswered
 * lookup falls back to the sentence the dialog said before it existed, rather
 * than a bare question with nothing under it.
 */
function moveHeadline(name: string, destination: string, access: MoveAccessChange): string {
  if (access.status === 'ready') {
    const question = moveQuestion(name, destination);
    return access.lose.length === 0 && access.gain.length === 0
      ? `${question} ${NO_ACCESS_CHANGE}`
      : question;
  }
  if (access.status === 'loading') return moveQuestion(name, destination);
  return moveSentence(name, destination);
}

/** One "Will lose access:" / "Will gain access:" block, or nothing when empty. */
function AccessBlock({ title, lines }: { title: string; lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <>
      <p className="mt-2 text-detail text-ink">{title}</p>
      <ul className="mt-1 space-y-1">
        {/* Two principals can read the same — a group and a role sharing a
            name spell one line identically — so position, not text, is what
            tells the rows apart. The list is re-derived from the answer on
            every render and holds no state of its own. */}
        {lines.map((line, i) => (
          <li key={`${i}:${line}`} className="text-detail text-ink">
            {line}
          </li>
        ))}
      </ul>
    </>
  );
}
