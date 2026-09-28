import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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

import { AppRegistryContext, makeRegistry, type AppRegistry, type SignInOptionPanelProps } from '../../../core/registry';
import { SetupScreen } from '../components/SetupScreen';
import { SettingsProblems, type SettingStatus } from '../services/setup.api';

const setting = (key: string, section: SettingStatus['section'], extra: Partial<SettingStatus> = {}): SettingStatus => ({
  key,
  section,
  source: 'unset',
  value: '',
  configured: false,
  secret: false,
  restartToApply: false,
  ...extra,
});

const settingsWith = (configured: boolean): SettingStatus[] => [
  setting('kbRepoUrl', 'knowledge-base'),
  setting('gitToken', 'knowledge-base', { secret: true, value: undefined }),
  setting('oidcIssuerUrl', 'sign-in', { configured, value: configured ? 'https://login.example.com' : '' }),
  setting('oidcClientId', 'sign-in', { configured, value: configured ? 'app' : '' }),
  setting('oidcClientSecret', 'sign-in', { configured, secret: true, value: undefined }),
  setting('allowedEmailDomains', 'sign-in'),
  setting('auditRetentionDays', 'audit'),
];

function ManagedPanel({ variant, ownProviderConfigured }: SignInOptionPanelProps) {
  return (
    <p data-testid="managed-panel">
      managed sign-in on {variant}, own provider {ownProviderConfigured ? 'configured' : 'absent'}
    </p>
  );
}

const hosted = makeRegistry({ signInOption: { label: 'Google and Microsoft', Panel: ManagedPanel } });

function renderScreen(opts: { variant?: 'setup' | 'settings'; configured?: boolean; registry?: AppRegistry } = {}) {
  const screenEl = (
    <SetupScreen settings={settingsWith(opts.configured ?? false)} onSaved={() => {}} variant={opts.variant ?? 'setup'} />
  );
  render(
    opts.registry ? <AppRegistryContext.Provider value={opts.registry}>{screenEl}</AppRegistryContext.Provider> : screenEl,
  );
}

const providerAddress = () => screen.queryByLabelText('Provider address', { exact: false });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

