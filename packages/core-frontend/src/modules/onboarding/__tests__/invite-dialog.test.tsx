import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { AppRegistryContext, makeRegistry } from '../../../core/registry';
import { AccountRequestError, type AccountSummary } from '../../auth/services/account.api';
import { InviteDialog } from '../components/InviteDialog';
import { InviteButton } from '../components/InviteButton';
import { InviteDialogProvider } from '../state/invite-dialog';
import { splitEmails } from '../invite-emails';

/**
 * The invite dialog: addresses become chips the way people paste them,
 * sending creates one account per valid address (and makes the new ones
 * admins when asked), a refusal for want of a seat says so on its row, and
 * the result view hands the admin what to forward.
 */

const { listAccountsMock, createAccountMock, addMemberMock, copyMock } = vi.hoisted(() => ({
  listAccountsMock: vi.fn<() => Promise<AccountSummary[]>>(),
  createAccountMock: vi.fn<(email: string, name: string) => Promise<void>>(),
  addMemberMock: vi.fn<(canonical: string, email: string) => Promise<unknown>>(),
  copyMock: vi.fn<(text: string) => Promise<boolean>>(),
}));

vi.mock('../../../lib/api', () => ({ authFetch: vi.fn() }));
vi.mock('../../auth/services/account.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/services/account.api')>()),
  listAccounts: listAccountsMock,
  createAccount: createAccountMock,
}));
vi.mock('../../admin/services/roles.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../admin/services/roles.api')>()),
  addMember: addMemberMock,
}));
vi.mock('../../library/utils/clipboard', () => ({ copyToClipboard: copyMock }));

function account(email: string): AccountSummary {
  return {
    id: email,
    email,
    name: email,
    hasPassword: false,
    isEnvAdmin: false,
    deactivatedAt: null,
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

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

function mountDialog(registry = makeRegistry({})) {
  const onInvited = vi.fn();
  const onClose = vi.fn();
  render(
    <AppRegistryContext.Provider value={registry}>
      <AuthContext.Provider value={authValue()}>
        <InviteDialog open onClose={onClose} onInvited={onInvited} />
      </AuthContext.Provider>
    </AppRegistryContext.Provider>,
  );
  return { onInvited, onClose, input: screen.getByLabelText('Work emails') };
}

/** The chips on screen, by the address each holds. */
function chips(): string[] {
  return screen.queryAllByRole('button', { name: /^Remove / }).map((b) =>
    b.getAttribute('aria-label')!.replace(/^Remove /, ''),
  );
}

beforeEach(() => {
  listAccountsMock.mockReset().mockResolvedValue([account('juan@bevel.software')]);
  createAccountMock.mockReset().mockResolvedValue(undefined);
  addMemberMock.mockReset().mockResolvedValue([]);
  copyMock.mockReset().mockResolvedValue(true);
});

describe('splitEmails', () => {
  it('splits on commas, semicolons and whitespace, lower-cases, and unwraps Name <address>', () => {
    expect(splitEmails('A@x.io, b@x.io;c@x.io\nd@x.io')).toEqual(['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io']);
    expect(splitEmails('Ana Diaz <ana@x.io>; Bo <bo@x.io>')).toEqual(['ana@x.io', 'bo@x.io']);
  });
});

describe('InviteDialog: the address field', () => {
  it('makes a chip on Enter and on a comma', async () => {
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.type(input, 'bo@bevel.software,');
    expect(chips()).toEqual(['ana@bevel.software', 'bo@bevel.software']);
    expect(input).toHaveValue('');
  });

  it('turns a pasted list into chips at once, without duplicates', () => {
    const { input } = mountDialog();
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'ana@bevel.software, bo@bevel.software\nANA@bevel.software' },
    });
    expect(chips()).toEqual(['ana@bevel.software', 'bo@bevel.software']);
  });

  it('takes the last chip back on Backspace in an empty field', async () => {
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}');
    await userEvent.type(input, '{Backspace}');
    expect(chips()).toEqual(['ana@bevel.software']);
  });

  it('keeps an invalid address on screen in the danger tone, and does not count it', async () => {
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}not-an-address{Enter}');
    const bad = screen.getByTitle('not-an-address is not an email address');
    expect(bad).toHaveClass('text-danger');
    expect(screen.getByText('One address isn’t valid and won’t be invited.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });

  it('can remove a chip with its button', async () => {
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Remove ana@bevel.software' }));
    expect(chips()).toEqual([]);
  });

  it('cannot send with no valid address', async () => {
    const { input } = mountDialog();
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeDisabled();
    await userEvent.type(input, 'nope{Enter}');
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeDisabled();
  });
});

describe('InviteDialog: sending', () => {
  it('creates one account per valid address, in order, and reports who was already here', async () => {
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('bo@bevel.software')]);
    const { input, onInvited } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}cy@bevel.software');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 3 people' }));

    expect(await screen.findByRole('dialog', { name: '3 people are invited' })).toBeInTheDocument();
    expect(createAccountMock.mock.calls.map((c) => c[0])).toEqual(['ana@bevel.software', 'cy@bevel.software']);
    expect(addMemberMock).not.toHaveBeenCalled();
    expect(onInvited).toHaveBeenCalledTimes(1);

    const people = within(screen.getByRole('list', { name: 'People' }));
    expect(people.getByText('Juan Viera (you)')).toBeInTheDocument();
    const bo = people.getByText('bo@bevel.software').closest('li')!;
    expect(within(bo).getByText('Already had an account')).toBeInTheDocument();
    const ana = people.getByText('ana@bevel.software').closest('li')!;
    expect(within(ana).getByText('Hasn’t signed in yet')).toBeInTheDocument();
  });

  it('makes newly created accounts admins when invited as Admin', async () => {
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('bo@bevel.software')]);
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}');
    await userEvent.selectOptions(screen.getByLabelText('Invite as'), 'admin');
    expect(screen.getByText('Can also change settings and who has access.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));

    await screen.findByRole('dialog', { name: '2 people are invited' });
    expect(addMemberMock).toHaveBeenCalledTimes(1);
    expect(addMemberMock).toHaveBeenCalledWith('admin', 'ana@bevel.software');
  });

  it('says "no seat left" on the row the deployment refused with a 403', async () => {
    createAccountMock.mockImplementation(async (email) => {
      if (email === 'bo@bevel.software') throw new AccountRequestError('No seat left on this plan', 403);
    });
    const { input, onInvited } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));

    await screen.findByRole('dialog', { name: '1 person is invited' });
    const bo = screen.getByText('bo@bevel.software').closest('li')!;
    expect(within(bo).getByText('Not invited: no seat left')).toBeInTheDocument();
    expect(within(bo).getByText('No seat left on this plan')).toBeInTheDocument();
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it('shows any other refusal in the server’s words', async () => {
    createAccountMock.mockRejectedValue(new AccountRequestError('Invalid email', 400));
    const { input, onInvited } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    await screen.findByRole('dialog', { name: 'Nobody was invited' });
    expect(screen.getByText('Not invited')).toBeInTheDocument();
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
    expect(screen.queryByText('Where they sign in')).not.toBeInTheDocument();
    expect(onInvited).not.toHaveBeenCalled();
  });

  it('hands over the sign-in link and a message to forward, and copies them', async () => {
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });

    const origin = window.location.origin;
    expect(screen.getByText(origin)).toBeInTheDocument();
    expect(screen.getByText(/Sign in with your work account at/)).toHaveTextContent(
      `Sign in with your work account at ${origin}, then connect your agent from the welcome page.`,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copyMock).toHaveBeenCalledWith(origin);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    copyMock.mockResolvedValue(false);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(copyMock).toHaveBeenLastCalledWith(expect.stringContaining('I’ve added you to'));
    expect(await screen.findByText('Couldn’t copy: select the text and copy it yourself.')).toBeInTheDocument();
  });

  it('goes back to an empty form on "Invite more people"', async () => {
    const { input } = mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Invite more people' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
    expect(chips()).toEqual([]);
  });
});

