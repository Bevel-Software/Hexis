import { Check, Copy } from 'lucide-react';
import { Button } from '../../../shared/components';
import { SnippetBlock, useCopyFeedback } from '../../../shared/mcp';

/**
 * "Copy prompt": one button that puts a ready-made prompt on the clipboard,
 * for the reader to paste into their agent. The agent then does the setup
 * itself, so the reader never has to find a settings file or read a
 * configuration. The prompt is not shown: what matters is the one action.
 */
export function CopyPromptButton({
  value,
  label = 'Copy prompt',
  onCopyFailed,
  className,
}: {
  /** The prompt to copy. */
  value: string;
  label?: string;
  onCopyFailed?: () => void;
  className?: string;
}) {
  const { status, copied, copy } = useCopyFeedback();
  // A browser may refuse the clipboard (plain http, a blocked permission).
  // Then the prompt is shown, so it can be selected and copied by hand.
  const refused = status === 'failed';

  async function copyPrompt() {
    if (!(await copy(value))) onCopyFailed?.();
  }

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => void copyPrompt()} className={className}>
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
        {copied ? 'Copied' : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
      {refused && (
        <div className="mt-3 space-y-2 text-detail text-danger" role="alert">
          <p>Your browser did not allow copying. Select the prompt and copy it:</p>
          <SnippetBlock value={value} copyLabel="Copy prompt" wrap />
        </div>
      )}
    </>
  );
}
