import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

import { SetupGate } from '../components/SetupGate';
import { SetupScreen } from '../components/SetupScreen';
import { SettingsProblems, type SettingStatus } from '../services/setup.api';

const SIGN_IN = 'sign-in' as const;
const setting = (key: string, envVar: string, extra: Partial<SettingStatus> = {}): SettingStatus => ({
  key,
  envVar,
  section: SIGN_IN,
  source: 'unset',
  value: '',
  configured: false,
  secret: false,
  restartToApply: true,
  ...extra,
});
const SETTINGS: SettingStatus[] = [
  setting('oidcIssuerUrl', 'OIDC_ISSUER_URL'),
  setting('oidcClientId', 'OIDC_CLIENT_ID'),
  setting('oidcClientSecret', 'OIDC_CLIENT_SECRET', { secret: true, value: undefined }),
  setting('oidcScopes', 'OIDC_SCOPES'),
  setting('allowedEmailDomains', 'ALLOWED_EMAIL_DOMAINS'),
];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

const field = (label: string) => screen.getByLabelText(label, { exact: false });

describe('SetupScreen — single sign-on check', () => {
  it('tests the typed provider values, and only those', async () => {
    api.testOidc.mockResolvedValue({ ok: true, outcome: 'verified', oidcVerification: 'unverified' });
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="not-configured" />);
    await userEvent.type(field('Provider address'), 'https://login.example.com');
    await userEvent.type(field('Application ID'), 'app');
    await userEvent.type(field('Application secret'), 'shh');
    await userEvent.type(field('Allowed email domains'), 'example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Test sign-in configuration' }));
    expect(await screen.findByText(/Verified\. The provider accepted/)).toBeInTheDocument();
    expect(api.testOidc).toHaveBeenCalledWith({
      oidcIssuerUrl: 'https://login.example.com',
      oidcClientId: 'app',
      oidcClientSecret: 'shh',
    });
  });

  it.each([
    [{ ok: false, outcome: 'rejected', field: 'oidcIssuerUrl', error: 'That address is not a single sign-on provider.' }, 'That address is not a single sign-on provider.'],
    [{ ok: false, outcome: 'rejected', field: 'oidcClientSecret', error: 'The provider rejected the application ID or secret.' }, 'The provider rejected the application ID or secret.'],
    [{ ok: false, outcome: 'unverified', error: 'could not be verified (server_error)' }, 'could not be verified (server_error)'],
    [{ ok: true, outcome: 'issuer-verified' }, /is a sign-in provider/],
  ])('reports %j', async (result, text) => {
    api.testOidc.mockResolvedValue(result);
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" />);
    await userEvent.click(screen.getByRole('button', { name: 'Test sign-in configuration' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('clears the result when a provider field is edited, but not for the domains', async () => {
    api.testOidc.mockResolvedValue({ ok: true, outcome: 'verified' });
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" />);
    await userEvent.click(screen.getByRole('button', { name: 'Test sign-in configuration' }));
    await screen.findByText(/Verified\. The provider accepted/);
    await userEvent.type(field('Allowed email domains'), 'x');
    expect(screen.getByText(/Verified\. The provider accepted/)).toBeInTheDocument();
    await userEvent.type(field('Application ID'), 'x');
    expect(screen.queryByText(/Verified\. The provider accepted/)).not.toBeInTheDocument();
  });

  it('shows a save refused by the provider against the secret field', async () => {
    api.saveSettings.mockRejectedValue(
      new SettingsProblems({ oidcClientSecret: 'The provider rejected the application ID or secret.' }),
    );
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" />);
    await userEvent.type(field('Application secret'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    const problem = await screen.findByText('The provider rejected the application ID or secret.');
    expect(problem).toHaveAttribute('id', 'oidcClientSecret-problem');
  });

  it('labels the configuration with what the save answered', async () => {
    api.saveSettings.mockResolvedValue({
      restartRequired: true,
      complete: true,
      settings: SETTINGS,
      oidcVerification: 'verified',
    });
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="unverified" />);
    expect(screen.getByTestId('oidc-verification')).toHaveTextContent('Unverified — sign in once to confirm');
    await userEvent.type(field('Application secret'), 'new');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(screen.getByTestId('oidc-verification')).toHaveTextContent('Verified'));
  });

  it('a host refresh supersedes a test answer for good, even one back to the value it replaced', async () => {
    api.testOidc.mockResolvedValue({ ok: true, outcome: 'verified', oidcVerification: 'verified' });
    const view = render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="unverified" />);
    await userEvent.click(screen.getByRole('button', { name: 'Test sign-in configuration' }));
    await waitFor(() => expect(screen.getByTestId('oidc-verification')).toHaveTextContent(/^Verified$/));
    view.rerender(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="verified" />);
    // A new secret saved since reads as unverified again: the old answer must not come back.
    view.rerender(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="unverified" />);
    expect(screen.getByTestId('oidc-verification')).toHaveTextContent('Unverified — sign in once to confirm');
  });

  it('editing a provider field drops a test answer about the old values', async () => {
    api.testOidc.mockResolvedValue({ ok: true, outcome: 'verified', oidcVerification: 'verified' });
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="unverified" />);
    await userEvent.click(screen.getByRole('button', { name: 'Test sign-in configuration' }));
    await waitFor(() => expect(screen.getByTestId('oidc-verification')).toHaveTextContent(/^Verified$/));
    await userEvent.type(field('Application secret'), 'x');
    expect(screen.getByTestId('oidc-verification')).toHaveTextContent('Unverified — sign in once to confirm');
  });

  it('cannot save while a sign-in check is running', async () => {
    let answer: (value: unknown) => void = () => {};
    api.testOidc.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<SetupScreen settings={SETTINGS} onSaved={() => {}} variant="settings" oidcVerification="unverified" />);
    await userEvent.type(field('Application secret'), 'new');
    await userEvent.click(screen.getByRole('button', { name: 'Test sign-in configuration' }));
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
    answer({ ok: true, outcome: 'verified', oidcVerification: 'unverified' });
    await waitFor(() => expect(screen.getByRole('button', { name: /Save/ })).toBeEnabled());
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('still shows the state and the test when every provider setting comes from the environment', () => {
    const fromEnv = SETTINGS.map((s) => ({ ...s, source: 'env' as const, configured: true }));
    render(<SetupScreen settings={fromEnv} onSaved={() => {}} variant="settings" oidcVerification="verified" />);
    expect(screen.getByTestId('oidc-verification')).toHaveTextContent('Verified');
    expect(screen.getByRole('button', { name: 'Test sign-in configuration' })).toBeInTheDocument();
  });

  it('the setup screen shows the state from the status', async () => {
    api.fetchSetupStatus.mockResolvedValue({
      complete: false,
      isAdmin: true,
      settings: SETTINGS,
      oidcVerification: 'not-configured',
    });
    render(<SetupGate>app</SetupGate>);
    expect(await screen.findByTestId('oidc-verification')).toHaveTextContent('Not configured');
  });
});
