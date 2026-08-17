import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Users } from 'lucide-react';
import { Button, Dialog, Surface } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { NewPluginDialog } from '../../library/components/NewPluginDialog';
import { NewSkillPanel } from '../../library/components/NewSkillPanel';
import { useLibrary } from '../../library/state/library-data';
import { displayFirstName } from '../../library/utils/personal-plugin';
import { useOnboarding } from '../state/onboarding';

/**
 * The first useful screen in an empty deployment.
 *
 * A regular account needs to connect an agent before the library becomes
 * useful. The first admin has a different job: make the shared structure that
 * everyone else will find. This page offers the two smallest real beginnings,
 * using the same plugin and skill creation flows available everywhere else.
 */
export function CreatorWelcomePage() {
  const { user } = useAuth();
  const onboarding = useOnboarding();
  const data = useLibrary();
  const [newPluginOpen, setNewPluginOpen] = useState(false);
  const [newSkillOpen, setNewSkillOpen] = useState(false);
  /**
   * The skill panel's in-flight state, lifted. A create that has started
   * finishes even if the dialog goes away — and then navigates. Holding the
   * dialog's close doors shut while it runs (`Dialog.busy` + the footer
   * button) is what keeps "dismiss" from turning into "get carried to a page
   * you closed the door on".
   */
  const [newSkillBusy, setNewSkillBusy] = useState(false);

  const { markWelcomed } = onboarding;
  useEffect(() => {
    markWelcomed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one idempotent welcome record per mount
  }, []);

  const pluginNames = useMemo(
    () => [
      ...new Set([
        ...data.pluginSummaries.map((plugin) => plugin.name),
        ...data.items.flatMap((item) => (item.plugin ? [item.plugin] : [])),
      ]),
    ],
    [data.pluginSummaries, data.items],
  );
  const skillNames = useMemo(
    () => data.items.filter((item) => item.kind === 'skill').map((item) => item.name),
    [data.items],
  );
  const firstName = displayFirstName(user?.name) || 'there';

  return (
    <div className="mx-auto mt-[9vh] max-w-[580px] pb-14">
      <h1 className="text-display font-bold">Welcome, {firstName}</h1>
      <p className="mt-3 max-w-[54ch] text-lede text-ink-muted">
        Build the shared library your team and AI agents work from. Start with a plugin for a
        team or project, or create a skill in your own space.
      </p>

      <div className="mt-9 text-label uppercase text-ink-faint">Choose where to start</div>
      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        <Surface as="section" elevation="none" padded className="flex min-h-48 flex-col">
          <Users size={19} className="text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-strong font-semibold text-ink">Create a plugin</h2>
          <p className="mt-1 text-ui text-ink-muted">
            Organize skills and tools for a team, then invite the people who need them.
          </p>
          <Button
            variant="primary"
            className="mt-auto self-start"
            onClick={() => setNewPluginOpen(true)}
          >
            Create a plugin
          </Button>
        </Surface>

        <Surface as="section" elevation="none" padded className="flex min-h-48 flex-col">
          <Sparkles size={19} className="text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-strong font-semibold text-ink">Create a skill</h2>
          <p className="mt-1 text-ui text-ink-muted">
            Capture repeatable instructions for an AI agent. You can add the skill to a plugin
            later.
          </p>
          <Button
            variant="outline"
            className="mt-auto self-start"
            onClick={() => setNewSkillOpen(true)}
          >
            Create a skill
          </Button>
        </Surface>
      </div>

      {newPluginOpen && (
        <NewPluginDialog
          existing={pluginNames}
          onClose={() => setNewPluginOpen(false)}
          onCreated={() => {
            data.reload();
            data.reloadPlugins();
          }}
        />
      )}

      {newSkillOpen && (
        <Dialog
          open
          busy={newSkillBusy}
          onClose={() => setNewSkillOpen(false)}
          title="New skill"
          footer={
            <Button
              variant="quiet"
              disabled={newSkillBusy}
              onClick={() => setNewSkillOpen(false)}
            >
              Close
            </Button>
          }
        >
          <p className="text-ui text-ink-muted">
            Start in your own space. You can move the skill into a shared plugin when it is ready.
          </p>
          <NewSkillPanel
            destination={{ personal: true }}
            existingSkills={skillNames}
            onBusyChange={setNewSkillBusy}
            onCreated={() => {
              // Belt and braces on the lifted flag: the panel clears it
              // itself, and clearing it again as the dialog closes means a
              // later open can never inherit a stale busy state.
              setNewSkillOpen(false);
              setNewSkillBusy(false);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
