import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ShellRoutes } from '../CoreAppShell';
import type { AppDef } from '../registry';

// The /secrets standalone page fetches on mount — stub its data layer so the
// route can render without a network. (The other standalone pages are not
// visited by these tests.)
vi.mock('../../modules/secrets-vault/services/secrets.api', () => ({
  listSecrets: vi.fn(async () => []),
  createOAuthSecret: vi.fn(async () => {}),
  deleteSecret: vi.fn(async () => {}),
  startOAuth: vi.fn(async () => ''),
}));
vi.mock('../../modules/secrets-vault/services/tool-secrets.api', () => ({
  listToolSecrets: vi.fn(async () => []),
  setAdminVar: vi.fn(async () => {}),
  setUserVar: vi.fn(async () => {}),
  setOAuthClientSecret: vi.fn(async () => {}),
  deleteAdminVar: vi.fn(async () => {}),
  deleteUserVar: vi.fn(async () => {}),
}));

/** Exposes the router's current pathname so redirects can be asserted. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="pathname">{location.pathname}</div>;
}

// Stub app surfaces — the route table is what's under test, not the panes.
const apps: AppDef[] = [
  {
    id: 'knowledge',
    label: 'Knowledge',
    path: '/workspace',
    order: 10,
    element: <div data-testid="knowledge-surface" />,
  },
  {
    id: 'skills-tools',
    label: 'Skills & Tools',
    path: '/skills-and-tools',
    order: 20,
    element: <div data-testid="skills-surface" />,
  },
];

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShellRoutes apps={apps} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('ShellRoutes', () => {
  it('redirects / to /workspace and renders the Knowledge surface', () => {
    renderAt('/');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/workspace$/);
    expect(screen.getByTestId('knowledge-surface')).toBeInTheDocument();
  });

  it('sends the retired /library path into the catch-all → /workspace', () => {
    renderAt('/library');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/workspace$/);
    expect(screen.getByTestId('knowledge-surface')).toBeInTheDocument();
  });

  it('sends an unknown URL into the catch-all → /workspace', () => {
    renderAt('/no-such-page/at-all');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/workspace$/);
    expect(screen.getByTestId('knowledge-surface')).toBeInTheDocument();
  });

  it('keeps a KB deep link inside the Knowledge surface', () => {
    renderAt('/workspace/main/SomeFile.md');
    expect(screen.getByTestId('pathname')).toHaveTextContent('/workspace/main/SomeFile.md');
    expect(screen.getByTestId('knowledge-surface')).toBeInTheDocument();
  });

  it('renders the Skills & Tools surface at /skills-and-tools', () => {
    renderAt('/skills-and-tools');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/skills-and-tools$/);
    expect(screen.getByTestId('skills-surface')).toBeInTheDocument();
  });

  it('renders the standalone Secrets page at /secrets without redirecting', async () => {
    renderAt('/secrets');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/secrets$/);
    expect(await screen.findByRole('heading', { name: 'Secrets' })).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-surface')).not.toBeInTheDocument();
  });
});
