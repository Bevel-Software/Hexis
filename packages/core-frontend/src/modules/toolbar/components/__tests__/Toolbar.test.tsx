import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSidebarCollapsed } from '../../../layout/state/sidebar';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Toolbar } from '../Toolbar';
import { AuthContext, type AuthContextValue } from '../../../auth/state/auth.context';
import {
  AutoUpdateContext,
  IDLE_AUTO_UPDATE,
  type AutoUpdateState,
} from '../../../git/state/auto-update.context';
import { GitContext, type GitContextValue } from '../../../git/state/git.context';
import { WorkspaceContext, type WorkspaceContextValue } from '../../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../../workspace/__tests__/testFixtures';
import { LayoutContext, type LayoutController } from '../../../layout/state/layout.context';
import { ReviewContext, type ReviewContextValue } from '../../../review/state/review.context';
import { PrViewerContext, type PrViewerContextValue } from '../../../pr/state/pr-viewer.context';
import { AdminContext } from '../../../admin/state/admin.context';
// The gear menu's extension rows (in the enterprise build: Connectors,
// Watchlist, Routines, Connected apps, feedback, LLM config, user accounts)
// are contributed through the registry. Core tests mount STUB registry rows —
// one per section, one with a dialog — so the merge/gating/dialog mechanics
// stay covered without importing enterprise modules.
import {
  AppRegistryContext,
  makeRegistry,
  type AdminMenuItem,
  type ToolbarItemDef,
} from '../../../../core/registry';

const stubAdminMenuItems: AdminMenuItem[] = [
  {
    id: 'stub-extension',
    order: 10,
    label: 'Stub extension',
    dialog: ({ open, onClose }) =>
      open ? (
        <div role="dialog" aria-label="Stub extension">
          <button onClick={onClose}>Close</button>
        </div>
      ) : (
        <></>
      ),
  },
  {
    id: 'stub-admin-row',
    section: 'admin',
    order: 90,
    label: 'Stub admin row',
    onSelect: ({ closeMenu }) => closeMenu(),
  },
];

/** Exposes the router's current pathname so menu navigation can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function renderToolbar(overrides?: {
  auth?: Partial<AuthContextValue>;
  autoUpdate?: AutoUpdateState;
  git?: Partial<GitContextValue>;
  layout?: Partial<LayoutController>;
  isAdmin?: boolean;
  toolbarItems?: ToolbarItemDef[];
  /** Initial route — the Library sidebar toggle is path-gated. */
  route?: string;
}) {
  const toggleExplorer = vi.fn();
  const toggleChat = vi.fn();
  const logout = vi.fn();
  const makeCommit = () => ({
    sha: 'abc',
    authorName: 'n',
    authorEmail: 'e',
    subject: 's',
    committedAt: '2026-04-20T00:00:00.000Z',
  });

  const auth: AuthContextValue = {
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      avatarUrl: 'https://example.com/avatar.png',
    },
    token: 'token',
    isLoading: false,
    login: async () => {},
    logout,
    ...overrides?.auth,
  };

  const git: GitContextValue = {
    status: null,
    branches: [],
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    revert: async () => makeCommit(),
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileComparison: async () => '',
    ...overrides?.git,
  };

  const workspace: WorkspaceContextValue = makeWorkspaceFixture();

  const layout: LayoutController = {
    isExplorerCollapsed: false,
    isChatCollapsed: false,
    canToggleExplorer: true,
    canToggleChat: true,
    toggleExplorer,
    toggleChat,
    ...overrides?.layout,
  };

  const prViewer: PrViewerContextValue = {
    openPrNumber: null,
    detail: null,
    notFound: false,
    selectedPath: null,
    isLoading: false,
    lastError: null,
    openPr: () => {},
    closeViewer: () => {},
    selectPath: () => {},
    refresh: async () => {},
  };

  const review: ReviewContextValue = {
    session: null,
    selectedPath: null,
    fileDiff: null,
    isLoadingDiff: false,
    lastError: null,
    isLoading: false,
    refresh: async () => {},
    selectPath: async () => {},
    acceptOne: async () => {},
    rejectOne: async () => {},
    acceptAll: async () => {},
    rejectAll: async () => {},
    clearError: () => {},
  };

  render(
    <MemoryRouter initialEntries={[overrides?.route ?? '/']}>
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>
          <GitContext.Provider value={git}>
            <AutoUpdateContext.Provider value={overrides?.autoUpdate ?? IDLE_AUTO_UPDATE}>
              <ReviewContext.Provider value={review}>
                <PrViewerContext.Provider value={prViewer}>
                  <LayoutContext.Provider value={layout}>
                    <AdminContext.Provider
                      value={{
                        isAdmin: overrides?.isAdmin ?? false,
                        unreadCount: 0,
                        lastSeen: null,
                        markSeen: () => {},
                        refresh: () => {},
                        rolesConfigCorrupted: false,
                        rolesConfigErrors: [],
                        runRolesRecovery: async () => {},
                      }}
                    >
                      <AppRegistryContext.Provider
                        value={makeRegistry({
                          adminMenuItems: stubAdminMenuItems,
                          toolbarItems: overrides?.toolbarItems ?? [],
                        })}
                      >
                        <Toolbar />
                        <LocationProbe />
                      </AppRegistryContext.Provider>
                    </AdminContext.Provider>
                  </LayoutContext.Provider>
                </PrViewerContext.Provider>
              </ReviewContext.Provider>
            </AutoUpdateContext.Provider>
          </GitContext.Provider>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );

  return { toggleExplorer, toggleChat, logout };
}

