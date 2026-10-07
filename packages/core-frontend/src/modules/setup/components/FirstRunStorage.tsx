import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Check, GitBranch, Server } from 'lucide-react';
import { Badge, Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { useAppRegistry } from '../../../core/registry';
import { GitHubRepositoryPanel } from './GitHubRepositoryPanel';
import { forgetDraft } from '../utils/kept-draft';
import { KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
import {
  saveSettings,
  KbInitFailed,
  SettingsProblems,
  type RepositoryStatus,
} from '../services/setup.api';

/** Core's words for the repository the deployment keeps; a distribution names itself (`managedStorage`). */
const MANAGED_DEFAULT = {
  title: 'Hexis takes care of it',
  description: 'Ready right away. There is nothing to connect and nothing to enter.',
};

type Choice = 'managed' | 'github-app';

interface Props {
  /** The ways offered. The gate only sends a deployment here that has chosen none and is not pinned. */
  repository: RepositoryStatus;
  /** Re-read the status: the gate then shows whatever the deployment still needs. */
  onSaved(): void;
  /** Leave for the full setup form, opened on the address and the token. */
  onUseAddressAndToken(): void;
}

/**
 * The first screen a fresh deployment shows its admin: one question, where
 * the knowledge base lives, answered by picking a card.
 *
 * WHY NOT THE FULL FORM. Almost every new deployment ends up on the
 * repository it keeps for itself, which needs no answers at all. The full
 * form put that choice behind a tab among address fields, sign-in settings
 * and folder names, so the one-press path looked like the hardest one. This
 * screen asks the question on its own and leaves everything else for later.
 *
 * NOTHING IS TAKEN AWAY. An address and a token, single sign-on and the
 * rest are one link away, on the same form as before. Once a way is chosen
 * the gate goes back to that form for whatever is still missing, so a save
 * that leaves something to fix lands where it can be fixed.
 */
export function FirstRunStorage({ repository, onSaved, onUseAddressAndToken }: Props) {
  const { managedStorage } = useAppRegistry();
  const managed = managedStorage ?? MANAGED_DEFAULT;
  const offersGitHub = repository.modes.includes('github-app');

  const [choice, setChoice] = useState<Choice>('managed');
  /**
   * The GitHub steps are open. Opened straight away on a return from GitHub,
   * which the address says: the trip started here, and what came of it is
   * said in the panel.
   */
  const [connecting, setConnecting] = useState(
    () => offersGitHub && new URLSearchParams(window.location.search ?? '').has('github'),
  );
  const [githubRepository, setGitHubRepository] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryProblem, setRepositoryProblem] = useState<string | undefined>();
  /** Saved, but the running process needs a restart before it can use what was saved. */
  const [needsRestart, setNeedsRestart] = useState(false);

  /**
   * Store the choice, and then do what the full form does after the save
   * that finishes setup: load the app afresh on completion (the browser's
   * branch model predates it), say so when a restart is owed, otherwise
   * re-read the status.
   *
   * The fresh load opens the knowledge base. Choosing where it lives is the
   * one step that has to come first; connecting an agent and the rest wait
   * in the Get set up list beside it, so nothing else stands in the way.
   */
  async function save(settings: Record<string, string>) {
    if (saving) return;
    setSaving(true);
    setError(null);
    setRepositoryProblem(undefined);
    try {
      const result = await saveSettings(settings);
      if (result.awaitingRestart) {
        setNeedsRestart(true);
        return;
      }
      if (result.complete) {
        window.location.assign(KB_ROUTE_PREFIX);
        return;
      }
      onSaved();
    } catch (err) {
      if (err instanceof KbInitFailed) {
        // The choice IS stored; only the initialization failed. The full form
        // owns that failure and its retry, and the next status read sends the
        // gate there, since a way has now been chosen.
        onSaved();
      } else if (err instanceof SettingsProblems) {
        const { githubRepository: aboutRepository, ...rest } = err.problems;
        if (aboutRepository && connecting) setRepositoryProblem(aboutRepository);
        const elsewhere = Object.values(aboutRepository && connecting ? rest : err.problems);
        if (elsewhere.length > 0) setError(elsewhere.join(' '));
      } else {
        setError(err instanceof Error ? err.message : 'Could not save this choice.');
      }
    } finally {
      setSaving(false);
    }
  }

  const choices: Choice[] = offersGitHub ? ['managed', 'github-app'] : ['managed'];
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  /** Arrows move the choice, as a radiogroup promises; Tab leaves it. */
  function onRadioKeyDown(event: KeyboardEvent, index: number) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + choices.length) % choices.length;
    setChoice(choices[next]!);
    radios.current[next]?.focus();
  }

  function proceed() {
    if (choice === 'github-app') {
      setError(null);
      setConnecting(true);
    } else void save({ gitMode: 'managed' });
  }

  const notices = (
    <>
      {error && (
        <Banner tone="danger" role="alert">
          {error}
        </Banner>
      )}
      {needsRestart && (
        <Banner tone="wait" role="status">
          Saved. This deployment needs a restart to pick the branch settings up; everything else is in place.
        </Banner>
      )}
    </>
  );

  return (
    // `h-full` and its own scroll, as the full form does: `#root` clips, so a
    // page that only grew past it would scroll nothing.
    <div className="h-full overflow-y-auto bg-canvas">
      <main className="mx-auto px-4 pt-8 pb-16 md:pt-16 md:pb-24 max-w-[692px]">
        <div className="grid gap-7">
          <span className="text-ui font-semibold tracking-wide text-ink">
            Hexis by{' '}
            <a
              href="https://bevel.software"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Bevel
            </a>
          </span>
          {connecting ? (
            <>
              <Heading title="Connect your GitHub">
                This deployment reads and writes the one repository you pick.
              </Heading>
              <GitHubRepositoryPanel
                repository={githubRepository}
                onChoose={(name) => {
                  setGitHubRepository(name);
                  setRepositoryProblem(undefined);
                }}
                problem={repositoryProblem}
                disabled={saving || needsRestart}
                // Nothing typed here needs keeping across the trip. What an
                // earlier, abandoned trip from the full form kept would send
                // the gate there on return, so it goes.
                onLeaving={forgetDraft}
              />
              {notices}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void save({ gitMode: 'github-app', githubRepository })}
                  disabled={!githubRepository || saving || needsRestart}
                >
                  {saving ? 'Saving…' : 'Save and continue'}
                </Button>
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => {
                    setConnecting(false);
                    setError(null);
                  }}
                  disabled={saving}
                >
                  Back
                </Button>
              </div>
            </>
          ) : (
            <>
              <Heading title="Where should your knowledge base live?">
                Your knowledge, skills and tools are kept together in one git repository. Choose who looks after it.
              </Heading>
              <div role="radiogroup" aria-label="Where the knowledge base lives" className="grid gap-3 lg:grid-cols-2">
                {choices.map((c, i) => (
                  <ChoiceCard
                    key={c}
                    ref={(el) => {
                      radios.current[i] = el;
                    }}
                    selected={choice === c}
                    onSelect={() => setChoice(c)}
                    onKeyDown={(e) => onRadioKeyDown(e, i)}
                    disabled={saving || needsRestart}
                    {...(c === 'managed'
                      ? {
                          icon: <Server className="size-[18px]" aria-hidden />,
                          badge: 'Recommended',
                          title: managed.title,
                          description: managed.description,
                          points: [
                            'Every change is a commit, reviewed as a change request',
                            'Stored with this deployment’s backups',
                            'Movable to a repository of your own later',
                          ],
                        }
                      : {
                          icon: <GitBranch className="size-[18px]" aria-hidden />,
                          title: 'My own GitHub',
                          description: 'Keep it in a repository your organisation owns.',
                          points: [
                            'Install the GitHub app, then pick a repository',
                            'Edits made here show up as commits',
                            'A brand-new empty repository is fine',
                          ],
                        })}
                  />
                ))}
              </div>
              {notices}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button type="button" variant="primary" onClick={proceed} disabled={saving || needsRestart}>
                  {saving ? 'Saving…' : 'Continue'}
                </Button>
                {/* Its own flex row with a line height of one, so the text's
                    centre, not a taller line box around it, lines up with the
                    middle of the Continue button. */}
                <span className="flex flex-wrap items-center gap-x-1 text-detail leading-none text-ink-faint">
                  <span>Using GitLab, Bitbucket or Azure DevOps?</span>
                  <button
                    type="button"
                    onClick={onUseAddressAndToken}
                    disabled={saving}
                    className="leading-none text-accent underline underline-offset-2 hover:text-accent-hover"
                  >
                    Use an address and token
                  </button>
                </span>
              </div>
              <p className="text-meta text-ink-faint">
                To add single sign-on and the audit log, go to Settings → Deployment later.
              </p>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function Heading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <h1 className="text-display font-semibold text-ink">{title}</h1>
      <p className="max-w-[58ch] text-lede text-ink-muted">{children}</p>
    </div>
  );
}

