import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionKeysPage } from '../components/ConnectionKeysPage';
import { groupByAccount } from '../components/connection-keys-grouping';
import { AdminContext } from '../state/admin.context';
import {
  listConnectionKeys,
  revokeConnectionKey,
  type AdminConnectionKey,
} from '../services/connection-keys.api';

vi.mock('../services/connection-keys.api', () => ({
  listConnectionKeys: vi.fn(),
  revokeConnectionKey: vi.fn(),
}));

const ALICE = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const BOB = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const ALICE_CI: AdminConnectionKey = {
  id: 'k-ci',
  label: 'CI pipeline',
  kind: 'key',
  createdAt: NOW - 10 * DAY,
  lastUsedAt: NOW - 2 * 60 * 60 * 1000,
  revokedAt: null,
  revokedBy: null,
  user: ALICE,
};
const ALICE_LAPTOP: AdminConnectionKey = {
  id: 'k-laptop',
  label: 'Laptop',
  kind: 'key',
  createdAt: NOW - 3 * DAY,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
  user: ALICE,
};
const BOB_OLD: AdminConnectionKey = {
  id: 'k-old',
  label: 'Old script',
  kind: 'key',
  createdAt: NOW - 40 * DAY,
  lastUsedAt: NOW - 30 * DAY,
  revokedAt: NOW - 20 * DAY,
  revokedBy: 'owner',
  user: BOB,
};
const BOB_LINK: AdminConnectionKey = {
  id: 'k-link',
  label: 'Claude',
  kind: 'github-link',
  createdAt: NOW - 1 * DAY,
  lastUsedAt: NOW - 60 * 1000,
  revokedAt: null,
  revokedBy: null,
  user: BOB,
};

function renderPage(opts: { isAdmin?: boolean } = {}) {
  return render(
    <AdminContext.Provider
      value={{
        isAdmin: opts.isAdmin ?? true,
        unreadCount: 0,
        lastSeen: null,
        markSeen: () => {},
        refresh: () => {},
        rolesConfigCorrupted: false,
        rolesConfigErrors: [],
        runRolesRecovery: async () => {},
      }}
    >
      <ConnectionKeysPage />
    </AdminContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(listConnectionKeys)
    .mockReset()
    .mockResolvedValue([ALICE_LAPTOP, ALICE_CI, BOB_OLD, BOB_LINK]);
  vi.mocked(revokeConnectionKey).mockReset().mockResolvedValue(undefined);
});

describe('groupByAccount', () => {
  it('groups in server order, live keys first, most recently used at the top', () => {
    const groups = groupByAccount([ALICE_LAPTOP, ALICE_CI, BOB_OLD, BOB_LINK], true);
    expect(groups.map((g) => g.user.id)).toEqual(['u-alice', 'u-bob']);
    // Alice: CI was used, Laptop never → CI first despite Laptop being newer.
    expect(groups[0].keys.map((k) => k.id)).toEqual(['k-ci', 'k-laptop']);
    // Bob: the live link outranks the revoked key.
    expect(groups[1].keys.map((k) => k.id)).toEqual(['k-link', 'k-old']);
  });

  it('drops revoked keys (and accounts left empty) when they are hidden', () => {
    const groups = groupByAccount([BOB_OLD, ALICE_CI], false);
    expect(groups.map((g) => g.user.id)).toEqual(['u-alice']);
  });
});