describe('SetupScreen: what the first run asks', () => {
  it('asks for the repository and for sign-in, and nothing else', () => {
    renderScreen();
    const titles = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(titles).toEqual(['Knowledge, skills & tools', 'Single sign-on']);
  });

  it('keeps every section on the Deployment page', async () => {
    renderScreen({ variant: 'settings' });
    expect(screen.getByRole('heading', { name: 'Audit log' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Marketplace' })).toBeInTheDocument();
  });
});

describe('SetupScreen: a sign-in the distribution runs', () => {
  it('shows no tabs, and the provider form as ever, when the distribution runs none', () => {
    renderScreen();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(providerAddress()).toBeInTheDocument();
  });

  it('opens on the tab of the distribution, with the provider form out of the way', () => {
    renderScreen({ registry: hosted });
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Google and Microsoft', 'Your own provider']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('managed-panel')).toHaveTextContent('managed sign-in on setup, own provider absent');
    expect(providerAddress()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test sign-in configuration' })).toBeNull();
  });

  it('shows the provider form on the second tab, and keeps what was typed across a switch', async () => {
    renderScreen({ registry: hosted });
    await userEvent.click(screen.getByRole('tab', { name: 'Your own provider' }));
    expect(screen.queryByTestId('managed-panel')).toBeNull();
    await userEvent.type(providerAddress()!, 'https://login.example.com');

    await userEvent.click(screen.getByRole('tab', { name: 'Google and Microsoft' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Your own provider' }));
    expect(providerAddress()).toHaveValue('https://login.example.com');
  });

  it('opens on the own provider of the deployment once it has one', () => {
    renderScreen({ registry: hosted, configured: true, variant: 'settings' });
    expect(screen.getByRole('tab', { name: 'Your own provider' })).toHaveAttribute('aria-selected', 'true');
    expect(providerAddress()).toBeInTheDocument();
  });

  it('tells the panel where it stands', async () => {
    renderScreen({ registry: hosted, configured: true, variant: 'settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'Google and Microsoft' }));
    expect(screen.getByTestId('managed-panel')).toHaveTextContent('managed sign-in on settings, own provider configured');
  });

  it('uses the name the distribution gives the second tab', () => {
    renderScreen({
      registry: makeRegistry({
        signInOption: { label: 'Google and Microsoft', ownProviderLabel: 'Your identity provider', Panel: ManagedPanel },
      }),
    });
    expect(screen.getByRole('tab', { name: 'Your identity provider' })).toBeInTheDocument();
  });

  /**
   * The panel is the distribution's code, on the screen a deployment cannot
   * be set up without. Its fault costs its own tab: the repository fields,
   * the other tab and the button that finishes setup all stand.
   */
  it('keeps the form when the panel throws, and says so in its place', async () => {
    function BrokenPanel(): never {
      throw new Error('the distribution has a bug');
    }
    // React and the boundary both report the caught error; neither belongs in the run's output.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderScreen({ registry: makeRegistry({ signInOption: { label: 'Google and Microsoft', Panel: BrokenPanel } }) });
      expect(screen.getByRole('alert')).toHaveTextContent(/sign-in panel couldn.t be shown/);
      expect(screen.getByRole('button', { name: 'Save and continue' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('tab', { name: 'Your own provider' }));
      expect(providerAddress()).toBeInTheDocument();
      expect(quiet).toHaveBeenCalled();
    } finally {
      quiet.mockRestore();
    }
  });
});

/**
 * A refused save names the fields that were wrong. Every one of those
 * messages has to reach the reader, wherever its field is: a save that
 * failed must never look like a save that did nothing.
 */
describe('SetupScreen: where a refused save says so', () => {
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

  it('opens the tab a problem is on, and shows it beside its field', async () => {
    api.saveSettings.mockRejectedValue(new SettingsProblems({ oidcClientSecret: 'The provider rejected the application secret.' }));
    renderScreen({ registry: hosted, variant: 'settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'Your own provider' }));
    await userEvent.type(providerAddress()!, 'https://login.example.com');
    await userEvent.click(screen.getByRole('tab', { name: 'Google and Microsoft' }));
    expect(providerAddress()).toBeNull();

    await save();
    expect(await screen.findByText('The provider rejected the application secret.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Your own provider' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Application secret', { exact: false })).toHaveAttribute('aria-invalid', 'true');
  });

  it('leaves the reader on their tab when the problem is somewhere else', async () => {
    api.saveSettings.mockRejectedValue(new SettingsProblems({ kbRepoUrl: 'The URL must start with https://' }));
    renderScreen({ registry: hosted, variant: 'settings' });
    await userEvent.type(screen.getByLabelText('Repository address', { exact: false }), 'git@example.com:kb.git');
    await save();
    expect(await screen.findByText('The URL must start with https://')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Google and Microsoft' })).toHaveAttribute('aria-selected', 'true');
  });

  it('says a problem out loud when its field has no place on this screen', async () => {
    // The first run does not show the Audit log section, and a field the
    // environment supplies is not the form's to show anywhere.
    api.saveSettings.mockRejectedValue(
      new SettingsProblems({ auditRetentionDays: 'Enter a number of days.', gitUsername: 'The token username was refused.' }),
    );
    api.testConnection.mockResolvedValue({ ok: true, outcome: 'read-write', branches: ['main'], defaultBranch: 'main' });
    render(
      <SetupScreen
        settings={[...settingsWith(false), setting('gitUsername', 'knowledge-base', { source: 'env', envVar: 'GIT_USERNAME' })]}
        onSaved={() => {}}
        variant="setup"
      />,
    );
    await userEvent.type(screen.getByLabelText('Repository address', { exact: false }), 'https://example.com/kb.git');
    await save();
    const said = await screen.findByText(/Enter a number of days\./);
    expect(said).toHaveTextContent('The token username was refused.');
  });
});

describe('SetupScreen: the form around the distribution panel', () => {
  function PanelWithFields() {
    return (
      <div>
        <input aria-label="Invite by email" />
        <textarea aria-label="A note" />
      </div>
    );
  }
  const withFields = makeRegistry({ signInOption: { label: 'Google and Microsoft', Panel: PanelWithFields } });

  /**
   * Asserted on the key itself, whose default action IS the submission: a
   * browser submits through the form's button wherever that button sits,
   * and the test environment only through one inside the form, which this
   * form's is not. `fireEvent` answers false when the default was prevented.
   */
  const enterIsLeftToTheForm = (field: HTMLElement) => fireEvent.keyDown(field, { key: 'Enter' });

  it('is not submitted by Enter in one of the panel inputs', () => {
    renderScreen({ registry: withFields, variant: 'settings' });
    expect(enterIsLeftToTheForm(screen.getByLabelText('Invite by email'))).toBe(false);
  });

  it('leaves the panel its other keys, and a text area its new line', async () => {
    renderScreen({ registry: withFields, variant: 'settings' });
    expect(fireEvent.keyDown(screen.getByLabelText('Invite by email'), { key: 'a' })).toBe(true);
    expect(enterIsLeftToTheForm(screen.getByLabelText('A note'))).toBe(true);
    await userEvent.type(screen.getByLabelText('A note'), 'one{Enter}two');
    expect(screen.getByLabelText('A note')).toHaveValue('one\ntwo');
  });

  it('is still submitted by Enter in one of its own fields', async () => {
    renderScreen({ registry: withFields, variant: 'settings' });
    await userEvent.click(screen.getByRole('tab', { name: 'Your own provider' }));
    expect(enterIsLeftToTheForm(providerAddress()!)).toBe(true);
    expect(enterIsLeftToTheForm(screen.getByLabelText('Repository address', { exact: false }))).toBe(true);
  });
});

describe('SetupScreen: what each tab names', () => {
  it.each([
    ['Google and Microsoft', 'managed-panel'],
    ['Your own provider', null],
  ])('gives the tab "%s" a panel of its own', async (name, marker) => {
    renderScreen({ registry: hosted });
    const tab = screen.getByRole('tab', { name });
    await userEvent.click(tab);
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', tab.getAttribute('aria-controls'));
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    if (marker) expect(within(panel).getByTestId(marker)).toBeInTheDocument();
    else {
      expect(within(panel).getByLabelText('Provider address', { exact: false })).toBeInTheDocument();
      expect(within(panel).getByText('Redirect URI:', { exact: false })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Test sign-in configuration' })).toBeInTheDocument();
    }
  });

  it('leaves the section as it was when there are no tabs', () => {
    renderScreen();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByText('Redirect URI:', { exact: false })).toBeInTheDocument();
  });
});
