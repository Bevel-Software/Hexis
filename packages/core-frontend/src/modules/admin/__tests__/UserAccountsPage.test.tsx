import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  isEnvAdmin: false,
  createdAt: '2026-01-01T00:00:00Z',
};
const BOB = {
  id: 'u-bob',
  email: 'bob@example.com',
  name: 'Bob',
  hasPassword: true,
  isEnvAdmin: false,
  createdAt: '2026-01-01T00:00:00Z',
};
// The deployment admin (ADMIN_EMAIL) — a different account from the signed-in
// admin, so its row offers the actions. No hash stored yet.
const ROOT = {
  id: 'u-root',
  email: 'root@example.com',
  name: 'Root',
  hasPassword: false,
  isEnvAdmin: true,
  createdAt: '2026-01-01T00:00:00Z',
};

/** The "email · Joined … · sign-in method" line of the named account's row. */
function row(name: string): HTMLElement {
  const li = screen.getByText(name).closest('li');
  if (!li) throw new Error(`no row for ${name}`);
  return within(li).getByText(/· Joined /);
}

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
      { ...ME, hasPassword: true, isEnvAdmin: false, createdAt: '2026-01-01T00:00:00Z' },
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
    expect(row('Alice')).toHaveTextContent(/· No password — signs in with single sign-on$/);
    expect(
      screen.getByRole('button', { name: 'Set password for alice@example.com' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete account alice@example.com' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Set password for admin@example.com' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete account admin@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('labels each account with the sign-in methods it actually has', async () => {
    vi.mocked(listAccounts).mockResolvedValue([
      ALICE,
      BOB,
      ROOT,
      { ...ROOT, id: 'u-root-hashed', name: 'Root Hashed', hasPassword: true },
    ]);
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    expect(row('Alice')).toHaveTextContent(/· No password — signs in with single sign-on$/);
    expect(row('Bob')).toHaveTextContent(/· Password$/);
    // The deployment admin reads the same with or without a stored hash.
    expect(row('Root')).toHaveTextContent(/· Password \(deployment admin\)$/);
    expect(row('Root Hashed')).toHaveTextContent(/· Password \(deployment admin\)$/);
    expect(screen.queryByText(/Single sign-on only/)).not.toBeInTheDocument();
  });

  it('the delete confirmation describes the password state in the same words', async () => {
    vi.mocked(listAccounts).mockResolvedValue([ALICE, BOB, ROOT]);
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    const cases: Array<[string, RegExp]> = [
      ['alice@example.com', /No password — signs in with single sign-on: they can sign in again later with single sign-on/],
      ['bob@example.com', /Password: to sign in again they will need an admin/],
      ['root@example.com', /Password \(deployment admin\): they can still sign in with the deployment admin password/],
    ];
    for (const [email, wording] of cases) {
      await userEvent.click(screen.getByRole('button', { name: `Delete account ${email}` }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent(wording);
      expect(dialog).not.toHaveTextContent(/Single sign-on only/);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    }
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  // The one account no admin may give a stored password. Its password is the
  // environment's: a stored one would not replace that credential, it would add
  // a second that survives rotating ADMIN_PASSWORD. The service refuses it, so
  // the page must not offer a button that can only fail — it says why instead.
  it('offers no password action on the deployment admin row, and says why', async () => {
    vi.mocked(listAccounts).mockResolvedValue([
      ALICE,
      ROOT,
      { ...ROOT, id: 'u-root-hashed', name: 'Root Hashed', email: 'root2@example.com', hasPassword: true },
    ]);
    renderPage();
    await waitFor(() => screen.getByText('Root'));
    // Neither label, and `hasPassword` does not pick one for it either: the
    // deployment admin reads the same with or without a stored hash.
    for (const email of ['root@example.com', 'root2@example.com']) {
      expect(
        screen.queryByRole('button', { name: `Set password for ${email}` }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: `Reset password for ${email}` }),
      ).not.toBeInTheDocument();
    }
    const li = screen.getByText('Root').closest('li');
    expect(li).toHaveTextContent('Password set in the deployment environment');
    expect(screen.getByText('Root Hashed').closest('li')).toHaveTextContent(
      'Password set in the deployment environment',
    );
    // Only that one action is withheld — erasure still belongs to another admin.
    expect(
      screen.getByRole('button', { name: 'Delete account root@example.com' }),
    ).toBeInTheDocument();
    // And the ordinary account beside it is untouched by the rule.
    expect(
      screen.getByRole('button', { name: 'Set password for alice@example.com' }),
    ).toBeInTheDocument();
  });

  it('after Set password the label follows the refreshed facts, no manual reload', async () => {
    // Initial load, then one reload per Set password: each reload reports the
    // hash now stored for the account that was just set.
    vi.mocked(listAccounts)
      .mockResolvedValueOnce([ALICE, BOB])
      .mockResolvedValueOnce([{ ...ALICE, hasPassword: true }, BOB]);
    renderPage();
    await waitFor(() => screen.getByText('Alice'));

    expect(row('Alice')).toHaveTextContent(/· No password — signs in with single sign-on$/);
    await userEvent.click(screen.getByRole('button', { name: 'Set password for alice@example.com' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('New password'), 'fresh-password-1');
    await userEvent.click(dialog.getByRole('button', { name: 'Set password' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await waitFor(() => expect(row('Alice')).toHaveTextContent(/· Password$/));
    expect(listAccounts).toHaveBeenCalledTimes(2);
    // ...and the action offered on that row is now the OTHER one: the same
    // reload that changed the sign-in method changes what the button does.
    expect(
      screen.getByRole('button', { name: 'Reset password for alice@example.com' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Set password for alice@example.com' }),
    ).not.toBeInTheDocument();
  });

  // The whole point of the ticket: first setup and replacing a working
  // credential are different acts, so they are not offered in the same words.
  it('offers Set password without one and Reset password with one', async () => {
    vi.mocked(listAccounts).mockResolvedValue([ALICE, BOB]);
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    expect(
      screen.getByRole('button', { name: 'Set password for alice@example.com' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Reset password for bob@example.com' }),
    ).toBeInTheDocument();
    // Neither label leaks onto the other row.
    expect(
      screen.queryByRole('button', { name: 'Reset password for alice@example.com' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Set password for bob@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('the Set password dialog says the person gains a way to sign in', async () => {
    vi.mocked(listAccounts).mockResolvedValue([ALICE, BOB]);
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.click(screen.getByRole('button', { name: 'Set password for alice@example.com' }));
    const dialog = screen.getByRole('dialog');
    // Title, explanation and confirm button all say the same act.
    expect(within(dialog).getByRole('heading', { name: 'Set password' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/from now on they will be able to sign in with this one/);
    expect(within(dialog).getByRole('button', { name: 'Set password' })).toBeInTheDocument();
    // Nothing is being taken away, so nothing warns that it is.
    expect(dialog).not.toHaveTextContent(/stops working/);
    expect(dialog).not.toHaveTextContent(/Reset it\?/);
  });

  it('the Reset password dialog says the old password stops working, and asks', async () => {
    vi.mocked(listAccounts).mockResolvedValue([ALICE, BOB]);
    renderPage();
    await waitFor(() => screen.getByText('Bob'));
    await userEvent.click(screen.getByRole('button', { name: 'Reset password for bob@example.com' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Reset password' })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/current password stops working immediately/);
    expect(dialog).toHaveTextContent(/Reset it\?/);
    expect(within(dialog).getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
    // It asks before it does anything: the question is on screen and nothing
    // has been sent until the confirm button is pressed.
    expect(createAccount).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText('New password'), 'fresh-password-2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Reset password' }));
    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith('bob@example.com', '', 'fresh-password-2'),
    );
    // ...and the banner reports the act that was actually performed.
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Password reset for bob@example.com',
    );
  });

  it('cancelling a reset leaves the password alone', async () => {
    vi.mocked(listAccounts).mockResolvedValue([ALICE, BOB]);
    renderPage();
    await waitFor(() => screen.getByText('Bob'));
    await userEvent.click(screen.getByRole('button', { name: 'Reset password for bob@example.com' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.type(dialog.getByLabelText('New password'), 'fresh-password-2');
    await userEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(createAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(listAccounts).toHaveBeenCalledTimes(1);
  });

  it('sets a password for a user WITHOUT touching their name', async () => {
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.click(screen.getByRole('button', { name: 'Set password for alice@example.com' }));
    const dialog = within(screen.getByRole('dialog'));
    // Empty password → the confirm button stays disabled; nothing is sent.
    expect(dialog.getByRole('button', { name: 'Set password' })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText('New password'), 'fresh-password-1');
    await userEvent.click(dialog.getByRole('button', { name: 'Set password' }));
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
    await userEvent.click(screen.getByRole('button', { name: 'Delete account alice@example.com' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('u-alice'));
    // List reloaded after the delete.
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });

  it('a failed delete closes the dialog, surfaces the error, and does not reload', async () => {
    vi.mocked(deleteAccount).mockRejectedValueOnce(new Error('Failed to erase user'));
    renderPage();
    await waitFor(() => screen.getByText('Alice'));
    await userEvent.click(screen.getByRole('button', { name: 'Delete account alice@example.com' }));
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: 'Delete account' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Announced, not merely coloured — same guarantee the load failure gets.
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to erase user');
    // And the rows survive: keeping what was already fetched is the half of
    // the old `[]` coercion that was worth keeping, so it is pinned here.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(listAccounts).toHaveBeenCalledTimes(1);
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

  // "We could not ask" is not "there is nobody". The failure used to store an
  // empty list, so an admin whose backend was unreachable read "No user
  // accounts." — a deployment they would have had every reason to believe.
  it('a failed FIRST load reports the failure rather than an empty deployment', async () => {
    vi.mocked(listAccounts).mockReset().mockRejectedValue(new Error('Backend unreachable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Backend unreachable');
    expect(screen.queryByText('No user accounts.')).not.toBeInTheDocument();
    // ...and no "Loading…" left sitting beside the banner forever, either.
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });
});
