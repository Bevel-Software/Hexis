import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppSwitcher } from '../AppSwitcher';
import {
  ActiveAppIdContext,
  AppRegistryContext,
  makeRegistry,
  type AppDef,
} from '../../../../core/registry';

/** Exposes the router's current pathname so navigation can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

/**
 * Move the viewport. happy-dom answers `matchMedia` out of `innerWidth`, so
 * this is how a test crosses the toolbar's compact breakpoint.
 */
function setViewportWidth(width: number): void {
  const testWindow = window as typeof window & {
    happyDOM: { setInnerWidth(value: number): void };
  };
  testWindow.happyDOM.setInnerWidth(width);
}

// The switcher reads apps from the registry — in the app the shell merges
// the core apps in (see CoreAppShell CORE_APPS); the harness mirrors that.
const coreLikeApps: AppDef[] = [
  {
    id: 'knowledge',
    label: 'Knowledge',
    path: '/workspace',
    description: 'Browse and edit your knowledge base',
    order: 10,
    element: <div />,
  },
  {
    id: 'skills-tools',
    label: 'Skills & Tools',
    path: '/skills-and-tools',
    description: 'What your assistant can do, and what it connects to',
    order: 20,
    element: <div />,
  },
];

const assistantApp: AppDef = {
  id: 'assistant',
  label: 'Assistant',
  path: '/assistant',
  description: 'Chat with your knowledge base',
  order: 30,
  element: <div />,
};

const insightsApp: AppDef = {
  id: 'insights',
  label: 'Insights',
  path: '/insights',
  order: 40,
  element: <div />,
};

function renderSwitcher(opts?: {
  path?: string;
  /** Registry apps past the two core ones. */
  extraApps?: AppDef[];
  shellActiveId?: string;
}) {
  const registry = makeRegistry({ apps: [...coreLikeApps, ...(opts?.extraApps ?? [])] });
  const tree = (
    <MemoryRouter initialEntries={[opts?.path ?? '/']}>
      <AppSwitcher />
      <LocationProbe />
    </MemoryRouter>
  );
  return render(
    <AppRegistryContext.Provider value={registry}>
      {opts?.shellActiveId ? (
        <ActiveAppIdContext.Provider value={opts.shellActiveId}>{tree}</ActiveAppIdContext.Provider>
      ) : (
        tree
      )}
    </AppRegistryContext.Provider>,
  );
}

beforeEach(() => {
  setViewportWidth(1400);
});

