import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  const actual = await vi.importActual<typeof import('../services/setup.api')>('../services/setup.api');
  return { ...actual, ...api };
});
vi.mock('../../settings/services/github-facade.api', () => ({
  fetchGitHubFacade: vi.fn(),
  rotateGitHubFacade: vi.fn(),
  fetchMarketplaceRegistration: vi.fn(async () => false),
  setMarketplaceRegistration: vi.fn(),
}));

import { SetupScreen } from '../components/SetupScreen';
import {
  SettingsProblems,
  type GitHubAppStatus,
  type GitMode,
  type RepositoryStatus,
  type SettingStatus,
} from '../services/setup.api';

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

const settingsOf = (repository = ''): SettingStatus[] => [
  setting('gitMode', { restartToApply: true }),
  setting('githubRepository', repository ? { source: 'stored', configured: true, value: repository } : {}),
  setting('kbRepoUrl'),
  setting('gitToken', { secret: true, value: undefined }),
  setting('defaultBranch'),
  setting('protectedBranches'),
];

const MODES: GitMode[] = ['managed', 'github-app', 'token'];
const NO_APP: GitHubAppStatus = { registeredBy: null, app: null, installation: null, repository: null };
const APP = { slug: 'hexis-acme', url: 'https://github.com/apps/hexis-acme' };
const REGISTERED: GitHubAppStatus = { registeredBy: 'setup', app: APP, installation: null, repository: null };
const INSTALLED: GitHubAppStatus = { ...REGISTERED, installation: { id: '77', account: 'acme' } };
const REPOSITORIES = {
  repositories: [
    { fullName: 'acme/kb', private: true, defaultBranch: 'main', writable: true },
    { fullName: 'acme/website', private: false, defaultBranch: 'trunk', writable: true },
  ],
  more: false,
};

const realLocation = window.location;
function standAt(search = '') {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...realLocation, href: `https://kb.acme.test/${search}`, search, origin: 'https://kb.acme.test', reload: vi.fn() },
  });
}

function show(opts: { mode?: GitMode | null; stored?: string; variant?: 'setup' | 'settings'; modes?: GitMode[] } = {}) {
  const repository: RepositoryStatus = { mode: opts.mode ?? null, modes: opts.modes ?? MODES };
  render(<SetupScreen settings={settingsOf(opts.stored)} onSaved={() => {}} variant={opts.variant ?? 'setup'} repository={repository} />);
}

const openGitHub = () => userEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchGitHubApp.mockResolvedValue(NO_APP);
  api.fetchGitHubRepositories.mockResolvedValue(REPOSITORIES);
  standAt();
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
});

describe('SetupScreen: the GitHub tab', () => {
  it('is offered second, between the repository the deployment keeps and an address', () => {
    show();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Hexis takes care of it', 'GitHub', 'Address and token']);
    expect(screen.getByRole('tab', { name: 'Hexis takes care of it' })).toHaveAttribute('aria-selected', 'true');
  });

  it('is not drawn by a deployment that cannot connect to GitHub', () => {
    show({ modes: ['managed', 'token'] });
    expect(screen.queryByRole('tab', { name: 'GitHub' })).toBeNull();
  });

  it('asks GitHub nothing until it is opened', async () => {
    show();
    expect(api.fetchGitHubApp).not.toHaveBeenCalled();
    await openGitHub();
    await waitFor(() => expect(api.fetchGitHubApp).toHaveBeenCalled());
  });
});

