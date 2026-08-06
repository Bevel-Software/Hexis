import { Button, Dialog, Surface } from '../../../shared/components';
import { useLibraryToast } from '../state/toast.context';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

export interface PersonalAddDialogProps {
  /** The list's own name, e.g. `Juan's List` — the copy says it out loud. */
  name: string;
  onClose(): void;
}

/**
 * "Add a skill or tool" for a person's own list — the prototype's
 * `personalAddModal` (proto:3366-3369).
 *
 * The same door as a group's, because the prototype's whole point about the
 * add flow is that there is only one. What differs is where the thing LANDS,
 * and the dialog says so in its first line: a skill you build stays yours
 * until a group takes it in.
 *
 * There is no "Open in the workspace" half here, unlike `AddToGroupDialog`.
 * That link exists to put you in the folder the skill belongs to, and this
 * page is defined as the items in NO folder — so there is no destination to
 * open. A link to the workspace root would be a link to somewhere else.
 */
export function PersonalAddDialog({ name, onClose }: PersonalAddDialogProps) {
  const toast = useLibraryToast();
  const prompt = `Help me build a new skill or tool at Bevel. Keep it to myself for now — it goes in my own list, not a group.`;

  async function copyPrompt() {
    const copied = await copyToClipboard(prompt);
    toast(copied ? COPIED_TOAST : COPY_FAILED_TOAST, copied ? 'neutral' : 'danger');
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add a skill or tool"
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => void copyPrompt()}>
            Copy prompt
          </Button>
        </>
      }
    >
      <p className="text-ui text-ink-muted">
        {`It lands in ${name} — yours alone until you add it to a group.`}
      </p>

      <p className="mt-3.5 text-ui text-ink-muted">
        Tell your agent what you need — it drafts the skill and puts it here.
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{prompt}</p>
      </Surface>
    </Dialog>
  );
}
