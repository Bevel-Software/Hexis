import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AppSwitcher } from '../AppSwitcher';
import { ActiveAppIdContext, AppRegistryContext, makeRegistry } from '../../../../core/registry';

/** Exposes the router's current pathname so navigation can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

function renderSwitcher(opts?: { path?: string; extraApps?: boolean; shellActiveId?: string }) {
  // The switcher reads apps from the registry — in the app the shell merges
  // the core apps in (see CoreAppShell CORE_APPS); the harness mirrors that.
  const coreLikeApps = [
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
  const registry = makeRegistry({
    apps: opts?.extraApps
      ? [
          ...coreLikeApps,
          {
            id: 'assistant',
            label: 'Assistant',
            path: '/assistant',
            description: 'Chat with your knowledge base',
            order: 30,
            element: <div />,
          },
        ]
      : coreLikeApps,
  });
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

describe('AppSwitcher', () => {
  it('renders the brand as the trigger and no menu until clicked', () => {
    renderSwitcher();
    expect(screen.getByText('Bevel')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('names the current app next to the brand', () => {
    renderSwitcher({ path: '/skills-and-tools' });
    const trigger = screen.getByRole('button', { name: 'Switch app' });
    expect(trigger).toHaveTextContent('Bevel');
    expect(trigger).toHaveTextContent('Skills & Tools');
  });

  it('names the current app on a deep link inside it', () => {
    renderSwitcher({ path: '/workspace/main/Skills' });
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
    renderSwitcher({
      path: '/workspace/main/knowledge-base/Groups/Sales/create-sales-deck/SKILL.md',
      shellActiveId: 'skills-tools',
    });
    expect(screen.getByRole('button', { name: 'Switch app' })).toHaveTextContent(
      'Skills & Tools',
    );
  });

  it('shows the brand alone where no app is active', () => {
    renderSwitcher({ path: '/secrets' });
    const trigger = screen.getByRole('button', { name: 'Switch app' });
    expect(trigger).toHaveTextContent('Bevel');
    expect(trigger).not.toHaveTextContent('Knowledge');
    expect(trigger).not.toHaveTextContent('Skills & Tools');
  });

  it('updates the named app after switching', async () => {
    renderSwitcher({ path: '/workspace' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Skills & Tools/ }));
    expect(screen.getByRole('button', { name: 'Switch app' })).toHaveTextContent(
      'Skills & Tools',
    );
  });

  it('opens the Apps list with the two core apps', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Apps')).toBeInTheDocument();
    expect(within(menu).getByText('Knowledge')).toBeInTheDocument();
    expect(within(menu).getByText('Skills & Tools')).toBeInTheDocument();
  });

  it('appends registry-contributed apps after the core ones', async () => {
    renderSwitcher({ extraApps: true });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('Knowledge'),
      expect.stringContaining('Skills & Tools'),
      expect.stringContaining('Assistant'),
    ]);
  });

  it('marks the app matching the current location as current', async () => {
    renderSwitcher({ path: '/skills-and-tools' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const current = screen.getByLabelText('Current app');
    expect(current.closest('[role="menuitem"]')).toHaveTextContent('Skills & Tools');
  });

  it('marks Knowledge as current on a KB deep link', async () => {
    renderSwitcher({ path: '/workspace/main/Skills' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    const current = screen.getByLabelText('Current app');
    expect(current.closest('[role="menuitem"]')).toHaveTextContent('Knowledge');
  });

  it('marks no app as current on a standalone settings page', async () => {
    renderSwitcher({ path: '/secrets' });
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    expect(screen.queryByLabelText('Current app')).not.toBeInTheDocument();
  });

  it('navigates to the selected app and closes the menu', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Skills & Tools/ }));
    expect(screen.getByTestId('pathname')).toHaveTextContent('/skills-and-tools');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes on Escape without navigating', async () => {
    renderSwitcher();
    await userEvent.click(screen.getByRole('button', { name: 'Switch app' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('pathname')).toHaveTextContent('/');
  });
});
