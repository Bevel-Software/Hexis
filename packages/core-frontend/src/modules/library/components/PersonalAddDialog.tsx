import { Button, Dialog, Surface } from '../../../shared/components';
import { NewSkillPanel } from './NewSkillPanel';
import { useLibraryToast } from '../state/toast.context';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

export interface PersonalAddDialogProps {
  /** The list's own name, e.g. `Juan's List` — the copy says it out loud. */
  name: string;
  /** Every skill name already in the catalog — the create half rejects collisions. */
  existingSkills: string[];
  onClose(): void;
}

/**
 * "Add a skill or tool" for a person's own list — the prototype's
 * `personalAddModal` (proto:3366-3369).
 *
 * The same two doors as a group's, because the prototype's whole point about
 * the add flow is that there is only one. What differs is where the thing
 * LANDS, and the dialog says so in its first line: a skill you build stays
 * yours until a group takes it in.
 *
 * This page used to have no first door at all. The reason was real but narrow:
 * the group dialog's first half was a LINK into the destination folder, and
 * this page is defined as the items in no folder, so there was nothing to open.
 * That objection died with the link: a personal skill has a perfectly definite
 * home — the caller's own `Groups/personal-<id>/` folder, which
 * `createEmptySkill` ensures through the provisioning endpoint before the
 * first write. The folder's seeded access.md names you as its owner, so the
 * write that follows passes the ordinary gate on its own merits — no
 * permission special-case anywhere in this flow.
 */
export function PersonalAddDialog({ name, existingSkills, onClose }: PersonalAddDialogProps) {
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

      <NewSkillPanel destination={{ personal: true }} existingSkills={existingSkills} onCreated={onClose} />

      <div className="my-3.5 flex items-center gap-3">
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        <span className="text-meta text-ink-faint">or</span>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
      </div>

      <p className="text-ui text-ink-muted">
        Tell your agent what you need — it drafts the skill and puts it here.
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{prompt}</p>
      </Surface>
    </Dialog>
  );
}
