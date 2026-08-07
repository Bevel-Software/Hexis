import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AdminProvider, useAdmin } from '../state/admin.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import { AppRegistryContext, makeRegistry } from '../../../core/registry';

vi.mock('../services/admin.api', () => ({
  fetchAdminAccess: vi.fn().mockResolvedValue({ isAdmin: true, rolesConfig: { ok: true } }),
}));

const auth = {
  user: { id: 'u1', email: 'root@example.com', name: 'Root' },
  token: 't',
  isLoading: false,
  login: async () => {},
  logout: () => {},
} as AuthContextValue;

function Badge() {
  return <span data-testid="count">{useAdmin().unreadCount}</span>;
}

function renderWith(registry: ReturnType<typeof makeRegistry>) {
  return render(
    <AuthContext.Provider value={auth}>
      <AppRegistryContext.Provider value={registry}>
        <AdminProvider>
          <Badge />
        </AdminProvider>
      </AppRegistryContext.Provider>
    </AuthContext.Provider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ count: 0 }) });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

/**
 * The badge counts an ENTERPRISE inbox. Core polled its endpoint every thirty
 * seconds anyway — a guaranteed 404 on every core deployment, forever, filling
 * the console of the one screen an operator opens when something is wrong.
 */
describe('AdminProvider: the unread badge', () => {
  it('makes no request at all when nothing is counting', async () => {
    renderWith(makeRegistry({}));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    const asked = fetchSpy.mock.calls.some((call) => String(call[0]).includes('unread-count'));
    expect(asked).toBe(false);
  });

  it('uses the counter an overlay registers', async () => {
    const adminUnreadCount = vi.fn().mockResolvedValue(7);
    renderWith(makeRegistry({ adminUnreadCount }));
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('7'));
    expect(adminUnreadCount).toHaveBeenCalled();
  });
});
