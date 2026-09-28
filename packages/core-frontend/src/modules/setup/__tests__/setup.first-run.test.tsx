import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
import type { SettingStatus } from '../services/setup.api';

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
