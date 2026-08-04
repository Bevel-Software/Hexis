import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserAccountsPage } from '../components/UserAccountsPage';
import { AdminContext } from '../state/admin.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import {
  createAccount,
  deleteAccount,
  listAccounts,
} from '../../auth/services/account.api';

vi.mock('../../auth/services/account.api', () => ({
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  listAccounts: vi.fn(),
}));

const ME = { id: 'admin-1', email: 'admin@example.com', name: 'Admin' };
const ALICE = {
  id: 'u-alice',
  email: 'alice@example.com',
  name: 'Alice',
  hasPassword: false,
  createdAt: '2026-01-01T00:00:00Z',
};

function renderPage(opts: { isAdmin?: boolean } = {}) {
  const auth: AuthContextValue = {
    user: ME,
    token: 't',
    isLoading: false,
    login: vi.fn(async () => {}),
    logout: vi.fn(),
  };
  return render(
    <AuthContext.Provider value={auth}>
      <AdminContext.Provider
        value={{
          isAdmin: opts.isAdmin ?? true,
          unreadCount: 0,
          lastSeen: null,
          markSeen: () => {},
          refresh: () => {},
          rolesConfigCorrupted: false,
          rolesConfigErrors: [],
          runRolesRecovery: async () => {},
        }}
      >
        <UserAccountsPage />
      </AdminContext.Provider>
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(listAccounts)
    .mockReset()
    .mockResolvedValue([
      { ...ME, hasPassword: true, createdAt: '2026-01-01T00:00:00Z' },
      ALICE,
    ]);
  vi.mocked(deleteAccount).mockReset().mockResolvedValue(undefined);
  vi.mocked(createAccount).mockReset().mockResolvedValue(undefined);
});

describe('UserAccountsPage', () => {
  it('shows the admins-only state (and never loads) for non-admins', () => {
    renderPage({ isAdmin: false });
    expect(screen.getByText(/Admins only/)).toBeInTheDocument();
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('lists accounts with sign-in method; own row offers no actions', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText(/Single sign-on only/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Set password' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Delete account' })).toHaveLength(1);
  });

  it('sets a password for a user WITHOUT touching their name', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.click(screen.getByRole('button', { name: 'Set password' }));
    await userEvent.type(screen.getByLabelText('New password'), 'fresh-password-1');
    const buttons = screen.getAllByRole('button', { name: 'Set password' });
    await userEvent.click(buttons[buttons.length - 1]);
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith('alice@example.com', '', 'fresh-password-1'),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Password set for alice@example.com',
    );
  });

  it('deletes an account after confirmation', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }));
    // Confirm dialog's primary button carries the same label; last rendered wins.
    const buttons = screen.getAllByRole('button', { name: 'Delete account' });
    await userEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('u-alice'));
    // List reloaded after the delete.
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });

  it('adds a new account and refreshes the list', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.type(screen.getByLabelText('Email'), 'bob@example.com');
    await userEvent.type(screen.getByLabelText(/Name/), 'Bob');
    await userEvent.type(screen.getByLabelText('Password'), 'bobs-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith('bob@example.com', 'Bob', 'bobs-password-1'),
    );
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });

  it('surfaces an add failure inline', async () => {
    vi.mocked(createAccount).mockRejectedValueOnce(
      new Error('Password must be at least 8 characters'),
    );
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.type(screen.getByLabelText('Email'), 'bob@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 8 characters');
  });
});
