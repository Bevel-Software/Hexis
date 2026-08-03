import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountPage } from '../components/AccountPage';
import { AuthContext, type AuthContextValue } from '../state/auth.context';
import { changePassword } from '../services/account.api';

vi.mock('../services/account.api', () => ({
  changePassword: vi.fn(),
}));

function renderPage() {
  const value: AuthContextValue = {
    user: { id: 'u1', email: 'alice@example.com', name: 'Alice' },
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
