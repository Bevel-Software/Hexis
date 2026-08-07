import { useEffect, useMemo, useState } from 'react';
import { Sparkles, Users } from 'lucide-react';
import { Button, Dialog, Surface } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { NewGroupDialog } from '../../library/components/NewGroupDialog';
import { NewSkillPanel } from '../../library/components/NewSkillPanel';
import { useLibrary } from '../../library/state/library-data';
import { displayFirstName } from '../../library/utils/personal-group';
import { useOnboarding } from '../state/onboarding';

/**
 * The first useful screen in an empty deployment.
 *
 * A regular account needs to connect an agent before the library becomes
 * useful. The first admin has a different job: make the shared structure that
 * everyone else will find. This page offers the two smallest real beginnings,
 * using the same group and skill creation flows available everywhere else.
 */
export function CreatorWelcomePage() {
  const { user } = useAuth();
  const onboarding = useOnboarding();
  const data = useLibrary();
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [newSkillOpen, setNewSkillOpen] = useState(false);

  const { markWelcomed } = onboarding;
  useEffect(() => {
    markWelcomed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one idempotent welcome record per mount
  }, []);

  const groupNames = useMemo(
    () => [
      ...new Set([
        ...data.groupSummaries.map((group) => group.name),
        ...data.items.flatMap((item) => (item.group ? [item.group] : [])),
      ]),
    ],
    [data.groupSummaries, data.items],
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
        Build the shared library your team and AI agents work from. Start with a group for a
        team or project, or create a skill in your own space.
      </p>

      <div className="mt-9 text-label uppercase text-ink-faint">Choose where to start</div>
      <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
        <Surface as="section" elevation="none" padded className="flex min-h-48 flex-col">
          <Users size={19} className="text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-strong font-semibold text-ink">Create a group</h2>
          <p className="mt-1 text-ui text-ink-muted">
            Organize skills and tools for a team, then invite the people who need them.
          </p>
          <Button
            variant="primary"
            className="mt-auto self-start"
            onClick={() => setNewGroupOpen(true)}
          >
            Create a group
          </Button>
        </Surface>

        <Surface as="section" elevation="none" padded className="flex min-h-48 flex-col">
          <Sparkles size={19} className="text-accent" aria-hidden="true" />
          <h2 className="mt-3 text-strong font-semibold text-ink">Create a skill</h2>
          <p className="mt-1 text-ui text-ink-muted">
            Capture repeatable instructions for an AI agent. You can add the skill to a group
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

      {newGroupOpen && (
        <NewGroupDialog
          existing={groupNames}
          onClose={() => setNewGroupOpen(false)}
          onCreated={() => {
            data.reload();
            data.reloadGroups();
          }}
        />
      )}

      {newSkillOpen && (
        <Dialog
          open
          onClose={() => setNewSkillOpen(false)}
          title="New skill"
          footer={
            <Button variant="quiet" onClick={() => setNewSkillOpen(false)}>
              Close
            </Button>
          }
        >
          <p className="text-ui text-ink-muted">
            Start in your own space. You can move the skill into a shared group when it is ready.
          </p>
          <NewSkillPanel
            destination={{ personal: true }}
            existingSkills={skillNames}
            onCreated={() => setNewSkillOpen(false)}
          />
        </Dialog>
      )}
    </div>
  );
}
