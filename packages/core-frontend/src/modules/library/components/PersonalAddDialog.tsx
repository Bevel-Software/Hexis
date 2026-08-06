import { useEffect, useState } from 'react';
import { GROUPS_DIR } from '@bevel-software/platform-shared';
import { Button, Dialog, Surface } from '../../../shared/components';
import { fetchFileAccess } from '../../access/api';
import { NewSkillPanel } from './NewSkillPanel';
import { defaultWorkspaceId } from '../services/library.api';
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
 * That objection died with the link. An ungrouped skill has a perfectly
 * definite home on disk — `Groups/<name>/SKILL.md`, one level above where a
 * group's skills sit (see `groupOfPath`) — so there has always been somewhere
 * to WRITE, only nowhere to open.
 */
export function PersonalAddDialog({ name, existingSkills, onClose }: PersonalAddDialogProps) {
  const toast = useLibraryToast();
  const canWrite = useCanWriteGroupsRoot();
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

      <NewSkillPanel
        parentPath={GROUPS_DIR}
        canWrite={canWrite}
        existingSkills={existingSkills}
        onCreated={onClose}
      />

      {/* Said before they press, not after. An ungrouped skill lives at the
          `Groups/` root, which the default access tree hands to Admin alone —
          so for most people this door opens onto a review step, and a dialog
          that only mentioned that in the success toast would have been
          promising something it could not deliver. */}
      {canWrite === false && (
        <p className="mt-1.5 text-detail text-ink-muted">
          You can't write outside a group directly, so it goes for review first.
        </p>
      )}

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

/**
 * Whether the caller may write the `Groups/` root on the default branch — the
 * folder an ungrouped skill goes into. `null` until the answer lands, which
 * `NewSkillPanel` reads as "not a writer": the cautious route (a change
 * request) is correct either way, the confident one is not.
 *
 * A group page gets this verdict for free off its group summary; this page has
 * no summary to read, so it asks. `useFileAccess` is the wrong instrument here
 * — it resolves against the branch the user happens to be on, and drafts
 * short-circuit to `true`, whereas the destination is always the default
 * branch.
 */
function useCanWriteGroupsRoot(): boolean | null {
  const [canWrite, setCanWrite] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchFileAccess(defaultWorkspaceId(), GROUPS_DIR, 'folder')
      .then((res) => {
        if (!cancelled) setCanWrite(res.canWrite);
      })
      .catch(() => {
        // Leave it null. The backend is the authoritative gate at write time,
        // and a failed lookup should not upgrade anyone to writer.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return canWrite;
}
