import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setLibrarySidebarCollapsed } from '../../../library/state/sidebar-collapse';
import { render, screen } from '@testing-library/react';
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
  it('renders explorer and chat toggle buttons with correct aria-pressed when panels are open', () => {
    renderToolbar();
    const explorerBtn = screen.getByRole('button', { name: /hide file explorer/i });
    const chatBtn = screen.getByRole('button', { name: /hide chat panel/i });
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'true');
    expect(chatBtn).toHaveAttribute('aria-pressed', 'true');
  });

  it('reflects collapsed state in aria-pressed and labels', () => {
    renderToolbar({
      layout: { isExplorerCollapsed: true, isChatCollapsed: true },
    });
    const explorerBtn = screen.getByRole('button', { name: /show file explorer/i });
    const chatBtn = screen.getByRole('button', { name: /show chat panel/i });
    expect(explorerBtn).toHaveAttribute('aria-pressed', 'false');
    expect(chatBtn).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls toggleExplorer when the explorer button is clicked', async () => {
    const { toggleExplorer } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /hide file explorer/i }));
    expect(toggleExplorer).toHaveBeenCalledTimes(1);
  });

  it('calls toggleChat when the chat button is clicked', async () => {
    const { toggleChat } = renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /hide chat panel/i }));
    expect(toggleChat).toHaveBeenCalledTimes(1);
  });

  it('renders logout but NO branch picker — the core toolbar carries only registry items', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
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

  it('shows the explorer toggle and fires toggleExplorer when canToggleExplorer is true', async () => {
    const { toggleExplorer } = renderToolbar({ layout: { canToggleExplorer: true } });
    const btn = screen.getByRole('button', { name: /hide file explorer/i });
    expect(btn).toBeInTheDocument();
    await userEvent.click(btn);
    expect(toggleExplorer).toHaveBeenCalledTimes(1);
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

  // The Library's nav toggle sits first in the row, left of the brand. It is
  // path-gated: it controls the Library's sidebar, so it exists exactly where
  // that sidebar exists.
  describe('library sidebar toggle', () => {
    beforeEach(() => setLibrarySidebarCollapsed(false));

    it('shows on Library routes and flips the shared collapse state', async () => {
      renderToolbar({ route: '/skills-and-tools' });
      const btn = screen.getByRole('button', { name: 'Hide sidebar' });
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      await userEvent.click(btn);
      expect(
        screen.getByRole('button', { name: 'Show sidebar' }),
      ).toHaveAttribute('aria-expanded', 'false');
    });

    it('does not render off the Library — there is no sidebar to control', () => {
      renderToolbar({ route: '/secrets' });
      expect(screen.queryByRole('button', { name: /(hide|show) sidebar/i })).toBeNull();
    });

    // WP7: one glyph, one spot, both surfaces. Knowledge's explorer toggle and
    // the Library's nav toggle are the same control doing the same thing, and
    // two different marks for it would be the app saying "you are somewhere
    // else" at the one place that must never move.
    it('draws the explorer toggle with the same glyph as the Library nav toggle', () => {
      renderToolbar({ route: '/skills-and-tools', layout: { canToggleExplorer: true } });
      const explorer = screen.getByRole('button', { name: /(hide|show) file explorer/i });
      const library = screen.getByRole('button', { name: /(hide|show) sidebar/i });
      const shape = (btn: HTMLElement) => btn.querySelector('svg')?.innerHTML;
      expect(shape(explorer)).toBeTruthy();
      expect(shape(explorer)).toBe(shape(library));
    });
  });

  // The "Reconciling with the team…" status pill is gone with the
  // pending-commits queue refactor — push failures are handled silently
  // by the background recovery agent now, so there's nothing user-facing
  // to render. The Toolbar no longer mounts a `role="status"` element
  // and the resolution context was deleted entirely.

  // The gear menu consolidates every former sidebar-footer entry. The
  // all-user rows show for everyone; the "Admin only" section is gated.
  describe('settings menu', () => {
    async function openMenu() {
      await userEvent.click(screen.getByRole('button', { name: /^menu/i }));
    }

    it('shows the all-user rows (core + registry) to a non-admin and hides the Admin only section', async () => {
      renderToolbar({ isAdmin: false });
      await openMenu();
      // Registry-contributed row merged with the core rows.
      expect(screen.getByRole('menuitem', { name: 'Stub extension' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Skills & Tools' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'External agent access' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Secrets' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Browse available tools' })).toBeInTheDocument();
      // Admin only section + its rows are hidden for non-admins.
      expect(screen.queryByText('Admin only')).toBeNull();
      expect(screen.queryByRole('menuitem', { name: /Roles/ })).toBeNull();
      expect(screen.queryByRole('menuitem', { name: 'Stub admin row' })).toBeNull();
    });

    it('shows the Admin only section with its rows to an admin', async () => {
      renderToolbar({ isAdmin: true });
      await openMenu();
      expect(screen.getByText('Admin only')).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /Roles/ })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Stub admin row' })).toBeInTheDocument();
      // All-user rows are still present alongside the admin ones.
      expect(screen.getByRole('menuitem', { name: 'Stub extension' })).toBeInTheDocument();
    });

    // Core rows all NAVIGATE — the settings surfaces are standalone routed
    // pages below the persistent toolbar, not dialogs.
    it('navigates to the standalone settings pages from the core rows and closes the menu', async () => {
      renderToolbar();
      for (const [row, path] of [
        ['External agent access', '/external-agent-access'],
        ['Secrets', '/secrets'],
        ['Browse available tools', '/tools'],
        ['Skills & Tools', '/skills-and-tools'],
      ] as const) {
        await openMenu();
        await userEvent.click(screen.getByRole('menuitem', { name: row }));
        expect(screen.getByTestId('pathname')).toHaveTextContent(path);
        expect(screen.queryByRole('menu')).toBeNull();
      }
    });

    it('navigates to /roles-and-members from the admin row', async () => {
      renderToolbar({ isAdmin: true });
      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Roles & Members' }));
      expect(screen.getByTestId('pathname')).toHaveTextContent('/roles-and-members');
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens a registry-contributed dialog from its row and closes the menu', async () => {
      renderToolbar();
      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Stub extension' }));
      expect(await screen.findByRole('dialog', { name: 'Stub extension' })).toBeInTheDocument();
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });
});
