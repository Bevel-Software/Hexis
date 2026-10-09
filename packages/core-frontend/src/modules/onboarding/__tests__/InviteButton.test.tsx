import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import type { AdminContact } from '../../access/api';
import { InviteButton } from '../components/InviteButton';
import { InviteDialogContext, type InviteDialogController } from '../state/invite-dialog.context';
import { InviteDialogProvider } from '../state/invite-dialog';

/**
 * The top bar's Invite, for everyone signed in: an admin's click opens the
 * Invite dialog; anyone else's opens a popover that says to ask an admin and
 * lists the admins, each with an Email button carrying a prefilled request.
 */

const { fetchAdminsMock } = vi.hoisted(() => ({
  fetchAdminsMock: vi.fn<() => Promise<AdminContact[]>>(),
}));
vi.mock('../../access/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../access/api')>()),
  fetchAdmins: fetchAdminsMock,
}));
vi.mock('../../../lib/api', () => ({ authFetch: vi.fn() }));
// The dialog asks how people sign in; this file is about the button.
vi.mock('../../auth/services/sso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/services/sso')>()),
  fetchLoginProvidersStrict: vi.fn(async () => ({ password: true, sso: [] })),
}));

const ADMINS: AdminContact[] = [
  { name: 'Dana Admin', email: 'dana@acme.com' },
  { name: 'Sam Ortiz', email: 'sam.ortiz@acme.com' },
];

function adminValue(isAdmin: boolean): AdminContextValue {
  return {
    isAdmin,
    isAdminLoading: false,
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
function mountWithController(isAdmin: boolean, compact = false) {
  const invite: InviteDialogController = { open: vi.fn(), invitedRevision: 0 };
  render(
    <AuthContext.Provider value={authValue()}>
      <AdminContext.Provider value={adminValue(isAdmin)}>
        <InviteDialogContext.Provider value={invite}>
          <div>
            <p>Elsewhere on the page</p>
            <InviteButton compact={compact} />
          </div>
        </InviteDialogContext.Provider>
      </AdminContext.Provider>
    </AuthContext.Provider>,
  );
  return invite;
}

function popover() {
  return screen.queryByRole('group', { name: 'Ask an admin to invite people' });
}

beforeEach(() => {
  fetchAdminsMock.mockReset().mockResolvedValue(ADMINS);
});

describe('InviteButton for an admin', () => {
  it('opens the Invite dialog, and no popover', async () => {
    render(
      <AuthContext.Provider value={authValue()}>
        <AdminContext.Provider value={adminValue(true)}>
          <InviteDialogProvider>
            <InviteButton />
          </InviteDialogProvider>
        </AdminContext.Provider>
      </AuthContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
    expect(popover()).not.toBeInTheDocument();
    expect(fetchAdminsMock).not.toHaveBeenCalled();
  });

  it('drops its word on a compact toolbar but keeps its name, and still opens the dialog', async () => {
    const invite = mountWithController(true, true);
    const button = screen.getByRole('button', { name: 'Invite' });
    // Exactly empty: the word is the accessible name, never on screen.
    expect(button.textContent).toBe('');
    await userEvent.click(button);
    expect(invite.open).toHaveBeenCalledTimes(1);
    expect(popover()).not.toBeInTheDocument();
  });
});

describe('InviteButton for anyone else', () => {
  it('is shown, and opens a popover saying to ask an admin — not the dialog', async () => {
    const invite = mountWithController(false);
    const button = screen.getByRole('button', { name: 'Invite' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = popover()!;
    expect(within(panel).getByText('Ask an admin to invite people')).toBeInTheDocument();
    expect(within(panel).getByText('Only admins can add people to this workspace.')).toBeInTheDocument();
    expect(invite.open).not.toHaveBeenCalled();
  });

  it('lists every admin with name, email and an Email button carrying the request', async () => {
    mountWithController(false);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    const list = await screen.findByRole('list', { name: 'Admins' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Dana Admin')).toBeInTheDocument();
    expect(within(rows[0]).getByText('dana@acme.com')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Sam Ortiz')).toBeInTheDocument();
    expect(within(rows[1]).getByText('sam.ortiz@acme.com')).toBeInTheDocument();

    const email = within(rows[0]).getByRole('link', { name: 'Email Dana Admin' });
    expect(email).toHaveTextContent('Email');
    const href = email.getAttribute('href')!;
    expect(href.startsWith('mailto:dana@acme.com?')).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(params.get('subject')).toBe('Please invite someone to Hexis');
    expect(params.get('body')).toBe(
      `Hi Dana,\n\nCould you invite ... to our workspace at ${window.location.origin}?\n\nThanks`,
    );
    expect(within(rows[1]).getByRole('link', { name: 'Email Sam Ortiz' }).getAttribute('href')).toMatch(
      /^mailto:sam\.ortiz@acme\.com\?.*Hi%20Sam%2C/,
    );
  });

  it('keeps its two lines and lists nobody when the admins cannot be read', async () => {
    fetchAdminsMock.mockRejectedValue(new Error('down'));
    mountWithController(false);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    await waitFor(() => expect(fetchAdminsMock).toHaveBeenCalled());
    const panel = popover()!;
    expect(within(panel).getByText('Ask an admin to invite people')).toBeInTheDocument();
    expect(within(panel).getByText('Only admins can add people to this workspace.')).toBeInTheDocument();
    expect(within(panel).queryByRole('list')).not.toBeInTheDocument();
  });

  it('closes on Escape and hands focus back to the button', async () => {
    mountWithController(false);
    const button = screen.getByRole('button', { name: 'Invite' });
    await userEvent.click(button);
    await screen.findByRole('list', { name: 'Admins' });
    await userEvent.keyboard('{Escape}');
    expect(popover()).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('closes on a click outside', async () => {
    mountWithController(false);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(popover()).toBeInTheDocument();
    await userEvent.click(screen.getByText('Elsewhere on the page'));
    expect(popover()).not.toBeInTheDocument();
  });

  it('toggles closed on a second click of the button', async () => {
    mountWithController(false);
    const button = screen.getByRole('button', { name: 'Invite' });
    await userEvent.click(button);
    await userEvent.click(button);
    expect(popover()).not.toBeInTheDocument();
  });

  it('the compact icon opens the same popover', async () => {
    const invite = mountWithController(false, true);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(popover()).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Admins' })).toBeInTheDocument();
    expect(invite.open).not.toHaveBeenCalled();
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
