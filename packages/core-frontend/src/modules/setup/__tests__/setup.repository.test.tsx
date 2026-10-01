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
import { RepositoryChangeNeedsConfirmation, SettingsProblems, type GitMode, type RepositoryStatus, type SettingStatus } from '../services/setup.api';

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
/** A deployment on `mode`, which has chosen `chosen`: the same way, unless a move is pending. */
const offering = (mode: GitMode | null, chosen: GitMode | null = mode, pinned?: string): RepositoryStatus => ({
  mode,
  chosen,
  ...(pinned ? { pinned } : {}),
  modes: MODES,
});

function show(
  opts: {
    mode?: GitMode | null;
    chosen?: GitMode | null;
    pinned?: string;
    configured?: boolean;
    variant?: 'setup' | 'settings';
    tabs?: boolean;
  } = {},
) {
  const configured = opts.configured ?? false;
  const mode = opts.mode === undefined ? (configured ? 'token' : null) : opts.mode;
  return render(
    <SetupScreen
      settings={settingsOf(configured)}
      onSaved={() => {}}
      variant={opts.variant ?? 'setup'}
      {...(opts.tabs === false ? {} : { repository: offering(mode, opts.chosen === undefined ? mode : opts.chosen, opts.pinned) })}
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

  /** The server's refusal of a save that moves, until the admin has answered. */
  const asksFirst = (openChangeRequests = 0, to: GitMode = 'managed') =>
    api.saveSettings.mockImplementation(async (_settings: unknown, confirm?: string) => {
      if (!confirm) throw new RepositoryChangeNeedsConfirmation(openChangeRequests, 'token', to);
      return {
        ...saved(to, true),
        repositoryChange: { choice: confirm, closedChangeRequests: confirm === 'close' ? openChangeRequests : 0 },
      };
    });
  const question = () => screen.findByTestId('repository-change-confirm');
  const confirmMove = () => userEvent.click(screen.getByRole('button', { name: 'Move the deployment' }));

  /**
   * The tab is the choice, and the tab is a screen above the button. An
   * admin who opens another way to read about it, changes a sign-in field
   * and saves must not have moved the deployment to an empty repository.
   * The server refuses that save, and the screen puts the question.
   */
  it('does not move on a save the admin was not asked about', async () => {
    asksFirst();
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await userEvent.type(screen.getByLabelText('Knowledge folder', { exact: false }), 'Docs');
    await save();

    // Asked at the button, naming what is left and what is moved to.
    const asked = await question();
    expect(asked).toHaveTextContent('Move this deployment from “Address and token” to “Managed for you”?');
    expect(asked).toHaveTextContent('Nothing is deleted');
    expect(asked).toHaveTextContent('with no restart');
    // One refused attempt, and the save button waits for the answer.
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeDisabled();
  });

  it('sends the move once the admin has said yes, and nothing of the repository it leaves', async () => {
    asksFirst();
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await save();
    await question();
    await confirmMove();
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ gitMode: 'managed' }, 'keep', 0));
    expect(api.testConnection).not.toHaveBeenCalled();
    // Moved on the save: said so, with no restart owed.
    expect(await screen.findByTestId('repository-changed')).toHaveTextContent('now works on the new repository');
  });

  it('asks again for another move: a yes to one is not a yes to the next', async () => {
    asksFirst();
    render(
      <SetupScreen
        settings={settingsOf(true)}
        onSaved={() => {}}
        variant="settings"
        repository={{ mode: 'token', chosen: 'token', modes: ['managed', 'github-app', 'token'] }}
      />,
    );
    await userEvent.click(tab('Managed for you'));
    await save();
    await question();
    await confirmMove();
    await screen.findByTestId('repository-changed');
    expect(api.saveSettings).toHaveBeenCalledTimes(2);

    // Another move, after a yes: its save carries no answer, and is asked.
    await userEvent.click(tab('Address and token'));
    await save();
    await question();
    expect(api.saveSettings).toHaveBeenCalledTimes(3);
    expect(api.saveSettings.mock.calls[2]).toHaveLength(1);
  });

  it('takes the question down when another tab is opened: it was about another move', async () => {
    asksFirst();
    render(
      <SetupScreen
        settings={settingsOf(true)}
        onSaved={() => {}}
        variant="settings"
        repository={{ mode: 'token', chosen: 'token', modes: ['managed', 'github-app', 'token'] }}
      />,
    );
    await userEvent.click(tab('Managed for you'));
    await save();
    await question();
    await userEvent.click(tab('GitHub'));
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('closes the open change requests when the admin picks that, and says so', async () => {
    asksFirst(2);
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await save();
    await question();
    await userEvent.click(screen.getByRole('radio', { name: /Close them as/ }));
    await confirmMove();
    await waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith({ gitMode: 'managed' }, 'close', 2));
    expect(await screen.findByTestId('repository-changed')).toHaveTextContent(
      '2 change requests were closed as “repository replaced”.',
    );
  });

  it('asks again when the count of open change requests changed while the question stood', async () => {
    let open = 0;
    api.saveSettings.mockImplementation(async (_settings: unknown, confirm?: string, seen?: number) => {
      if (!confirm || seen !== open) throw new RepositoryChangeNeedsConfirmation(open, 'token', 'managed');
      return { ...saved('managed', true), repositoryChange: { choice: confirm, closedChangeRequests: 0 } };
    });
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await save();
    await question();
    expect(screen.queryAllByRole('radio')).toEqual([]);

    // A request is opened before the admin answers.
    open = 1;
    await confirmMove();
    await waitFor(() => expect(screen.getByTestId('repository-change-confirm')).toHaveTextContent('There is 1 open change request.'));
    expect(screen.queryByTestId('repository-changed')).toBeNull();
  });

  it('cancelling leaves the deployment where it is', async () => {
    asksFirst(2);
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await save();
    expect(await question()).toHaveTextContent('There are 2 open change requests.');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
  });

  it('asks nothing of a save that stays where the deployment is', async () => {
    api.saveSettings.mockResolvedValue(saved('token', true));
    show({ configured: true, variant: 'settings' });
    await userEvent.click(tab('Managed for you'));
    await userEvent.click(tab('Address and token'));
    await userEvent.type(screen.getByLabelText('Knowledge folder', { exact: false }), 'Docs');
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ knowledgeBaseDir: 'Docs' }));
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
  });

  it('asks nothing on a deployment that has no repository to leave', async () => {
    api.saveSettings.mockResolvedValue(saved('managed', false));
    show();
    await userEvent.click(tab('Address and token'));
    expect(screen.queryByTestId('moves-repository')).toBeNull();
    await userEvent.click(tab('Managed for you'));
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'managed' }));
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
  });
});

