import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { AppRegistryContext, makeRegistry } from '../../../core/registry';
import { AccountRequestError, type AccountSummary } from '../../auth/services/account.api';
import type { LoginProviders } from '../../auth/services/sso';
import { InviteDialog } from '../components/InviteDialog';
import { InviteDialogProvider } from '../state/invite-dialog';
import { useInviteDialog } from '../state/invite-dialog.context';
import { splitEmails } from '../invite-emails';

/** Every invite promotion is sent `ifActive`: the server refuses a switched-off account at the write. */
const ACTIVE = { ifActive: true };

/**
 * The invite dialog: addresses become chips the way people paste them; the
 * dialog asks how the deployment signs people in before it lets anything be
 * sent, and asks for a starting password where one is needed; sending
 * creates one account per valid address (and makes the new ones admins when
 * asked); and the result view says how each person signs in and hands the
 * admin what to forward — never the password.
 */

const { listAccountsMock, createAccountMock, addMemberMock, fetchRolesMock, copyMock, providersMock } = vi.hoisted(
  () => ({
    listAccountsMock: vi.fn<() => Promise<AccountSummary[]>>(),
    createAccountMock:
      vi.fn<
        (
          email: string,
          name: string,
          password?: string,
          options?: { keepExistingPassword?: boolean },
        ) => Promise<{ passwordSet?: boolean }>
      >(),
    addMemberMock: vi.fn<(canonical: string, email: string, options?: { ifActive?: boolean }) => Promise<unknown>>(),
    fetchRolesMock: vi.fn<() => Promise<{ canonical: string; members: string[]; fixedMembers?: string[] }[]>>(),
    copyMock: vi.fn<(text: string) => Promise<boolean>>(),
    providersMock: vi.fn<() => Promise<LoginProviders>>(),
  }),
);

vi.mock('../../../lib/api', () => ({ authFetch: vi.fn() }));
vi.mock('../../auth/services/account.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/services/account.api')>()),
  listAccounts: listAccountsMock,
  createAccount: createAccountMock,
}));
vi.mock('../../admin/services/roles.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../admin/services/roles.api')>()),
  addMember: addMemberMock,
  fetchRoles: fetchRolesMock,
}));
vi.mock('../../auth/services/sso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/services/sso')>()),
  fetchLoginProvidersStrict: providersMock,
}));
vi.mock('../../library/utils/clipboard', () => ({ copyToClipboard: copyMock }));

const DUENDE = { key: 'oidc', label: 'Duende Demo', startPath: '/api/auth/oidc/start' };
/** Password sign-in, no single sign-on (knowledge.bevel.software). */
const PASSWORD_ONLY: LoginProviders = { password: true, sso: [] };
/** Single sign-on and password sign-in (core-staging). */
const SSO_AND_PASSWORD: LoginProviders = { password: true, sso: [DUENDE] };
/** Single sign-on only: password sign-in is off. */
const SSO_ONLY: LoginProviders = { password: false, sso: [DUENDE] };

const SECRET = 'welcome-to-acme';
/** How a starting password is sent: the server never writes it over one of the account's own. */
const KEEP = { keepExistingPassword: true };

