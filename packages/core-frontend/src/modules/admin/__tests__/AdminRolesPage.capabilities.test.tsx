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
  RolesApiError,
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

// Matches the real registry: Admin IS group-assignable — the backend's
// parse-time invariant (≥1 direct email member) is what keeps a directory
// outage from ever locking the deployment out, not a UI refusal.
const ADMIN: RoleRosterEntry = {
  canonical: 'admin',
  displayName: 'Admin',
  members: ['root@example.com'],
  groups: [],
  capability: { description: 'Full administrative access.', groupAssignable: true },
  isAdmin: true,
  referencedBy: [],
};

// A capability role whose registry entry opts out of group assignment.
const OPTED_OUT: RoleRosterEntry = {
  canonical: 'auditor',
  displayName: 'Auditor',
  members: [],
  groups: [],
  capability: { description: 'Read-only audit access.', groupAssignable: false },
  isAdmin: false,
  referencedBy: [],
};

const EDITOR: RoleRosterEntry = {
  canonical: 'editor',
  displayName: 'Editor',
  members: [],
  groups: ['engineering'],
  capability: { description: 'Can edit everything.', groupAssignable: true },
  isAdmin: false,
  referencedBy: [],
};

// A legacy people-set role: no capability behind it — gets the Convert action.
const LEGACY: RoleRosterEntry = {
  canonical: 'product',
  displayName: 'Product',
  members: ['pat@example.com'],
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

/** The card that owns a role heading — scopes queries to one role's row. */
async function findCard(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name });
  return heading.closest('div.rounded-lg') as HTMLElement;
}

const ALL = [ADMIN, OPTED_OUT, EDITOR, LEGACY];

beforeEach(() => {
  vi.mocked(suggestPrincipals)
    .mockReset()
    .mockResolvedValue({ roles: [], groups: [], people: [], peopleWithheld: false });
  vi.mocked(fetchRoles).mockReset().mockResolvedValue(ALL);
  vi.mocked(addMember).mockReset().mockResolvedValue(ALL);
  vi.mocked(removeMember).mockReset().mockResolvedValue(ALL);
  vi.mocked(assignGroup).mockReset().mockResolvedValue(ALL);
  vi.mocked(unassignGroup).mockReset().mockResolvedValue(ALL);
  vi.mocked(convertRoleToGroup).mockReset().mockResolvedValue([ADMIN, OPTED_OUT, EDITOR]);
});

