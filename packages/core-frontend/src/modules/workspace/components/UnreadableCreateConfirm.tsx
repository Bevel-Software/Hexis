import { useEffect, useRef } from 'react';
import { Button, Dialog } from '../../../shared/components';
import { unreadableCreateSentence } from '../utils/unreadableCreate';
import type { UnreadableCreateRequest } from '../state/unreadable-create.context';

/**
 * What the tree says before it adds a file its creator will not be able to
 * see. Why that state exists is in `../utils/unreadableCreate.ts`; the gate
 * that decides when to show this is in
 * `../state/unreadable-create.context.ts`.
 *
 * Continue and Cancel, with Cancel the safe default: focus starts on it, so
 * Enter on an unread dialog adds nothing. (The delete/move confirmation
 * focuses its verb instead, because there the user asked for that verb by
 * name; here the dialog is telling them something they did not know.)
 */
export function UnreadableCreateDialog({
  request,
  onCancel,
  onContinue,
}: {
  request: UnreadableCreateRequest;
  onCancel(): void;
  onContinue(): void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  // After the Dialog's own open effect (child effects first), so this focus
  // wins over its first-focusable default: the header's Close.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  const many = request.names.length > 1;
  return (
    <Dialog
      open
      size="sm"
      onClose={onCancel}
      title={many ? "You won't see these files" : "You won't see this file"}
      footer={
        <>
          <Button ref={cancelRef} size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={onContinue}>
            Continue
          </Button>
        </>
      }
    >
      <p className="text-detail text-ink" data-testid="unreadable-create-sentence">
        {unreadableCreateSentence(request.names, request.folder)}
      </p>
      {/* The names themselves, once the sentence has stopped carrying them. */}
      {many && (
        <ul className="mt-2 space-y-1">
          {request.names.map((name) => (
            <li key={name} className="text-detail text-ink">
              {name}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-detail text-ink-muted">
        {many ? 'They are still added' : 'It is still added'} and the change request still reaches
        the folder's owners — you just won't see {many ? 'them' : 'it'} in your own explorer.
      </p>
    </Dialog>
  );
}
