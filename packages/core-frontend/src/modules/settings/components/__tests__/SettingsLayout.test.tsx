import type { ReactNode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SettingsLayout } from '../SettingsLayout';
import { AdminContext, type AdminContextValue } from '../../../admin/state/admin.context';
import { SIDEBAR_DOM_ID } from '../../../layout/components/SidebarFrame';
import { setSidebarCollapsed } from '../../../layout/state/sidebar';
import { AppRegistryContext, makeRegistry, type AdminMenuItem } from '../../../../core/registry';

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
    expect(within(nav()).queryByRole('link', { name: 'Roles & Members' })).toBeNull();
  });

  it('hides the admin section from a non-admin', () => {
    renderAt('/secrets', { isAdmin: false });
    expect(within(nav()).queryByText('Admin only')).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'Roles & Members' })).toBeNull();
    expect(within(nav()).queryByRole('link', { name: 'User accounts' })).toBeNull();
  });

  it('shows the admin section to an admin', () => {
    renderAt('/secrets', { isAdmin: true });
    expect(within(nav()).getByText('Admin only')).toBeInTheDocument();
    expect(within(nav()).getByRole('link', { name: 'Roles & Members' })).toBeInTheDocument();
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
    expect(within(navBefore).queryByRole('link', { name: 'Roles & Members' })).toBeNull();

    rerender(withAdmin(true, routerTree('/secrets')));

    expect(nav()).toBe(navBefore);
    expect(within(nav()).getByRole('link', { name: 'Roles & Members' })).toBeInTheDocument();
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
      const frame = document.getElementById(SIDEBAR_DOM_ID);
      expect(frame).not.toBeNull();
      expect(frame).toContainElement(nav());
      vi.unstubAllGlobals();
    });

    // The one-sidebar invariant on phones: a 212px rail on a 375px screen is
    // most of the screen, so the rows become a strip and no frame is mounted.
    it('becomes a strip with no sidebar frame on a narrow window', () => {
      stubMatchMedia(true);
      renderAt('/secrets');
      expect(document.getElementById(SIDEBAR_DOM_ID)).toBeNull();
      expect(noNav()).not.toBeNull();
      expect(within(nav()).getAllByRole('link')).toHaveLength(4);
      vi.unstubAllGlobals();
    });
  });
});
