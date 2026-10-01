import { useState } from 'react';
import { Button, Dialog, Surface } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { NewSkillPanel } from './NewSkillPanel';
import { LinkSkillPanel } from './LinkSkillPanel';
import { AddDialogTabs, type AddKind } from './AddDialogTabs';
import type { LibraryItem } from '../state/library-data';
import { useLibraryToast } from '../state/toast.context';
import { COPIED_TOAST, COPY_FAILED_TOAST, copyToClipboard } from '../utils/clipboard';

export interface AddToPluginDialogProps {
  /** Plugin name — the folder segment, already decoded. */
  name: string;
  /** Repo-relative primary folder, e.g. `Plugins/GTM`. */
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
  /**
   * The caller's catalog, for the "link an existing skill" half. Optional
   * together with `onLinked`: a caller without them gets the dialog as it was
   * before linking existed.
   */
  linkable?: LibraryItem[];
  onLinked?(): void;
  onClose(): void;
}

/**
 * "Add a skill or tool to {plugin}" — the writer's half of the plugin page.
 *
 * The agent prompt is the path everyone gets. Admins also get the direct
 * starter that creates an empty `SKILL.md`; non-admins do not. A placeholder
 * is useful to an admin who can finish it directly, while a non-admin should
 * send complete drafted content through the ordinary review flow.
 *
 * The prompt is the actual product here. It is copy-pasteable into the agent
 * verbatim and it already knows the plugin, so nobody has to explain where the
 * skill goes.
 *
 * The add button itself stays consistent for every role. What changes is the
 * safe action inside it: non-admins can copy the prompt, and the prompt's last
 * clause tells the truth about whether the resulting skill lands directly or
 * arrives as a change request.
 *
 * Skills and tools are separate tabs. The Tools tab has no form, on purpose: it
 * carries a tool-specific prompt and says where an MCP server or a `.tool`
 * manual goes, under the same owner-or-change-request note as the Skills tab.
 * The footer's "Copy prompt" copies the prompt of whichever tab is showing.
 */
export function AddToPluginDialog({
  name,
  primaryPath,
  canWrite,
  existingSkills,
  linkable,
  onLinked,
  onClose,
}: AddToPluginDialogProps) {
  const { isAdmin } = useAdmin();
  const toast = useLibraryToast();
  const [kind, setKind] = useState<AddKind>('skills');

  // The only sentence in this dialog that varies by role.
  const landing = canWrite
    ? 'I run it, so it goes in directly. No review step.'
    : 'I am not an owner, so send it to the plugin as a change request for review.';
  const skillPrompt = `Help me build a new skill or tool and add it to the ${name} plugin at Bevel. ${landing}`;
  const toolPrompt = `Help me build a new tool and add it to the ${name} plugin at Bevel. ${landing}`;

  async function copyPrompt() {
    const prompt = kind === 'tools' ? toolPrompt : skillPrompt;
    const copied = await copyToClipboard(prompt);
    toast(copied ? COPIED_TOAST : COPY_FAILED_TOAST, copied ? 'neutral' : 'danger');
  }

  // Both panels are handed to `AddDialogTabs`, which mounts BOTH and hides the
  // inactive one. The Skills half owns typed state — the new-skill name and the
  // link search — and a tab click that unmounted it would silently throw a
  // half-written draft away.
  const skillsPanel = (
    <>
      <p className="text-ui text-ink-muted">
        {isAdmin
          ? canWrite
            ? `Two ways in. Either way it joins ${name}. Everyone in the plugin gets it the next time their agent connects.`
            : `Two ways in. Either way it goes to ${name} as a change request, and an owner reviews it before it joins.`
          : canWrite
            ? `Use the prompt below to have your agent draft the skill and add it to ${name} for everyone in the plugin.`
            : `Use the prompt below to have your agent draft the skill and send it to ${name} as a change request for an owner to review.`}
      </p>

      {/* Linking is the MANAGER's half: it edits this plugin's manifest, and the
          server refuses anyone else. A non-manager only gets the prompt below. */}
      {canWrite && linkable && onLinked && (
        <>
          <div className="mt-3">
            <LinkSkillPanel
              plugin={name}
              items={linkable}
              onLinked={() => {
                onLinked();
                onClose();
              }}
            />
          </div>
          <div className="my-3.5 flex items-center gap-3">
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
            <span className="text-meta text-ink-faint">or</span>
            <span aria-hidden="true" className="h-px flex-1 bg-line" />
          </div>
        </>
      )}

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
        <p className="font-mono text-detail text-ink">{skillPrompt}</p>
      </Surface>
    </>
  );

  const toolsPanel = (
    <>
      {/* The Skills tab's owner-or-change-request note, without its
          "Two ways in": none of the tool paths below is a form. */}
      <p className="text-ui text-ink-muted">
        {canWrite
          ? `Whichever way you add it, it joins ${name}. Everyone in the plugin gets it the next time their agent connects.`
          : `Whichever way you add it, it goes to ${name} as a change request, and an owner reviews it before it joins.`}
      </p>

      <p className="mt-3 text-ui text-ink-muted">
        {`Tell your agent what the tool should do. It drafts the tool and adds it to ${name}.`}
      </p>

      <Surface tone="sunken" radius="md" elevation="none" padded className="mt-2.5">
        <p className="font-mono text-detail text-ink">{toolPrompt}</p>
      </Surface>

      {/* Both locations are the ones the workspace layout defines (shared
          `kb-layout.ts`): `mcp.json` at the plugin root — the Agent Plugins
          fixed location — and `.tool` manuals under the reverse-DNS extension
          directory, which is where the migration writes them and where a
          reader expects to find them. */}
      <p className="mt-3.5 text-ui text-ink-muted">
        {`To connect an MCP server, add it to the mcp.json in the ${name} plugin folder.`}
      </p>
      <p className="mt-2 text-ui text-ink-muted">
        {`To call an API without an MCP server, add a .tool manual describing it to the ${name} plugin's software.bevel.hexis/tools/ folder.`}
      </p>
    </>
  );

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
      <AddDialogTabs
        selected={kind}
        onSelect={setKind}
        panels={{ skills: skillsPanel, tools: toolsPanel }}
      />
    </Dialog>
  );
}
