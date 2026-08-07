import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
}));
vi.mock('../services/setup.api', async () => {
  // The error class is real — the screen distinguishes field problems from a
  // general failure by `instanceof`, so a stub would defeat the test.
  const actual = await vi.importActual<typeof import('../services/setup.api')>(
    '../services/setup.api',
  );
  return { ...actual, ...api };
});

import { SetupGate } from '../components/SetupGate';
import { SetupScreen } from '../components/SetupScreen';
import { SettingsProblems, type SettingStatus } from '../services/setup.api';

const KB = 'knowledge-base' as const;
const SETTINGS: SettingStatus[] = [
  { key: 'kbRepoUrl', envVar: 'KB_REPO_URL', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'gitToken', envVar: 'GIT_TOKEN', section: KB, source: 'unset', configured: false, secret: true, restartToApply: false },
  { key: 'gitUsername', envVar: 'GIT_USERNAME', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: false },
  { key: 'kbDirName', envVar: 'KB_DIR_NAME', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: true },
  { key: 'defaultBranch', envVar: 'DEFAULT_BRANCH', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: true },
  { key: 'protectedBranches', envVar: 'PROTECTED_BRANCHES', section: KB, source: 'unset', value: '', configured: false, secret: false, restartToApply: true },
  { key: 'oidcClientSecret', envVar: 'OIDC_CLIENT_SECRET', section: 'sign-in', source: 'unset', configured: false, secret: true, restartToApply: true },
];

/**
 * Completing setup RELOADS rather than re-rendering: the branch model the
 * browser holds was fetched before any of it existed, and every module that
 * reads it took its value then. Stubbed so the assertion is "it reloaded",
 * which is the actual contract.
 */
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  api.fetchSetupStatus.mockReset();
  api.saveSettings.mockReset();
  api.testConnection.mockReset();
  reload = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload, origin: 'https://example.test' },
  });
});

const APP = <div>The application</div>;

describe('SetupGate', () => {
  it('lets a configured deployment straight through', async () => {
    api.fetchSetupStatus.mockResolvedValue({ complete: true, isAdmin: true });
    render(<SetupGate>{APP}</SetupGate>);
    expect(await screen.findByText('The application')).toBeInTheDocument();
  });

  /**
   * The app behind this gate reads from a workspace that cannot exist yet.
   * Rendering it — even for a moment — shows a broken file tree and a stream of
   * failed requests to the person least able to do anything about it.
   */
  it('shows a non-admin that setup is in progress, not the app', async () => {
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: false });
    render(<SetupGate>{APP}</SetupGate>);
    expect(await screen.findByText(/Still being set up/)).toBeInTheDocument();
    expect(screen.queryByText('The application')).toBeNull();
  });

  it('tells a non-admin nothing about what is missing', async () => {
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: false });
    render(<SetupGate>{APP}</SetupGate>);
    await screen.findByText(/Still being set up/);
    expect(document.body.textContent).not.toContain('KB_REPO_URL');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  /**
   * The check guards against an unconfigured deployment; it is not an
   * authorisation boundary. Blocking on a transient failure would lock everyone
   * out of a deployment that works.
   */
  it('opens the gate when the status check itself fails', async () => {
    api.fetchSetupStatus.mockRejectedValue(new Error('offline'));
    render(<SetupGate>{APP}</SetupGate>);
    expect(await screen.findByText('The application')).toBeInTheDocument();
  });

  it('claims nothing until the answer is in', () => {
    api.fetchSetupStatus.mockReturnValue(new Promise(() => {}));
    render(<SetupGate>{APP}</SetupGate>);
    expect(screen.queryByText('The application')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });
});

