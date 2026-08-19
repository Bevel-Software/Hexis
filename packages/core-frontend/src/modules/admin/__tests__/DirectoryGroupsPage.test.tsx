import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirectoryGroupsPage } from '../components/DirectoryGroupsPage';
import { AdminContext } from '../state/admin.context';
import {
  AppRegistryContext,
  EMPTY_REGISTRY,
  type GroupsDirectoryPanelProps,
} from '../../../core/registry';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroupsRoster,
  GroupsApiError,
  removeGroupMember,
  type GroupsRoster,
} from '../services/groups.api';

vi.mock('../services/groups.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/groups.api')>();
  return {
    ...actual,
    getGroupsRoster: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    addGroupMember: vi.fn(),
    removeGroupMember: vi.fn(),
  };
});

const MANUAL_ROSTER: GroupsRoster = {
  mode: 'manual',
  groups: [
    {
      canonical: 'product',
      displayName: 'Product',
      members: ['pat@example.com'],
      referencedBy: [{ path: 'docs/roadmap.md', verb: 'read' }],
      assignedToRoles: [],
    },
    {
      canonical: 'design',
      displayName: 'Design',
      members: [],
      referencedBy: [],
      assignedToRoles: [],
    },
  ],
  groupsHealth: { ok: true },
};

const IDP_ROSTER: GroupsRoster = {
  mode: 'idp',
  groups: [
    {
      canonical: 'engineering',
      displayName: 'Engineering',
      members: ['ada@example.com', 'bo@example.com', 'cy@example.com'],
      referencedBy: [],
      assignedToRoles: [],
    },
    { canonical: 'sales', displayName: 'Sales', members: [], referencedBy: [], assignedToRoles: [] },
  ],
  groupsHealth: { ok: true },
};

function renderPage(opts: {
  isAdmin?: boolean;
  directoryPanel?: (props: GroupsDirectoryPanelProps) => React.ReactElement;
} = {}) {
  const registry = opts.directoryPanel
    ? { ...EMPTY_REGISTRY, groupsDirectoryPanel: opts.directoryPanel }
    : EMPTY_REGISTRY;
  return render(
    <AppRegistryContext.Provider value={registry}>
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
        <DirectoryGroupsPage />
      </AdminContext.Provider>
    </AppRegistryContext.Provider>,
  );
}

beforeEach(() => {
  vi.mocked(getGroupsRoster).mockReset().mockResolvedValue(MANUAL_ROSTER);
  vi.mocked(createGroup).mockReset().mockResolvedValue(MANUAL_ROSTER);
  vi.mocked(deleteGroup).mockReset().mockResolvedValue(MANUAL_ROSTER);
  vi.mocked(addGroupMember).mockReset().mockResolvedValue(MANUAL_ROSTER);
  vi.mocked(removeGroupMember).mockReset().mockResolvedValue(MANUAL_ROSTER);
});

