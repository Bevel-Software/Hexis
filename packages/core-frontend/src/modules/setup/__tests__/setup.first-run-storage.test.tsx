import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testOidc: vi.fn(),
  syncNow: vi.fn(),
  fetchGitHubApp: vi.fn(),
  fetchGitHubRepositories: vi.fn(),
  startGitHubAppRegistration: vi.fn(),
  startGitHubAppInstallation: vi.fn(),
  startGitHubAppRefresh: vi.fn(),
}));
vi.mock('../services/setup.api', async () => {
  // The error classes are real: the screen tells a refusal from a failure by `instanceof`.
  const actual = await vi.importActual<typeof import('../services/setup.api')>('../services/setup.api');
  return { ...actual, ...api };
});
vi.mock('../../settings/services/github-facade.api', () => ({
  fetchGitHubFacade: vi.fn(),
  rotateGitHubFacade: vi.fn(),
  fetchMarketplaceRegistration: vi.fn(async () => false),
  setMarketplaceRegistration: vi.fn(),
}));

import { SetupGate } from '../components/SetupGate';
import { AppRegistryContext, EMPTY_REGISTRY } from '../../../core/registry';
import {
  KbInitFailed,
  SettingsProblems,
  type GitHubAppStatus,
  type GitMode,
  type RepositoryStatus,
  type SettingStatus,
} from '../services/setup.api';

/**
 * The first-run storage question: what a fresh deployment shows its admin
 * before the full setup form, and when it steps aside for that form.
 */

const setting = (key: string, extra: Partial<SettingStatus> = {}): SettingStatus => ({
  key,
  section: 'knowledge-base',
  source: 'unset',
  value: '',
  configured: false,
  secret: false,
  restartToApply: false,
  ...extra,
});

const SETTINGS: SettingStatus[] = [
  setting('gitMode', { restartToApply: true }),
  setting('githubRepository'),
  setting('kbRepoUrl'),
  setting('gitToken', { secret: true, value: undefined }),
  setting('defaultBranch'),
  setting('protectedBranches'),
];

const MODES: GitMode[] = ['managed', 'github-app', 'token'];
const FRESH: RepositoryStatus = { mode: null, chosen: null, modes: MODES };
const INSTALLED: GitHubAppStatus = {
  registeredBy: 'setup',
  app: { slug: 'hexis-acme', url: 'https://github.com/apps/hexis-acme' },
  installation: { id: '77', account: 'acme' },
  repository: null,
};

const realLocation = window.location;
let reload: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;
function standAt(search = '') {
  reload = vi.fn();
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, href: `https://kb.acme.test/${search}`, search, origin: 'https://kb.acme.test', reload, assign },
  });
}

/** `null`: a server that knows one way only, and so reports none. */
function statusWith(repository: RepositoryStatus | null) {
  return { complete: false, isAdmin: true, settings: SETTINGS, ...(repository ? { repository } : {}) };
}

function showGate(repository: RepositoryStatus | null = FRESH, registry = EMPTY_REGISTRY) {
  api.fetchSetupStatus.mockResolvedValue(statusWith(repository));
  render(
    <AppRegistryContext.Provider value={registry}>
      <SetupGate>
        <div>The application</div>
      </SetupGate>
    </AppRegistryContext.Provider>,
  );
}

