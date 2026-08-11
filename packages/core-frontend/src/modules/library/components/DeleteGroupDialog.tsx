import { useState } from 'react';
import { Banner, Button, Dialog } from '../../../shared/components';
import { deleteGroup } from '../services/groups.api';

/**
 * The "are you sure" a group deletion deserves — and it deserves a bigger one
 * than a single skill's: this takes the folder, every skill and tool inside
 * it, and the membership that made it appear in people's MCPs. The content
 * survives only in git history.
 *
 * One dialog serves both openers (the sidebar's right-click and the group
 * page's `⋯` menu), so the two surfaces cannot describe the same act in
 * different words. Who may open it is the caller's decision (`isOwner` on the
 * summary); the backend enforces the same verdict for real.
 */
export function DeleteGroupDialog({
  name,
  skillCount,
  toolCount,
  onClose,
  onDeleted,
}: {
  name: string;
  /** The group's totals, for copy that says what is actually at stake. */
  skillCount: number;
  toolCount: number;
  onClose(): void;
  /** Fired after the delete lands; the host reloads and navigates away. */
  onDeleted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const contents =
    skillCount === 0 && toolCount === 0
      ? 'It has no skills or tools in it.'
      : `Its ${[
          skillCount > 0 ? `${skillCount} ${skillCount === 1 ? 'skill' : 'skills'}` : null,
          toolCount > 0 ? `${toolCount} ${toolCount === 1 ? 'tool' : 'tools'}` : null,
        ]
          .filter(Boolean)
          .join(' and ')} go with it.`;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteGroup(name);
      onDeleted();
      onClose();
    } catch (err) {
      // The backend's refusal names the rule (ownership, a refused push); a
      // generic apology would hide the one thing worth reading.
      setError(err instanceof Error ? err.message : "Couldn't delete the group.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${name}?`}
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete group'}
          </Button>
        </>
      }
    >
      <p className="text-ui text-ink-muted">
        {`This deletes the group for everyone in it. ${contents} Members lose it the next time their agent connects, and there is no undo — the content survives only in git history.`}
      </p>
      {error && (
        <Banner tone="danger" role="alert" className="mt-3">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}