describe('AdminRolesPage: capabilities, groups, and legacy conversion', () => {
  it('renders the capability description under a role that has one', async () => {
    renderPage();
    expect(await screen.findByText('Full administrative access.')).toBeInTheDocument();
    expect(screen.getByText('Can edit everything.')).toBeInTheDocument();
  });

  it('group assignment follows the roster payload: Admin (assignable) gets the control, an opted-out role does not', async () => {
    renderPage();
    // Admin: the registry says groupAssignable — the UI offers assignment
    // (the ≥1-direct-email invariant is the backend's guard, not a UI ban)
    // but NEVER a Convert action (it is a capability role).
    const adminCard = within(await findCard('Admin'));
    expect(adminCard.getByRole('textbox', { name: 'Assign group' })).toBeInTheDocument();
    expect(
      adminCard.queryByRole('button', { name: 'Convert to group' }),
    ).not.toBeInTheDocument();
    // Opted out in the registry: no assignment UI, no Convert either.
    const optedOutCard = within(await findCard('Auditor'));
    expect(optedOutCard.queryByRole('textbox', { name: 'Assign group' })).not.toBeInTheDocument();
    expect(optedOutCard.queryByText('Assigned groups')).not.toBeInTheDocument();
    expect(
      optedOutCard.queryByRole('button', { name: 'Convert to group' }),
    ).not.toBeInTheDocument();
  });

  it('renders group chips and assigns a group through the endpoint', async () => {
    renderPage();
    const editorCard = within(await findCard('Editor'));
    expect(editorCard.getByText('engineering')).toBeInTheDocument();

    await userEvent.type(editorCard.getByRole('textbox', { name: 'Assign group' }), 'design');
    await userEvent.click(editorCard.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(assignGroup).toHaveBeenCalledWith('editor', 'design'));
  });

  it('removes a group chip through the endpoint', async () => {
    renderPage();
    const editorCard = within(await findCard('Editor'));
    await userEvent.click(editorCard.getByRole('button', { name: 'Remove group engineering' }));
    await waitFor(() => expect(unassignGroup).toHaveBeenCalledWith('editor', 'engineering'));
  });

  it('a legacy role WITHOUT assignments gets Convert and no assigned-groups section', async () => {
    renderPage();
    const legacyCard = within(await findCard('Product'));
    expect(legacyCard.getByRole('button', { name: 'Convert to group' })).toBeInTheDocument();
    // Nothing assigned and nothing assignable — no section at all. Offering
    // the assign input here would dead-end the Convert path (a group-assigned
    // role can't be converted).
    expect(legacyCard.queryByText('Assigned groups')).not.toBeInTheDocument();
    expect(legacyCard.queryByRole('textbox', { name: 'Assign group' })).not.toBeInTheDocument();
  });

  it('a legacy role WITH assignments keeps the chips and remove control — but no add input', async () => {
    // A legacy role can already carry assignments (hand-edited roles.yaml, or
    // assigned before the gating existed). convertRoleToGroup refuses until
    // they're removed, so the unassign controls MUST stay reachable.
    const legacyAssigned: RoleRosterEntry = { ...LEGACY, groups: ['engineering'] };
    vi.mocked(fetchRoles).mockResolvedValue([ADMIN, EDITOR, legacyAssigned]);
    renderPage();
    const legacyCard = within(await findCard('Product'));
    expect(legacyCard.getByText('Assigned groups')).toBeInTheDocument();
    expect(legacyCard.getByText('engineering')).toBeInTheDocument();
    // The add input stays hidden — only removal is offered on a legacy role.
    expect(legacyCard.queryByRole('textbox', { name: 'Assign group' })).not.toBeInTheDocument();
    expect(legacyCard.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
    // The remove control works and hits the endpoint.
    await userEvent.click(legacyCard.getByRole('button', { name: 'Remove group engineering' }));
    await waitFor(() => expect(unassignGroup).toHaveBeenCalledWith('product', 'engineering'));
  });

  it('legacy role converts only after an explicit confirm, refreshing from the response', async () => {
    renderPage();
    const legacyCard = within(await findCard('Product'));
    await userEvent.click(legacyCard.getByRole('button', { name: 'Convert to group' }));
    expect(convertRoleToGroup).not.toHaveBeenCalled();

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Grants keep working/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(convertRoleToGroup).toHaveBeenCalledWith('product'));
    // The response no longer contains the role — its card is gone.
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Product' })).not.toBeInTheDocument(),
    );
  });

  it('a convert refusal surfaces the backend message on the card', async () => {
    vi.mocked(convertRoleToGroup).mockRejectedValue(
      new Error('A group named "product" already exists.'),
    );
    renderPage();
    const card = await findCard('Product');
    await userEvent.click(within(card).getByRole('button', { name: 'Convert to group' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Convert' }),
    );
    expect(
      await within(card).findByText('A group named "product" already exists.'),
    ).toBeInTheDocument();
  });

  it('non-Admin roles with a capability do not offer Convert', async () => {
    renderPage();
    const editorCard = within(await findCard('Editor'));
    expect(
      editorCard.queryByRole('button', { name: 'Convert to group' }),
    ).not.toBeInTheDocument();
  });
});

describe('AdminRolesPage: membership-only surface', () => {
  it('offers NO create / rename / delete affordances — roles are app-defined', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Admin' });
    // Roles cannot be minted, rebranded, or retired from the UI (the backend
    // routes are gone too): no New-role control, no rename pencil, no trash.
    expect(screen.queryByRole('button', { name: /new role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /new role name/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rename role/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete role/i })).not.toBeInTheDocument();
    // What remains is membership: member emails and (where assignable) groups.
    const adminCard = within(await findCard('Admin'));
    expect(adminCard.getByRole('textbox', { name: 'Member email' })).toBeInTheDocument();
  });

  it('the Admin ≥1-direct-email 422 renders the backend message inline on the card', async () => {
    // Two direct members, so the client-side last-member disable does not
    // trip — the backend is the authority (e.g. a concurrent edit already
    // removed the other member) and answers 422 with the invariant message.
    const adminTwo: RoleRosterEntry = {
      ...ADMIN,
      members: ['root@example.com', 'second@example.com'],
    };
    vi.mocked(fetchRoles).mockResolvedValue([adminTwo, EDITOR]);
    const invariant =
      'The Admin role must keep at least one direct email member — group references alone are not enough.';
    vi.mocked(removeMember).mockRejectedValue(new RolesApiError(invariant, 422));

    renderPage();
    const adminCard = within(await findCard('Admin'));
    await userEvent.click(adminCard.getByRole('button', { name: 'Remove second@example.com' }));
    // The exact backend message, inline on the card — not a generic failure.
    expect(await adminCard.findByText(invariant)).toBeInTheDocument();
    // The optimistic hide rolled back: the member chip is visible again.
    expect(adminCard.getByText('second@example.com')).toBeInTheDocument();
  });

  it("a 'group:'-prefixed member value gets the inline hint and no request", async () => {
    renderPage();
    const editorCard = within(await findCard('Editor'));
    await userEvent.type(
      editorCard.getByRole('textbox', { name: 'Member email' }),
      'group:engineering',
    );
    await userEvent.click(editorCard.getByRole('button', { name: 'Add' }));
    expect(
      await editorCard.findByText(/Members are emails — to give this role to a group/),
    ).toBeInTheDocument();
    expect(addMember).not.toHaveBeenCalled();
  });
});
