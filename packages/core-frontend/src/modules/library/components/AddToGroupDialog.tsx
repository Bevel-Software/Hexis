import { Button, Dialog, Surface } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { NewSkillPanel } from './NewSkillPanel';
import { useLibraryToast } from '../state/toast.context';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

export interface AddToGroupDialogProps {
  /** Group name — the folder segment, already decoded. */
  name: string;
  /** Repo-relative primary folder, e.g. `Groups/GTM`. */
  primaryPath: string;
  /**
   * Whether the caller can write the folder. It changes the prompt's landing
   * clause and, for an admin, whether an empty skill lands directly or goes
   * through review. `null` (verdict not in yet) is treated as "not a writer":
   * the cautious sentence is true either way, the confident one is not.
   */
  canWrite: boolean | null;
  /** Every skill name already in the catalog. The admin create half rejects collisions. */
  existingSkills: string[];
  onClose(): void;
}

/**
 * "Add a skill or tool to {group}" — the writer's half of the group page.
 *
 * The agent prompt is the path everyone gets. Admins also get the direct
 * starter that creates an empty `SKILL.md`; non-admins do not. A placeholder
 * is useful to an admin who can finish it directly, while a non-admin should
 * send complete drafted content through the ordinary review flow.
 *
 * The prompt is the actual product here. It is copy-pasteable into the agent
 * verbatim and it already knows the group, so nobody has to explain where the
 * skill goes.
 *
 * The add button itself stays consistent for every role. What changes is the
 * safe action inside it: non-admins can copy the prompt, and the prompt's last
 * clause tells the truth about whether the resulting skill lands directly or
 * arrives as a change request.
 */
export function AddToGroupDialog({
  name,
  primaryPath,
  canWrite,
  existingSkills,
  onClose,
}: AddToGroupDialogProps) {
  const { isAdmin } = useAdmin();
  const toast = useLibraryToast();

  // The only sentence in this dialog that varies by role.
  const landing = canWrite
    ? 'I run it, so it goes in directly. No review step.'
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
        {isAdmin
          ? canWrite
            ? `Two ways in. Either way it joins ${name}. Everyone in the group gets it the next time their agent connects.`
            : `Two ways in. Either way it goes to ${name} as a change request, and an owner reviews it before it joins.`
          : canWrite
            ? `Use the prompt below to have your agent draft the skill and add it to ${name} for everyone in the group.`
            : `Use the prompt below to have your agent draft the skill and send it to ${name} as a change request for an owner to review.`}
      </p>

      {isAdmin && (
        <>
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
        </>
      )}

      {isAdmin && (
        <p className="text-ui text-ink-muted">
          {`Tell your agent what you need. It drafts the skill and adds it to ${name}.`}
        </p>
      )}

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{prompt}</p>
      </Surface>
    </Dialog>
  );
}