describe('Toolbar', () => {
  it('renders sidebar and chat toggles open when their panels are open', () => {
    setSidebarCollapsed(false);
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Hide sidebar' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('button', { name: /hide chat panel/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reflects collapsed state in the labels', () => {
    setSidebarCollapsed(true);
    renderToolbar({ layout: { isChatCollapsed: true } });
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('button', { name: /show chat panel/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('calls toggleChat when the chat button is clicked', async () => {
    const { toggleChat } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /hide chat panel/i }));
    expect(toggleChat).toHaveBeenCalledTimes(1);
  });

  it('renders the profile trigger but NO branch picker — the core toolbar carries only registry items', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: 'Test User' })).toBeInTheDocument();
    // The branch switcher left the core toolbar: it is an enterprise
    // toolbarItem contribution, scoped by the item itself to the Knowledge
    // app. The git module still ships the component; the shell doesn't
    // mount it. (Share/Discard/status badge stayed retired with
    // auto-commit-on-release.)
    expect(screen.queryByTitle('Your active shared draft')).toBeNull();
    expect(screen.queryByRole('button', { name: /share changes/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /discard/i })).toBeNull();
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('renders registry-contributed toolbar items in the left cluster', () => {
    renderToolbar({
      toolbarItems: [
        { id: 'stub-branch-tools', node: <button>Stub branch tools</button> },
      ],
    });
    expect(
      screen.getByRole('button', { name: 'Stub branch tools' }),
    ).toBeInTheDocument();
  });

  it('hides the explorer toggle when canToggleExplorer is false', () => {
    renderToolbar({ layout: { canToggleExplorer: false } });
    expect(
      screen.queryByRole('button', { name: /(show|hide) file explorer/i }),
    ).toBeNull();
  });

  it('shows the sidebar toggle and flips the shared state when canToggleExplorer is true', async () => {
    setSidebarCollapsed(false);
    renderToolbar({ layout: { canToggleExplorer: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Hide sidebar' }));
    expect(screen.getByRole('button', { name: 'Show sidebar' })).toBeInTheDocument();
  });

  it('hides the chat toggle when canToggleChat is false', () => {
    renderToolbar({ layout: { canToggleChat: false } });
    expect(
      screen.queryByRole('button', { name: /(show|hide) chat panel/i }),
    ).toBeNull();
  });

  it('shows the chat toggle and fires toggleChat when canToggleChat is true', async () => {
    const { toggleChat } = renderToolbar({ layout: { canToggleChat: true } });
    const btn = screen.getByRole('button', { name: /hide chat panel/i });
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(toggleChat).toHaveBeenCalledTimes(1);
  });

  // ONE nav toggle, first in the row and left of the brand, for the app's ONE
  // sidebar. There were two buttons here — same glyph, same spot, different
  // state — until Knowledge's file tree and the Library's group list became
  // the same sidebar.
  describe('sidebar toggle', () => {
    beforeEach(() => setSidebarCollapsed(false));

    it('flips the shared collapse state on the Library', async () => {
      renderToolbar({ route: '/skills-and-tools', layout: { canToggleExplorer: false } });
      const btn = screen.getByRole('button', { name: 'Hide sidebar' });
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(btn);
      expect(
        screen.getByRole('button', { name: 'Show sidebar' }),
      ).toHaveAttribute('aria-expanded', 'false');
    });

    // Three surfaces answer "do I have a sidebar?" two ways — Knowledge
    // declares a `sidebar` pane, the Library and the settings pages are known
    // by their paths — but there is only ever ONE button, never one per
    // surface. The settings case is what catches anyone adding a second,
    // settings-specific toggle instead of reusing SidebarToggle.
    it.each([
      ['the Library, by path', '/skills-and-tools', false],
      ['Knowledge, by its sidebar pane', '/workspace/main', true],
      ['both at once, without doubling up', '/skills-and-tools', true],
      ['a settings page, by its route table', '/secrets', false],
    ])('renders exactly one toggle on %s', (_name, route, canToggleExplorer) => {
      renderToolbar({ route, layout: { canToggleExplorer } });
      expect(screen.getAllByRole('button', { name: /(hide|show) sidebar/i })).toHaveLength(1);
      // The separate "file explorer" button is gone — it was this same button.
      expect(screen.queryByRole('button', { name: /file explorer/i })).toBeNull();
    });

    // This used to assert the opposite, at this same route — which was the bug
    // written down as a test: /secrets had no nav, so it had nothing to
    // toggle. There is no nav-less surface below the toolbar any more, so
    // there is no negative case left to pin (`/` only redirects to
    // /workspace).
    it('renders on a settings page, which has a nav now', () => {
      renderToolbar({ route: '/secrets', layout: { canToggleExplorer: false } });
      expect(
        screen.getByRole('button', { name: /(hide|show) sidebar/i }),
      ).toBeInTheDocument();
    });
  });

  // The "Reconciling with the team…" status pill is gone with the
  // pending-commits queue refactor — push failures are handled silently
  // by the background recovery agent now, so there's nothing user-facing
  // to render. The Toolbar no longer mounts a `role="status"` element
  // and the resolution context was deleted entirely.

  // The profile menu consolidates every former sidebar-footer entry, plus the
  // three top-bar controls it replaced. The all-user rows show for everyone;
  // the "Admin only" section is gated.
  describe('profile menu', () => {
    async function openMenu() {
      await userEvent.click(screen.getByRole('button', { name: 'Test User' }));
    }

    // The panel is a labelled GROUP of buttons, not a `role="menu"`: it has no
    // arrow-key navigation, so claiming the menu role would promise a keyboard
    // model it does not implement. Every assertion below is the one it always
    // was; only the selector moved.
    const panel = () => screen.getByRole('group', { name: 'You and your settings' });
    const rows = () => within(panel()).getAllByRole('button');
    const row = (name: string | RegExp) => within(panel()).getByRole('button', { name });
    const noRow = (name: string | RegExp) => within(panel()).queryByRole('button', { name });
    const panelGone = () =>
      screen.queryByRole('group', { name: 'You and your settings' });

    // One button, not three. The name used to be an inert span between the
    // gear and the sign-out arrow — three controls for one question.
    it('collapses the name, the gear and the sign-out arrow into a single trigger', () => {
      renderToolbar();
      expect(screen.queryByRole('button', { name: /^menu/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /sign out/i })).toBeNull();
      // A disclosure, not a menu button. `aria-haspopup="true"` is a synonym
      // for `"menu"`, and the panel is a `group` of ordinary buttons with no
      // roving arrow-key model — so the trigger must NOT claim one.
      const trigger = screen.getByRole('button', { name: 'Test User' });
      expect(trigger).not.toHaveAttribute('aria-haspopup');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    // The pill says the first name; the full one is the accessible name and
    // sits in the panel's identity block. Asserting the text exists catches a
    // name missing from the DOM — it cannot catch one hidden by CSS, since
    // happy-dom applies no stylesheet. That failure mode has bitten once
    // already (`sm:not-sr-only` compiles to nothing under Tailwind v4), so
    // the trigger deliberately carries no class Tailwind can silently drop.
    it('shows the first name beside the avatar', () => {
      renderToolbar();
      const trigger = screen.getByRole('button', { name: 'Test User' });
      expect(trigger).toHaveTextContent('Test');
      expect(trigger).not.toHaveTextContent('Test User');
    });

    // Identity first: the menu says who you are before offering to change
    // anything. The email is real, unlike the prototype's fabricated one.
    it('states who you are at the top of the panel', async () => {
      renderToolbar();
      await openMenu();
      const menu = panel();
      expect(within(menu).getByText('Test User')).toBeInTheDocument();
      expect(within(menu).getByText('user@example.com')).toBeInTheDocument();
    });

    it('signs you out from the last row and nowhere else', async () => {
      const { logout } = renderToolbar();
      await openMenu();
      const openRows = rows();
      expect(openRows[openRows.length - 1]).toHaveTextContent('Sign out');
      await userEvent.click(row('Sign out'));
      expect(logout).toHaveBeenCalledTimes(1);
    });

    // Nothing in the menu means anything without a person, and the trigger is
    // that person — so signed out there is no button at all.
    it('renders nothing when there is no signed-in user', () => {
      renderToolbar({ auth: { user: null } });
      expect(screen.queryByRole('button', { name: /sign out|test user/i })).toBeNull();
    });

    it('shows the all-user rows (core + registry) to a non-admin and hides the Admin only section', async () => {
      renderToolbar({ isAdmin: false });
      await openMenu();
      // Registry-contributed row merged with the core rows.
      expect(row('Stub extension')).toBeInTheDocument();
      expect(row('External agent access')).toBeInTheDocument();
      expect(row('Secrets')).toBeInTheDocument();
      expect(row('Browse available tools')).toBeInTheDocument();
      // Admin only section + its rows are hidden for non-admins.
      // Scoped to the panel: the settings nav renders this same string, and
      // an unscoped query would throw on multiple matches the day a test
      // mounts both. This harness never does — that is why it passes today —
      // but the trap is now real enough to be worth closing.
      expect(within(panel()).queryByText('Admin only')).toBeNull();
      expect(noRow(/Roles/)).toBeNull();
      expect(noRow('Stub admin row')).toBeNull();
    });

    // Skills & Tools is an APP, and apps live in the app switcher — which
    // already lists it AND marks it as current. Carrying it here too gave one
    // destination two front doors, only one of which could tell you that you
    // were already standing behind it.
    it('does not offer Skills & Tools, which belongs to the app switcher', async () => {
      renderToolbar();
      await openMenu();
      expect(noRow(/Skills & Tools/)).toBeNull();
    });

    it('shows the Admin only section with its rows to an admin', async () => {
      renderToolbar({ isAdmin: true });
      await openMenu();
      expect(within(panel()).getByText('Admin only')).toBeInTheDocument();
      expect(row(/Roles/)).toBeInTheDocument();
      expect(row('Stub admin row')).toBeInTheDocument();
      // All-user rows are still present alongside the admin ones.
      expect(row('Stub extension')).toBeInTheDocument();
    });

    // Core rows all NAVIGATE — the settings surfaces are standalone routed
    // pages below the persistent toolbar, not dialogs.
    it('navigates to the standalone settings pages from the core rows and closes the menu', async () => {
      renderToolbar();
      for (const [label, path] of [
        ['External agent access', '/external-agent-access'],
        ['Secrets', '/secrets'],
        ['Browse available tools', '/tools'],
      ] as const) {
        await openMenu();
        await userEvent.click(row(label));
        expect(screen.getByTestId('pathname')).toHaveTextContent(path);
        expect(panelGone()).toBeNull();
      }
    });

    it('navigates to /roles-and-members from the admin row', async () => {
      renderToolbar({ isAdmin: true });
      await openMenu();
      await userEvent.click(row('Roles & Members'));
      expect(screen.getByTestId('pathname')).toHaveTextContent('/roles-and-members');
      expect(panelGone()).toBeNull();
    });

    it('opens a registry-contributed dialog from its row and closes the menu', async () => {
      renderToolbar();
      await openMenu();
      await userEvent.click(row('Stub extension'));
      expect(await screen.findByRole('dialog', { name: 'Stub extension' })).toBeInTheDocument();
      expect(panelGone()).toBeNull();
    });
  });
});
