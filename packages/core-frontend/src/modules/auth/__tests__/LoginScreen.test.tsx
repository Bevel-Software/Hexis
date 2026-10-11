import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginScreen } from '../components/LoginScreen';
import { AuthContext, type AuthContextValue } from '../state/auth.context';
import { AppRegistryContext, makeRegistry, type AppRegistry } from '../../../core/registry';
import { fetchLoginProviders, startSsoLogin } from '../services/sso';

vi.mock('../services/sso', () => ({
  fetchLoginProviders: vi.fn(),
  startSsoLogin: vi.fn(),
  OAUTH_ERROR_KEY: 'bevel_oauth_error',
}));

const login = vi.fn(async () => {});

function renderScreen(registry?: Partial<AppRegistry>) {
  const value: AuthContextValue = {
    user: null,
    token: null,
    isLoading: false,
    login,
    logout: vi.fn(),
  };
  return render(
    <AppRegistryContext.Provider value={makeRegistry(registry ?? {})}>
      <AuthContext.Provider value={value}>
        <LoginScreen />
      </AuthContext.Provider>
    </AppRegistryContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchLoginProviders).mockReset();
  vi.mocked(startSsoLogin).mockReset();
  login.mockClear();
});

describe('LoginScreen', () => {
  it('lists the links a deployment names under the sign-in card, and none when it names none', async () => {
    vi.mocked(fetchLoginProviders).mockResolvedValue({ password: true, sso: [] });
    const { unmount } = renderScreen({
      loginLinks: [
        { label: 'Impressum', href: '/impressum' },
        { label: 'Privacy', href: '/privacy' },
      ],
    });
    const nav = screen.getByRole('navigation', { name: 'Legal' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Impressum' })).toHaveAttribute('href', '/impressum');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    // Outside the form: they are not part of signing in.
    expect(nav.closest('form')).toBeNull();
    unmount();
    // Absent and empty both mean none: no empty landmark under the card.
    for (const registry of [{}, { loginLinks: [] }]) {
      const { unmount: unmountNone } = renderScreen(registry);
      expect(screen.queryByRole('navigation', { name: 'Legal' })).toBeNull();
      unmountNone();
    }
  });

  it('renders the password form and one button per advertised SSO provider', async () => {
    vi.mocked(fetchLoginProviders).mockResolvedValue({
      password: true,
      sso: [
        { key: 'oidc', label: 'Sign in with Okta', startPath: '/api/auth/oidc/login' },
        { key: 'microsoft', label: 'Sign in with Microsoft', startPath: '/api/auth/microsoft/login' },
      ],
    });
    renderScreen();
    expect(screen.getByLabelText(/Email/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Password$/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in with Okta' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument();
  });

  it('starts the provider flow when its button is clicked', async () => {
    const provider = { key: 'oidc', label: 'Sign in with Okta', startPath: '/api/auth/oidc/login' };
    vi.mocked(fetchLoginProviders).mockResolvedValue({ password: true, sso: [provider] });
    renderScreen();
    await waitFor(() => screen.getByRole('button', { name: 'Sign in with Okta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sign in with Okta' }));
    expect(startSsoLogin).toHaveBeenCalledWith(provider);
  });

  it('hides the password form when the probe disables it', async () => {
    vi.mocked(fetchLoginProviders).mockResolvedValue({
      password: false,
      sso: [{ key: 'oidc', label: 'Single sign-on', startPath: '/api/auth/oidc/login' }],
    });
    renderScreen();
    await waitFor(() => screen.getByRole('button', { name: 'Single sign-on' }));
    expect(screen.queryByLabelText(/Email/)).not.toBeInTheDocument();
  });

  it('submits email + password through the auth context', async () => {
    vi.mocked(fetchLoginProviders).mockResolvedValue({ password: true, sso: [] });
    renderScreen();
    await userEvent.type(screen.getByLabelText(/Email/), 'alice@example.com');
    await userEvent.type(screen.getByLabelText(/^Password$/), 'alices-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledWith('alice@example.com', 'alices-password');
  });
});
