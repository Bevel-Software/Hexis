import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvitationRequest } from '@bevel-software/platform-shared';
import { AuthContext, type AuthContextValue, type LoginProviders } from '../../auth';
import { AdminContext, type AdminContextValue } from '../../admin';
import { AppRegistryContext, makeRegistry } from '../../../core/registry';
import { InviteDialog } from '../components/InviteDialog';
import { InviteDialogProvider } from '../state/invite-dialog';
import { useInviteDialog } from '../state/invite-dialog.context';
import { splitEmails } from '../invite-emails';

/**
 * The invite dialog: addresses become chips the way people paste them; the
 * dialog asks how the deployment signs people in before it lets anything be
 * sent; only an admin chooses the Role; nobody types a password — the server
 * generates one where one is needed, and the result view shows it once, on
 * its row, with a Copy button, and never in the message to forward.
 *
 * The server is stood in for at the one place every request leaves through
 * (`lib/api`'s `authFetch`, and `fetch` for the unauthenticated sign-in
 * probe), so the dialog's own services run as they do in the app.
 */

const { authFetchMock, copyMock } = vi.hoisted(() => ({
  authFetchMock: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  copyMock: vi.fn<(text: string) => Promise<boolean>>(),
}));
vi.mock('../../../lib/api', () => ({ authFetch: authFetchMock, getToken: () => 'test-token', setToken: () => {} }));
vi.mock('../../../lib/clipboard', () => ({ copyToClipboard: copyMock }));

const DUENDE = { key: 'oidc', label: 'Duende Demo', startPath: '/api/auth/oidc/start' };
/** Password sign-in, no single sign-on (knowledge.bevel.software). */
const PASSWORD_ONLY: LoginProviders = { password: true, sso: [] };
/** Single sign-on and password sign-in (core-staging). */
const SSO_AND_PASSWORD: LoginProviders = { password: true, sso: [DUENDE] };
/** Single sign-on only: password sign-in is off. */
const SSO_ONLY: LoginProviders = { password: false, sso: [DUENDE] };

const GENERATED = 'K7mPq2Rx9vTw4Hn8';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** What the sign-in probe answers; a function so a test can fail or hold it. */
let providers: () => Promise<Response>;
/** Addresses the stand-in server already has an account for. */
let existing: Set<string>;
/** Per-address answers that override the default for one invitation. */
let invitationAnswers: Map<string, () => Response>;
/** Admins on the roster. */
let admins: string[];
/** Channels the deployment's listeners answer for a new account. */
let notified: string[];
/** Every invitation request the dialog sent, in order. */
let invitations: InvitationRequest[];
/** Every Admin promotion the dialog sent, in order. */
let promotions: { email: string; ifActive?: boolean }[];

function answerProviders(methods: LoginProviders) {
  providers = async () => json(200, methods);
}

