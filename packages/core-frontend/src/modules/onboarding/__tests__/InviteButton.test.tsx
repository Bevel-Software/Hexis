import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthContext, type AuthContextValue } from '../../auth';
import { AdminContext, type AdminContextValue } from '../../admin';
import { InviteButton } from '../components/InviteButton';
import { InviteDialogContext, type InviteDialogController } from '../state/invite-dialog.context';
import { InviteDialogProvider } from '../state/invite-dialog';

/**
 * The top bar's Invite, for everyone signed in: anyone's click opens the
 * Invite dialog, admin or not. There is no ask-an-admin popover any more.
 */

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock('../../../lib/api', () => ({ authFetch: authFetchMock, getToken: () => 'test-token', setToken: () => {} }));

beforeEach(() => {
  authFetchMock.mockReset();
  // The dialog asks how people sign in; this file is about the button.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ password: true, sso: [] }), { status: 200 })),
  );
});

function authValue(): AuthContextValue {
  return {
    user: { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera' },
    token: 'test-token',
    isLoading: false,
    login: vi.fn(),
    logout: vi.fn(),
  };
}

function adminValue(isAdmin: boolean, isAdminLoading = false): AdminContextValue {
  return {
    isAdmin,
    isAdminLoading,
    unreadCount: 0,
    lastSeen: null,
    markSeen: () => {},
    refresh: () => {},
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: async () => {},
  };
}

/** With a stub controller, so a test can tell whether the dialog was asked for. */
function mountWithController(isAdmin: boolean, compact = false, isAdminLoading = false) {
  const invite: InviteDialogController = { open: vi.fn(), invitedRevision: 0 };
  render(
    <AuthContext.Provider value={authValue()}>
      <AdminContext.Provider value={adminValue(isAdmin, isAdminLoading)}>
        <InviteDialogContext.Provider value={invite}>
          <InviteButton compact={compact} />
        </InviteDialogContext.Provider>
      </AdminContext.Provider>
    </AuthContext.Provider>,
  );
  return invite;
}

/** With the real dialog host, so a test sees the dialog itself. */
function mountWithDialog(isAdmin: boolean) {
  render(
    <AuthContext.Provider value={authValue()}>
      <AdminContext.Provider value={adminValue(isAdmin)}>
        <InviteDialogProvider>
          <InviteButton />
        </InviteDialogProvider>
      </AdminContext.Provider>
    </AuthContext.Provider>,
  );
}

describe('InviteButton', () => {
  it('opens the Invite dialog for an admin', async () => {
    mountWithDialog(true);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
  });

  it('opens the Invite dialog for anyone else, with no ask-an-admin popover and no admin list read', async () => {
    mountWithDialog(false);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Ask an admin to invite people' })).not.toBeInTheDocument();
    expect(authFetchMock).not.toHaveBeenCalledWith('/api/access/admins', expect.anything());
    expect(authFetchMock).not.toHaveBeenCalledWith('/api/access/admins');
  });

  it('is enabled and opens the dialog while the admin check is still out', async () => {
    const invite = mountWithController(false, false, true);
    const button = screen.getByRole('button', { name: 'Invite' });
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(invite.open).toHaveBeenCalledTimes(1);
  });

  it('drops its word on a compact toolbar but keeps its name, and still opens the dialog', async () => {
    const invite = mountWithController(false, true);
    const button = screen.getByRole('button', { name: 'Invite' });
    // Exactly empty: the word is the accessible name, never on screen.
    expect(button.textContent).toBe('');
    await userEvent.click(button);
    expect(invite.open).toHaveBeenCalledTimes(1);
  });
});

describe('InviteButton outside a provider', () => {
  it('renders nothing, for an admin or anyone else', () => {
    render(
      <AuthContext.Provider value={authValue()}>
        <AdminContext.Provider value={adminValue(true)}>
          <InviteButton />
        </AdminContext.Provider>
        <AdminContext.Provider value={adminValue(false)}>
          <InviteButton compact />
        </AdminContext.Provider>
      </AuthContext.Provider>,
    );
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });
});
