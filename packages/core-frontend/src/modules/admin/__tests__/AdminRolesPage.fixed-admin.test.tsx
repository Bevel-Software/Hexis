import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminRolesPage } from '../components/AdminRolesPage';
import { AdminContext } from '../state/admin.context';
import {
  addMember,
  assignGroup,
  convertRoleToGroup,
  fetchRoles,
  removeMember,
  unassignGroup,
  type RoleRosterEntry,
} from '../services/roles.api';

vi.mock('../services/roles.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/roles.api')>();
  return {
    ...actual,
    fetchRoles: vi.fn(),
    addMember: vi.fn(),
    removeMember: vi.fn(),
    assignGroup: vi.fn(),
    unassignGroup: vi.fn(),
    convertRoleToGroup: vi.fn(),
  };
});
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, suggestPrincipals: vi.fn() };
});
import { suggestPrincipals } from '../../access/api';

const OWNER = 'owner@bevel.software';
const NOTE = 'Deployment admin, set in the server configuration; cannot be removed here';

/** Admin as the backend now reports it: a fixed member plus editable ones. */
function adminRole(over: Partial<RoleRosterEntry> = {}): RoleRosterEntry {
  return {
    canonical: 'admin',
    displayName: 'Admin',
    members: ['razvan@bevel.software'],
    fixedMembers: [OWNER],
    groups: [],
    capability: { description: 'Full administrative access.', groupAssignable: true },
    isAdmin: true,
    referencedBy: [],
    ...over,
  };
}

const SALES: RoleRosterEntry = {
  canonical: 'sales',
  displayName: 'Sales',
  members: ['felix@example.com'],
  fixedMembers: [],
  groups: [],
  capability: null,
  isAdmin: false,
  referencedBy: [],
};

function renderPage() {
  return render(
    <AdminContext.Provider
      value={{
        isAdmin: true,
        unreadCount: 0,
        lastSeen: null,
        markSeen: () => {},
        refresh: () => {},
        rolesConfigCorrupted: false,
        rolesConfigErrors: [],
        runRolesRecovery: async () => {},
      }}
    >
      <AdminRolesPage />
    </AdminContext.Provider>,
  );
}

async function findCard(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name });
  return heading.closest('div.rounded-lg') as HTMLElement;
}

beforeEach(() => {
  vi.mocked(suggestPrincipals)
    .mockReset()
    .mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
  vi.mocked(fetchRoles).mockReset().mockResolvedValue([adminRole(), SALES]);
  vi.mocked(addMember).mockReset().mockResolvedValue([adminRole(), SALES]);
  vi.mocked(removeMember).mockReset().mockResolvedValue([adminRole(), SALES]);
  vi.mocked(assignGroup).mockReset().mockResolvedValue([adminRole(), SALES]);
  vi.mocked(unassignGroup).mockReset().mockResolvedValue([adminRole(), SALES]);
  vi.mocked(convertRoleToGroup).mockReset().mockResolvedValue([adminRole(), SALES]);
});

describe('AdminRolesPage: the deployment admin is a fixed Admin member', () => {
  it('lists the deployment admin under Admin with the note and no remove control', async () => {
    renderPage();
    const card = within(await findCard('Admin'));
    expect(card.getByText(OWNER)).toBeInTheDocument();
    // The explanation is VISIBLE on the card, not just a tooltip.
    expect(card.getByText(`${NOTE}.`)).toBeInTheDocument();
    // No X for that address — the one editable member still has one.
    expect(card.queryByRole('button', { name: `Remove ${OWNER}` })).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Remove razvan@bevel.software' })).toBeInTheDocument();
  });

  it('renders an address named by BOTH roles.yaml and the server config exactly once, as fixed', async () => {
    // The normal deployment: seeding wrote ADMIN_EMAIL into roles.yaml, so the
    // backend reports it in `members` AND `fixedMembers`.
    vi.mocked(fetchRoles).mockResolvedValue([
      adminRole({ members: [OWNER, 'razvan@bevel.software'] }),
      SALES,
    ]);
    renderPage();
    const card = await findCard('Admin');
    expect(within(card).getAllByText(OWNER)).toHaveLength(1);
    expect(within(card).queryByRole('button', { name: `Remove ${OWNER}` })).not.toBeInTheDocument();
  });

  it('still allows removing the last EDITABLE admin when the file names the fixed one too', async () => {
    // Regression guard for the chip filtering: `roles.yaml` has two direct
    // members, so the >=1-direct-email invariant does not bite — hiding the
    // fixed chip must not make the UI think there is only one.
    vi.mocked(fetchRoles).mockResolvedValue([
      adminRole({ members: [OWNER, 'razvan@bevel.software'] }),
      SALES,
    ]);
    renderPage();
    const card = within(await findCard('Admin'));
    await userEvent.click(card.getByRole('button', { name: 'Remove razvan@bevel.software' }));
    await waitFor(() =>
      expect(removeMember).toHaveBeenCalledWith('admin', 'razvan@bevel.software'),
    );
  });

  it('keeps the last-direct-member guard when the fixed address is the only one in the file', async () => {
    vi.mocked(fetchRoles).mockResolvedValue([adminRole({ members: ['razvan@bevel.software'] }), SALES]);
    renderPage();
    const card = within(await findCard('Admin'));
    expect(card.getByRole('button', { name: 'Remove razvan@bevel.software' })).toBeDisabled();
  });

  it('refuses to add the deployment admin as a regular member, with the same explanation', async () => {
    renderPage();
    const card = within(await findCard('Admin'));
    await userEvent.type(card.getByRole('combobox', { name: 'Member email' }), OWNER);
    await userEvent.keyboard('{Enter}');

    expect(await card.findByText(`${NOTE}. ${OWNER} is already an Admin.`)).toBeInTheDocument();
    // Refused locally: no request, and no optimistic chip left behind.
    expect(addMember).not.toHaveBeenCalled();
    expect(card.getAllByText(OWNER)).toHaveLength(1);
  });

  it('surfaces the backend refusal verbatim if one reaches the page anyway', async () => {
    // A second admin could configure ADMIN_EMAIL between this page's load and
    // the submit — then only the server knows, and its 422 is the explanation.
    vi.mocked(fetchRoles).mockResolvedValue([adminRole({ fixedMembers: [] }), SALES]);
    vi.mocked(addMember).mockRejectedValue(
      new Error(`${NOTE}. ${OWNER} is always an Admin, so its Admin membership cannot be added or removed from this page.`),
    );
    renderPage();
    const card = await findCard('Admin');
    await userEvent.type(within(card).getByRole('combobox', { name: 'Member email' }), OWNER);
    await userEvent.keyboard('{Enter}');
    expect(await within(card).findByText(new RegExp(NOTE))).toBeInTheDocument();
  });

  it('shows no fixed member (and no note) on a role that has none', async () => {
    renderPage();
    const card = within(await findCard('Sales'));
    expect(card.queryByText(`${NOTE}.`)).not.toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Remove felix@example.com' })).toBeInTheDocument();
  });

  it('degrades to today’s behaviour when the backend omits fixedMembers', async () => {
    const legacyShape = { ...adminRole() } as Partial<RoleRosterEntry>;
    delete legacyShape.fixedMembers;
    vi.mocked(fetchRoles).mockResolvedValue([legacyShape as RoleRosterEntry, SALES]);
    renderPage();
    const card = within(await findCard('Admin'));
    expect(card.queryByText(`${NOTE}.`)).not.toBeInTheDocument();
    expect(card.getByText('razvan@bevel.software')).toBeInTheDocument();
  });
});
