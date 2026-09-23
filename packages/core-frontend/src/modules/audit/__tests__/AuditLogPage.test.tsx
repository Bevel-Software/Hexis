import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuditLogPage } from '../components/AuditLogPage';
import { groupByAccount } from '../components/principal-grouping';
import { AdminContext } from '../../admin/state/admin.context';
import { AuthContext } from '../../auth/state/auth.context';
import {
  listPrincipals,
  listEvents,
  revokeAgent,
  revokeKey,
  type AgentEvent,
  type AuditPrincipal,
} from '../services/audit.api';

vi.mock('../services/audit.api', () => ({
  listPrincipals: vi.fn(),
  listEvents: vi.fn(),
  revokeAgent: vi.fn(),
  revokeKey: vi.fn(),
}));

const ALICE = { id: 'u-alice', email: 'alice@example.com', name: 'Alice' };
const BOB = { id: 'u-bob', email: 'bob@example.com', name: 'Bob' };

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const ALICE_CLAUDE: AuditPrincipal = {
  kind: 'agent',
  id: 'c-claude',
  label: 'Claude',
  createdAt: NOW - 12 * DAY,
  lastUsedAt: NOW - 4 * 60 * 1000,
  revokedAt: null,
  revokedBy: null,
  eventCount: 3,
  user: ALICE,
};
const ALICE_CI: AuditPrincipal = {
  kind: 'key',
  id: 'k-ci',
  label: 'CI pipeline',
  keyKind: 'key',
  createdAt: NOW - 10 * DAY,
  lastUsedAt: NOW - 2 * 60 * 60 * 1000,
  revokedAt: null,
  revokedBy: null,
  eventCount: 0,
  user: ALICE,
};
const BOB_OLD: AuditPrincipal = {
  kind: 'key',
  id: 'k-old',
  label: 'Old script',
  keyKind: 'key',
  createdAt: NOW - 40 * DAY,
  lastUsedAt: NOW - 30 * DAY,
  revokedAt: NOW - 20 * DAY,
  revokedBy: 'admin',
  eventCount: 18,
  user: BOB,
};
const BOB_LINK: AuditPrincipal = {
  kind: 'key',
  id: 'k-link',
  label: 'Claude',
  keyKind: 'github-link',
  createdAt: NOW - DAY,
  lastUsedAt: NOW - 60 * 1000,
  revokedAt: null,
  revokedBy: null,
  eventCount: 63,
  user: BOB,
};

const EVENTS: AgentEvent[] = [
  { id: 'e1', kind: 'capability', manual: null, name: 'grep', outcome: 'ok', at: NOW - 1000 },
  { id: 'e2', kind: 'tool', manual: 'notion', name: 'notion-search', outcome: 'error', at: NOW - 2000 },
  { id: 'e3', kind: 'skill', manual: 'Plugins/Sales/rfi', name: 'rfi', outcome: 'ok', at: NOW - 3000 },
  { id: 'e4', kind: 'tool', manual: 'slack', name: 'post_message', outcome: 'denied', at: NOW - 4000 },
];

function renderPage(opts: { isAdmin?: boolean; me?: typeof ALICE } = {}) {
  const me = opts.me ?? ALICE;
  return render(
    <MemoryRouter>
      <AuthContext.Provider
        value={{
          user: { id: me.id, email: me.email, name: me.name },
          token: 'jwt',
          isLoading: false,
          login: async () => {},
          logout: () => {},
        }}
      >
        <AdminContext.Provider
          value={{
            isAdmin: opts.isAdmin ?? false,
            isAdminLoading: false,
            unreadCount: 0,
            lastSeen: null,
            markSeen: () => {},
            refresh: () => {},
            rolesConfigCorrupted: false,
            rolesConfigErrors: [],
            runRolesRecovery: async () => {},
          }}
        >
          <AuditLogPage />
        </AdminContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(listPrincipals).mockReset().mockResolvedValue([ALICE_CLAUDE, ALICE_CI, BOB_LINK, BOB_OLD]);
  vi.mocked(listEvents).mockReset().mockResolvedValue({ events: EVENTS, total: 4, nextCursor: null });
  vi.mocked(revokeAgent).mockReset().mockResolvedValue(undefined);
  vi.mocked(revokeKey).mockReset().mockResolvedValue(undefined);
});

