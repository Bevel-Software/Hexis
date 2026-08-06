import { Button, Dialog, Surface } from '../../../shared/components';
import { NewSkillPanel } from './NewSkillPanel';
import { useLibraryToast } from '../state/toast.context';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

export interface AddToGroupDialogProps {
  /** Group name — the folder segment, already decoded. */
  name: string;
  /** Repo-relative primary folder, e.g. `Groups/GTM`. */
  primaryPath: string;
  /**
   * Whether the caller can write the folder. It changes ONE clause of the
   * prompt and nothing else — see the note below on why the door is the same
   * for everyone. `null` (verdict not in yet) is treated as "not a writer":
   * the cautious sentence is true either way, the confident one is not.
   */
  canWrite: boolean | null;
  /** Every skill name already in the catalog — the create half rejects collisions. */
  existingSkills: string[];
  onClose(): void;
}

/**
 * "Add a skill or tool to {group}" — the writer's half of the group page.
 *
 * Two ways in, and NEITHER of them is an upload form. A skill is a folder
 * (`SKILL.md` plus whatever it needs), so the honest doors are one that makes
 * that folder for you and one that hands the job to the agent. The prototype's
 * dropzone is deliberately not ported: there is no upload endpoint behind it,
 * and a dropzone that silently does nothing is worse than a button that does
 * something.
 *
 * The prompt is the actual product here. It is copy-pasteable into the agent
 * verbatim and it already knows the group, so nobody has to explain where the
 * skill goes.
 *
 * ONE door, for every role. This dialog used to be the writer's half of a
 * fork — everyone else got a separate "Propose a skill or tool" page — which
 * meant the same button in the same spot opened a different flow with
 * different words depending on who pressed it. Who reviews what is a property
 * of the GROUP, not of the door, so the door is the same and the prompt's last
 * clause tells the truth about what happens next: a writer's skill goes in
 * directly, everyone else's arrives as a change request. Nothing here writes
 * to the KB, so there is no permission to gate on — the dialog hands you a
 * prompt and a link.
 */
export function AddToGroupDialog({
  name,
  primaryPath,
  canWrite,
  existingSkills,
  onClose,
}: AddToGroupDialogProps) {
  const toast = useLibraryToast();

  // The only sentence in this dialog that varies by role.
  const landing = canWrite
    ? 'I run it, so it goes in directly — no review step.'
    : 'I am not an owner, so send it to the group as a change request for review.';
  const prompt = `Help me build a new skill or tool and add it to the ${name} group at Bevel. ${landing}`;

  async function copyPrompt() {
    const copied = await copyToClipboard(prompt);
    toast(copied ? COPIED_TOAST : COPY_FAILED_TOAST, copied ? 'neutral' : 'danger');
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add a skill or tool to ${name}`}
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
        {canWrite
          ? `Two ways in. Either way it joins ${name} — everyone in the group gets it the next time their agent connects.`
          : `Two ways in. Either way it goes to ${name} as a change request, and an owner reviews it before it joins.`}
      </p>

      <NewSkillPanel
        destination={{ parentPath: primaryPath, canWrite }}
        existingSkills={existingSkills}
        onCreated={onClose}
      />

      <div className="my-3.5 flex items-center gap-3">
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
        <span className="text-meta text-ink-faint">or</span>
        <span aria-hidden="true" className="h-px flex-1 bg-line" />
      </div>

      <p className="text-ui text-ink-muted">
        {`Tell your agent what you need — it drafts the skill and adds it to ${name}.`}
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{prompt}</p>
      </Surface>
    </Dialog>
  );
}
