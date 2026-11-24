import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { AdminRolesPage } from '../components/AdminRolesPage';
import { AdminContext } from '../state/admin.context';
import { fetchRoles, type RoleRosterEntry } from '../services/roles.api';

vi.mock('../services/roles.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/roles.api')>();
  return { ...actual, fetchRoles: vi.fn() };
});

const BOT = 'delivery-mechanic@agent.hexis';
const PERSON = 'razvan@bevel.software';

function role(over: Partial<RoleRosterEntry>): RoleRosterEntry {
  return {
    canonical: 'admin',
    displayName: 'Admin',
    members: [PERSON, BOT],
    bots: [BOT],
    fixedMembers: [],
    fixedMembersNote: null,
    groups: [],
    capability: { description: 'Full administrative access.', groupAssignable: true },
    isAdmin: true,
    referencedBy: [],
    ...over,
  };
}

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

async function chipOf(email: string): Promise<HTMLElement> {
  const card = (await screen.findByRole('heading', { name: 'Admin' })).closest('div.rounded-lg') as HTMLElement;
  return within(card).getByText(email).parentElement as HTMLElement;
}

beforeEach(() => {
  vi.mocked(fetchRoles).mockReset();
});

describe('AdminRolesPage: a bot written under a role', () => {
  it('is marked "Bot" and a person beside it is not', async () => {
    vi.mocked(fetchRoles).mockResolvedValue([role({})]);
    renderPage();
    expect(within(await chipOf(BOT)).getByText('Bot')).toBeInTheDocument();
    // No person initials on the bot's chip: it is never shown as a person.
    expect(within(await chipOf(BOT)).queryByText('DE')).not.toBeInTheDocument();
    expect(within(await chipOf(PERSON)).queryByText('Bot')).not.toBeInTheDocument();
    // It can still be removed: the line grants it nothing, and an admin may clean it up.
    expect(screen.getByRole('button', { name: `Remove ${BOT}` })).toBeInTheDocument();
  });

  it('marks nobody when an older server sends no bots list', async () => {
    vi.mocked(fetchRoles).mockResolvedValue([role({ bots: undefined })]);
    renderPage();
    expect(within(await chipOf(BOT)).queryByText('Bot')).not.toBeInTheDocument();
  });
});
