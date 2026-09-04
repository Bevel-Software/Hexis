import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { AppChrome } from '../CoreAppShell';
import { AppRegistryContext, makeRegistry, type AppDef } from '../registry';
import {
  setSidebarCollapsed,
  setSidebarNarrow,
  toggleSidebar,
  useSidebar,
} from '../../modules/layout/state/sidebar';

vi.mock('../../modules/toolbar/components/Toolbar', () => ({
  Toolbar: () => null,
}));
vi.mock('../../modules/layout/components/DemoBanner', () => ({
  DemoBanner: () => null,
}));
vi.mock('../../modules/admin/components/RolesCorruptedBanner', () => ({
  RolesCorruptedBanner: () => null,
}));
vi.mock('../../modules/update-check/components/UpdateBanner', () => ({
  UpdateBanner: () => null,
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
  // Module state: clear the breakpoint the previous test settled on so this
  // mount reads as a fresh crossing rather than a no-op.
  setSidebarNarrow(false);
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