describe('SetupScreen', () => {
  async function renderScreen(settings: SettingStatus[] = SETTINGS) {
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: true, settings });
    render(<SetupGate>{APP}</SetupGate>);
    await screen.findByRole('heading', { name: /Set up this deployment/ });
  }

  it('saves what was typed and lets the app through once complete', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });
    // The second status read is what the gate acts on.
    api.fetchSetupStatus.mockResolvedValue({ complete: true, isAdmin: true });

    await userEvent.type(screen.getByLabelText('Repository address'), 'https://example.com/kb.git');
    await userEvent.type(screen.getByLabelText('Access token'), 'ghp_secret');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          kbRepoUrl: 'https://example.com/kb.git',
          gitToken: 'ghp_secret',
        }),
      ),
    );
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  /**
   * The whole reason a form beats an environment variable: it can ask the host
   * whether the answer is right, and say which part was wrong — before anything
   * is saved, rather than in a clone failure minutes later.
   */
  it('reports what the host said about the credentials', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({
      ok: false,
      error: 'The host rejected those credentials.',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/rejected those credentials/)).toBeInTheDocument();
  });

  /** An empty repository is a supported starting point, not a failure. */
  it('treats an empty repository as a success', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({ ok: true, empty: true, branches: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/repository is empty/)).toBeInTheDocument();
  });

  it('marks the field the server complained about', async () => {
    await renderScreen();
    api.saveSettings.mockRejectedValue(
      new SettingsProblems({ kbRepoUrl: 'The URL must start with https://' }),
    );
    await userEvent.type(screen.getByLabelText('Repository address'), 'git@example.com:kb.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('must start with https://');
    expect(screen.getByLabelText('Repository address')).toHaveAttribute('aria-invalid', 'true');
  });

  /**
   * A stored secret is never sent back, so there is nothing to prefill. The
   * field says what leaving it blank means instead of looking empty-and-unset.
   */
  it('does not pretend to show a saved token', async () => {
    await renderScreen([
      { ...SETTINGS[1]!, source: 'stored', configured: true },
      ...SETTINGS.filter((s) => s.key !== 'gitToken'),
    ]);
    const token = screen.getByLabelText('Access token');
    expect(token).toHaveValue('');
    expect(token).toHaveAttribute('placeholder', 'Saved. Type to replace');
  });

  /**
   * A value the environment supplies cannot be overwritten from a browser —
   * the server refuses it, so offering an input would be a lie. The variable is
   * named instead, which is the actionable thing.
   */
  it('does not offer to edit a setting the environment owns', async () => {
    await renderScreen([
      { ...SETTINGS[0]!, source: 'env', value: 'https://env.example/kb.git', configured: true },
      ...SETTINGS.slice(1),
    ]);
    expect(screen.queryByLabelText('Repository address')).toBeNull();
    expect(screen.getByText('KB_REPO_URL')).toBeInTheDocument();
  });

  /**
   * Branch names must match the repository exactly, and a typo produces a
   * deployment pointing at a branch nobody has. The connection test already
   * knows what is there, so it offers them rather than leaving it to memory.
   */
  it('offers the branches the connection test found', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({
      ok: true,
      empty: false,
      branches: ['main', 'release'],
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText(/Found 2 branches/);

    const list = screen.getByLabelText('Main branch').getAttribute('list');
    expect(list).toBeTruthy();
    const options = [...document.querySelectorAll(`#${list} option`)].map((o) =>
      o.getAttribute('value'),
    );
    expect(options).toEqual(['main', 'release']);
  });

  /** Nothing to suggest before a test has run — an empty list is not an answer. */
  it('offers nothing until the remote has been asked', async () => {
    await renderScreen();
    expect(screen.getByLabelText('Main branch')).not.toHaveAttribute('list');
  });

  /**
   * Neither branch field is valid on its own — the default has to appear in the
   * protected list — so the server checks the pair and the screen marks the
   * field with room to hold the answer.
   */
  it('surfaces the pair problem the server reports', async () => {
    await renderScreen();
    api.saveSettings.mockRejectedValue(
      new SettingsProblems({
        protectedBranches: 'The default branch ("main") must be one of the protected branches (release).',
      }),
    );
    await userEvent.type(screen.getByLabelText('Main branch'), 'main');
    await userEvent.type(screen.getByLabelText('Branches that need approval'), 'release');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be one of the protected');
  });

  /** SSO is optional, so the screen shows the one thing the provider needs. */
  it('shows the redirect URI to register with the provider', async () => {
    await renderScreen();
    expect(screen.getByText(`${window.location.origin}/api/auth/oidc/callback`)).toBeInTheDocument();
  });

  /** A section whose fields all come from the environment is not rendered at all. */
  it('omits a section the environment fully owns', async () => {
    await renderScreen(
      SETTINGS.map((s) =>
        s.section === 'sign-in' ? { ...s, source: 'env' as const, configured: true } : s,
      ),
    );
    expect(screen.queryByRole('heading', { name: 'Single sign-on' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Knowledge, skills & tools' })).toBeInTheDocument();
  });

  /**
   * "Token username" is not a username. People read it as their own account,
   * and it is in fact a fixed string each host expects beside a token — so it
   * is answered from the repository address rather than asked for, and lives
   * under Advanced for the self-hosted cases that address cannot settle.
   */
  it('answers the token-username question from the repository address', async () => {
    await renderScreen();
    await userEvent.type(
      screen.getByLabelText('Repository address'),
      'https://gitlab.com/acme/kb.git',
    );
    expect(screen.getByLabelText('Token username')).toHaveValue('oauth2');
  });

  it('does not overwrite a token username somebody typed', async () => {
    await renderScreen();
    await userEvent.type(screen.getByLabelText('Token username'), 'custom-user');
    await userEvent.type(
      screen.getByLabelText('Repository address'),
      'https://github.com/acme/kb.git',
    );
    expect(screen.getByLabelText('Token username')).toHaveValue('custom-user');
  });

  /** An unrecognised host gets no guess — a wrong credential is worse than none. */
  it('guesses nothing for a self-hosted address', async () => {
    await renderScreen();
    await userEvent.type(
      screen.getByLabelText('Repository address'),
      'https://git.internal.example/acme/kb.git',
    );
    expect(screen.getByLabelText('Token username')).toHaveValue('');
  });

  /**
   * The branch names must match the repository exactly. Asking someone to
   * remember them is how a deployment ends up pointing at a branch nobody has,
   * so the repository is asked instead.
   */
  it('fills the version fields from what the repository calls its trunk', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({
      ok: true,
      empty: false,
      branches: ['develop', 'trunk'],
      defaultBranch: 'trunk',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByLabelText('Main branch')).toHaveValue('trunk'));
    expect(screen.getByLabelText('Branches that need approval')).toHaveValue('trunk');
  });

  it('leaves version fields somebody already filled in alone', async () => {
    await renderScreen();
    await userEvent.type(screen.getByLabelText('Main branch'), 'release');
    api.testConnection.mockResolvedValue({ ok: true, branches: ['main'], defaultBranch: 'main' });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(api.testConnection).toHaveBeenCalled());
    expect(screen.getByLabelText('Main branch')).toHaveValue('release');
  });

  /**
   * The branch pair lives under Advanced now, and the server validates it as a
   * pair. A message about it landing inside a closed box is a form that refuses
   * to save and will not say why, so the box opens itself.
   */
  it('opens Advanced when the problem is inside it', async () => {
    await renderScreen();
    const advanced = document.querySelector('details');
    expect(advanced).not.toHaveAttribute('open');

    api.saveSettings.mockRejectedValue(
      new SettingsProblems({ protectedBranches: 'The default branch must be one of them.' }),
    );
    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(document.querySelector('details')).toHaveAttribute('open'));
    expect(await screen.findByRole('alert')).toHaveTextContent('must be one of them');
  });

  /**
   * A blank field means "leave it alone", so the server accepts a batch that
   * answers only part of what it needs. The screen then cleared the form and
   * re-rendered — indistinguishable from a save that silently failed, which is
   * exactly what it looked like.
   */
  it('says what is still missing when a save lands but does not finish setup', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({
      restartRequired: false,
      complete: false,
      settings: SETTINGS.map((s) =>
        s.key === 'kbRepoUrl' || s.key === 'gitToken' ? { ...s, configured: true } : s,
      ),
    });
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: true, settings: SETTINGS });

    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/still needs/);
    expect(notice).toHaveTextContent('Main branch');
    // And the box holding them opens, or the advice points somewhere invisible.
    await waitFor(() => expect(document.querySelector('details')).toHaveAttribute('open'));
  });

  it('says nothing of the sort when the save does finish setup', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });
    api.fetchSetupStatus.mockResolvedValue({ complete: true, isAdmin: true });
    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  /**
   * Not every host advertises its HEAD, and a blank version field is the one
   * way a save can succeed without finishing setup — so a visible, correctable
   * guess beats leaving it empty.
   */
  it('falls back to a conventional branch when the remote does not name one', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({
      ok: true,
      branches: ['develop', 'main', 'release'],
      defaultBranch: null,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByLabelText('Main branch')).toHaveValue('main'));
  });

  it('falls back to the first branch when even that is absent', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({
      ok: true,
      branches: ['production', 'staging'],
      defaultBranch: null,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByLabelText('Main branch')).toHaveValue('production'));
  });

  /**
   * The test belongs beside the two fields it proves, not after every section.
   * Pinned by position rather than by eye: it drifted to the end once already,
   * which put "did I type the token right?" below the identity-provider
   * questions and, on a page that now scrolls, below the fold.
   */
  it('keeps the connection test inside the knowledge-base card', async () => {
    await renderScreen();
    const card = screen.getByRole('heading', { name: 'Knowledge, skills & tools' }).closest('section');
    expect(card).not.toBeNull();
    expect(card).toContainElement(screen.getByRole('button', { name: 'Test connection' }));
    // Above Advanced, because testing is what fills Advanced in.
    const details = card!.querySelector('details');
    expect(details).not.toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Test connection' })
        .compareDocumentPosition(details!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /**
   * Pressing Save without pressing Test used to be refused over a missing
   * branch name. That is a question with a knowable answer — ask the
   * repository — so it is only worth refusing over when the repository cannot
   * answer either.
   */
  it('works the version out on save rather than refusing over it', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({ ok: true, branches: ['main'], defaultBranch: 'main' });
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });

    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.type(screen.getByLabelText('Access token'), 'ghp_x');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: 'main', protectedBranches: 'main' }),
    );
  });

  it('settings mode: a COMPLETE save refreshes in place, never reloads the document', async () => {
    // In setup mode a complete save reloads the page (the gate's browser
    // holds no branch model yet). On the Deployment page the app around the
    // form is already running — a save must refetch status, not yank the
    // document out from under the admin. `onSaved` being called at all is
    // the distinguishing observable: the setup path reloads INSTEAD of
    // calling it.
    const onSaved = vi.fn();
    render(<SetupScreen settings={SETTINGS} onSaved={onSaved} variant="settings" />);
    api.saveSettings.mockResolvedValue({
      restartRequired: false,
      complete: true,
      settings: SETTINGS,
    });

    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('settings mode: an awaiting-restart save refreshes AND keeps the restart notice', async () => {
    const onSaved = vi.fn();
    render(<SetupScreen settings={SETTINGS} onSaved={onSaved} variant="settings" />);
    api.saveSettings.mockResolvedValue({
      restartRequired: true,
      complete: false,
      awaitingRestart: true,
      settings: SETTINGS,
    });

    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText(/needs a restart/)).toBeInTheDocument();
  });

  it('derives the standard branch name on save when the repository is empty', async () => {
    await renderScreen();
    api.testConnection.mockResolvedValue({ ok: true, empty: true, branches: [], defaultBranch: null });
    api.saveSettings.mockResolvedValue({
      restartRequired: false,
      complete: true,
      settings: SETTINGS,
    });
    api.fetchSetupStatus.mockResolvedValue({ complete: true, isAdmin: true, settings: SETTINGS });

    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    // An EMPTY repository has no branch to report, but it will be seeded with
    // whatever is configured — so the conventional name is derived and the
    // save FINISHES setup, instead of succeeding into a "still needs Main
    // branch" notice about a value the app could have supplied itself.
    await waitFor(() =>
      expect(api.saveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ defaultBranch: 'main', protectedBranches: 'main' }),
      ),
    );
  });

  /**
   * The branch model is applied at boot. Saving it now applies it to the
   * running process too, but if that ever fails the gate must stay shut and
   * ask for a restart rather than open onto a server that cannot serve.
   */
  it('asks for a restart instead of claiming a field is missing', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({
      restartRequired: true,
      complete: false,
      awaitingRestart: true,
      settings: SETTINGS,
    });
    await userEvent.type(screen.getByLabelText('Repository address'), 'https://x/y.git');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(/needs a restart/);
    expect(notice).not.toHaveTextContent(/still needs/);
  });

  /** Single sign-on is skippable, and the screen has to say so. */
  it('marks the optional section optional', async () => {
    await renderScreen();
    expect(screen.getByText('Optional')).toBeInTheDocument();
  });

  it('says so when a saved setting needs a restart', async () => {
    await renderScreen();
    api.saveSettings.mockResolvedValue({ restartRequired: true, complete: false, settings: SETTINGS });
    api.fetchSetupStatus.mockResolvedValue({ complete: false, isAdmin: true, settings: SETTINGS });
    await userEvent.type(screen.getByLabelText('Folder name'), 'company-brain');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText(/restart it when convenient/)).toBeInTheDocument();
  });
});
