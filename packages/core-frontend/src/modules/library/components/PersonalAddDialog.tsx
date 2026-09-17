import { useState } from 'react';
import { Button, Dialog, Surface } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { NewSkillPanel } from './NewSkillPanel';
import { AddDialogTabs, type AddKind } from './AddDialogTabs';
import { useLibraryToast } from '../state/toast.context';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

export interface PersonalAddDialogProps {
  /** The list's own name, e.g. `Juan's List` — the copy says it out loud. */
  name: string;
  /** Every skill name already in the catalog. The admin create half rejects collisions. */
  existingSkills: string[];
  onClose(): void;
}

/**
 * "Add a skill or tool" for a person's own list — the prototype's
 * `personalAddModal` (proto:3366-3369).
 *
 * The same role split as a plugin's add flow. Everyone can copy a prompt for
 * their agent. Admins can also start an empty skill directly; non-admins do
 * not get a placeholder they would have to finish in a separate follow-up.
 *
 * This page used to have no first door at all. The reason was real but narrow:
 * the plugin dialog's first half was a LINK into the destination folder, and
 * this page is defined as the items in no folder, so there was nothing to open.
 * That objection died with the link: a personal skill has a perfectly definite
 * home — the caller's own `Plugins/personal-<id>/` folder, which
 * `createEmptySkill` ensures through the provisioning endpoint before the
 * first write. The folder's seeded access.md names you as its owner, so the
 * write that follows passes the ordinary gate on its own merits — no
 * permission special-case anywhere in this flow.
 *
 * Skills and tools are separate tabs, as in `AddToPluginDialog`: the Tools tab
 * explains (a prompt, an MCP server, a `.tool` manual) rather than creates.
 */
export function PersonalAddDialog({ name, existingSkills, onClose }: PersonalAddDialogProps) {
  const { isAdmin } = useAdmin();
  const toast = useLibraryToast();
  const [kind, setKind] = useState<AddKind>('skills');
  const skillPrompt = `Help me build a new skill or tool at Bevel. Keep it to myself for now. It goes in my own list, not a plugin.`;
  const toolPrompt = `Help me build a new tool at Bevel. Keep it to myself for now. It goes in my own list, not a plugin.`;

  async function copyPrompt() {
    const prompt = kind === 'tools' ? toolPrompt : skillPrompt;
    const copied = await copyToClipboard(prompt);
    toast(copied ? COPIED_TOAST : COPY_FAILED_TOAST, copied ? 'neutral' : 'danger');
  }

  // Both panels stay mounted (see `AddDialogTabs`): the Skills half holds the
  // new-skill name an admin may already have typed, and a tab click is not a
  // reason to lose it.
  const skillsPanel = (
    <>
      <p className="text-ui text-ink-muted">
        {`It lands in ${name}. Yours alone until you add it to a plugin.`}
      </p>

      {isAdmin && (
        <>
          <NewSkillPanel
            destination={{ personal: true }}
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

      <p className="text-ui text-ink-muted">
        Tell your agent what you need. It drafts the skill and puts it here.
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{skillPrompt}</p>
      </Surface>
    </>
  );

  const toolsPanel = (
    <>
      {/* The same note as the Skills tab: your own folder has no other
          owner, so there is no change request to mention. */}
      <p className="text-ui text-ink-muted">
        {`It lands in ${name}. Yours alone until you add it to a plugin.`}
      </p>

      <p className="mt-3 text-ui text-ink-muted">
        Tell your agent what the tool should do. It drafts the tool and puts it here.
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{toolPrompt}</p>
      </Surface>

      {/* A personal folder is an ordinary plugin folder on disk, so it uses the
          same two locations as any other: `mcp.json` at its root, `.tool`
          manuals under the reverse-DNS extension directory. */}
      <p className="mt-3.5 text-ui text-ink-muted">
        To connect an MCP server, add it to the mcp.json in your own folder.
      </p>
      <p className="mt-2 text-ui text-ink-muted">
        To call an API without an MCP server, add a .tool manual describing it under
        software.bevel.hexis/tools/ in your own folder.
      </p>
    </>
  );

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
      <AddDialogTabs
        selected={kind}
        onSelect={setKind}
        panels={{ skills: skillsPanel, tools: toolsPanel }}
      />
    </Dialog>
  );
}