interface ChoiceCardProps {
  ref: (el: HTMLButtonElement | null) => void;
  selected: boolean;
  onSelect(): void;
  onKeyDown(event: KeyboardEvent): void;
  disabled: boolean;
  icon: ReactNode;
  badge?: string;
  title: string;
  description: string;
  points: string[];
}

/** One way of keeping the repository, as a radio: its own heading, what it means, and what it asks. */
function ChoiceCard({ ref, selected, onSelect, onKeyDown, disabled, icon, badge, title, description, points }: ChoiceCardProps) {
  // Named by its title and described by the rest, so a screen reader says
  // "Hexis takes care of it, radio, checked" rather than the whole card.
  const id = useId();
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      // Roving: the group is one Tab stop, on the card that is chosen.
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      onKeyDown={onKeyDown}
      disabled={disabled}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description ${id}-points`}
      className={cn(
        'relative grid content-start gap-3 rounded-xl border-[1.5px] bg-surface p-5 text-left transition-[border-color,box-shadow] hover:border-accent disabled:cursor-not-allowed disabled:opacity-60',
        selected ? 'border-accent ring-3 ring-accent/15' : 'border-line-strong',
      )}
    >
      {badge && (
        <Badge size="sm" className="absolute top-4 right-4 bg-accent/10 font-semibold text-accent">
          {badge}
        </Badge>
      )}
      <span className="grid size-[34px] place-items-center rounded-md bg-sunken text-ink">{icon}</span>
      <span id={`${id}-title`} className="text-head font-semibold text-ink">
        {title}
      </span>
      <span id={`${id}-description`} className="text-ui text-ink-muted">
        {description}
      </span>
      {/* Spans, not a list: a button holds phrasing content only. */}
      <span id={`${id}-points`} className="grid gap-1.5">
        {points.map((point) => (
          <span key={point} className="flex gap-2 text-detail text-ink">
            <Check className="mt-[3px] size-[13px] shrink-0 text-ok" aria-hidden />
            {point}
          </span>
        ))}
      </span>
    </button>
  );
}