const question = () => screen.findByRole('heading', { name: 'Where should your knowledge base live?' });
const fullForm = () => screen.findByRole('heading', { name: 'Set up this deployment' });
const managedCard = () => screen.getByRole('radio', { name: 'Hexis takes care of it' });
const gitHubCard = () => screen.queryByRole('radio', { name: 'My own GitHub' });
const proceed = () => userEvent.click(screen.getByRole('button', { name: 'Continue' }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchGitHubApp.mockResolvedValue(INSTALLED);
  api.fetchGitHubRepositories.mockResolvedValue({
    repositories: [{ fullName: 'acme/kb', private: true, defaultBranch: 'main', writable: true }],
    more: false,
  });
  sessionStorage.clear();
  standAt();
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('SetupGate: the first-run storage question', () => {
  it('is what a fresh deployment shows its admin, with the managed repository chosen', async () => {
    showGate();
    await question();
    expect(screen.queryByRole('heading', { name: 'Set up this deployment' })).toBeNull();
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(managedCard()).toHaveAccessibleDescription(/Ready right away/);
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.queryByText('The application')).toBeNull();
  });

  it('saves the managed repository with nothing else, and opens the knowledge base once setup is complete', async () => {
    showGate();
    await question();
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });
    await proceed();
    expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'managed' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/workspace'));
  });

  it('hands over to the full form when the save leaves something still to answer', async () => {
    showGate();
    await question();
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: false, settings: SETTINGS });
    api.fetchSetupStatus.mockResolvedValue(statusWith({ mode: 'managed', chosen: 'managed', modes: MODES }));
    await proceed();
    expect(await fullForm()).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  /** The choice is stored; the full form owns the failure and its retry. */
  it('hands over to the full form when the knowledge base could not be initialized', async () => {
    showGate();
    await question();
    api.saveSettings.mockRejectedValue(new KbInitFailed({ kind: 'unknown', cause: 'The disk is full.' }));
    api.fetchSetupStatus.mockResolvedValue({
      ...statusWith({ mode: 'managed', chosen: 'managed', modes: MODES }),
      kbInit: { kind: 'unknown', cause: 'The disk is full.' },
    });
    await proceed();
    expect(await screen.findByTestId('kb-init-failure')).toHaveTextContent('The disk is full.');
  });

  it('says when a restart is owed', async () => {
    showGate();
    await question();
    api.saveSettings.mockResolvedValue({ restartRequired: true, complete: false, awaitingRestart: true, settings: SETTINGS });
    await proceed();
    expect(await screen.findByText(/needs a restart to pick the branch settings up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('says why a save failed and lets it be tried again', async () => {
    showGate();
    await question();
    api.saveSettings.mockRejectedValue(new Error('The server could not be reached.'));
    await proceed();
    expect(await screen.findByRole('alert')).toHaveTextContent('The server could not be reached.');
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('offers GitHub only where the deployment can connect through a GitHub App', async () => {
    showGate({ mode: null, chosen: null, modes: ['managed', 'token'] });
    await question();
    expect(gitHubCard()).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });

  it('moves the choice with the arrow keys, as a radiogroup promises', async () => {
    showGate();
    await question();
    managedCard().focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(gitHubCard()).toHaveAttribute('aria-checked', 'true');
    expect(gitHubCard()).toHaveFocus();
    expect(managedCard()).toHaveAttribute('tabindex', '-1');
  });

  it('connects GitHub, then saves the repository chosen there', async () => {
    showGate();
    await question();
    await userEvent.click(gitHubCard()!);
    await proceed();
    expect(await screen.findByRole('heading', { name: 'Connect your GitHub' })).toBeInTheDocument();
    expect(api.saveSettings).not.toHaveBeenCalled();
    const save = screen.getByRole('button', { name: 'Save and continue' });
    expect(save).toBeDisabled();

    const picker = await screen.findByLabelText('Repository');
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.selectOptions(picker, 'acme/kb');
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });
    await userEvent.click(save);
    expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'github-app', githubRepository: 'acme/kb' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/workspace'));
  });

  it('shows a refusal about the repository beside it', async () => {
    showGate();
    await question();
    await userEvent.click(gitHubCard()!);
    await proceed();
    const picker = await screen.findByLabelText('Repository');
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.selectOptions(picker, 'acme/kb');
    const refusal = 'The GitHub App cannot reach that repository.';
    api.saveSettings.mockRejectedValue(new SettingsProblems({ githubRepository: refusal }));
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText(refusal)).toHaveAttribute('id', 'github-repository-problem');
  });

  it('goes back from GitHub to the question', async () => {
    showGate();
    await question();
    await userEvent.click(gitHubCard()!);
    await proceed();
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(await question()).toBeInTheDocument();
  });

  /** The trip to GitHub started here, so the return lands here, on the GitHub step. */
  it('opens on the GitHub step on a return from GitHub', async () => {
    standAt('?github=connected');
    showGate();
    expect(await screen.findByRole('heading', { name: 'Connect your GitHub' })).toBeInTheDocument();
  });

  it('returns to the full form when the trip to GitHub started there', async () => {
    standAt('?github=connected');
    sessionStorage.setItem(
      'hexis_setup_draft',
      JSON.stringify({ draft: { defaultBranch: 'trunk' }, dropped: [], at: Date.now() }),
    );
    showGate();
    expect(await fullForm()).toBeInTheDocument();
  });

  describe('an address and a token, on this screen', () => {
    const openAddressStep = async () => {
      showGate();
      await question();
      await userEvent.click(screen.getByRole('button', { name: 'Use an address and token' }));
      await screen.findByRole('heading', { name: 'Connect your repository' });
    };
    const fill = async (url: string, token = 'glpat-secret') => {
      await userEvent.type(screen.getByLabelText('Repository address'), url);
      await userEvent.type(screen.getByLabelText('Access token'), token);
    };

    it('opens as a step of this screen, not the full form, and goes back to the cards', async () => {
      await openAddressStep();
      expect(screen.queryByRole('heading', { name: 'Set up this deployment' })).toBeNull();
      expect(screen.queryByRole('tab', { name: 'Managed for you' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      expect(await question()).toBeInTheDocument();
    });

    it('tests the connection and says what the host answered', async () => {
      await openAddressStep();
      await fill('https://gitlab.com/acme/kb.git');
      api.testConnection.mockResolvedValue({ ok: true, outcome: 'connected', empty: true, branches: [] });
      await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      expect(await screen.findByText('Connected. The repository is empty; it will be set up for you.')).toBeInTheDocument();
      // The host's token username is known, so it is sent and not asked.
      expect(api.testConnection).toHaveBeenCalledWith(
        expect.objectContaining({ kbRepoUrl: 'https://gitlab.com/acme/kb.git', gitToken: 'glpat-secret' }),
      );
      expect(screen.queryByLabelText('Username for the token')).toBeNull();
    });

    it('proves the connection before saving, then saves it with the branch the host named', async () => {
      await openAddressStep();
      await fill('https://gitlab.com/acme/kb.git');
      api.testConnection.mockResolvedValue({ ok: true, outcome: 'connected', defaultBranch: 'trunk', branches: ['trunk'] });
      api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: SETTINGS });
      await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
      await waitFor(() =>
        expect(api.saveSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            gitMode: 'token',
            kbRepoUrl: 'https://gitlab.com/acme/kb.git',
            gitToken: 'glpat-secret',
            defaultBranch: 'trunk',
            protectedBranches: 'trunk',
          }),
        ),
      );
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/workspace'));
    });

    it('does not save what the host turned down, and says why', async () => {
      await openAddressStep();
      await fill('https://gitlab.com/acme/kb.git', 'wrong');
      api.testConnection.mockResolvedValue({ ok: false, outcome: 'rejected', field: 'gitToken', error: 'The token was refused.' });
      await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
      expect(await screen.findByText('The token was refused.')).toBeInTheDocument();
      expect(screen.getByLabelText('Access token')).toHaveAttribute('aria-invalid', 'true');
      expect(api.saveSettings).not.toHaveBeenCalled();
    });

    it('asks for the token username only on a host it does not know', async () => {
      await openAddressStep();
      await fill('https://git.acme.internal/kb.git');
      expect(screen.getByLabelText('Username for the token')).toBeInTheDocument();
    });
  });

  it.each<[string, RepositoryStatus | null]>([
    ['a way is already chosen', { mode: null, chosen: 'token', modes: MODES }],
    ['a way is in effect on a server that does not report the choice', { mode: 'token', modes: MODES }],
    ['the environment pinned the way', { mode: null, chosen: null, pinned: 'GIT_MODE', modes: MODES }],
    ['the managed repository is not offered', { mode: null, chosen: null, modes: ['github-app', 'token'] }],
    ['the server knows one way only', null],
  ])('shows the full form as before when %s', async (_, repository) => {
    showGate(repository);
    expect(await fullForm()).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Where should your knowledge base live?' })).toBeNull();
  });

  it('takes what the managed card says from the registry', async () => {
    showGate(FRESH, {
      ...EMPTY_REGISTRY,
      managedStorage: { title: 'Hexis keeps it', description: 'Hosted for you, ready now.' },
    });
    await question();
    const card = screen.getByRole('radio', { name: 'Hexis keeps it' });
    expect(card).toHaveAccessibleDescription(/Hosted for you, ready now\./);
    expect(screen.queryByText('Hexis takes care of it')).toBeNull();
  });
});