function account(email: string, over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: email,
    email,
    name: email,
    hasPassword: false,
    isEnvAdmin: false,
    deactivatedAt: null,
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** Mount the dialog and wait until it knows how people sign in (or that it can't). */
async function mountDialog(
  opts: { registry?: ReturnType<typeof makeRegistry>; initialEmails?: string[]; settle?: boolean } = {},
) {
  const onInvited = vi.fn();
  const onClose = vi.fn();
  render(
    <AppRegistryContext.Provider value={opts.registry ?? makeRegistry({})}>
      <AuthContext.Provider value={authValue()}>
        <InviteDialog open onClose={onClose} onInvited={onInvited} initialEmails={opts.initialEmails} />
      </AuthContext.Provider>
    </AppRegistryContext.Provider>,
  );
  if (opts.settle !== false) {
    await waitFor(() => expect(providersMock).toHaveBeenCalled());
    // One turn for the answer to land.
    await waitFor(() => expect(screen.queryByText(/^They sign in with|Couldn’t check/)).toBeInTheDocument());
  }
  return { onInvited, onClose, input: screen.getByLabelText('Emails') };
}

/** The chips on screen, by the address each holds. */
function chips(): string[] {
  return screen.queryAllByRole('button', { name: /^Remove / }).map((b) =>
    b.getAttribute('aria-label')!.replace(/^Remove /, ''),
  );
}

function passwordField(): HTMLInputElement {
  return screen.getByLabelText('Starting password') as HTMLInputElement;
}

function rowOf(email: string): HTMLElement {
  return within(screen.getByRole('list', { name: 'People' })).getByText(email).closest('li')!;
}

beforeEach(() => {
  listAccountsMock.mockReset().mockResolvedValue([account('juan@bevel.software', { hasPassword: true })]);
  createAccountMock.mockReset().mockResolvedValue({});
  addMemberMock.mockReset().mockResolvedValue([]);
  fetchRolesMock.mockReset().mockResolvedValue([{ canonical: 'admin', members: ['juan@bevel.software'] }]);
  copyMock.mockReset().mockResolvedValue(true);
  // The address-field and plain sending tests run as today's dialog did: no
  // password involved, because the deployment has single sign-on.
  providersMock.mockReset().mockResolvedValue(SSO_AND_PASSWORD);
  localStorage.clear();
  sessionStorage.clear();
});

describe('splitEmails', () => {
  it('splits on commas, semicolons and whitespace, lower-cases, and unwraps Name <address>', () => {
    expect(splitEmails('A@x.io, b@x.io;c@x.io\nd@x.io')).toEqual(['a@x.io', 'b@x.io', 'c@x.io', 'd@x.io']);
    expect(splitEmails('Ana Diaz <ana@x.io>; Bo <bo@x.io>')).toEqual(['ana@x.io', 'bo@x.io']);
  });

  it('keeps a display name with a comma in it whole, quoted or not', () => {
    expect(splitEmails('Doe, Jane <jane@example.com>')).toEqual(['jane@example.com']);
    expect(splitEmails('Doe, Jane <jane@example.com>, Roe, Rick <rick@example.com>')).toEqual([
      'jane@example.com',
      'rick@example.com',
    ]);
    expect(splitEmails('"Doe, Jane" <jane@example.com>; "Bo; Smith" <bo@example.com>')).toEqual([
      'jane@example.com',
      'bo@example.com',
    ]);
  });

  it('keeps bare addresses beside named ones, and a mistyped one after the last of them', () => {
    expect(splitEmails('ana@x.io, Doe, Jane <jane@x.io>, bo@x.io')).toEqual(['ana@x.io', 'jane@x.io', 'bo@x.io']);
    expect(splitEmails('Doe, Jane <jane@x.io>, nope')).toEqual(['jane@x.io', 'nope']);
  });
});

describe('InviteDialog: the address field', () => {
  it('makes a chip on Enter and on a comma', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.type(input, 'bo@bevel.software,');
    expect(chips()).toEqual(['ana@bevel.software', 'bo@bevel.software']);
    expect(input).toHaveValue('');
  });

  it('turns a pasted list into chips at once, without duplicates', async () => {
    const { input } = await mountDialog();
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'ana@bevel.software, bo@bevel.software\nANA@bevel.software' },
    });
    expect(chips()).toEqual(['ana@bevel.software', 'bo@bevel.software']);
  });

  it('takes the last chip back on Backspace in an empty field', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}');
    await userEvent.type(input, '{Backspace}');
    expect(chips()).toEqual(['ana@bevel.software']);
  });

  it('keeps an invalid address on screen in the danger tone, and does not count it', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}not-an-address{Enter}');
    const bad = screen.getByTitle('not-an-address is not an email address');
    expect(bad).toHaveClass('text-danger');
    expect(screen.getByText('One address isn’t valid and won’t be invited.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });

  it('counts an invalid address still in the field, which a send would clear unsent', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}not-an-address');
    expect(chips()).toEqual(['ana@bevel.software']);
    expect(screen.getByText('One address isn’t valid and won’t be invited.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });

  it('turns a pasted Outlook recipient list into one chip per person', async () => {
    const { input } = await mountDialog();
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'Doe, Jane <jane@bevel.software>; Roe, Rick <rick@bevel.software>' },
    });
    expect(chips()).toEqual(['jane@bevel.software', 'rick@bevel.software']);
  });

  it('can remove a chip with its button', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Remove ana@bevel.software' }));
    expect(chips()).toEqual([]);
  });

  it('cannot send with no valid address', async () => {
    const { input } = await mountDialog();
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeDisabled();
    await userEvent.type(input, 'nope{Enter}');
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeDisabled();
  });

  it('opens through the shared controller with the addresses it is given', async () => {
    function Opener() {
      const invite = useInviteDialog();
      return (
        <button type="button" onClick={() => invite?.open({ emails: ['new.hire@bevel.software'] })}>
          Open
        </button>
      );
    }
    render(
      <AppRegistryContext.Provider value={makeRegistry({})}>
        <AuthContext.Provider value={authValue()}>
          <InviteDialogProvider>
            <Opener />
          </InviteDialogProvider>
        </AuthContext.Provider>
      </AppRegistryContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
    expect(chips()).toEqual(['new.hire@bevel.software']);
  });

  it('starts with the addresses it was opened with', async () => {
    await mountDialog({ initialEmails: ['new.hire@bevel.software'] });
    expect(chips()).toEqual(['new.hire@bevel.software']);
  });
});

