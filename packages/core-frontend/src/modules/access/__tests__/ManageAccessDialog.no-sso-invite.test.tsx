import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { AccessResponse } from '../api';
import type { LoginProviders } from '../../auth';
import { AdminContext, type AdminContextValue } from '../../admin';
import type { InviteDialogController } from '../../onboarding';

const api = vi.hoisted(() => ({
  fetchFileAccess: vi.fn(),
  grantAccess: vi.fn(),
  revokeAccess: vi.fn(),
  suggestPrincipals: vi.fn(),
}));
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, ...api };
});
// The sign-in probe is a plain `fetch` of `/api/auth/providers`; the other
// modules are stood in for at their entries.
const { providersMock, invite } = vi.hoisted(() => ({
  providersMock: vi.fn<() => Promise<LoginProviders>>(),
  invite: { current: null as InviteDialogController | null },
}));
vi.mock('../../workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace')>()),
  useWorkspace: () => ({ workspaceId: 'ws-1', kbDirName: 'knowledge-base' }),
}));
vi.mock('../../auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth')>()),
  useAuth: () => ({ user: { email: 'me@x.com', name: 'Me' } }),
}));
vi.mock('../../onboarding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../onboarding')>()),
  useInviteDialog: () => invite.current,
}));

import { ManageAccessDialog } from '../components/ManageAccessDialog';

/**
 * Manage access on a deployment with no single sign-on: an address with no
 * account cannot sign in until someone invites it, so the row says so, and
 * offers anyone viewing (admin or not) an Invite action that opens the
 * Invite dialog with that address. The grant saves exactly as before. With single sign-on, or when the sign-in methods could not be
 * read, the note is today's.
 */

const KB = 'knowledge-base';
const ENTRY: FileTreeEntry = {
  name: 'Deal.md',
  relativePath: `${KB}/Sales/Deal.md`,
  type: 'file',
} as unknown as FileTreeEntry;

const KNOWN = { name: 'Alice', email: 'alice@x.com' };
const UNKNOWN = { name: 'new.hire', email: 'new.hire@x.com' };
const TODAY_NOTE = /hasn't signed in yet/i;
const TODAY_HELP =
  'No account for this email yet. The grant is saved and takes effect the moment they first sign in — if you did not expect this, check the spelling.';
const ADMIN_HELP = "No account yet. They can't sign in until you invite them.";

const viewWith = (users: { name: string; email: string; hasAccount?: boolean }[]): AccessResponse =>
  ({
    canRead: true,
    canWrite: true,
    canDownload: false,
    canOwner: false,
    eligible: { roles: [], users: [] },
    readers: { restricted: true, roles: [], users },
    owners: { roles: [], users: [] },
    downloaders: { roles: [], users: [] },
    sources: Object.fromEntries(
      users.map((u) => [`u:${u.email.toLowerCase()}`, { read: [{ kind: 'direct' }] }]),
    ),
  }) as AccessResponse;

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

function mount(isAdmin: boolean) {
  const controller: InviteDialogController = { open: vi.fn(), invitedRevision: 0 };
  invite.current = controller;
  render(
    <AdminContext.Provider value={adminValue(isAdmin)}>
      <ManageAccessDialog entry={ENTRY} onClose={() => {}} />
    </AdminContext.Provider>,
  );
  return controller;
}

async function rowFor(name: string): Promise<HTMLElement> {
  const label = await screen.findByText(name);
  const row = label.closest('div.flex.flex-wrap');
  if (!row) throw new Error(`no row around ${name}`);
  return row as HTMLElement;
}

function chipFor(label: string): HTMLElement {
  return screen.getByRole('button', { name: `Remove ${label}` }).parentElement!;
}

/**
 * Type an unknown address into the picker, chip it, check the chip's help
 * (`title`) while it is still on screen — Share removes it — and Share.
 */
