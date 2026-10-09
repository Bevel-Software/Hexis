import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import { ShellRoutes } from '../CoreAppShell';
import type { AppDef } from '../registry';

// The /secrets standalone page fetches on mount — stub its data layer so the
// route can render without a network. (The other standalone pages are not
// visited by these tests. Any future test that visits /account, /tools,
// /user-accounts or /roles-and-members needs that page's data layer mocked
// here too — they all now share the SettingsLayout route, but each still
// fetches its own.)
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
// The change-request address opens the request by number; the fetch is
// stubbed so the route can render without a network, and the view is the
// stand-in below — the route table is what is under test.
vi.mock('../../modules/git/services/pr.api', () => ({
  getPullRequest: vi.fn(async (num: number) => ({ number: num, title: `Request `, author: { login: 'bot' } })),
  listPullRequestsForMe: vi.fn(async () => []),
  listMyPullRequests: vi.fn(async () => []),
}));
vi.mock('../../modules/change-requests/components/ChangeRequestDialog', () => ({
  ChangeRequestDialog: ({ cr }: { cr: { number: number } }) => <div data-testid="cr-dialog">{cr.number}</div>,
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

  it('keeps a tool deep link inside the Skills & Tools surface', () => {
    // The app owns everything under `/skills-and-tools/*`, so its nested
    // routes (the tool page, the plugin pages) must not fall into the shell's
    // catch-all on a cold load or a refresh.
    renderAt('/skills-and-tools/tools/heyreach');
    expect(screen.getByTestId('pathname')).toHaveTextContent(
      /^\/skills-and-tools\/tools\/heyreach$/,
    );
    expect(screen.getByTestId('skills-surface')).toBeInTheDocument();
  });

  it('renders the standalone Secrets page at /secrets without redirecting', async () => {
    renderAt('/secrets');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/secrets$/);
    expect(await screen.findByRole('heading', { name: 'Secrets' })).toBeInTheDocument();
    expect(screen.queryByTestId('knowledge-surface')).not.toBeInTheDocument();
  });

  // The pathless SettingsLayout wraps the settings routes only. Both cases
  // below deliberately need NO providers: the layout reads AdminContext
  // directly rather than through useAdmin(), which would throw here.
  it('keeps the settings nav on screen at /secrets', async () => {
    renderAt('/secrets');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Secrets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  // Guards the one-sidebar invariant where it is actually enforced — the route
  // table. Settings and the app surfaces are exclusive siblings, so they can
  // never both mount a frame carrying the same DOM id.
  it('does not wrap an app surface in the settings layout', () => {
    renderAt('/workspace/main');
    expect(screen.queryByRole('navigation', { name: 'Settings' })).toBeNull();
    expect(screen.getByTestId('knowledge-surface')).toBeInTheDocument();
  });
});

describe('ShellRoutes — the change-request address', () => {
  // The link the backend builds for every change request. It used to fall
  // into the catch-all and land on Knowledge with nothing open.
  it('opens the request at /change-requests/<number> instead of redirecting', async () => {
    renderAt('/change-requests/276');
    expect(screen.getByTestId('pathname')).toHaveTextContent(/^\/change-requests\/276$/);
    expect(await screen.findByTestId('cr-dialog')).toHaveTextContent('276');
    expect(screen.queryByTestId('knowledge-surface')).not.toBeInTheDocument();
  });
});

describe('ShellRoutes — /connect', () => {
  /** The whole address, and how the router got there. */
  function AddressProbe() {
    const { pathname, search, hash } = useLocation();
    return (
      <>
        <div data-testid="address">{pathname + search + hash}</div>
        <div data-testid="navigation">{useNavigationType()}</div>
      </>
    );
  }

  function renderConnect(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <ShellRoutes apps={apps} />
        <AddressProbe />
      </MemoryRouter>,
    );
  }

  // The server keeps handing out `/connect` — MCP consent (`?oauth=`), tool
  // sign-in returns (`#authorized`, `#error=`) — and each of those depends on
  // what rides along, so the redirect must carry the query AND the fragment.
  it.each([
    ['/connect', '/skills-and-tools/connect'],
    ['/connect?oauth=abc&x=1#authorized=1', '/skills-and-tools/connect?oauth=abc&x=1#authorized=1'],
    ['/connect#error=Nope.', '/skills-and-tools/connect#error=Nope.'],
    ['/connect?from=agent', '/skills-and-tools/connect?from=agent'],
  ])('sends %s to %s inside Skills & Tools', (from, to) => {
    renderConnect(from);
    expect(screen.getByTestId('address')).toHaveTextContent(to);
    expect(screen.getByTestId('skills-surface')).toBeInTheDocument();
  });

  // Back must not land on an address that only bounces forward again.
  it('replaces the history entry rather than pushing one', () => {
    renderConnect('/connect?oauth=abc');
    expect(screen.getByTestId('navigation')).toHaveTextContent('REPLACE');
  });
});