/**
 * A confirmed move takes effect on its save, so this state is not one a move
 * leaves behind any more. It is still one a server can report (a way chosen
 * that it has not put in effect), and the screen must read it truthfully.
 */
describe('SetupScreen: a way chosen that is not in effect yet', () => {
  it('opens on the way chosen, and says the deployment is still on the one it has', () => {
    show({ configured: true, mode: 'token', chosen: 'managed', variant: 'settings' });
    expect(tab('Managed for you')).toHaveAttribute('aria-selected', 'true');
    const pending = screen.getByTestId('move-pending');
    expect(pending).toHaveTextContent('A restart is pending');
    expect(pending).toHaveTextContent('still working on “Address and token”');
    // The move was made: it is not offered again, and not asked about again.
    expect(screen.queryByTestId('moves-repository')).toBeNull();
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
  });

  it('does not send the move a second time with a save about something else', async () => {
    api.saveSettings.mockResolvedValue({ ...saved('token', true), restartRequired: true, repository: offering('token', 'managed') });
    show({ configured: true, mode: 'token', chosen: 'managed', variant: 'settings' });
    await userEvent.type(screen.getByLabelText('Knowledge folder', { exact: false }), 'Docs');
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ knowledgeBaseDir: 'Docs' }));
  });

  it('takes the move back by saving on the way in effect, without being asked', async () => {
    api.saveSettings.mockResolvedValue(saved('token', true));
    show({ configured: true, mode: 'token', chosen: 'managed', variant: 'settings' });
    await userEvent.click(tab('Address and token'));
    expect(screen.getByTestId('move-taken-back')).toHaveTextContent('Saving takes the move back');
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
    await save();
    await waitFor(() => expect(api.saveSettings).toHaveBeenCalledWith({ gitMode: 'token' }));
  });

  it('reads a server that does not tell the two apart as one that has no move pending', () => {
    render(<SetupScreen settings={settingsOf(true)} onSaved={() => {}} variant="settings" repository={{ mode: 'token', modes: MODES }} />);
    expect(tab('Address and token')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('move-pending')).toBeNull();
  });
});

describe('SetupScreen: a way chosen by the environment', () => {
  it('shows the other ways as not the screen to choose, and says which variable chose', async () => {
    show({ mode: 'managed', pinned: 'GIT_MODE', variant: 'settings' });
    expect(tab('Managed for you')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Managed for you')).toBeEnabled();
    expect(tab('Address and token')).toBeDisabled();
    expect(screen.getByTestId('repository-pinned')).toHaveTextContent('Set by the GIT_MODE environment variable');
    await userEvent.click(tab('Address and token'));
    expect(tab('Managed for you')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('repository-change-confirm')).toBeNull();
  });

  it('says nothing of the kind when the admin chose', () => {
    show({ mode: 'managed', variant: 'settings' });
    expect(tab('Address and token')).toBeEnabled();
    expect(screen.queryByTestId('repository-pinned')).toBeNull();
  });
});