describe('InviteDialog: the form shows only what it needs', () => {
  it('has no intro line, paste hint, role description or footer note', async () => {
    await mountDialog();
    for (const gone of [
      'They sign in with the account for the address you add.',
      'Paste a list, or press Enter or comma after each address.',
      'Sees everything shared with the whole workspace.',
      'Can also change settings and who has access.',
      'Uses the same access rules as Share → Manage access.',
    ]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    expect(screen.getByLabelText('Role')).toBeInTheDocument();
  });
});

describe('InviteDialog: how people sign in here', () => {
  it('stays disabled while it is still asking', async () => {
    providersMock.mockReturnValue(new Promise(() => {}));
    await mountDialog({ initialEmails: ['ana@bevel.software'], settle: false });
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
  });

  it('without single sign-on, requires a starting password of at least 8 characters', async () => {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    const { input } = await mountDialog();
    expect(screen.getByText('They sign in with their email and the password you set.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Also give them a password')).not.toBeInTheDocument();
    const field = passwordField();
    expect(field).toBeRequired();
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'new-password');

    // A valid address alone is not enough.
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();

    // A short password says why and stays disabled.
    await userEvent.type(field, 'acme');
    expect(screen.getByText('The password needs at least 8 characters.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();

    await userEvent.type(field, '-team');
    expect(screen.queryByText('The password needs at least 8 characters.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });

  it('a password alone is not enough either', async () => {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    await mountDialog();
    await userEvent.type(passwordField(), SECRET);
    expect(screen.getByRole('button', { name: 'Invite people' })).toBeDisabled();
  });

  it('shows the password on the eye button, and hides it again', async () => {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    await mountDialog();
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(passwordField()).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(passwordField()).toHaveAttribute('type', 'password');
  });

  it('with single sign-on, offers "Also give them a password", off, and requires the password once ticked', async () => {
    const { input } = await mountDialog();
    expect(screen.getByText('They sign in with Duende Demo.')).toBeInTheDocument();
    const option = screen.getByLabelText('Also give them a password');
    expect(option).not.toBeChecked();
    expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();

    await userEvent.click(option);
    expect(passwordField()).toBeRequired();
    expect(
      screen.getByText('They sign in with Duende Demo, or with their email and the password you set.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
    await userEvent.type(passwordField(), SECRET);
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });

  it('names several single sign-on providers', async () => {
    providersMock.mockResolvedValue({
      password: true,
      sso: [DUENDE, { key: 'ms', label: 'Microsoft', startPath: '/api/auth/ms/start' }],
    });
    await mountDialog();
    expect(screen.getByText('They sign in with Duende Demo or Microsoft.')).toBeInTheDocument();
  });

  it('with password sign-in off, shows no password field and no option, and invites as today', async () => {
    providersMock.mockResolvedValue(SSO_ONLY);
    const { input } = await mountDialog();
    expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Also give them a password')).not.toBeInTheDocument();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(createAccountMock).toHaveBeenCalledWith('ana@bevel.software', '');
  });

  it('with password sign-in off and no single sign-on either, sends nothing and says why', async () => {
    providersMock.mockResolvedValue({ password: false, sso: [] });
    await mountDialog({ initialEmails: ['ana@bevel.software'], settle: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nobody could sign in: password sign-in is off here and no single sign-on is set up.',
    );
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
    expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
  });

  it('when the check fails, keeps Invite disabled with Retry, and a successful Retry enables the form', async () => {
    providersMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(PASSWORD_ONLY);
    await mountDialog({ initialEmails: ['ana@bevel.software'] });
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t check how people sign in here.');
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
    // Only the emails and the role while it doesn't know.
    expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Also give them a password')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('They sign in with their email and the password you set.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.type(passwordField(), SECRET);
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });
});

describe('InviteDialog: sending', () => {
  it('creates one account per valid address, in order, and reports who was already here', async () => {
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('bo@bevel.software')]);
    const { input, onInvited } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}cy@bevel.software');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 3 people' }));

    expect(await screen.findByRole('dialog', { name: '3 people are invited' })).toBeInTheDocument();
    expect(createAccountMock.mock.calls).toEqual([
      ['ana@bevel.software', ''],
      ['cy@bevel.software', ''],
    ]);
    expect(addMemberMock).not.toHaveBeenCalled();
    expect(onInvited).toHaveBeenCalledTimes(1);

    const people = within(screen.getByRole('list', { name: 'People' }));
    expect(people.getByText('Juan Viera (you)')).toBeInTheDocument();
    expect(within(rowOf('bo@bevel.software')).getByText('Already had an account')).toBeInTheDocument();
    expect(within(rowOf('bo@bevel.software')).getByText('Signs in with Duende Demo')).toBeInTheDocument();
    expect(within(rowOf('ana@bevel.software')).getByText('Hasn’t signed in yet')).toBeInTheDocument();
    expect(within(rowOf('ana@bevel.software')).getByText('Member · signs in with Duende Demo')).toBeInTheDocument();
    expect(screen.getByText('They can sign in now with Duende Demo. Send them the link.')).toBeInTheDocument();
  });

  it('makes everyone invited as Admin an admin, new accounts and existing ones alike', async () => {
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('bo@bevel.software')]);
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));

    await screen.findByRole('dialog', { name: '2 people are invited' });
    expect(createAccountMock.mock.calls.map((c) => c[0])).toEqual(['ana@bevel.software']);
    expect(addMemberMock.mock.calls).toEqual([
      ['admin', 'ana@bevel.software', ACTIVE],
      ['admin', 'bo@bevel.software', ACTIVE],
    ]);
    expect(within(rowOf('bo@bevel.software')).getByText('Signs in with Duende Demo, now an admin')).toBeInTheDocument();
  });

  it('leaves an existing admin as they are when invited as Admin', async () => {
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('bo@bevel.software')]);
    fetchRolesMock.mockResolvedValue([{ canonical: 'admin', members: ['juan@bevel.software', 'bo@bevel.software'] }]);
    const { input } = await mountDialog();
    await userEvent.type(input, 'bo@bevel.software{Enter}');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(addMemberMock).not.toHaveBeenCalled();
    expect(screen.getByText('Signs in with Duende Demo, already an admin')).toBeInTheDocument();
  });

  it('says "no seat left" on the row the deployment refused for want of a place', async () => {
    createAccountMock.mockImplementation(async (email) => {
      if (email === 'bo@bevel.software') throw new AccountRequestError('No seat left on this plan', 403, 'admission');
      return {};
    });
    const { input, onInvited } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}bo@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));

    await screen.findByRole('dialog', { name: '1 person is invited' });
    const bo = rowOf('bo@bevel.software');
    expect(within(bo).getByText('Not invited: no seat left')).toBeInTheDocument();
    expect(within(bo).getByText('No seat left on this plan')).toBeInTheDocument();
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it('reads a 403 that is not an admission refusal (the admin check) as an error, not "no seat left"', async () => {
    createAccountMock.mockRejectedValue(new AccountRequestError('Admins only', 403));
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    await screen.findByRole('dialog', { name: 'Nobody was invited' });
    expect(screen.queryByText('Not invited: no seat left')).not.toBeInTheDocument();
    expect(screen.getByText('Not invited')).toBeInTheDocument();
    expect(screen.getByText('Admins only')).toBeInTheDocument();
  });

  it('does not claim a switched-off account can sign in, or count it as invited', async () => {
    listAccountsMock.mockResolvedValue([
      account('juan@bevel.software'),
      account('bo@bevel.software', { deactivatedAt: '2026-09-01T00:00:00Z' }),
    ]);
    const { input, onInvited } = await mountDialog();
    await userEvent.type(input, 'bo@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    await screen.findByRole('dialog', { name: 'Nobody was invited' });
    expect(createAccountMock).not.toHaveBeenCalled();
    const bo = rowOf('bo@bevel.software');
    expect(within(bo).getByText('Account switched off')).toBeInTheDocument();
    expect(within(bo).getByText('Can’t sign in until it’s switched on in User accounts')).toBeInTheDocument();
    expect(screen.queryByText('Where they sign in')).not.toBeInTheDocument();
    expect(onInvited).not.toHaveBeenCalled();
  });

  it('shows any other refusal in the server’s words', async () => {
    createAccountMock.mockRejectedValue(new AccountRequestError('Invalid email', 400));
    const { input, onInvited } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    await screen.findByRole('dialog', { name: 'Nobody was invited' });
    expect(screen.getByText('Not invited')).toBeInTheDocument();
    expect(screen.getByText('Invalid email')).toBeInTheDocument();
    expect(screen.queryByText('Where they sign in')).not.toBeInTheDocument();
    expect(onInvited).not.toHaveBeenCalled();
  });

  it('with single sign-on and no password, names the provider in the message, with no password reminder', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });

    const origin = window.location.origin;
    expect(screen.getByText(origin)).toBeInTheDocument();
    expect(screen.getByText(/^I’ve added you to/)).toHaveTextContent(
      `Sign in at ${origin} with Duende Demo, then connect your agent from the welcome page.`,
    );
    expect(screen.queryByText(/Send them the password you set/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copyMock).toHaveBeenCalledWith(origin);
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    copyMock.mockResolvedValue(false);
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(copyMock).toHaveBeenLastCalledWith(expect.stringContaining('I’ve added you to'));
    expect(await screen.findByText('Couldn’t copy: select the text and copy it yourself.')).toBeInTheDocument();
  });

  it('goes back to an empty form on "Invite more people"', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Invite more people' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
    expect(chips()).toEqual([]);
  });
});

