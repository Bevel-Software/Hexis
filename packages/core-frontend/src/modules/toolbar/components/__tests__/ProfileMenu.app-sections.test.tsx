import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';
import { AdminContext } from '../../../admin/state/admin.context';
import { AppRegistryContext, makeRegistry, type AdminMenuItem } from '../../../../core/registry';
import { ProfileMenu } from '../ProfileMenu';

/**
 * The profile menu with sections of the app's own, as an app contributes them
 * through the registry: a labelled group between the default rows and "Admin
 * only", for whom each row's `isShown` names — admin or not — and no heading
 * for a section none of whose rows is offered.
 */

const INFRA = { id: 'infra', label: 'Infrastructure only', order: 10 };
const holder = (email: string) => (user: { email: string }) => user.email === email;

const rows: AdminMenuItem[] = [
  { id: 'agents-settings', section: INFRA, label: 'Agents', path: '/agents/settings', isShown: holder('ada@example.com') },
  { id: 'executors', section: INFRA, order: 5, label: 'Executors', path: '/agents/executors', isShown: holder('ada@example.com') },
  { id: 'billing', section: { id: 'billing', label: 'Billing only' }, label: 'Invoices', path: '/invoices', isShown: () => false },
];

function mount(email: string, isAdmin: boolean) {
  const auth: AuthContextValue = {
    user: { id: 'u', email, name: 'Ada Lovelace', avatarUrl: '' },
    token: 'token',
    isLoading: false,
    login: async () => {},
    logout: () => {},
  };
  render(
    <MemoryRouter>
      <AppRegistryContext.Provider value={makeRegistry({ adminMenuItems: rows })}>
        <AuthContext.Provider value={auth}>
          <AdminContext.Provider
            value={{
              isAdmin,
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
      </AppRegistryContext.Provider>
    </MemoryRouter>,
  );
}

describe('ProfileMenu: the app\'s own sections', () => {
  it('draws the section for a person its rows are for, admin or not, its rows in their order', async () => {
    mount('ada@example.com', false);
    await userEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
    const section = screen.getByRole('group', { name: 'Infrastructure only' });
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Executors', 'Agents']);
    // Not an admin: no Admin only section, and the section nobody is offered has no heading.
    expect(screen.queryByText('Admin only')).toBeNull();
    expect(screen.queryByText('Billing only')).toBeNull();
  });

  it('draws it for an admin its rows are for too, after the default rows and before Admin only', async () => {
    mount('ada@example.com', true);
    await userEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
    const section = screen.getByRole('group', { name: 'Infrastructure only' });
    const lastDefault = screen.getByRole('button', { name: 'Account' });
    const adminHeading = screen.getByText('Admin only');
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Executors', 'Agents']);
    expect(lastDefault.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(section.compareDocumentPosition(adminHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws nothing of it for anyone else, even an admin', async () => {
    mount('bob@example.com', true);
    await userEvent.click(screen.getByRole('button', { name: 'Ada Lovelace' }));
    expect(screen.queryByText('Infrastructure only')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Executors' })).toBeNull();
    expect(screen.getByText('Admin only')).toBeInTheDocument();
  });
});
