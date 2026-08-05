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

function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

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

describe('AppChrome — narrow navigation', () => {
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