describe('groupByAccount', () => {
  it('groups in server order and drops revoked rows (and accounts left empty) when they are hidden', () => {
    const groups = groupByAccount([ALICE_CLAUDE, ALICE_CI, BOB_OLD], { includeRevoked: false });
    expect(groups.map((g) => g.user.id)).toEqual(['u-alice']);
    expect(groups[0].principals.map((p) => p.id)).toEqual(['c-claude', 'k-ci']);
    expect(groupByAccount([ALICE_CLAUDE, BOB_OLD], { includeRevoked: true }).map((g) => g.user.id)).toEqual(['u-alice', 'u-bob']);
  });

  it('narrows by person or by row label', () => {
    const all = [ALICE_CLAUDE, ALICE_CI, BOB_LINK];
    expect(groupByAccount(all, { includeRevoked: true, query: 'bob' }).map((g) => g.user.id)).toEqual(['u-bob']);
    const byLabel = groupByAccount(all, { includeRevoked: true, query: 'CI' });
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0].principals.map((p) => p.id)).toEqual(['k-ci']);
  });
});

describe('AuditLogPage', () => {
  it("asks for the member's own rows and lists them without account headers", async () => {
    vi.mocked(listPrincipals).mockResolvedValue([ALICE_CLAUDE, ALICE_CI]);
    renderPage({ isAdmin: false });
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    expect(listPrincipals).toHaveBeenCalledWith('me');
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('Agent · OAuth')).toBeInTheDocument();
    expect(screen.getByText('Connection key')).toBeInTheDocument();
    expect(screen.getByText(/Connected 1w ago/)).toBeInTheDocument();
    expect(screen.getByText(/3 events/)).toBeInTheDocument();
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
    // A member sees no per-account header: the page is theirs alone.
    expect(screen.queryByText('alice@example.com')).not.toBeInTheDocument();
    expect(screen.getByText(/2 live/)).toBeInTheDocument();
  });

  it('asks for every account for an admin, grouped per person, hiding revoked rows by default', async () => {
    renderPage({ isAdmin: true });
    await waitFor(() => expect(screen.getByText('CI pipeline')).toBeInTheDocument());

    expect(listPrincipals).toHaveBeenCalledWith('all');
    const alice = screen.getByRole('region', { name: 'Agents and keys for alice@example.com' });
    expect(within(alice).getByText('Alice')).toBeInTheDocument();
    expect(within(alice).getByText('CI pipeline')).toBeInTheDocument();
    const bob = screen.getByRole('region', { name: 'Agents and keys for bob@example.com' });
    expect(within(bob).getByText('Claude link')).toBeInTheDocument();
    expect(within(bob).queryByText('Old script')).not.toBeInTheDocument();
    expect(screen.getByText(/2 accounts · 3 live · 1 revoked/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Show revoked' }));
    expect(within(bob).getByText('Old script')).toBeInTheDocument();
    expect(within(bob).getByText('Revoked by an admin')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke key for Old script/ })).not.toBeInTheDocument();
  });

  it('expands a row to its events once, keeps them across a collapse, and filters them', async () => {
    vi.mocked(listPrincipals).mockResolvedValue([ALICE_CLAUDE]);
    renderPage();
    const row = await screen.findByRole('button', { name: /Claude/, expanded: false });

    await userEvent.click(row);
    await waitFor(() => expect(screen.getByText('grep')).toBeInTheDocument());
    expect(listEvents).toHaveBeenCalledWith('agent', 'c-claude', { limit: 50 });
    expect(row).toHaveAttribute('aria-expanded', 'true');

    // Skills and tools link to their pages; a capability is plain text.
    expect(screen.getByRole('link', { name: 'rfi' })).toHaveAttribute('href', '/skills-and-tools/skills/rfi');
    expect(screen.getByRole('link', { name: /notion-search/ })).toHaveAttribute('href', '/skills-and-tools/tools/notion');
    expect(screen.queryByRole('link', { name: 'grep' })).not.toBeInTheDocument();
    expect(screen.getByText('needs sign-in')).toBeInTheDocument();
    expect(screen.getByText(/Showing 4 of 4 events/)).toBeInTheDocument();

    // Errors only: the ok rows go, the error and the denied one stay.
    await userEvent.click(screen.getByRole('checkbox', { name: 'Errors only' }));
    expect(screen.queryByText('grep')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /notion-search/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /post_message/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Errors only' }));

    // Type chips narrow to one kind.
    await userEvent.click(screen.getByRole('button', { name: 'Skill', pressed: false }));
    expect(screen.getByRole('link', { name: 'rfi' })).toBeInTheDocument();
    expect(screen.queryByText('grep')).not.toBeInTheDocument();

    // Collapse and re-expand: no second request.
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('loads older events through the cursor', async () => {
    vi.mocked(listPrincipals).mockResolvedValue([ALICE_CLAUDE]);
    vi.mocked(listEvents)
      .mockResolvedValueOnce({ events: EVENTS.slice(0, 2), total: 4, nextCursor: 'cur-2' })
      .mockResolvedValueOnce({ events: EVENTS.slice(2), total: 4, nextCursor: null });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /Claude/, expanded: false }));
    await waitFor(() => expect(screen.getByText(/Showing 2 of 4 events/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: 'Load older events' }));
    await waitFor(() => expect(screen.getByText(/Showing 4 of 4 events/)).toBeInTheDocument());
    expect(listEvents).toHaveBeenLastCalledWith('agent', 'c-claude', { before: 'cur-2', limit: 50 });
    expect(screen.queryByRole('button', { name: 'Load older events' })).not.toBeInTheDocument();
  });

  it('revokes an agent after confirmation and marks the row at once', async () => {
    vi.mocked(listPrincipals).mockResolvedValue([ALICE_CLAUDE]);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke access for Claude (alice@example.com)' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Every token it holds stops working now/)).toBeInTheDocument();
    // The reload after the revoke sees the server's view of it.
    vi.mocked(listPrincipals).mockResolvedValue([{ ...ALICE_CLAUDE, revokedAt: NOW, revokedBy: 'owner' }]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke access' }));

    await waitFor(() => expect(revokeAgent).toHaveBeenCalledWith('c-claude'));
    expect(revokeKey).not.toHaveBeenCalled();
    // Revoked rows hide by default; the toggle now offers them.
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Show revoked' }));
    expect(screen.getByText('Disconnected by owner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke access for Claude/ })).not.toBeInTheDocument();
  });

  it("revokes someone else's key as an admin, marked as an admin's doing", async () => {
    vi.mocked(listPrincipals).mockResolvedValue([BOB_LINK]);
    renderPage({ isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke key for Claude (bob@example.com)' }));
    vi.mocked(listPrincipals).mockResolvedValue([{ ...BOB_LINK, revokedAt: NOW, revokedBy: 'admin' }]);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(revokeKey).toHaveBeenCalledWith('k-link'));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Show revoked' }));
    expect(screen.getByText('Revoked by an admin')).toBeInTheDocument();
  });

  it('keeps the rows and shows the error when a revoke fails', async () => {
    vi.mocked(listPrincipals).mockResolvedValue([ALICE_CI]);
    vi.mocked(revokeKey).mockRejectedValue(new Error('Could not revoke this key'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke key for CI pipeline (alice@example.com)' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke key' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not revoke this key'));
    expect(screen.getByRole('button', { name: 'Revoke key for CI pipeline (alice@example.com)' })).toBeInTheDocument();
  });

  it('shows the load error instead of an empty log when the list cannot be fetched', async () => {
    vi.mocked(listPrincipals).mockRejectedValue(new Error('Could not load the audit log'));
    renderPage();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not load the audit log'));
    expect(screen.queryByText(/Nothing connected/)).not.toBeInTheDocument();
  });
});
