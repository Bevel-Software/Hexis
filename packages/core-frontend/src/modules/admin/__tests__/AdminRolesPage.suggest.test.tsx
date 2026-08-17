import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminRolesPage } from '../components/AdminRolesPage';
import { AdminContext } from '../state/admin.context';
import { fetchRoles, type RoleRosterEntry } from '../services/roles.api';
import { suggestPrincipals } from '../../access/api';

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
  };
});
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return { ...actual, suggestPrincipals: vi.fn() };
});

const ENGINEERING: RoleRosterEntry = {
  canonical: 'engineering',
  displayName: 'Engineering',
  members: [],
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

beforeEach(() => {
  vi.mocked(fetchRoles).mockReset().mockResolvedValue([ENGINEERING]);
  vi.mocked(suggestPrincipals)
    .mockReset()
    .mockResolvedValue({
      plugins: [],
      people: [{ name: 'Alice', email: 'alice@example.com' }],
      peopleWithheld: false,
    });
});

describe('AdminRolesPage: add-member autocomplete', () => {
  it('caps the suggestion list at its wrapper so it cannot overflow the card', async () => {
    const user = userEvent.setup();
    renderPage();

    const input = await screen.findByRole('textbox', { name: 'Member email' });
    await user.type(input, 'al');

    // The suggest fetch is debounced 200ms; wait for the list to materialise.
    const alice = await screen.findByText(
      'alice@example.com',
      undefined,
      { timeout: 2000 },
    );
    const list = alice.closest('ul')!;

    // The wrapper is `flex-1 min-w-0 max-w-[16rem]` and can shrink below
    // 16rem; the list forces `sm:w-72` (18rem) at the sm breakpoint. Without
    // `max-w-full` the absolutely-positioned list escapes the shrinking
    // wrapper and runs past the card border on narrow viewports.
    expect(list.className).toContain('max-w-full');
  });
});