describe('DirectoryGroupsPage', () => {
  it('shows the admins-only state (and never loads) for non-admins', () => {
    renderPage({ isAdmin: false });
    expect(screen.getByText(/Admins only/)).toBeInTheDocument();
    expect(getGroupsRoster).not.toHaveBeenCalled();
  });

  it('manual mode: renders the groups with members and CRUD controls', async () => {
    renderPage();
    expect(await screen.findByText('Product')).toBeInTheDocument();
    expect(screen.getByText('pat@example.com')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New group name' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Product' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add member to Product' })).toBeInTheDocument();
  });

  it('manual mode: creating a group calls the api and applies the returned roster', async () => {
    vi.mocked(createGroup).mockResolvedValue({
      mode: 'manual',
      groups: [
        ...MANUAL_ROSTER.groups,
        {
          canonical: 'support',
          displayName: 'Support',
          members: [],
          referencedBy: [],
          assignedToRoles: [],
        },
      ],
      groupsHealth: { ok: true },
    });
    renderPage();
    await userEvent.type(await screen.findByRole('textbox', { name: 'New group name' }), 'Support');
    await userEvent.click(screen.getByRole('button', { name: /Create group/ }));
    await waitFor(() => expect(createGroup).toHaveBeenCalledWith('Support'));
    expect(await screen.findByText('Support')).toBeInTheDocument();
  });

  it('manual mode: adding and removing members hit the api', async () => {
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'dana@example.com');
    // Scope to the input's row — each group card has its own Add button.
    await userEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(addGroupMember).toHaveBeenCalledWith('design', 'dana@example.com'),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Remove pat@example.com' }));
    await waitFor(() =>
      expect(removeGroupMember).toHaveBeenCalledWith('product', 'pat@example.com'),
    );
  });

  it('manual mode: overlapping mutations are serialized — the second request waits for the first', async () => {
    // Mutations are snapshot-based server-side, so the page must never have
    // two in flight at once. Hold the first response open and check the second
    // click doesn't issue its request until the first resolves.
    const resolvers: ((r: GroupsRoster) => void)[] = [];
    vi.mocked(addGroupMember).mockImplementation(
      () => new Promise<GroupsRoster>((resolve) => resolvers.push(resolve)),
    );
    renderPage();

    const productInput = await screen.findByRole('textbox', { name: 'Add member to Product' });
    await userEvent.type(productInput, 'a@example.com');
    await userEvent.click(within(productInput.closest('div')!).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addGroupMember).toHaveBeenCalledTimes(1));

    // Second card: its own busy flag is free, so the click goes through — but
    // the request must queue behind the unresolved first one.
    const designInput = screen.getByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(designInput, 'b@example.com');
    await userEvent.click(within(designInput.closest('div')!).getByRole('button', { name: 'Add' }));
    expect(addGroupMember).toHaveBeenCalledTimes(1);

    resolvers[0](MANUAL_ROSTER);
    await waitFor(() => expect(addGroupMember).toHaveBeenCalledTimes(2));
    expect(addGroupMember).toHaveBeenNthCalledWith(2, 'design', 'b@example.com');

    resolvers[1](MANUAL_ROSTER);
    // Both cards settle back to idle.
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Add member to Design' })).not.toBeDisabled(),
    );
  });

  it('manual mode: deleting a group requires a confirm and warns about references', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Product' }));
    expect(deleteGroup).not.toHaveBeenCalled();

    const dialog = within(screen.getByRole('dialog'));
    // Product is referenced by one access rule — the dialog must say so.
    expect(dialog.getByText(/1 access rule/)).toBeInTheDocument();
    expect(dialog.getByText(/docs\/roadmap\.md/)).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Delete group' }));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith('product'));
  });

  it('idp mode: read-only roster, no mutation controls, membership note shown', async () => {
    vi.mocked(getGroupsRoster).mockResolvedValue(IDP_ROSTER);
    renderPage();
    expect(await screen.findByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText(/3 members/)).toBeInTheDocument();
    expect(
      screen.getByText('Membership is managed in your identity provider.'),
    ).toBeInTheDocument();
    // No manual CRUD anywhere: no create form, no add-member inputs, no deletes.
    expect(screen.queryByRole('textbox', { name: 'New group name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Add member/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('renders the registry directory panel with the mode, and its callback refreshes', async () => {
    const rosters = [MANUAL_ROSTER, IDP_ROSTER];
    vi.mocked(getGroupsRoster).mockImplementation(async () => rosters.shift() ?? IDP_ROSTER);
    renderPage({
      directoryPanel: ({ mode, onDirectoryChanged }) => (
        <button onClick={onDirectoryChanged}>panel:{mode}</button>
      ),
    });
    // The panel sees the roster's mode.
    await userEvent.click(await screen.findByRole('button', { name: 'panel:manual' }));
    // Its callback refetches: the second roster is idp, so the page flips.
    expect(await screen.findByRole('button', { name: 'panel:idp' })).toBeInTheDocument();
    expect(
      await screen.findByText('Membership is managed in your identity provider.'),
    ).toBeInTheDocument();
  });

  it('connected-but-not-materialized: the panel signal suppresses manual CRUD', async () => {
    renderPage({
      directoryPanel: ({ onConnectedChange }) => (
        <button onClick={() => onConnectedChange(true)}>simulate-connect</button>
      ),
    });
    // Manual CRUD is up while disconnected.
    expect(await screen.findByRole('textbox', { name: 'New group name' })).toBeInTheDocument();
    // The panel reports a live connection (e.g. a token was just minted).
    await userEvent.click(screen.getByRole('button', { name: 'simulate-connect' }));
    // No create form, no member editing — the IdP owns groups now.
    expect(screen.queryByRole('textbox', { name: 'New group name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Add member/ })).not.toBeInTheDocument();
    expect(
      await screen.findByText(/Groups appear here after its first provisioning push/),
    ).toBeInTheDocument();
  });

  it('no registry panel means the page never mentions a directory connection', async () => {
    renderPage();
    expect(await screen.findByText('Product')).toBeInTheDocument();
    expect(screen.queryByText(/identity provider/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SCIM/)).not.toBeInTheDocument();
  });

  it('a failed FIRST load reports the failure, not an empty manual page', async () => {
    vi.mocked(getGroupsRoster).mockReset().mockRejectedValue(new Error('Backend unreachable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('Backend unreachable');
    expect(screen.queryByRole('textbox', { name: 'New group name' })).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('a roster whose groupsHealth is broken banners loudly: file, reason, "not being applied"', async () => {
    // Broken IdP-synced file: the roster still answers 200 (mode stays idp,
    // groups empty) but carries the health marker — resolution is degraded
    // and the page must say so, not render a quietly empty list.
    vi.mocked(getGroupsRoster).mockResolvedValue({
      mode: 'idp',
      groups: [],
      groupsHealth: { ok: false, file: 'synced-groups.yaml', reason: 'bad indentation on line 3' },
    });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('synced-groups.yaml');
    expect(alert).toHaveTextContent(/groups are\s+not being applied/i);
    expect(alert).toHaveTextContent('bad indentation on line 3');
    // The rest of the page stays alive (the idp view still renders).
    expect(screen.getByText(/synced from your identity provider/i)).toBeInTheDocument();
  });

  it("the roster 422 (kind 'broken-groups') gets the same banner with the parse message", async () => {
    // Broken MANUAL groups.yaml: the roster endpoint answers 422 with the
    // parse message — the operator must see what to fix, never a dead page.
    vi.mocked(getGroupsRoster)
      .mockReset()
      .mockRejectedValue(
        new GroupsApiError('groups.yaml cannot be read: mapping values are not allowed', 422, 'broken-groups', {
          file: 'groups.yaml',
          reason: 'mapping values are not allowed',
        }),
      );
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('groups.yaml');
    expect(alert).toHaveTextContent(/groups are\s+not being applied/i);
    expect(alert).toHaveTextContent('mapping values are not allowed');
    // Not the generic load-failure message, and not stuck on the spinner.
    expect(screen.queryByText("Couldn't load groups.")).not.toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('the delete confirm names the roles the group is assigned to', async () => {
    vi.mocked(getGroupsRoster).mockResolvedValue({
      mode: 'manual',
      groups: [
        {
          canonical: 'gtm',
          displayName: 'GTM',
          members: ['pat@example.com'],
          referencedBy: [],
          assignedToRoles: ['editor', 'reviewer'],
        },
      ],
      groupsHealth: { ok: true },
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete GTM' }));
    const dialog = within(screen.getByRole('dialog'));
    // Deleting also unassigns — the confirm names the affected roles.
    expect(dialog.getByText(/unassigns this group from the roles/i)).toBeInTheDocument();
    expect(dialog.getByText('editor, reviewer')).toBeInTheDocument();
    // The "loses nothing else" reassurance would be a lie here.
    expect(dialog.queryByText(/lose nothing else/i)).not.toBeInTheDocument();
  });

  it("a 'group:'-prefixed member value gets the inline hint and no request", async () => {
    renderPage();
    const input = await screen.findByRole('textbox', { name: 'Add member to Design' });
    await userEvent.type(input, 'group:engineering');
    await userEvent.click(within(input.closest('div')!).getByRole('button', { name: 'Add' }));
    expect(
      await screen.findByText(/Group members are emails — 'group:' references aren't allowed/),
    ).toBeInTheDocument();
    expect(addGroupMember).not.toHaveBeenCalled();
  });
});