describe('InviteDialog: the registry slot', () => {
  it('renders inviteExtras with the number of valid addresses entered', async () => {
    const Extras = ({ inviting }: { inviting: number }) => <p>Seats after invites: {inviting}</p>;
    const { input } = mountDialog(makeRegistry({ inviteExtras: Extras }));
    expect(screen.getByText('Seats after invites: 0')).toBeInTheDocument();
    await userEvent.type(input, 'ana@bevel.software{Enter}nope{Enter}bo@bevel.software');
    expect(screen.getByText('Seats after invites: 2')).toBeInTheDocument();
  });

  it('keeps the form when the slot throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = () => {
      throw new Error('boom');
    };
    mountDialog(makeRegistry({ inviteExtras: Broken }));
    expect(screen.getByRole('alert')).toHaveTextContent('The invite panel couldn’t be shown.');
    expect(screen.getByLabelText('Work emails')).toBeInTheDocument();
    consoleError.mockRestore();
  });
});

describe('InviteButton (toolbar)', () => {
  function mountButton(isAdmin: boolean, withProvider = true) {
    const button = <InviteButton />;
    render(
      <AuthContext.Provider value={authValue()}>
        <AdminContext.Provider value={adminValue(isAdmin)}>
          {withProvider ? <InviteDialogProvider>{button}</InviteDialogProvider> : button}
        </AdminContext.Provider>
      </AuthContext.Provider>,
    );
  }

  it('is offered to admins and opens the invite dialog', async () => {
    mountButton(true);
    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
  });

  it('is not offered to members', () => {
    mountButton(false);
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });

  it('is not offered without a dialog to open', () => {
    mountButton(true, false);
    expect(screen.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
  });
});
