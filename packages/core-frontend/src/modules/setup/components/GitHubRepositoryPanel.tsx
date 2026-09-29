import { useEffect, useRef, useState } from 'react';
import { Banner, Button, TextField } from '../../../shared/components';
import {
  fetchGitHubApp,
  fetchGitHubRepositories,
  startGitHubAppInstallation,
  startGitHubAppRegistration,
  type GitHubAppStatus,
  type GitHubRepository,
} from '../services/setup.api';

/** How a round trip to GitHub ended, as the address the browser came back on says. */
const OUTCOMES: Record<string, { tone: 'ok' | 'danger' | 'wait'; text: string }> = {
  connected: { tone: 'ok', text: 'GitHub is connected. Choose the repository below.' },
  requested: {
    tone: 'wait',
    text: 'You asked an owner of the organisation to install the app. Come back here once they have.',
  },
  'not-yours': {
    tone: 'danger',
    text: 'That installation is not one your GitHub account can reach, so it was not connected. Install the app on an account or organisation you belong to.',
  },
  'nothing-to-write': {
    tone: 'danger',
    text: 'The app reaches no repository your own GitHub account can write to, so nothing was connected. Add a repository you can write to, or ask someone who can to connect it.',
  },
  state: { tone: 'danger', text: 'The round trip to GitHub could not be verified. Start it again from here.' },
  refused: { tone: 'danger', text: 'GitHub did not complete the connection. Start it again from here.' },
  unreachable: { tone: 'danger', text: 'GitHub could not be reached. Try again shortly.' },
  'not-registered': { tone: 'danger', text: 'This deployment has no GitHub App yet. Create it first.' },
  'already-registered': { tone: 'wait', text: 'This deployment already has its GitHub App. Install it to go on.' },
};

/** The outcome on the address, read once and taken off it, so a reload does not say it again. */
function takeOutcome(): string | null {
  const outcome = new URLSearchParams(window.location.search ?? '').get('github');
  if (!outcome) return null;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('github');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // The address stays as it is: the outcome is said once more on a reload, which is all that is lost.
  }
  return outcome;
}

/**
 * Send the browser to GitHub with the manifest: a form GitHub receives, not
 * a request of ours, because the app is created in the person's own GitHub
 * session. Built on the page and outside the settings form, which a form
 * cannot sit inside.
 */
