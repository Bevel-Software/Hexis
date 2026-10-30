import { useState } from 'react';
import { Button } from '../../../shared/components';
import { copyToClipboard } from '../../../lib/clipboard';
import { formatRelativeTime } from '../../../lib/utils';
import { ErrorScreen } from './ErrorScreen';

/** Who deleted the file and when this page learned of it — see `OpenTab.deletedBy`. */
export interface DeletedBy {
  name: string | null;
  at: number;
}

/**
 * How long ago this page learned of the delete: "a moment ago" within the
 * minute, then the relative time, so a tab revisited later does not claim
 * the delete just happened.
 */
function deletedAgo(at: number | undefined): string {
  if (at === undefined || Date.now() - at < 60_000) return 'a moment ago';
  return formatRelativeTime(at);
}

/**
 * "This file was deleted": the file on screen was deleted by someone else.
 * The same frame as "File not found". With unsaved edits, the edited text
 * stays on screen with Copy edits beside Close — the page is the only place
 * those edits exist.
 *
 * ONE notice for both apps' file viewers: the Knowledge file page (an open
 * tab someone else deleted) and the skill and tool pages in Skills & Tools
 * (the skill or tool on screen deleted). Each caller says what Close does.
 */
export function DeletedFileNotice({
  fileName,
  branch,
  deletedBy,
  edits,
  agentVersion = null,
  onClose,
}: {
  /** The name the notice gives the file: its base name, or the item's. */
  fileName: string;
  branch: string;
  deletedBy: DeletedBy | null | undefined;
  /** The unsaved edits, or null when there are none. */
  edits: string | null;
  /**
   * A version the agent wrote that was still awaiting review when the file
   * went: kept here too, or it would be lost with the tab.
   */
  agentVersion?: string | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const name = deletedBy?.name ?? null;
  const copy = async (text: string, done: string) =>
    setCopied((await copyToClipboard(text)) ? done : "Couldn't copy: select the text above instead.");
  return (
    <ErrorScreen title="This file was deleted">
      <p className="text-ui text-ink-muted">
        <span className="font-mono text-ink">{fileName}</span> was deleted from{' '}
        <span className="font-mono text-ink">{branch}</span>
        {name ? ` by ${name} ${deletedAgo(deletedBy?.at)}.` : '.'}
      </p>
      {edits !== null && (
        <div className="space-y-2 text-left">
          <p className="text-ui text-ink">Your unsaved edits exist only here. Copy them before you close.</p>
          <pre
            aria-label="Your unsaved edits"
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken p-3 text-detail text-ink"
          >
            {edits}
          </pre>
        </div>
      )}
      {agentVersion !== null && (
        <div className="space-y-2 text-left">
          <p className="text-ui text-ink">The agent's change you had not reviewed yet is kept here too. Copy it before you close.</p>
          <pre
            aria-label="The agent's version"
            className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-sunken p-3 text-detail text-ink"
          >
            {agentVersion}
          </pre>
        </div>
      )}
      <div className="flex justify-center gap-2">
        {edits !== null && (
          <Button variant="outline" onClick={() => copy(edits, 'Edits copied.')}>
            Copy edits
          </Button>
        )}
        {agentVersion !== null && (
          <Button variant="outline" onClick={() => copy(agentVersion, "Agent's version copied.")}>
            Copy agent's version
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>Close</Button>
      </div>
      {copied !== null && (
        <p role="status" className="text-meta text-ink-faint">
          {copied}
        </p>
      )}
    </ErrorScreen>
  );
}