beforeEach(() => {
  answerProviders(SSO_AND_PASSWORD);
  existing = new Set();
  invitationAnswers = new Map();
  admins = ['juan@bevel.software'];
  notified = [];
  invitations = [];
  promotions = [];
  copyMock.mockReset().mockResolvedValue(true);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/providers') return providers();
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
  authFetchMock.mockReset().mockImplementation(async (url, init) => {
    if (url === '/api/invitations') {
      const request = JSON.parse(String(init?.body)) as InvitationRequest;
      invitations.push(request);
      const answer = invitationAnswers.get(request.email);
      if (answer) return answer();
      if (existing.has(request.email)) return json(200, { status: 'existing' });
      return json(201, {
        status: 'created',
        account: { id: `id-${request.email}`, email: request.email, name: request.email.split('@')[0] },
        ...(request.startingPassword ? { startingPassword: GENERATED } : {}),
        notified,
      });
    }
    if (url === '/api/access/roles') return json(200, { roles: [{ canonical: 'admin', members: admins }] });
    if (url === '/api/access/roles/admin/members') {
      promotions.push(JSON.parse(String(init?.body)));
      return json(200, { roles: [] });
    }
    throw new Error(`unexpected authFetch ${url}`);
  });
  localStorage.clear();
  sessionStorage.clear();
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

/** Mount the dialog and wait until it knows how people sign in (or that it can't). */
async function mountDialog(
  opts: {
    registry?: ReturnType<typeof makeRegistry>;
    initialEmails?: string[];
    settle?: boolean;
    admin?: boolean;
  } = {},
) {
  const onInvited = vi.fn();
  const onClose = vi.fn();
  render(
    <AppRegistryContext.Provider value={opts.registry ?? makeRegistry({})}>
      <AuthContext.Provider value={authValue()}>
        <AdminContext.Provider value={adminValue(opts.admin ?? true)}>
          <InviteDialog open onClose={onClose} onInvited={onInvited} initialEmails={opts.initialEmails} />
        </AdminContext.Provider>
      </AuthContext.Provider>
    </AppRegistryContext.Provider>,
  );
  if (opts.settle !== false) {
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

function rowOf(email: string): HTMLElement {
  return within(screen.getByRole('list', { name: 'People' })).getByText(email).closest('li')!;
}

/** Chip each address as a person types it, then press the send button by its label. */
async function invite(input: HTMLElement, addresses: string[], button: string) {
  await userEvent.type(input, addresses.map((a) => `${a}{Enter}`).join(''));
  await userEvent.click(screen.getByRole('button', { name: button }));
}

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

describe('InviteDialog: the Role choice is an admin’s', () => {
  it('an admin sees Member and Admin', async () => {
    await mountDialog({ admin: true });
    const role = screen.getByLabelText('Role');
    expect(within(role).getAllByRole('option').map((o) => o.textContent)).toEqual(['Member', 'Admin']);
  });

  it('anyone else sees no Role picker, and invites as Member', async () => {
    answerProviders(PASSWORD_ONLY);
    const { input } = await mountDialog({ admin: false });
    expect(screen.queryByLabelText('Role')).not.toBeInTheDocument();
    await invite(input, ['ana@acme.com'], 'Invite 1 person');
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(invitations).toEqual([{ email: 'ana@acme.com', role: 'member', startingPassword: true }]);
    // Their own row says what they are.
    expect(within(rowOf('Juan Viera (you)')).getByText('Member')).toBeInTheDocument();
  });
});

describe('InviteDialog: how people sign in here', () => {
  it('stays disabled while it is still asking', async () => {
    providers = () => new Promise(() => {});
    await mountDialog({ initialEmails: ['ana@bevel.software'], settle: false });
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
  });

  it('has no starting-password field in any mode', async () => {
    for (const methods of [PASSWORD_ONLY, SSO_AND_PASSWORD, SSO_ONLY]) {
      answerProviders(methods);
      await mountDialog();
      expect(screen.queryByLabelText('Starting password')).not.toBeInTheDocument();
      expect(document.querySelector('input[type="password"]')).toBeNull();
      cleanup();
    }
  });

  it('without single sign-on, asks the server for a generated password for every address', async () => {
    answerProviders(PASSWORD_ONLY);
    const { input } = await mountDialog();
    expect(
      screen.getByText('They sign in with their email and a password made for them. You see it once, after you invite, to pass on.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Also give them a password')).not.toBeInTheDocument();
    await invite(input, ['ana@acme.com', 'bo@acme.com'], 'Invite 2 people');
    await screen.findByRole('dialog', { name: '2 people are invited' });
    expect(invitations.map((i) => i.startingPassword)).toEqual([true, true]);
  });

  it('with single sign-on, "Also give them a password" is off by default and asks for a generated one once ticked', async () => {
    const { input } = await mountDialog();
    const option = screen.getByLabelText('Also give them a password');
    expect(option).not.toBeChecked();
    expect(screen.getByText('They sign in with Duende Demo.')).toBeInTheDocument();
    await userEvent.click(option);
    expect(
      screen.getByText('They sign in with Duende Demo, or with their email and a password made for them. You see it once, after you invite.'),
    ).toBeInTheDocument();
    await invite(input, ['ana@acme.com'], 'Invite 1 person');
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(invitations).toEqual([{ email: 'ana@acme.com', role: 'member', startingPassword: true }]);
  });

  it('with single sign-on and the option off, asks for no password', async () => {
    const { input } = await mountDialog();
    await invite(input, ['ana@acme.com'], 'Invite 1 person');
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(invitations).toEqual([{ email: 'ana@acme.com', role: 'member', startingPassword: false }]);
    expect(screen.queryByRole('button', { name: /^Copy password/ })).not.toBeInTheDocument();
  });

  it('names several single sign-on providers', async () => {
    answerProviders({ password: true, sso: [DUENDE, { key: 'ms', label: 'Microsoft', startPath: '/api/auth/ms/start' }] });
    await mountDialog();
    expect(screen.getByText('They sign in with Duende Demo or Microsoft.')).toBeInTheDocument();
  });

  it('with password sign-in off, offers no password and asks for none', async () => {
    answerProviders(SSO_ONLY);
    const { input } = await mountDialog();
    expect(screen.queryByLabelText('Also give them a password')).not.toBeInTheDocument();
    await invite(input, ['ana@acme.com'], 'Invite 1 person');
    await screen.findByRole('dialog', { name: '1 person is invited' });
    expect(invitations).toEqual([{ email: 'ana@acme.com', role: 'member', startingPassword: false }]);
  });

  it('with password sign-in off and no single sign-on either, sends nothing and says why', async () => {
    answerProviders({ password: false, sso: [] });
    await mountDialog({ initialEmails: ['ana@bevel.software'], settle: false });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Nobody could sign in: password sign-in is off here and no single sign-on is set up.',
    );
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
  });

  it('when the check fails, keeps Invite disabled with Retry, and a successful Retry enables the form', async () => {
    providers = async () => json(500, {});
    await mountDialog({ initialEmails: ['ana@bevel.software'] });
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t check how people sign in here.');
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeDisabled();
    answerProviders(PASSWORD_ONLY);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/^They sign in with their email and a password made for them/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite 1 person' })).toBeEnabled();
  });
});

describe('InviteDialog: sending', () => {
  it('invites each valid address in order, and says who already had an account, untouched', async () => {
    existing = new Set(['old@acme.com']);
    const { input, onInvited } = await mountDialog();
    await invite(input, ['new@acme.com', 'old@acme.com'], 'Invite 2 people');
    await screen.findByRole('dialog', { name: '2 people are invited' });
    expect(invitations.map((i) => i.email)).toEqual(['new@acme.com', 'old@acme.com']);
    expect(within(rowOf('new@acme.com')).getByText('Hasn’t signed in yet')).toBeInTheDocument();
    expect(within(rowOf('old@acme.com')).getByText('Already has an account')).toBeInTheDocument();
    expect(within(rowOf('old@acme.com')).getByText('Unchanged: signs in as before')).toBeInTheDocument();
    expect(onInvited).toHaveBeenCalledTimes(1);
  });

  it('an admin’s Admin invite promotes new and existing accounts through the roles route, ifActive', async () => {
    existing = new Set(['old@acme.com']);
    const { input } = await mountDialog({ admin: true });
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin');
    await invite(input, ['new@acme.com', 'old@acme.com'], 'Invite 2 people');
    await screen.findByRole('dialog', { name: '2 people are invited' });
    expect(invitations.map((i) => i.role)).toEqual(['admin', 'admin']);
    expect(promotions).toEqual([
      { email: 'new@acme.com', ifActive: true },
      { email: 'old@acme.com', ifActive: true },
    ]);
    expect(within(rowOf('old@acme.com')).getByText('Unchanged: signs in as before, now an admin')).toBeInTheDocument();
  });

  it('says "no seat left" on the row the deployment refused for want of a place', async () => {
    invitationAnswers.set('full@acme.com', () => json(403, { error: 'Your plan has no seat left', kind: 'admission' }));
    const { input } = await mountDialog({ admin: false });
    await invite(input, ['full@acme.com'], 'Invite 1 person');
    await screen.findByRole('dialog', { name: 'Nobody was invited' });
    expect(within(rowOf('full@acme.com')).getByText('Not invited: no seat left')).toBeInTheDocument();
    expect(within(rowOf('full@acme.com')).getByText('Your plan has no seat left')).toBeInTheDocument();
  });

  it('reads a 403 that is not an admission refusal as an error in the server’s words', async () => {
    invitationAnswers.set('x@acme.com', () => json(403, { error: 'Only an admin can invite someone as Admin' }));
    const { input } = await mountDialog();
    await invite(input, ['x@acme.com'], 'Invite 1 person');
    await screen.findByRole('dialog', { name: 'Nobody was invited' });
    expect(within(rowOf('x@acme.com')).getByText('Not invited')).toBeInTheDocument();
    expect(within(rowOf('x@acme.com')).getByText('Only an admin can invite someone as Admin')).toBeInTheDocument();
  });
});

describe('InviteDialog: the generated password, shown once', () => {
  async function sendPasswordOnly(addresses: string[]) {
    answerProviders(PASSWORD_ONLY);
    const view = await mountDialog({ admin: false });
    await invite(view.input, addresses, addresses.length === 1 ? 'Invite 1 person' : `Invite ${addresses.length} people`);
    await screen.findByRole('dialog', { name: /invited$/ });
    return view;
  }

  it('shows the password on the created row with a Copy button that copies it', async () => {
    await sendPasswordOnly(['ana@acme.com']);
    const row = rowOf('ana@acme.com');
    expect(within(row).getByText(GENERATED)).toBeInTheDocument();
    expect(within(row).getByText('Member · signs in with the password below')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Copy password for ana@acme.com' }));
    expect(copyMock).toHaveBeenCalledWith(GENERATED);
    expect(within(row).getByRole('button', { name: 'Copy password for ana@acme.com' })).toHaveTextContent('Copied');
  });

  it('shows no password on a row whose account was already there', async () => {
    existing = new Set(['old@acme.com']);
    await sendPasswordOnly(['ana@acme.com', 'old@acme.com']);
    expect(within(rowOf('old@acme.com')).queryByRole('button', { name: /^Copy password/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(GENERATED)).toHaveLength(1);
  });

  it('keeps it out of the message to forward, which says it comes separately', async () => {
    await sendPasswordOnly(['ana@acme.com']);
    const message = screen.getByText(/^I’ve added you to/);
    expect(message.textContent).not.toContain(GENERATED);
    expect(message).toHaveTextContent('the password I’ll send you separately');
    expect(screen.getByText('Copy the password on its row now: it isn’t shown again.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(copyMock).toHaveBeenLastCalledWith(expect.not.stringContaining(GENERATED));
  });

  it('is gone after "Invite more people", and not shown again', async () => {
    await sendPasswordOnly(['ana@acme.com']);
    await userEvent.click(screen.getByRole('button', { name: 'Invite more people' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
    expect(screen.queryByText(GENERATED)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(GENERATED);
  });

  it('is gone after Done: the provider unmounts the dialog, and opening it again starts empty', async () => {
    function Opener() {
      const controller = useInviteDialog();
      return (
        <button type="button" onClick={() => controller?.open()}>
          Open
        </button>
      );
    }
    answerProviders(PASSWORD_ONLY);
    render(
      <AppRegistryContext.Provider value={makeRegistry({})}>
        <AuthContext.Provider value={authValue()}>
          <AdminContext.Provider value={adminValue(false)}>
            <InviteDialogProvider>
              <Opener />
            </InviteDialogProvider>
          </AdminContext.Provider>
        </AuthContext.Provider>
      </AppRegistryContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    const input = await screen.findByLabelText('Emails');
    await screen.findByText(/^They sign in with/);
    await invite(input, ['ana@acme.com'], 'Invite 1 person');
    await screen.findByText(GENERATED);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain(GENERATED);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('dialog', { name: 'Invite your team' });
    expect(document.body.textContent).not.toContain(GENERATED);
  });

  it('on a row the deployment emailed, says so and still shows the password', async () => {
    notified = ['email'];
    await sendPasswordOnly(['ana@acme.com', 'bo@acme.com']);
    const row = rowOf('ana@acme.com');
    expect(within(row).getByText('Emailed · Member · signs in with the password below')).toBeInTheDocument();
    expect(within(row).getByText(GENERATED)).toBeInTheDocument();
    expect(screen.getByText('They have been emailed the link and how to sign in.')).toBeInTheDocument();
    // The mail was the message: the link stays, the message to forward goes.
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument();
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
