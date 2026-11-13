import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SettingsLayout } from '../SettingsLayout';
import { isSettingsNavPath, registrySettingsPages, useSettingsNavPaths } from '../../settings-nav-items';
import { AdminContext, type AdminContextValue } from '../../../admin';
import { setSidebarCollapsed } from '../../../layout';
import { AppRegistryContext, makeRegistry, type AdminMenuItem } from '../../../../core/registry';
import { AuthContext, type AuthContextValue } from '../../../auth';
import type { AuthUser } from '@bevel-software/platform-shared';

/**
 * The settings nav's contract.
 *
 * The load-bearing case is "the nav survives the click" — the exact inverse of
 * the profile menu's `panelGone()`, and the regression test for the bug this
 * layout exists to fix.
 *
 * Renders `SettingsLayout` as a real layout route over STUB children, so no
 * real settings page mounts and the suite needs no API mocks and no provider
 * stack beyond the two contexts under test.
 */

/**
 * Two shapes the membership rule must REJECT, alongside a normal row: a
 * dialog-only row (no URL, so it can be neither linked nor marked current),
 * and an `onSelect` + off-surface `path` row — the enterprise shape that
 * navigates somewhere else in the app.
 */
const stubRows: AdminMenuItem[] = [
  {
    id: 'stub-dialog',
    order: 10,
    label: 'Stub dialog row',
    dialog: ({ open }) => (open ? <div role="dialog" aria-label="Stub" /> : <></>),
  },
  {
    id: 'stub-elsewhere',
    order: 20,
    label: 'Stub elsewhere row',
    path: '/workspace/connectors',
    onSelect: () => {},
  },
];

function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

/**
 * The router subtree, built ONCE and shared by `renderAt` and the rerender
 * below.
 *
 * React reconciles children by position and type, so a rerender that omits any
 * of this — `LocationProbe`, a sibling route — replaces the subtree instead of
 * updating it, and `SettingsLayout` remounts with the new props already baked
 * in. A remounted component cannot be caught holding stale memoized state,
 * which is the one thing the update test exists to catch. Sharing the builder
 * is what makes "identical except for the AdminContext value" true by
 * construction rather than by everyone remembering.
 */
