import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AppChrome } from '../CoreAppShell';
import { AppRegistryContext, makeRegistry, type AppDef } from '../registry';
import { setSidebarCollapsed, toggleSidebar, useSidebar } from '../../modules/layout';

vi.mock('../../modules/toolbar/components/Toolbar', () => ({
  Toolbar: () => null,
}));
vi.mock('../../modules/layout/components/DemoBanner', () => ({
  DemoBanner: () => null,
}));
vi.mock('../../modules/admin/components/RolesCorruptedBanner', () => ({
  RolesCorruptedBanner: () => null,
}));

/**
 * A stand-in app surface carrying the two gestures these tests need — the
 * toolbar's nav toggle and a navigation — plus the sidebar's collapsed state
 * as an assertable `<output>`. Registered under two routes so "navigate"
 * genuinely changes the path rather than re-rendering the same one.
 */
function RouteHarness({ destination }: { destination: string }) {
  const navigate = useNavigate();
  const { collapsed } = useSidebar();
  return (
    <>
      <output aria-label="sidebar state">{collapsed ? 'collapsed' : 'expanded'}</output>
      <button type="button" onClick={toggleSidebar}>
        Toggle sidebar
      </button>
      <button type="button" onClick={() => navigate(destination)}>
        Navigate
      </button>
    </>
  );
}

const apps: AppDef[] = [
  {
    id: 'first',
    label: 'First',
    path: '/first',
    element: <RouteHarness destination="/second" />,
  },
  {
    id: 'second',
    label: 'Second',
    path: '/second',
    element: <RouteHarness destination="/first" />,
  },
];

/**
 * Cross the narrow breakpoint. happy-dom answers `matchMedia` out of
 * `innerWidth`, so moving the viewport is how a test reaches the drawer
 * layout — there is no CSS engine here to do it for us.
 */
function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

/**
 * Mount the chrome at a given viewport width. The width is set BEFORE render
 * so the first render already sees the breakpoint, matching a real page load
 * on a phone rather than a desktop mount that later resizes.
 */
function renderChrome(width: number) {
  setViewportWidth(width);
  return render(
    <MemoryRouter initialEntries={['/first']}>
      <AppRegistryContext.Provider value={makeRegistry({ apps })}>
        <AppChrome />
      </AppRegistryContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setViewportWidth(1400);
  // Module state: open the sidebar the previous test may have left collapsed.
  // Its `narrow` flag needs no reset here, because nothing in this file sets
  // it: only a mounted sidebar frame reports the breakpoint to the store, the
  // narrow tests mount stand-in surfaces with no frame (the chrome collapses
  // the sidebar from its own media query), and the one test that mounts a
  // frame does so at a wide width.
  setSidebarCollapsed(false);
});

describe('AppChrome: narrow navigation', () => {
  it('closes a manually opened sidebar after a narrow-screen navigation', () => {
    renderChrome(375);
    expect(screen.getByRole('status', { name: 'sidebar state' })).toHaveTextContent(
      'collapsed',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    expect(screen.getByRole('status', { name: 'sidebar state' })).toHaveTextContent(
      'expanded',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(screen.getByRole('status', { name: 'sidebar state' })).toHaveTextContent(
      'collapsed',
    );
  });

  it('does not change sidebar state after a wide-screen navigation', () => {
    renderChrome(1400);
    expect(screen.getByRole('status', { name: 'sidebar state' })).toHaveTextContent(
      'expanded',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Navigate' }));
    expect(screen.getByRole('status', { name: 'sidebar state' })).toHaveTextContent(
      'expanded',
    );
  });
});

// The registry alone puts an app's settings page on screen: a row with a
// `path` and a `page`, and nothing handed to the routes by the test.
describe('AppChrome: a settings page the registry brings', () => {
  it('mounts the page of a registry row at its path, inside the settings nav', () => {
    setViewportWidth(1400);
    const row = { id: 'executors', label: 'Executors', path: '/executors', page: <div data-testid="executors-page" /> };
    render(
      <MemoryRouter initialEntries={['/executors']}>
        <AppRegistryContext.Provider value={makeRegistry({ apps, adminMenuItems: [row] })}>
          <AppChrome />
        </AppRegistryContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('executors-page')).toBeInTheDocument();
    const settingsNav = screen.getByRole('navigation', { name: 'Settings' });
    expect(within(settingsNav).getByRole('link', { name: 'Executors' })).toHaveAttribute('aria-current', 'page');
  });
});