describe('AppSwitcher as a segmented toggle (few apps, wide toolbar)', () => {
  const nav = () => screen.getByRole('navigation', { name: 'Apps' });

  it('shows the brand as text and both core apps side by side, with no menu', () => {
    renderSwitcher({ path: '/workspace' });
    expect(screen.getByText(/^Hexis by/).closest('button')).toBeNull();
    const links = within(nav()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Knowledge', 'Skills & Tools']);
    expect(screen.queryByRole('button', { name: 'Switch app' })).not.toBeInTheDocument();
  });

  it('marks the app matching the current location as current', () => {
    renderSwitcher({ path: '/workspace/main/Skills' });
    expect(within(nav()).getByRole('link', { name: 'Knowledge' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav()).getByRole('link', { name: 'Skills & Tools' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  // See the menu's equivalent below: a skill page at its canonical
  // /workspace URL CLAIMS Skills & Tools, and the toggle follows the claim.
  it('honours a shell-provided active app over the URL prefix', () => {
    renderSwitcher({
      path: '/workspace/main/knowledge-base/Plugins/Sales/create-sales-deck/SKILL.md',
      shellActiveId: 'skills-tools',
    });
    expect(within(nav()).getByRole('link', { name: 'Skills & Tools' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav()).getByRole('link', { name: 'Knowledge' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('marks no app as current on a standalone settings page', () => {
    renderSwitcher({ path: '/secrets' });
    for (const link of within(nav()).getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('navigates to the chosen app and moves the current mark with it', async () => {
    renderSwitcher({ path: '/workspace' });
    await userEvent.click(within(nav()).getByRole('link', { name: 'Skills & Tools' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools');
    expect(within(nav()).getByRole('link', { name: 'Skills & Tools' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('stays put when the current app is clicked from a deep link inside it', async () => {
    renderSwitcher({ path: '/workspace/main/Skills' });
    await userEvent.click(within(nav()).getByRole('link', { name: 'Knowledge' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/main/Skills');
  });

  it('still fits a third, registry-contributed app', () => {
    renderSwitcher({ extraApps: [assistantApp] });
    expect(within(nav()).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Knowledge',
      'Skills & Tools',
      'Assistant',
    ]);
  });

  it('falls back to the menu with four apps', () => {
    renderSwitcher({ extraApps: [assistantApp, insightsApp] });
    expect(screen.queryByRole('navigation', { name: 'Apps' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch app' })).toBeInTheDocument();
  });

  it('falls back to the menu on a compact toolbar', () => {
    setViewportWidth(600);
    renderSwitcher({ path: '/workspace' });
    expect(screen.queryByRole('navigation', { name: 'Apps' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch app' })).toHaveTextContent('Knowledge');
  });
});

/**
 * The menu is what more than three apps get, so these run against a
 * four-app registry; the compact case is covered by the fallback test above.
 */
describe('AppSwitcher as a menu (more than three apps)', () => {
  const renderMenu = (opts?: { path?: string; shellActiveId?: string }) =>
    renderSwitcher({ ...opts, extraApps: [assistantApp, insightsApp] });

  it('renders the brand as the trigger and no menu until clicked', () => {
    renderMenu();
    expect(screen.getByText('Hexis by Bevel')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('names the current app next to the brand', () => {
    renderMenu({ path: '/skills-and-tools' });
    const trigger = screen.getByRole('button', { name: 'Switch app' });
    expect(trigger).toHaveTextContent('Bevel');
    expect(trigger).toHaveTextContent('Skills & Tools');
  });

  it('names the current app on a deep link inside it', () => {
    renderMenu({ path: '/workspace/main/Skills' });
    expect(screen.getByRole('button', { name: 'Switch app' })).toHaveTextContent(
      'Knowledge',
    );
  });

  /**
   * The shell's answer beats the prefix rule. A skill page at its canonical
   * /workspace URL CLAIMS Skills & Tools (WorkspaceItemGate via
   * AppClaimContext → the shell's ActiveAppIdContext) — the switcher must
   * name the surface on screen, not the app that owns the URL prefix.
   */
  it('honours a shell-provided active app over the URL prefix', () => {
    renderMenu({
      path: '/workspace/main/knowledge-base/Plugins/Sales/create-sales-deck/SKILL.md',
      shellActiveId: 'skills-tools',
    });
    expect(screen.getByRole('button', { name: 'Switch app' })).toHaveTextContent(
      'Skills & Tools',
    );
  });

  it('shows the brand alone where no app is active', () => {
    renderMenu({ path: '/secrets' });
    const trigger = screen.getByRole('button', { name: 'Switch app' });
    expect(trigger).toHaveTextContent('Bevel');
    expect(trigger).not.toHaveTextContent('Knowledge');
    expect(trigger).not.toHaveTextContent('Skills & Tools');
  });

  it('updates the named app after switching', async () => {
    renderMenu({ path: '/workspace' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Skills & Tools/ }));
    expect(screen.getByRole('button', { name: 'Switch app' })).toHaveTextContent(
      'Skills & Tools',
    );
  });

  it('opens the Apps list with the two core apps', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Apps')).toBeInTheDocument();
    expect(within(menu).getByText('Knowledge')).toBeInTheDocument();
    expect(within(menu).getByText('Skills & Tools')).toBeInTheDocument();
  });

  it('appends registry-contributed apps after the core ones', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Knowledge'),
      expect.stringContaining('Skills & Tools'),
      expect.stringContaining('Assistant'),
      expect.stringContaining('Insights'),
    ]);
  });

  it('marks the app matching the current location as current', async () => {
    renderMenu({ path: '/skills-and-tools' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const current = screen.getByLabelText('Current app');
    expect(current.closest('[role="menuitem"]')).toHaveTextContent('Skills & Tools');
  });

  it('marks Knowledge as current on a KB deep link', async () => {
    renderMenu({ path: '/workspace/main/Skills' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const current = screen.getByLabelText('Current app');
    expect(current.closest('[role="menuitem"]')).toHaveTextContent('Knowledge');
  });

  it('marks no app as current on a standalone settings page', async () => {
    renderMenu({ path: '/secrets' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    expect(screen.queryByLabelText('Current app')).not.toBeInTheDocument();
  });

  it('navigates to the selected app and closes the menu', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Skills & Tools/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape without navigating', async () => {
    renderMenu();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/');
  });
});