function routerTree(route: string) {
  return (
    <AppRegistryContext.Provider value={makeRegistry({ adminMenuItems: stubRows })}>
      <MemoryRouter initialEntries={[route]}>
        <LocationProbe />
        <Routes>
          <Route element={<SettingsLayout />}>
            <Route path="/secrets" element={<div>Secrets stub</div>} />
            <Route path="/account" element={<div>Account stub</div>} />
            <Route path="/tools" element={<div>Tools stub</div>} />
            <Route path="/external-agent-access" element={<div>Agent access stub</div>} />
            <Route path="/roles-and-members" element={<div>Roles stub</div>} />
            <Route path="/user-accounts" element={<div>User accounts stub</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AppRegistryContext.Provider>
  );
}

function withAdmin(isAdmin: boolean, tree: ReactNode) {
  return (
    <AdminContext.Provider value={{ isAdmin } as AdminContextValue}>{tree}</AdminContext.Provider>
  );
}

function renderAt(
  route: string,
  { isAdmin, withAdminContext = true }: { isAdmin?: boolean; withAdminContext?: boolean } = {},
) {
  const tree = routerTree(route);
  if (!withAdminContext) return render(tree);
  return render(withAdmin(!!isAdmin, tree));
}

const nav = () => screen.getByRole('navigation', { name: 'Settings' });
const noNav = () => screen.queryByRole('navigation', { name: 'Settings' });

/**
 * `collapsed` is module state that `test-setup.ts` does not reset, and
 * Toolbar.test.tsx mutates it — so it leaks across files in a run. A collapsed
 * sidebar is `inert`, which would make every query here fail for a reason that
 * has nothing to do with this suite.
 */
beforeEach(() => setSidebarCollapsed(false));

describe('SettingsLayout', () => {
  it('lists every settings destination', () => {
    renderAt('/secrets');
    const links = within(nav()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'External agent access',
      'Audit log',
      'Secrets',
      'Browse available tools',
      'Account',
    ]);
  });

  it('marks the current destination, and only it', () => {
    renderAt('/secrets');
    expect(within(nav()).getByRole('link', { name: 'Secrets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav()).getByRole('link', { name: 'Account' })).not.toHaveAttribute(
      'aria-current',
    );
    expect(
      within(nav())
        .getAllByRole('link')
        .filter((l) => l.getAttribute('aria-current') === 'page'),
    ).toHaveLength(1);
  });

  // THE REGRESSION TEST. The reported bug was that picking a destination made
  // the list of destinations disappear.
  it('keeps the nav on screen after navigating, and moves the current marker', async () => {
    renderAt('/secrets');
    await userEvent.click(within(nav()).getByRole('link', { name: 'Account' }));

    expect(screen.getByTestId('pathname')).toHaveTextContent('/account');
    expect(nav()).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Account' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // React Router matches `/secrets/` to the route declared `/secrets`, so the
  // page renders — but `useLocation().pathname` keeps the slash. Comparing it
  // raw against the row paths marked NOTHING as current, on a page that is
  // plainly one of the six.
  it('marks the current destination when the URL carries a trailing slash', () => {
    renderAt('/secrets/');
    expect(within(nav()).getByRole('link', { name: 'Secrets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('excludes a registry row that only opens a dialog', () => {
    renderAt('/secrets');
    expect(within(nav()).queryByRole('link', { name: 'Stub dialog row' })).toBeNull();
  });

  // A settings nav that could navigate you into Knowledge would be a nav that
  // replaces itself mid-click.
  it('excludes a registry row pointing outside the settings surface', () => {
    renderAt('/secrets');
    expect(within(nav()).queryByRole('link', { name: 'Stub elsewhere row' })).toBeNull();
  });

  // This is what keeps ShellRoutes.test.tsx free of providers: the layout
  // reads AdminContext directly rather than through useAdmin(), which throws.
  it('renders with no AdminContext at all, as a non-admin', () => {
    expect(() => renderAt('/secrets', { withAdminContext: false })).not.toThrow();
    expect(within(nav()).queryByText('Admin only')).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'App roles' })).toBeNull();
  });

  it('hides the admin section from a non-admin', () => {
    renderAt('/secrets', { isAdmin: false });
    expect(within(nav()).queryByText('Admin only')).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'App roles' })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'User accounts' })).toBeNull();
  });

  it('shows the admin section to an admin', () => {
    renderAt('/secrets', { isAdmin: true });
    expect(within(nav()).getByText('Admin only')).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'App roles' })).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'User accounts' })).toBeInTheDocument();
  });

  // isAdmin resolves asynchronously — the nav must not have baked in the
  // starting `false`.
  //
  // Rerendered through the SAME `routerTree`, with only the AdminContext value
  // changed, so the layout is UPDATED rather than replaced. The identity check
  // below is what enforces that: a remount would build a new <nav> node, and
  // the assertion after it would then be passing for the wrong reason — a
  // fresh component reading `isAdmin: true` on its first render proves nothing
  // about a memo going stale.
  it('grows the admin section when isAdmin flips true after mount', () => {
    const { rerender } = renderAt('/secrets', { isAdmin: false });
    const navBefore = nav();
    expect(within(navBefore).queryByRole('link', { name: 'App roles' })).toBeNull();

    rerender(withAdmin(true, routerTree('/secrets')));

    expect(nav()).toBe(navBefore);
    expect(within(nav()).getByRole('link', { name: 'App roles' })).toBeInTheDocument();
  });

  describe('narrow windows', () => {
    const stubMatchMedia = (matches: boolean) => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn().mockImplementation((query: string) => ({
          matches,
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })),
      );
    };

    it('fills the app sidebar frame on a wide window', () => {
      stubMatchMedia(false);
      renderAt('/secrets');
      // The app's one sidebar frame: an `<aside>` named for the surface it holds.
      const frame = screen.queryByRole('complementary', { name: 'Settings' });
      expect(frame).not.toBeNull();
      expect(frame).toContainElement(nav());
      vi.unstubAllGlobals();
    });

    // The one-sidebar invariant on phones: a 212px rail on a 375px screen is
    // most of the screen, so the rows become a strip and no frame is mounted.
    it('becomes a strip with no sidebar frame on a narrow window', () => {
      stubMatchMedia(true);
      renderAt('/secrets');
      expect(screen.queryByRole('complementary', { name: 'Settings' })).toBeNull();
      expect(noNav()).not.toBeNull();
      expect(within(nav()).getAllByRole('link')).toHaveLength(5);
      vi.unstubAllGlobals();
    });
  });
});

