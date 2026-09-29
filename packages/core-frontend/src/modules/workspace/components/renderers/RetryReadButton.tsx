import { Button } from '../../../../shared/components';

/**
 * The button beside a viewer's own error message — see {@link useReadRetry}
 * for what it re-triggers.
 *
 * Its own component so the wording is one string across every viewer: a reader
 * who has learned what "Try again" does in one pane should not meet "Retry"
 * in the next.
 */
export function RetryReadButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="outline" size="tiny" onClick={onRetry}>
      Try again
    </Button>
  );
}
