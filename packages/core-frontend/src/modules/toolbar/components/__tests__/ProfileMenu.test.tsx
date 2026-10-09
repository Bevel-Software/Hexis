import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';
import { AdminContext } from '../../../admin/state/admin.context';
import type { AdminMenuItem } from '../../../../core/registry';
import { ProfileMenu } from '../ProfileMenu';

// Every admin row hidden from this person — not reachable with today's core
// rows, which are always shown, so the sections are stubbed here.
const hidden = (id: string, label: string): AdminMenuItem => ({
  id,
  section: 'admin',
  label,
  path: `/${id}`,
  isShown: () => false,
});

vi.mock('../../../settings/settings-nav-items', () => ({
  useMenuSections: () => ({
    defaultItems: [{ id: 'account', label: 'Account', path: '/account' }],
    adminItems: [hidden('hidden-a', 'Hidden A'), hidden('hidden-b', 'Hidden B')],
  }),
}));

const auth: AuthContextValue = {
  user: { id: 'user-1', email: 'user@example.com', name: 'Test User', avatarUrl: '' },
  token: 'token',
  isLoading: false,
  login: async () => {},
  logout: () => {},
};

describe('ProfileMenu', () => {
  it('draws no Admin only section when every admin row is hidden', async () => {
    render(
      <MemoryRouter>
        <AuthContext.Provider value={auth}>
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
            <ProfileMenu />
          </AdminContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Test User' }));
    const panel = screen.getByRole('group', { name: 'You and your settings' });
    expect(within(panel).getByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(within(panel).queryByText('Admin only')).toBeNull();
    expect(within(panel).queryByRole('group')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /Hidden/ })).toBeNull();
  });
});