async function grantToUnknown(title: string) {
  const user = userEvent.setup();
  const input = await screen.findByPlaceholderText('Add people, groups, roles or plugins…');
  await user.type(input, UNKNOWN.email);
  await waitFor(() => expect(api.suggestPrincipals).toHaveBeenCalled());
  await user.keyboard('{Enter}');
  expect(within(chipFor(UNKNOWN.name)).getByText(TODAY_NOTE)).toHaveAttribute('title', title);
  await user.click(screen.getByRole('button', { name: /^share$/i }));
  await waitFor(() => expect(api.grantAccess).toHaveBeenCalled());
  expect(api.grantAccess).toHaveBeenCalledWith(
    'ws-1',
    expect.objectContaining({
      principal: { kind: 'user', email: UNKNOWN.email, displayName: UNKNOWN.name },
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchFileAccess.mockResolvedValue(
    viewWith([
      { ...KNOWN, hasAccount: true },
      { ...UNKNOWN, hasAccount: false },
    ]),
  );
  api.grantAccess.mockResolvedValue(viewWith([]));
  api.suggestPrincipals.mockResolvedValue({
    roles: [],
    groups: [],
    people: [],
    peopleWithheld: false,
    accountsKnown: true,
  });
  providersMock.mockResolvedValue({ password: true, sso: [] });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/api/auth/providers') throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify(await providersMock()), { status: 200 });
    }),
  );
});

describe('ManageAccessDialog, no single sign-on', () => {
  it('an admin reads that they can’t sign in until invited, and Invite opens the dialog with the address', async () => {
    const invite = mount(true);
    const row = await rowFor(UNKNOWN.name);
    expect(await within(row).findByText(ADMIN_HELP)).toBeInTheDocument();
    expect(within(row).queryByText(TODAY_NOTE)).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: `Invite ${UNKNOWN.email}` }));
    expect(invite.open).toHaveBeenCalledWith({ emails: [UNKNOWN.email] });
    // Someone with an account gets neither.
    const known = await rowFor(KNOWN.name);
    expect(within(known).queryByRole('button', { name: /^Invite/ })).toBeNull();
    expect(within(known).queryByText(ADMIN_HELP)).toBeNull();
  });

  it('anyone else reads the same, and Invite opens the dialog with the address for them too', async () => {
    const invite = mount(false);
    const row = await rowFor(UNKNOWN.name);
    expect(await within(row).findByText(ADMIN_HELP)).toBeInTheDocument();
    expect(within(row).queryByText(/until an admin invites them/)).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: `Invite ${UNKNOWN.email}` }));
    expect(invite.open).toHaveBeenCalledWith({ emails: [UNKNOWN.email] });
  });

  it('the grant saves as today, and the new chip carries the same help — for an admin', async () => {
    mount(true);
    await screen.findByText(ADMIN_HELP);
    await grantToUnknown(ADMIN_HELP);
  });

  it('the grant saves as today, and the new chip carries the same help — for anyone else', async () => {
    mount(false);
    await screen.findByText(ADMIN_HELP);
    await grantToUnknown(ADMIN_HELP);
  });
});

describe('ManageAccessDialog keeps today’s note', () => {
  it('on a deployment with password sign-in off and no single sign-on, where an invite would not let anyone in', async () => {
    providersMock.mockResolvedValue({ password: false, sso: [] });
    mount(true);
    await waitFor(() => expect(providersMock).toHaveBeenCalled());
    const row = await rowFor(UNKNOWN.name);
    await waitFor(() => expect(within(row).getByText(TODAY_NOTE)).toHaveAttribute('title', TODAY_HELP));
    expect(within(row).queryByText(ADMIN_HELP)).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Invite/ })).toBeNull();
  });

  it('on a deployment with single sign-on', async () => {
    providersMock.mockResolvedValue({
      password: true,
      sso: [{ key: 'oidc', label: 'Duende Demo', startPath: '/api/auth/oidc/start' }],
    });
    mount(true);
    await waitFor(() => expect(providersMock).toHaveBeenCalled());
    const row = await rowFor(UNKNOWN.name);
    await waitFor(() => expect(within(row).getByText(TODAY_NOTE)).toHaveAttribute('title', TODAY_HELP));
    expect(within(row).queryByText(ADMIN_HELP)).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Invite/ })).toBeNull();
    await grantToUnknown(TODAY_HELP);
  });

  it('when the sign-in methods could not be read', async () => {
    providersMock.mockRejectedValue(new Error('offline'));
    mount(true);
    await waitFor(() => expect(providersMock).toHaveBeenCalled());
    const row = await rowFor(UNKNOWN.name);
    expect(within(row).getByText(TODAY_NOTE)).toHaveAttribute('title', TODAY_HELP);
    expect(within(row).queryByText(ADMIN_HELP)).toBeNull();
    expect(within(row).queryByRole('button', { name: /^Invite/ })).toBeNull();
  });
});