describe('InviteDialog: a starting password', () => {
  /** The five cases of mock screen 05, on a deployment without single sign-on. */
  async function sendFive(role: 'member' | 'admin' = 'member') {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    listAccountsMock.mockResolvedValue([
      account('juan@bevel.software', { hasPassword: true }),
      account('priya@acme.com'),
      account('sam@acme.com', { hasPassword: true }),
      account('olga@acme.com', { deactivatedAt: '2026-09-01T00:00:00Z' }),
    ]);
    const view = await mountDialog();
    fireEvent.paste(view.input, {
      clipboardData: { getData: () => 'lena@acme.com, tom@acme.com, priya@acme.com, sam@acme.com, olga@acme.com' },
    });
    if (role === 'admin') await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 5 people' }));
    await screen.findByRole('dialog', { name: '4 people are invited' });
    return view;
  }

  it('is given to every new account and to an existing one with none; never to one with its own or one switched off', async () => {
    const { onInvited } = await sendFive();
    expect(createAccountMock.mock.calls).toEqual([
      ['lena@acme.com', '', SECRET, KEEP],
      ['tom@acme.com', '', SECRET, KEEP],
      ['priya@acme.com', '', SECRET, KEEP],
    ]);
    expect(onInvited).toHaveBeenCalledTimes(1);

    expect(within(rowOf('lena@acme.com')).getByText('Member · signs in with the password you set')).toBeInTheDocument();
    expect(within(rowOf('tom@acme.com')).getByText('Member · signs in with the password you set')).toBeInTheDocument();
    expect(within(rowOf('priya@acme.com')).getByText('Had no password: now uses the one you set')).toBeInTheDocument();
    expect(within(rowOf('sam@acme.com')).getByText('Signs in with their own password (unchanged)')).toBeInTheDocument();
    expect(within(rowOf('olga@acme.com')).getByText('Account switched off')).toBeInTheDocument();
    expect(screen.getByText('They can sign in now. Send them the link and the password.')).toBeInTheDocument();
  });

  it('is given to Admin invites alike, and they are made admins as before — the switched-off one left unchanged', async () => {
    await sendFive('admin');
    expect(createAccountMock.mock.calls.map((c) => c[2])).toEqual([SECRET, SECRET, SECRET]);
    expect(addMemberMock.mock.calls.map((c) => c[1])).toEqual([
      'lena@acme.com',
      'tom@acme.com',
      'priya@acme.com',
      'sam@acme.com',
    ]);
    expect(within(rowOf('olga@acme.com')).getByText('Account switched off')).toBeInTheDocument();
    expect(within(rowOf('lena@acme.com')).getByText('Admin · signs in with the password you set')).toBeInTheDocument();
  });

  it('says to send the password separately, and the message says to change it — without ever holding it', async () => {
    await sendFive();
    const reminder = screen.getByText('Send them the password you set, separately.');
    expect(reminder.parentElement).toHaveTextContent(
      'It isn’t in the message below, so the message is safe to post in a shared channel.',
    );
    const origin = window.location.origin;
    const message = screen.getByText(/^I’ve added you to/);
    // Above the message.
    expect(reminder.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(message).toHaveTextContent(
      `Sign in at ${origin} with your work email and the password I’ll send you separately. Then change it on your Account page and connect your agent from the welcome page.`,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(copyMock).toHaveBeenCalledTimes(2);
    for (const [text] of copyMock.mock.calls) expect(text).not.toContain(SECRET);

    // Not shown again, and not kept in the browser.
    expect(document.body.textContent).not.toContain(SECRET);
    expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
    expect(JSON.stringify({ ...localStorage })).not.toContain(SECRET);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
  });

  it('is never logged', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    await sendFive();
    for (const spy of spies) {
      for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(SECRET);
      spy.mockRestore();
    }
  });

  it('"Invite more people" clears the password and the option', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'ana@bevel.software{Enter}');
    await userEvent.click(screen.getByLabelText('Also give them a password'));
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Invite more people' }));

    expect(screen.getByLabelText('Also give them a password')).not.toBeChecked();
    expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Also give them a password'));
    expect(passwordField()).toHaveValue('');
  });

  it('without single sign-on, "Invite more people" leaves the password field empty', async () => {
    await sendFive();
    await userEvent.click(screen.getByRole('button', { name: 'Invite more people' }));
    expect(passwordField()).toHaveValue('');
  });

  it('with single sign-on, names both ways in on the rows, the reminder and the message', async () => {
    const { input } = await mountDialog();
    await userEvent.type(input, 'lena@acme.com{Enter}');
    await userEvent.click(screen.getByLabelText('Also give them a password'));
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });

    expect(createAccountMock).toHaveBeenCalledWith('lena@acme.com', '', SECRET, KEEP);
    expect(within(rowOf('lena@acme.com')).getByText('Member · signs in with Duende Demo or password')).toBeInTheDocument();
    expect(screen.getByText('Send them the password you set, separately.')).toBeInTheDocument();
    expect(screen.getByText(/^I’ve added you to/)).toHaveTextContent(
      `Sign in at ${window.location.origin} with Duende Demo, or with your work email and the password I’ll send you separately (change it on your Account page). Then connect your agent from the welcome page.`,
    );
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('without a password, gives nobody one — new or existing', async () => {
    listAccountsMock.mockResolvedValue([account('priya@acme.com')]);
    const { input } = await mountDialog();
    await userEvent.type(input, 'lena@acme.com{Enter}priya@acme.com{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));
    await screen.findByRole('dialog', { name: '2 people are invited' });
    expect(createAccountMock.mock.calls).toEqual([['lena@acme.com', '']]);
    expect(screen.queryByText('Send them the password you set, separately.')).not.toBeInTheDocument();
  });

  it('when setting it on an existing account fails, leaves that account as it was and gives the server’s reason', async () => {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    listAccountsMock.mockResolvedValue([account('priya@acme.com')]);
    createAccountMock.mockImplementation(async (email) => {
      if (email === 'priya@acme.com') throw new AccountRequestError('Password too common', 400);
      return {};
    });
    const { input } = await mountDialog();
    await userEvent.type(input, 'lena@acme.com{Enter}priya@acme.com{Enter}');
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 2 people' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });

    const priya = rowOf('priya@acme.com');
    expect(within(priya).getByText('Password not set')).toBeInTheDocument();
    expect(within(priya).getByText('Couldn’t set the password: Password too common')).toBeInTheDocument();
    // Left as it was: not made an admin either.
    expect(addMemberMock.mock.calls).toEqual([['admin', 'lena@acme.com', ACTIVE]]);
  });

  it('when setting it fails on an account that has single sign-on, still counts it as invited and says how it signs in', async () => {
    listAccountsMock.mockResolvedValue([account('priya@acme.com')]);
    createAccountMock.mockRejectedValue(new AccountRequestError('Password too common', 400));
    const { input } = await mountDialog();
    await userEvent.type(input, 'priya@acme.com{Enter}');
    await userEvent.click(screen.getByLabelText('Also give them a password'));
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(
      within(rowOf('priya@acme.com')).getByText('Couldn’t set the password: Password too common · signs in with Duende Demo'),
    ).toBeInTheDocument();
  });

  it('reports an account that got its own password after the list was read as keeping it', async () => {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    listAccountsMock.mockResolvedValue([account('priya@acme.com')]);
    createAccountMock.mockResolvedValue({ passwordSet: false });
    const { input } = await mountDialog();
    await userEvent.type(input, 'priya@acme.com{Enter}');
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(createAccountMock).toHaveBeenCalledWith('priya@acme.com', '', SECRET, KEEP);
    expect(within(rowOf('priya@acme.com')).getByText('Signs in with their own password (unchanged)')).toBeInTheDocument();
    expect(screen.queryByText('Send them the password you set, separately.')).not.toBeInTheDocument();
  });

  it('when the account list cannot be read, sends nothing and offers Retry, keeping what was typed', async () => {
    providersMock.mockResolvedValue(PASSWORD_ONLY);
    listAccountsMock.mockRejectedValueOnce(new Error('Could not load accounts'));
    const { input, onInvited } = await mountDialog();
    await userEvent.type(input, 'lena@acme.com{Enter}');
    await userEvent.type(passwordField(), SECRET);
    await userEvent.click(screen.getByRole('button', { name: 'Invite 1 person' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nothing was sent: couldn’t check who already has an account.',
    );
    expect(createAccountMock).not.toHaveBeenCalled();
    expect(addMemberMock).not.toHaveBeenCalled();
    expect(onInvited).not.toHaveBeenCalled();
    expect(chips()).toEqual(['lena@acme.com']);
    expect(passwordField()).toHaveValue(SECRET);

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(createAccountMock).toHaveBeenCalledWith('lena@acme.com', '', SECRET, KEEP);
  });
});

describe('InviteDialog: the registry slot', () => {
  it('renders inviteExtras with the number of valid addresses entered', async () => {
    const Extras = ({ inviting }: { inviting: number }) => <p>Seats after invites: {inviting}</p>;
    const { input } = await mountDialog({ registry: makeRegistry({ inviteExtras: Extras }) });
    expect(screen.getByText('Seats after invites: 0')).toBeInTheDocument();
    await userEvent.type(input, 'ana@bevel.software{Enter}nope{Enter}bo@bevel.software');
    expect(screen.getByText('Seats after invites: 2')).toBeInTheDocument();
  });

  it('keeps the form when the slot throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const Broken = () => {
      throw new Error('boom');
    };
    await mountDialog({ registry: makeRegistry({ inviteExtras: Broken }) });
    expect(screen.getByRole('alert')).toHaveTextContent('The invite panel couldn’t be shown.');
    expect(screen.getByLabelText('Emails')).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