/**
 * An app's own settings pages (`AdminMenuItem.page`): rows of the registry
 * that bring a page are listed in the nav like core's, under the section they
 * name, to the people they are shown to.
 */
describe('SettingsLayout with pages the registry brings', () => {
  const INFRASTRUCTURE = { id: 'infrastructure', label: 'Infrastructure only' };
  const ada = { id: 'u1', email: 'ada@example.com', name: 'Ada' } as AuthUser;
  const pageRows: AdminMenuItem[] = [
    { id: 'connected-apps', order: 60, label: 'Connected apps', path: '/connected-apps', page: <div>Connected apps page</div> },
    { id: 'executors', section: INFRASTRUCTURE, label: 'Executors', path: '/executors/', page: <div>Executors page</div>, isShown: (user) => user.email === 'ada@example.com' },
    { id: 'llm', section: 'admin', order: 30, label: 'LLM configuration', path: '/llm-configuration', page: <div>LLM page</div> },
    // A path with no page is somewhere else in the app.
    { id: 'elsewhere', label: 'No page', path: '/agents/workflows' },
    // Rows that must NOT be linked: a page at a built-in address, at the old Connection keys address, at a path an
    // earlier row took, and a page row that also runs an action (the menu runs the action; a link would go around it).
    { id: 'takeover', label: 'Not the secrets page', path: '/secrets', page: <div>Never mounted</div> },
    { id: 'old-keys', label: 'Not the keys page', path: '/connection-keys', page: <div>Never mounted</div> },
    { id: 'second', label: 'Second at the same path', path: '/connected-apps', page: <div>Never mounted</div> },
    { id: 'acts', label: 'Runs an action', path: '/acts', page: <div>Acts page</div>, onSelect: () => {} },
    // A page row that also opens a dialog: the menu opens the dialog, so the row stays in the menu only.
    { id: 'opens', label: 'Opens a dialog', path: '/opens', page: <div>Opens page</div>, dialog: () => <></> },
    // Addresses the router reads as one already taken: the `/connect` redirect, core's page in other
    // case, and an earlier row's path in other case and with a trailing slash.
    { id: 'connect', label: 'Not the connect redirect', path: '/connect', page: <div>Never mounted</div> },
    { id: 'shouting', label: 'Not the secrets page either', path: '/SECRETS', page: <div>Never mounted</div> },
    { id: 'recased', label: 'Connected apps again', path: '/Connected-Apps/', page: <div>Never mounted</div> },
  ];

  function renderPages(route: string, { user = ada, isAdmin = false }: { user?: AuthUser | null; isAdmin?: boolean } = {}) {
    const tree = (
      <AppRegistryContext.Provider value={makeRegistry({ adminMenuItems: pageRows })}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route element={<SettingsLayout />}>
              <Route path="/secrets" element={<div>Secrets stub</div>} />
              {/* The app's pages as the shell mounts them: from the rows, through the one function that decides which are. */}
              {registrySettingsPages(pageRows).map((row) => (
                <Route key={row.path} path={row.path} element={row.page} />
              ))}
            </Route>
          </Routes>
        </MemoryRouter>
      </AppRegistryContext.Provider>
    );
    return render(
      <AuthContext.Provider value={(user ? { user } : null) as AuthContextValue | null}>{withAdmin(isAdmin, tree)}</AuthContext.Provider>,
    );
  }

  it('lists them with core\'s rows, in their order, each under its own section', () => {
    renderPages('/secrets', { isAdmin: true });
    expect(within(nav()).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'External agent access',
      'Audit log',
      'Secrets',
      'Connected apps',
      'Browse available tools',
      'Account',
      'Executors',
      'Deployment',
      'App roles',
      'Groups & Members',
      'User accounts',
      'LLM configuration',
    ]);
    // The app's section is labelled, between the default rows and "Admin only".
    expect(within(nav()).getByText('Infrastructure only')).toBeInTheDocument();
    expect(within(nav()).getAllByRole('link', { name: 'Secrets' })).toHaveLength(1);
    expect(within(nav()).queryByRole('link', { name: 'No page' })).toBeNull();
  });

  it('mounts a page per row that brings one, at its own path: never at a built-in address, and one page per path', () => {
    expect(registrySettingsPages(pageRows).map((row) => `${row.id} ${row.path}`)).toEqual([
      'connected-apps /connected-apps',
      'executors /executors',
      'llm /llm-configuration',
      'acts /acts',
      'opens /opens',
    ]);
  });

  it('marks the row current and shows its page when the URL spells the path in another case', () => {
    renderPages('/Executors/');
    expect(screen.getByText('Executors page')).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Executors' })).toHaveAttribute('aria-current', 'page');
  });

  it("counts an app's pages as settings paths through useSettingsNavPaths, and only core's without it", () => {
    function Probe() {
      const paths = useSettingsNavPaths();
      return (
        <>
          <output aria-label="with the app's pages">{String(isSettingsNavPath('/executors', paths))}</output>
          <output aria-label="core only">{String(isSettingsNavPath('/executors'))}</output>
        </>
      );
    }
    render(
      <AppRegistryContext.Provider value={makeRegistry({ adminMenuItems: pageRows })}>
        <Probe />
      </AppRegistryContext.Provider>,
    );
    expect(screen.getByRole('status', { name: "with the app's pages" })).toHaveTextContent('true');
    expect(screen.getByRole('status', { name: 'core only' })).toHaveTextContent('false');
  });

  it('shows the row\'s own page at its path and marks it current, whatever slashes the row was written with', () => {
    renderPages('/executors');
    expect(screen.getByText('Executors page')).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Executors' })).toHaveAttribute('aria-current', 'page');
    // Its section is a named group, so a link is heard with the section it is in.
    expect(within(screen.getByRole('group', { name: 'Infrastructure only' })).getByRole('link', { name: 'Executors' })).toBeInTheDocument();
  });

  it('asks who a row is shown to on every render, not once', () => {
    let role = false;
    const rows: AdminMenuItem[] = [{ id: 'late', label: 'Learnt later', path: '/late', page: <div>Late page</div>, isShown: () => role }];
    const tree = () => (
      <AuthContext.Provider value={{ user: ada } as AuthContextValue}>
        <AppRegistryContext.Provider value={registry}>
          <MemoryRouter initialEntries={['/secrets']}>
            <Routes>
              <Route element={<SettingsLayout />}>
                <Route path="/secrets" element={<div>Secrets stub</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AppRegistryContext.Provider>
      </AuthContext.Provider>
    );
    // The same registry object across both renders: nothing the layout memoizes on changes, only the answer does.
    const registry = makeRegistry({ adminMenuItems: rows });
    const { rerender } = render(tree());
    expect(within(nav()).queryByRole('link', { name: 'Learnt later' })).toBeNull();
    role = true;
    rerender(tree());
    expect(within(nav()).getByRole('link', { name: 'Learnt later' })).toBeInTheDocument();
  });

  it('offers a row to the people it is shown to, and its section only while a row of it shows', () => {
    renderPages('/secrets', { user: { ...ada, email: 'ben@example.com' } as AuthUser });
    expect(within(nav()).queryByRole('link', { name: 'Executors' })).toBeNull();
    expect(within(nav()).queryByText('Infrastructure only')).toBeNull();
    expect(within(nav()).getByRole('link', { name: 'Connected apps' })).toBeInTheDocument();
    // Not an admin either: a page the registry puts under "Admin only" is not advertised to them.
    expect(within(nav()).queryByRole('link', { name: 'LLM configuration' })).toBeNull();
  });

  it('with nobody signed in, offers none of the rows that ask who is', () => {
    renderPages('/secrets', { user: null });
    expect(within(nav()).queryByRole('link', { name: 'Executors' })).toBeNull();
    expect(within(nav()).getByRole('link', { name: 'Connected apps' })).toBeInTheDocument();
  });
});
