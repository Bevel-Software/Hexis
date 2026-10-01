import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountPage } from '../components/AccountPage';
import { AuthContext, type AuthContextValue } from '../state/auth.context';
import type { AuthUser } from '@bevel-software/platform-shared';
import { changePassword } from '../services/account.api';

vi.mock('../services/account.api', () => ({
  changePassword: vi.fn(),
}));

function renderPage(user: Partial<AuthUser> = {}) {
  const value: AuthContextValue = {
    user: { id: 'u1', email: 'alice@example.com', name: 'Alice', ...user },
    token: 't',
    isLoading: false,
    login: vi.fn(async () => {}),
    logout: vi.fn(),
  };
  return render(
    <AuthContext.Provider value={value}>
      <AccountPage />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(changePassword).mockReset();
});

describe('AccountPage', () => {
  it('shows who is signed in', () => {
    renderPage();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('(alice@example.com)')).toBeInTheDocument();
  });

  it('refuses mismatched confirmation without calling the API', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/New password/), 'new-password-1');
    await userEvent.type(screen.getByLabelText(/Confirm new password/), 'different');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('do not match');
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('submits current + new password and reports success', async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined);
    renderPage();
    await userEvent.type(screen.getByLabelText(/Current password/), 'old-password');
    await userEvent.type(screen.getByLabelText(/New password/), 'new-password-1');
    await userEvent.type(screen.getByLabelText(/Confirm new password/), 'new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed.');
    expect(changePassword).toHaveBeenCalledWith('old-password', 'new-password-1');
  });

  it('omits the current password when left empty (SSO-only first set)', async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined);
    renderPage();
    await userEvent.type(screen.getByLabelText(/New password/), 'first-password');
    await userEvent.type(screen.getByLabelText(/Confirm new password/), 'first-password');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed.');
    expect(changePassword).toHaveBeenCalledWith(undefined, 'first-password');
  });

  it('surfaces API errors', async () => {
    vi.mocked(changePassword).mockRejectedValue(new Error('Current password is incorrect'));
    renderPage();
    await userEvent.type(screen.getByLabelText(/Current password/), 'wrong');
    await userEvent.type(screen.getByLabelText(/New password/), 'new-password-1');
    await userEvent.type(screen.getByLabelText(/Confirm new password/), 'new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
  });
});

/**
 * The three account kinds the page has to tell apart — and it is only two
 * renderings, because role is not one of the distinctions. The Admin role is a
 * `roles.yaml` fact that gates the admin screens; it has never had anything to
 * do with changing your own password, which is what the original report got
 * wrong. The deployment admin is the one that differs.
 */
describe('AccountPage — the three account kinds', () => {
  for (const kind of [
    { label: 'an Admin-role account', user: { email: 'admin-role@example.com' } },
    { label: 'a business user', user: { email: 'bob@example.com' } },
  ]) {
    it(`offers the form to ${kind.label}`, async () => {
      vi.mocked(changePassword).mockResolvedValue(undefined);
      renderPage(kind.user);
      expect(screen.queryByText(/set in the deployment environment/)).not.toBeInTheDocument();
      await userEvent.type(screen.getByLabelText(/Current password/), 'old-password');
      await userEvent.type(screen.getByLabelText(/New password/), 'new-password-1');
      await userEvent.type(screen.getByLabelText(/Confirm new password/), 'new-password-1');
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }));
      expect(await screen.findByRole('status')).toHaveTextContent('Password changed.');
      expect(changePassword).toHaveBeenCalledWith('old-password', 'new-password-1');
    });
  }

  it('explains instead of asking, and offers no save, for the deployment admin', () => {
    renderPage({ email: 'root@example.com', isEnvAdmin: true });
    expect(screen.getByText(/set in the deployment environment/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be changed here/)).toBeInTheDocument();
    // No form, no fields, and nothing to press — the explanation is the whole
    // surface, so there is no way to reach an API call that would be refused.
    expect(screen.queryByLabelText(/Current password/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/New password/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Confirm new password/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change password' })).not.toBeInTheDocument();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('gives that same account the form once ADMIN_PASSWORD is unset', () => {
    // The flag is derived from configuration, so an SSO-only deployment turns
    // this account back into an ordinary one.
    renderPage({ email: 'root@example.com', isEnvAdmin: false });
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
    expect(screen.queryByText(/set in the deployment environment/)).not.toBeInTheDocument();
  });
});