describe('ConnectionKeysPage', () => {
  it('shows the admins-only state (and never loads) for non-admins', () => {
    renderPage({ isAdmin: false });
    expect(screen.getByText(/Admins only/)).toBeInTheDocument();
    expect(listConnectionKeys).not.toHaveBeenCalled();
  });

  it('lists live keys per account with created / last used, hiding disconnected ones by default', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    const alice = screen.getByRole('region', { name: 'Keys for alice@example.com' });
    expect(within(alice).getByText('Alice')).toBeInTheDocument();
    expect(within(alice).getByText('Created 1w ago')).toBeInTheDocument();
    expect(within(alice).getByText('Last used 2h ago')).toBeInTheDocument();
    expect(within(alice).getByText('Created 3d ago')).toBeInTheDocument();
    expect(within(alice).getByText('Last used never')).toBeInTheDocument();
    expect(
      within(alice).getByRole('button', { name: 'Revoke CI pipeline for alice@example.com' }),
    ).toBeInTheDocument();

    const bob = screen.getByRole('region', { name: 'Keys for bob@example.com' });
    expect(within(bob).getByText('Claude link')).toBeInTheDocument();
    expect(within(bob).queryByText('Old script')).not.toBeInTheDocument();

    expect(screen.getByText(/3 live keys · 1 disconnected/)).toBeInTheDocument();
  });

  it('reveals disconnected keys, without a revoke button, when toggled', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show disconnected keys' }));

    const bob = screen.getByRole('region', { name: 'Keys for bob@example.com' });
    expect(within(bob).getByText('Old script')).toBeInTheDocument();
    expect(within(bob).getByText(/Disconnected by owner 2w ago/)).toBeInTheDocument();
    expect(
      within(bob).queryByRole('button', { name: 'Revoke Old script for bob@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('revokes after confirmation and reloads the list', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke CI pipeline for alice@example.com' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Alice \(alice@example.com\)/)).toBeInTheDocument();
    expect(revokeConnectionKey).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(revokeConnectionKey).toHaveBeenCalledWith('k-ci'));
    await waitFor(() => expect(listConnectionKeys).toHaveBeenCalledTimes(2));
  });

  it('cancelling the confirm revokes nothing', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke CI pipeline for alice@example.com' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(revokeConnectionKey).not.toHaveBeenCalled();
    expect(listConnectionKeys).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed revoke inline and keeps the rows it had', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());
    vi.mocked(revokeConnectionKey).mockRejectedValueOnce(new Error('Token not found'));

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke CI pipeline for alice@example.com' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke key' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Token not found');
    expect(screen.getByText('CI pipeline')).toBeInTheDocument();
  });

  it('keeps a revoked key disconnected when the reload after revoking fails', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());
    vi.mocked(listConnectionKeys).mockRejectedValueOnce(new Error('Could not load connection keys'));

    await userEvent.click(
      screen.getByRole('button', { name: 'Revoke CI pipeline for alice@example.com' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke key' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load connection keys');
    // The server said yes, so the row is disconnected regardless of the reload:
    // hidden with the other disconnected keys, and never offering Revoke again.
    expect(
      screen.queryByRole('button', { name: 'Revoke CI pipeline for alice@example.com' }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show disconnected keys' }));
    expect(screen.getByText('CI pipeline')).toBeInTheDocument();
    expect(screen.getByText(/2 live keys · 2 disconnected/)).toBeInTheDocument();
  });

  it('ignores a stale list response that lands after a newer one', async () => {
    // Two revokes back to back: the reload from the FIRST resolves last, still
    // showing the second key as live. It must not win over the newer reload.
    const deferred = () => {
      let resolve!: (rows: AdminConnectionKey[]) => void;
      const promise = new Promise<AdminConnectionKey[]>((r) => (resolve = r));
      return { promise, resolve };
    };
    const first = deferred();
    const second = deferred();
    vi.mocked(listConnectionKeys)
      .mockReset()
      .mockResolvedValueOnce([ALICE_CI, ALICE_LAPTOP])
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderPage();
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    const revoke = async (name: string) => {
      await userEvent.click(screen.getByRole('button', { name }));
      await userEvent.click(
        within(await screen.findByRole('dialog')).getByRole('button', { name: 'Revoke key' }),
      );
    };
    await revoke('Revoke CI pipeline for alice@example.com');
    await revoke('Revoke Laptop for alice@example.com');
    await waitFor(() => expect(listConnectionKeys).toHaveBeenCalledTimes(3));

    const ciRevoked = { ...ALICE_CI, revokedAt: NOW };
    second.resolve([ciRevoked, { ...ALICE_LAPTOP, revokedAt: NOW }]);
    await waitFor(() => expect(screen.getByText(/0 live keys · 2 disconnected/)).toBeInTheDocument());

    // The stale reload: taken at face value, Laptop would come back to life.
    first.resolve([ciRevoked, ALICE_LAPTOP]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/0 live keys · 2 disconnected/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Revoke Laptop for alice@example.com' }),
    ).not.toBeInTheDocument();
  });

  it('shows the load error and no empty state when the first load fails', async () => {
    vi.mocked(listConnectionKeys).mockRejectedValueOnce(new Error('Could not load connection keys'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load connection keys');
    expect(screen.queryByText(/No connection keys/)).not.toBeInTheDocument();
  });
});
