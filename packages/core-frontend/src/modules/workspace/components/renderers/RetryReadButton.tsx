import { Button } from '../../../../shared/components';
import { READ_PANE_SELECTOR } from './readPane';

/**
 * The button beside a viewer's own error message — see {@link useReadRetry}
 * for what it re-triggers.
 *
 * Its own component so the wording is one string across every viewer: a reader
 * who has learned what "Try again" does in one pane should not meet "Retry"
 * in the next.
 *
 * It also hands keyboard focus on, because pressing it UNMOUNTS it: every
 * byte-reading viewer returns its error block as its whole output, so the
 * retry replaces that block with the viewer's loading state and then the
 * document. Focus would fall to `document.body`, and in a pane that is part
 * of a larger surface — Version history's version pane, the change-request
 * dialog — the next Tab would start again from the top of the page. There is
 * nothing inside the viewer that survives the swap to hand focus TO, so the
 * destination is the host pane's own region, which it names by spreading
 * `READ_PANE`. The move happens before the state change, while this button is
 * still on screen, so no frame is ever painted with focus on the body; a pane
 * that names no region keeps today's behaviour.
 */
export function RetryReadButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button
      variant="outline"
      size="tiny"
      onClick={(e) => {
        e.currentTarget.closest<HTMLElement>(READ_PANE_SELECTOR)?.focus();
        onRetry();
      }}
    >
      Try again
    </Button>
  );
}