describe('the three steps of connecting GitHub', () => {
  it('starts with creating the app, which sends the browser to GitHub with the manifest', async () => {
    api.startGitHubAppRegistration.mockResolvedValue({
      action: 'https://github.com/organizations/acme/settings/apps/new?state=abc',
      manifest: { name: 'Hexis kb.acme.test', public: false },
    });
    const submitted: HTMLFormElement[] = [];
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(function (this: HTMLFormElement) {
      submitted.push(this);
    });
    try {
      show();
      await openGitHub();
      await userEvent.type(await screen.findByLabelText('Organisation', { exact: false }), 'acme');
      await userEvent.click(screen.getByRole('button', { name: 'Create the GitHub App' }));
      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(api.startGitHubAppRegistration).toHaveBeenCalledWith('acme');
      const form = submitted[0]!;
      expect(form.method).toBe('post');
      expect(form.action).toBe('https://github.com/organizations/acme/settings/apps/new?state=abc');
      expect(JSON.parse((form.elements.namedItem('manifest') as HTMLInputElement).value)).toEqual({
        name: 'Hexis kb.acme.test',
        public: false,
      });
      // GitHub's form, on the page, never inside the settings form.
      expect(form.closest('#setup-settings-form')).toBeNull();
      expect(api.saveSettings).not.toHaveBeenCalled();
    } finally {
      submit.mockRestore();
    }
  });

  it('keeps Enter in the organisation field from saving the settings form', async () => {
    show();
    await openGitHub();
    const field = await screen.findByLabelText('Organisation', { exact: false });
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(field, { key: 'a' })).toBe(true);
  });

  it('says so in place when the app cannot be started', async () => {
    api.startGitHubAppRegistration.mockRejectedValue(new Error('This deployment already has a GitHub App.'));
    show();
    await openGitHub();
    await userEvent.click(await screen.findByRole('button', { name: 'Create the GitHub App' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a GitHub App');
    expect(screen.getByRole('button', { name: 'Create the GitHub App' })).toBeEnabled();
  });

  it('goes on to installing an app that exists, asking where on GitHub before it sends the browser there', async () => {
    api.fetchGitHubApp.mockResolvedValue(REGISTERED);
    api.startGitHubAppInstallation.mockResolvedValue('https://github.com/apps/hexis-acme/installations/new?state=abc');
    const assign = vi.fn();
    standAt();
    Object.assign(window.location, { assign });
    show();
    await openGitHub();
    await userEvent.click(await screen.findByRole('button', { name: 'Install the app on GitHub' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/apps/hexis-acme/installations/new?state=abc'));
    expect(screen.queryByRole('button', { name: 'Create the GitHub App' })).toBeNull();
    expect(api.fetchGitHubRepositories).not.toHaveBeenCalled();
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  /** A round trip is started by asking, never by a link someone could be sent. */
  it('has no link that starts a round trip', async () => {
    for (const status of [REGISTERED, INSTALLED]) {
      api.fetchGitHubApp.mockResolvedValue(status);
      const { unmount } = render(
        <SetupScreen settings={settingsOf()} onSaved={() => {}} repository={{ mode: 'github-app', chosen: 'github-app', modes: MODES }} />,
      );
      await screen.findByText(/hexis-acme/);
      expect(screen.queryAllByRole('link').filter((a) => (a.getAttribute('href') ?? '').includes('/api/'))).toEqual([]);
      unmount();
    }
  });

  it('says so in place when GitHub cannot be opened', async () => {
    api.fetchGitHubApp.mockResolvedValue(REGISTERED);
    api.startGitHubAppInstallation.mockRejectedValue(new Error('This deployment has no GitHub App yet. Create it first.'));
    show();
    await openGitHub();
    await userEvent.click(await screen.findByRole('button', { name: 'Install the app on GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has no GitHub App yet');
    expect(screen.getByRole('button', { name: 'Install the app on GitHub' })).toBeEnabled();
  });

  it('ends with choosing a repository among those the installation reaches', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    show();
    await openGitHub();
    const picker = await screen.findByRole('combobox', { name: 'Repository' });
    await waitFor(() => expect(picker).toBeEnabled());
    expect(screen.getByTestId('github-repository')).toHaveTextContent('Connected to acme through the app hexis-acme');
    expect(Array.from((picker as HTMLSelectElement).options).map((o) => o.value)).toEqual(['', 'acme/kb', 'acme/website']);
    // What the list is, and how it is brought up to date.
    expect(screen.getByTestId('github-repository')).toHaveTextContent('your own GitHub account can write to');
    expect(screen.getByRole('button', { name: 'Refresh the list' })).toBeEnabled();
  });

  /**
   * Which repositories the app reaches is decided on GitHub, first; the list
   * is what came of it. So the connection's controls come before the list.
   */
  it('puts the connection to GitHub above the repository it is chosen through', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    show();
    await openGitHub();
    const picker = await screen.findByRole('combobox', { name: 'Repository' });
    for (const name of ['Change repositories on GitHub', 'Refresh the list']) {
      const button = screen.getByRole('button', { name });
      expect(button.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING, name).toBeTruthy();
    }
  });

  /**
   * With the app installed, the address that installs it opens the
   * installation's settings on GitHub, and GitHub offers no way back from
   * there. In this tab the admin would be left on GitHub, the setup screen
   * gone.
   */
  it('opens GitHub in another tab to change what the app reaches, and stays where it is', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    api.startGitHubAppInstallation.mockResolvedValue('https://github.com/apps/hexis-acme/installations/new?state=abc');
    const assign = vi.fn();
    standAt();
    Object.assign(window.location, { assign });
    const tab = { opener: window as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    try {
      show();
      await openGitHub();
      await userEvent.click(await screen.findByRole('button', { name: 'Change repositories on GitHub' }));
      await waitFor(() => expect(tab.location.href).toBe('https://github.com/apps/hexis-acme/installations/new?state=abc'));
      // Opened at the press, in a tab of its own, which is given no handle on this one.
      expect(open).toHaveBeenCalledWith('', '_blank');
      expect(tab.opener).toBeNull();
      expect(assign).not.toHaveBeenCalled();
      // And the way back is said: nothing changed there is in the list yet.
      expect(await screen.findByTestId('github-managed')).toHaveTextContent('Refresh the list');
      expect(screen.getByRole('combobox', { name: 'Repository' })).toBeInTheDocument();
    } finally {
      open.mockRestore();
    }
  });

  it('goes itself when no tab may be opened, and closes the tab when GitHub cannot be asked', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    api.startGitHubAppInstallation.mockResolvedValue('https://github.com/apps/hexis-acme/installations/new?state=abc');
    const assign = vi.fn();
    standAt();
    Object.assign(window.location, { assign });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      show();
      await openGitHub();
      await userEvent.click(await screen.findByRole('button', { name: 'Change repositories on GitHub' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/apps/hexis-acme/installations/new?state=abc'));

      const tab = { opener: window as unknown, location: { href: '' }, close: vi.fn() };
      open.mockReturnValue(tab as unknown as Window);
      api.startGitHubAppInstallation.mockRejectedValue(new Error('GitHub could not be reached.'));
      await userEvent.click(screen.getByRole('button', { name: 'Change repositories on GitHub' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('GitHub could not be reached');
      expect(tab.close).toHaveBeenCalled();
      expect(tab.location.href).toBe('');
    } finally {
      open.mockRestore();
    }
  });

  it('refreshes the list by a sign-in that comes straight back', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    api.startGitHubAppRefresh.mockResolvedValue('https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc');
    const assign = vi.fn();
    standAt();
    Object.assign(window.location, { assign });
    show();
    await openGitHub();
    await userEvent.click(await screen.findByRole('button', { name: 'Refresh the list' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc'));
    expect(api.startGitHubAppInstallation).not.toHaveBeenCalled();
  });

  it('says the list is up to date when the browser comes back from refreshing it', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    standAt('?github=refreshed');
    show();
    expect(await screen.findByText('The list of repositories is up to date.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
  });

  /** Installed by an owner who approved it later, in a browser of their own. */
  it('offers to check again for an app that was installed somewhere this browser never came back from', async () => {
    api.fetchGitHubApp.mockResolvedValue(REGISTERED);
    api.startGitHubAppRefresh.mockResolvedValue('https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc');
    const assign = vi.fn();
    standAt();
    Object.assign(window.location, { assign });
    show();
    await openGitHub();
    await userEvent.click(await screen.findByRole('button', { name: 'Already installed? Check again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?client_id=Iv1.x&state=abc'));
  });
});

describe('saving a repository on GitHub', () => {
  beforeEach(() => api.fetchGitHubApp.mockResolvedValue(INSTALLED));

  it('sends the way and the repository, and leaves the proof to the server', async () => {
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: settingsOf('acme/kb'), repository: { mode: 'github-app', modes: MODES } });
    show();
    await openGitHub();
    const picker = await screen.findByRole('combobox', { name: 'Repository' });
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.selectOptions(picker, 'acme/kb');
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'github-app', githubRepository: 'acme/kb' }));
    expect(api.testConnection).not.toHaveBeenCalled();
  });

  it('does not send a repository that was chosen on a tab that was then left', async () => {
    api.saveSettings.mockResolvedValue({ restartRequired: false, complete: true, settings: settingsOf(), repository: { mode: 'managed', modes: MODES } });
    show();
    await openGitHub();
    const picker = await screen.findByRole('combobox', { name: 'Repository' });
    await waitFor(() => expect(picker).toBeEnabled());
    await userEvent.selectOptions(picker, 'acme/kb');
    await userEvent.click(screen.getByRole('tab', { name: 'Hexis takes care of it' }));
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'managed' }));
  });

  it('shows a refusal beside the repository, with its tab opened', async () => {
    const refusal = 'The GitHub App cannot reach that repository. Add the repository to the app’s installation on GitHub.';
    api.saveSettings.mockRejectedValue(new SettingsProblems({ githubRepository: refusal }));
    show({ mode: 'github-app', stored: 'acme/gone', variant: 'settings' });
    await screen.findByRole('combobox', { name: 'Repository' });
    await userEvent.click(screen.getByRole('tab', { name: 'Hexis takes care of it' }));
    await userEvent.click(screen.getByRole('tab', { name: 'GitHub' }));
    await save();
    expect(await screen.findByText(refusal)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox', { name: 'Repository' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps showing a stored repository the installation no longer reaches, so it is not replaced unseen', async () => {
    show({ mode: 'github-app', stored: 'acme/gone', variant: 'settings' });
    const picker = (await screen.findByRole('combobox', { name: 'Repository' })) as HTMLSelectElement;
    await waitFor(() => expect(picker).toBeEnabled());
    expect(picker.value).toBe('acme/gone');
    expect(Array.from(picker.options).map((o) => o.value)).toEqual(['', 'acme/gone', 'acme/kb', 'acme/website']);
  });

  it('says so when the repositories cannot be listed', async () => {
    api.fetchGitHubRepositories.mockRejectedValue(new Error('GitHub could not be reached. Try again shortly.'));
    show();
    await openGitHub();
    expect(await screen.findByText('GitHub could not be reached. Try again shortly.')).toBeInTheDocument();
  });
});

describe('coming back from GitHub', () => {
  it('opens on the GitHub tab, says what came of it, and takes it off the address', async () => {
    api.fetchGitHubApp.mockResolvedValue(INSTALLED);
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    try {
      standAt('?github=connected');
      show();
      expect(screen.getByRole('tab', { name: 'GitHub' })).toHaveAttribute('aria-selected', 'true');
      expect(await screen.findByText('GitHub is connected. Choose the repository below.')).toBeInTheDocument();
      expect(replace).toHaveBeenCalledWith({}, '', '/');
    } finally {
      replace.mockRestore();
    }
  });

  it.each([
    ['not-yours', /not one your GitHub account can reach/],
    ['nothing-to-write', /no repository your own GitHub account can write to/],
    ['requested', /asked an owner of the organisation/],
    ['unreachable', /could not be reached/],
    ['something-new', /did not complete the connection/],
  ])('says what %s means', async (outcome, said) => {
    const replace = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    try {
      standAt(`?github=${outcome}`);
      show();
      expect(await screen.findByText(said)).toBeInTheDocument();
    } finally {
      replace.mockRestore();
    }
  });

  it('opens where it always does on a deployment that does not offer GitHub', () => {
    standAt('?github=connected');
    show({ modes: ['managed', 'token'] });
    expect(screen.getByRole('tab', { name: 'Hexis takes care of it' })).toHaveAttribute('aria-selected', 'true');
  });
});