function postManifest(action: string, manifest: Record<string, unknown>): void {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = JSON.stringify(manifest);
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

interface Props {
  /** The repository chosen: what was picked on this screen, else what is stored. */
  repository: string;
  onChoose(repository: string): void;
  /** What a refused save said about the repository. */
  problem?: string;
  disabled?: boolean;
  /**
   * Called just before the browser is sent to GitHub. The page that comes
   * back is a new one, so whatever the form holds has to be kept now.
   */
  onLeaving?(): void;
}

/**
 * The GitHub tab of the repository section: connect a repository through a
 * GitHub App, in the three steps that takes, each offered when the one
 * before it is done.
 *
 *  1. The app. A deployment registers its own, in one press, unless whoever
 *     operates it supplied one.
 *  2. The installation: the admin chooses, on GitHub, which repositories
 *     the app may reach.
 *  3. The repository, chosen here among those.
 *
 * Nothing is typed and no token is created or stored: GitHub issues one for
 * an hour at a time. It sits inside the settings form, so it has no form of
 * its own and its buttons are buttons; the repository chosen is saved with
 * everything else by "Save and continue".
 */
export function GitHubRepositoryPanel({ repository, onChoose, problem, disabled, onLeaving }: Props) {
  const [status, setStatus] = useState<GitHubAppStatus | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [outcome] = useState(takeOutcome);
  const [organization, setOrganization] = useState('');
  const [starting, setStarting] = useState(false);
  const [repositories, setRepositories] = useState<GitHubRepository[] | null>(null);
  const [more, setMore] = useState(false);
  const [listFailed, setListFailed] = useState<string | null>(null);
  // Asked for at the moment of leaving, not at the press that led to it:
  // GitHub is asked for an address in between, and what the form holds when
  // the browser goes is what has to be kept.
  const leaving = useRef(onLeaving);
  leaving.current = onLeaving;

  useEffect(() => {
    let mounted = true;
    fetchGitHubApp()
      .then((found) => mounted && setStatus(found))
      .catch((err: unknown) => mounted && setFailed(err instanceof Error ? err.message : 'Could not read the GitHub connection.'));
    return () => {
      mounted = false;
    };
  }, []);

  const installed = status?.installation ?? null;
  useEffect(() => {
    if (!installed) return;
    let mounted = true;
    fetchGitHubRepositories()
      .then((found) => {
        if (!mounted) return;
        setRepositories(found.repositories);
        setMore(found.more);
      })
      .catch((err: unknown) => mounted && setListFailed(err instanceof Error ? err.message : 'Could not list the repositories.'));
    return () => {
      mounted = false;
    };
  }, [installed?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function register() {
    setFailed(null);
    setStarting(true);
    try {
      const { action, manifest } = await startGitHubAppRegistration(organization.trim());
      leaving.current?.();
      postManifest(action, manifest);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not start creating the app.');
      setStarting(false);
    }
  }

  /** Ask where on GitHub the app is installed, and go there. Asking is what starts the round trip. */
  async function install() {
    setFailed(null);
    setStarting(true);
    try {
      const address = await startGitHubAppInstallation();
      leaving.current?.();
      window.location.assign(address);
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not open GitHub.');
      setStarting(false);
    }
  }

  const said = outcome ? (OUTCOMES[outcome] ?? OUTCOMES.refused!) : null;
  // A repository that is stored but no longer reached is still shown, so it is not silently replaced.
  const listed = repositories ?? [];
  const options = repository && !listed.some((r) => r.fullName === repository) ? [repository, ...listed.map((r) => r.fullName)] : listed.map((r) => r.fullName);

  return (
    <div className="space-y-5" data-testid="github-repository">
      {said && (
        <Banner tone={said.tone} role="status">
          {said.text}
        </Banner>
      )}
      {failed && (
        <Banner tone="danger" role="alert">
          {failed}
        </Banner>
      )}

      {status && !status.app && (
        <div className="space-y-3">
          <p className="max-w-[60ch] text-detail text-ink">
            Connect a repository on GitHub without creating a token. This deployment gets a GitHub App of its own, which
            you install on the repository.
          </p>
          <label className="block space-y-1">
            <span className="text-detail font-medium text-ink">Organisation</span>
            <TextField
              value={organization}
              onChange={(e) => setOrganization(e.target.value)}
              // Enter here means "create the app", not "save the settings
              // form" this field happens to sit inside.
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                void register();
              }}
              placeholder="acme"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={disabled || starting}
              aria-describedby="github-organisation-help"
            />
            <span id="github-organisation-help" className="block text-meta text-ink-muted">
              The GitHub organisation that owns the repository, as it appears in its address. Leave blank if the
              repository is under your own account.
            </span>
          </label>
          <Button type="button" variant="primary" size="sm" onClick={() => void register()} disabled={disabled || starting}>
            {starting ? 'Opening GitHub…' : 'Create the GitHub App'}
          </Button>
          <p className="max-w-[60ch] text-meta text-ink-muted">
            GitHub asks you to confirm, then to choose which repositories the app may reach. It is given read and write
            access to their contents, and nothing else.
          </p>
        </div>
      )}

      {status?.app && !installed && (
        <div className="space-y-3">
          <p className="max-w-[60ch] text-detail text-ink">
            The GitHub App <span className="font-medium">{status.app.slug}</span> is ready. Install it on the account or
            organisation that owns the repository, and choose which repositories it may reach.
          </p>
          <Button type="button" variant="primary" size="sm" onClick={() => void install()} disabled={disabled || starting}>
            {starting ? 'Opening GitHub…' : 'Install the app on GitHub'}
          </Button>
        </div>
      )}

      {status?.app && installed && (
        <div className="space-y-3">
          <p className="max-w-[60ch] text-detail text-ink-muted">
            Connected to <span className="font-medium text-ink">{installed.account || 'GitHub'}</span> through the app{' '}
            <span className="font-medium text-ink">{status.app.slug}</span>.
          </p>
          {listFailed && (
            <Banner tone="danger" role="alert">
              {listFailed}
            </Banner>
          )}
          {/* Named by its label alone: wrapped in it, the picker would be
              named by every repository it lists and the help under it. */}
          <div className="space-y-1">
            <label htmlFor="github-repository-picker" className="block text-detail font-medium text-ink">
              Repository
            </label>
            <select
              id="github-repository-picker"
              value={repository}
              onChange={(e) => onChoose(e.target.value)}
              disabled={disabled || repositories === null}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? 'github-repository-problem' : 'github-repository-help'}
              className="block w-full rounded-md border border-line-strong bg-surface px-2.5 py-2 text-ui text-ink"
            >
              <option value="">{repositories === null && !listFailed ? 'Loading…' : 'Choose a repository'}</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            {problem ? (
              <span id="github-repository-problem" role="alert" className="block text-meta text-danger">
                {problem}
              </span>
            ) : (
              <span id="github-repository-help" className="block text-meta text-ink-muted">
                Where your knowledge, skills and tools are kept. An empty repository is fine: it is set up for you.
                {more ? ' Only the first 500 repositories are listed.' : ''}
              </span>
            )}
          </div>
          <div className="space-y-2">
            <p className="max-w-[60ch] text-meta text-ink-muted">
              The list holds the repositories the app reaches that your own GitHub account can write to, as they were
              when GitHub was connected. Connect it again to change which the app reaches, or to bring the list up to
              date.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void install()} disabled={disabled || starting}>
              {starting ? 'Opening GitHub…' : 'Connect GitHub again'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
