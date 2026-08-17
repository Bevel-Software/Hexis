import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminRolesPage } from '../components/AdminRolesPage';
import { AdminContext } from '../state/admin.context';
import {
  assignGroup,
  convertRoleToGroup,
  fetchRoles,
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
    createRole: vi.fn(),
    deleteRole: vi.fn(),
    renameRole: vi.fn(),
    assignGroup: vi.fn(),
    unassignGroup: vi.fn(),
    convertRoleToGroup: vi.fn(),
  };
});
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, suggestPrincipals: vi.fn() };
});

const ADMIN: RoleRosterEntry = {
  canonical: 'admin',
  displayName: 'Admin',
  members: ['root@example.com'],
  groups: [],
  capability: { description: 'Full administrative access.', groupAssignable: false },
  isAdmin: true,
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

beforeEach(() => {
  vi.mocked(fetchRoles).mockReset().mockResolvedValue([ADMIN, EDITOR, LEGACY]);
  vi.mocked(assignGroup).mockReset().mockResolvedValue([ADMIN, EDITOR, LEGACY]);
  vi.mocked(unassignGroup).mockReset().mockResolvedValue([ADMIN, EDITOR, LEGACY]);
  vi.mocked(convertRoleToGroup).mockReset().mockResolvedValue([ADMIN, EDITOR]);
});

describe('AdminRolesPage: capabilities, groups, and legacy conversion', () => {
  it('renders the capability description under a role that has one', async () => {
    renderPage();
    expect(await screen.findByText('Full administrative access.')).toBeInTheDocument();
    expect(screen.getByText('Can edit everything.')).toBeInTheDocument();
  });

  it('Admin has no group-assignment UI and no Convert action', async () => {
    renderPage();
    const adminCard = within(await findCard('Admin'));
    expect(adminCard.queryByRole('textbox', { name: 'Assign group' })).not.toBeInTheDocument();
    expect(adminCard.queryByText('Assigned groups')).not.toBeInTheDocument();
    expect(
      adminCard.queryByRole('button', { name: 'Convert to group' }),
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
