import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  fetchSetupStatus: vi.fn(),
  saveSettings: vi.fn(),
  testConnection: vi.fn(),
  testOidc: vi.fn(),
  syncNow: vi.fn(),
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
import { SettingsProblems, type GitMode, type RepositoryStatus, type SettingStatus } from '../services/setup.api';

const KB = 'knowledge-base' as const;
const setting = (key: string, extra: Partial<SettingStatus> = {}): SettingStatus => ({
  key,
  section: KB,
  source: 'unset',
  value: '',
  configured: false,
  secret: false,
  restartToApply: false,
  ...extra,
});

/** A deployment's settings: nothing answered, or an address and a token stored. */
const settingsOf = (configured: boolean): SettingStatus[] => [
  setting('gitMode', { envVar: 'GIT_MODE', restartToApply: true }),
  setting('kbRepoUrl', configured ? { source: 'stored', configured: true, value: 'https://git.example.com/acme/kb.git' } : {}),
  setting('gitToken', { secret: true, value: undefined, ...(configured ? { source: 'stored', configured: true } : {}) }),
  setting('gitUsername'),
  setting('knowledgeBaseDir', { restartToApply: true }),
  setting('defaultBranch', configured ? { source: 'stored', configured: true, value: 'main' } : {}),
  setting('protectedBranches', configured ? { source: 'stored', configured: true, value: 'main' } : {}),
];

const MODES: GitMode[] = ['managed', 'token'];
const offering = (mode: GitMode | null): RepositoryStatus => ({ mode, modes: MODES });

function show(opts: { mode?: GitMode | null; configured?: boolean; variant?: 'setup' | 'settings'; tabs?: boolean } = {}) {
  const configured = opts.configured ?? false;
  render(
    <SetupScreen
      settings={settingsOf(configured)}
      onSaved={() => {}}
      variant={opts.variant ?? 'setup'}
      {...(opts.tabs === false ? {} : { repository: offering(opts.mode === undefined ? (configured ? 'token' : null) : opts.mode) })}
    />,
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });
const address = () => screen.queryByLabelText('Repository address', { exact: false });
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
const saved = (mode: GitMode | null, configured: boolean) => ({
  restartRequired: false,
  complete: true,
  settings: settingsOf(configured),
  repository: offering(mode),
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn(), origin: 'https://example.test' },
  });
});

describe('SetupScreen: the ways of having a repository', () => {
  it('offers them as tabs, in the order the deployment gives', () => {
    show();
    const tabs = within(screen.getByRole('tablist', { name: 'Where the repository is' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Managed for you', 'Address and token']);
  });

  it('opens a new deployment on the first: the repository it keeps itself', () => {
    show();
    expect(tab('Managed for you')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('managed-repository')).toHaveTextContent('There is nothing to connect and nothing to enter');
    // Nothing to type, nothing to test.
    expect(address()).toBeNull();
    expect(screen.queryByLabelText('Access token', { exact: false })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull();
  });

  it('opens a configured deployment on the way it has, as it was', () => {
    show({ configured: true, variant: 'settings' });
    expect(tab('Address and token')).toHaveAttribute('aria-selected', 'true');
    expect(address()).toHaveValue('https://git.example.com/acme/kb.git');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
    expect(screen.queryByTestId('moves-repository')).toBeNull();
  });

  it('gives each tab a panel of its own', async () => {
    show();
    for (const name of ['Managed for you', 'Address and token']) {
      await userEvent.click(tab(name));
      const panel = document.getElementById(tab(name).getAttribute('aria-controls')!);
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', tab(name).id);
    }
    expect(within(document.getElementById('repository-panel-token')!).getByLabelText('Repository address', { exact: false })).toBeInTheDocument();
  });

  it('keeps what belongs to every repository under whichever tab is open', async () => {
    show();
    expect(screen.getByLabelText('Knowledge folder', { exact: false })).toBeInTheDocument();
    await userEvent.click(tab('Address and token'));
    expect(screen.getByLabelText('Knowledge folder', { exact: false })).toBeInTheDocument();
  });

  it('draws the one way there was, with no tabs, for a server that knows no other', () => {
    show({ tabs: false });
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(address()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeInTheDocument();
  });
});

describe('SetupScreen: saving a repository the deployment keeps', () => {
  it('finishes setup on the choice alone, without asking any host anything', async () => {
    api.saveSettings.mockResolvedValue(saved('managed', false));
    show();
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'managed' }));
    expect(api.testConnection).not.toHaveBeenCalled();
  });

  it('does not store an address and a token that were typed on a tab that was then left', async () => {
    api.saveSettings.mockResolvedValue(saved('managed', false));
    show();
    await userEvent.click(tab('Address and token'));
    await userEvent.type(address()!, 'https://git.example.com/acme/kb.git');
    await userEvent.type(screen.getByLabelText('Access token', { exact: false }), 'a-token');
    await userEvent.click(tab('Managed for you'));
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'managed' }));
    expect(api.testConnection).not.toHaveBeenCalled();
  });

  it('is not held back by a connection test that failed on the other tab', async () => {
    api.testConnection.mockResolvedValue({ ok: false, outcome: 'rejected', error: 'The host turned that token down.' });
    api.saveSettings.mockResolvedValue(saved('managed', false));
    show();
    await userEvent.click(tab('Address and token'));
    await userEvent.type(address()!, 'https://git.example.com/acme/kb.git');
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByText('The host turned that token down.');
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();

    await userEvent.click(tab('Managed for you'));
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
  });

  it('says out loud why the choice was refused, since no field holds it', async () => {
    api.saveSettings.mockRejectedValue(
      new SettingsProblems({ gitMode: 'The repository could not be created on this deployment’s storage.' }),
    );
    show();
    await save();
    expect(await screen.findByText(/could not be created on this deployment/)).toBeInTheDocument();
  });
});

