import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from '../components/UpdateBanner';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { fetchUpdateCheck } from '../services/update-check.api';

vi.mock('../services/update-check.api', () => ({
  fetchUpdateCheck: vi.fn(),
}));

const fetchUpdateCheckMock = vi.mocked(fetchUpdateCheck);

function adminContext(overrides: Partial<AdminContextValue> = {}): AdminContextValue {
  return {
    isAdmin: true,
    isAdminLoading: false,
    unreadCount: 0,
    lastSeen: null,
    markSeen: () => {},
    refresh: () => {},
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: async () => {},
    ...overrides,
  };
}

function renderBanner(ctx: AdminContextValue) {
  return render(
    <AdminContext.Provider value={ctx}>
      <UpdateBanner />
    </AdminContext.Provider>,
  );
}

beforeEach(() => {
  fetchUpdateCheckMock.mockReset();
  // test-setup clears localStorage between tests already.
});

describe('UpdateBanner', () => {
  it('shows the quiet line with the release-notes link for an admin', async () => {
    fetchUpdateCheckMock.mockResolvedValue({
      updateAvailable: true,
      current: '0.9.1',
      latest: '0.10.0',
      notesUrl: 'https://github.com/Bevel-Software/Hexis/releases/tag/v0.10.0',
    });
    renderBanner(adminContext());
    await waitFor(() =>
      expect(screen.getByText(/Hexis 0\.10\.0 is available/)).toBeInTheDocument(),
    );
    const link = screen.getByRole('link', { name: /see what's new/ });
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/Bevel-Software/Hexis/releases/tag/v0.10.0',
    );
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('dismiss hides it, and the dismissal sticks per VERSION across mounts', async () => {
    fetchUpdateCheckMock.mockResolvedValue({
      updateAvailable: true,
      current: '0.9.1',
      latest: '0.10.0',
      notesUrl: 'https://example.invalid/notes',
    });
    const { unmount } = renderBanner(adminContext());
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // A fresh mount (a reload) with the SAME version stays dismissed…
    unmount();
    renderBanner(adminContext());
    await waitFor(() => expect(fetchUpdateCheckMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // …and a NEWER release resurfaces the banner.
    fetchUpdateCheckMock.mockResolvedValue({
      updateAvailable: true,
      current: '0.9.1',
      latest: '0.10.1',
      notesUrl: 'https://example.invalid/notes',
    });
    renderBanner(adminContext());
    await waitFor(() =>
      expect(screen.getByText(/Hexis 0\.10\.1 is available/)).toBeInTheDocument(),
    );
  });

  it('non-admins never fetch and never render', async () => {
    renderBanner(adminContext({ isAdmin: false }));
    // Give any stray effect a tick to fire before asserting it did not.
    await Promise.resolve();
    expect(fetchUpdateCheckMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('waits out the admin verdict rather than fetching for everyone', async () => {
    renderBanner(adminContext({ isAdmin: false, isAdminLoading: true }));
    await Promise.resolve();
    expect(fetchUpdateCheckMock).not.toHaveBeenCalled();
  });

  it('renders nothing while up to date', async () => {
    fetchUpdateCheckMock.mockResolvedValue({ updateAvailable: false, current: '0.9.1' });
    renderBanner(adminContext());
    await waitFor(() => expect(fetchUpdateCheckMock).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