describe('SetupScreen: saving a repository reached by its address', () => {
  it('sends the way along with the address and the token on a deployment that has none', async () => {
    api.testConnection.mockResolvedValue({ ok: true, outcome: 'connected', branches: ['main'], defaultBranch: 'main' });
    api.saveSettings.mockResolvedValue(saved('token', true));
    show();
    await userEvent.click(tab('Address and token'));
    await userEvent.type(address()!, 'https://git.example.com/acme/kb.git');
    await userEvent.type(screen.getByLabelText('Access token', { exact: false }), 'a-token');
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalled());
    expect(api.saveSettings.mock.calls[0]![0]).toMatchObject({
      gitMode: 'token',
      kbRepoUrl: 'https://git.example.com/acme/kb.git',
      gitToken: 'a-token',
    });
    // Proven before it was stored, as ever.
    expect(api.testConnection).toHaveBeenCalled();
  });

  it('says nothing about the way on a deployment that stays on the one it has', async () => {
    api.saveSettings.mockResolvedValue(saved('token', true));
    show({ configured: true, variant: 'settings' });
    await userEvent.type(screen.getByLabelText('Knowledge folder', { exact: false }), 'Docs');
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ knowledgeBaseDir: 'Docs' }));
  });

  it('opens the tab a refused address or token is on', async () => {
    api.saveSettings.mockRejectedValue(new SettingsProblems({ gitToken: 'The host turned that token down.' }));
    show({ configured: true, mode: 'managed', variant: 'settings' });
    expect(tab('Managed for you')).toHaveAttribute('aria-selected', 'true');
    await save();
    expect(await screen.findByText('The host turned that token down.')).toBeInTheDocument();
    expect(tab('Address and token')).toHaveAttribute('aria-selected', 'true');
  });
});

describe('SetupScreen: moving a deployment to another repository', () => {
  it('says what saving will do, before it is pressed', async () => {
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    const warning = screen.getByTestId('moves-repository');
    expect(warning).toHaveTextContent('moves this deployment to another repository');
    expect(warning).toHaveTextContent('Nothing is deleted');
    // Going back is staying: nothing to warn about.
    await userEvent.click(tab('Address and token'));
    expect(screen.queryByTestId('moves-repository')).toBeNull();
  });

  it('sends the move, and nothing of the repository it leaves', async () => {
    api.saveSettings.mockResolvedValue({ ...saved('managed', true), restartRequired: true });
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'managed' }));
    expect(api.testConnection).not.toHaveBeenCalled();
  });

  it('warns nobody on a deployment that has no repository to leave', async () => {
    show();
    await userEvent.click(tab('Address and token'));
    expect(screen.queryByTestId('moves-repository')).toBeNull();
  });
});
