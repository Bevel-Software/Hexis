import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { ToolManualDetail } from '../services/tools.api';

/**
 * The page as a whole: what each URL state renders, the three signals that gate
 * it (read access, `canWrite`, `isAdmin`), and the OAuth fragment round-trip.
 *
 * Everything is selected by role / accessible name / text — the a11y contract
 * is what Ali's skill page and the deep links from `/secrets` and `/connect`
 * are built against, so it is the thing worth pinning.
 */

const secretsMock = vi.hoisted(() => ({
  listToolSecrets: vi.fn(),
  setAdminVar: vi.fn(),
  setUserVar: vi.fn(),
  deleteAdminVar: vi.fn(),
  setOAuthClientSecret: vi.fn(),
}));
vi.mock('../../secrets-vault/services/tool-secrets.api', () => secretsMock);

const toolsMock = vi.hoisted(() => ({ getToolDetail: vi.fn() }));
vi.mock('../services/tools.api', () => ({
  getToolDetail: toolsMock.getToolDetail,
  // The server section self-hides on null — these frame tests are not about it.
  getMcpServer: vi.fn(async () => null),
  putMcpServer: vi.fn(),
}));

const libraryMock = vi.hoisted(() => ({ listSkills: vi.fn(), getSkill: vi.fn() }));
vi.mock('../services/library.api', () => ({
  listSkills: libraryMock.listSkills,
  getSkill: libraryMock.getSkill,
}));

vi.mock('../../secrets-vault/services/connect.api', () => ({ startToolOAuth: vi.fn() }));
vi.mock('../utils/navigate-external', () => ({ navigateExternal: vi.fn() }));

import { ToolPage } from '../components/tool-page/ToolPage';

const GITHUB: ToolSecrets = {
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Plugins/GTM/heyreach.tool',
  type: 'inline',
  setup: null,
  canWrite: false,
  variables: [],
};

const DETAIL: ToolManualDetail = {
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Plugins/GTM/heyreach.tool',
  type: 'inline',
  description: 'Runs LinkedIn outreach campaigns.',
  capabilities: [
    { name: 'add_leads', description: 'Add leads to a campaign.' },
    { name: 'get_campaign', description: null },
  ],
};

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function admin(isAdmin: boolean) {
  return {
    isAdmin,
    unreadCount: 0,
    lastSeen: null,
    markSeen: vi.fn(),
    refresh: vi.fn(),
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: vi.fn(),
  };
}

/** Exposes the router's pathname so navigation away from the page is assertable. */
function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

function wrap(children: ReactNode, isAdmin: boolean) {
  return (
    <AdminContext.Provider value={admin(isAdmin)}>
      <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
    </AdminContext.Provider>
  );
}

function renderPage({ slug = 'heyreach', isAdmin = false } = {}) {
  return render(
    <MemoryRouter initialEntries={[`/skills-and-tools/tools/${slug}`]}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/tools/:slug" element={<ToolPage />} />
          <Route path="/skills-and-tools" element={<div>Gallery</div>} />
        </Routes>,
        isAdmin,
      )}
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.history.replaceState(null, '', '/skills-and-tools/tools/heyreach');
  secretsMock.listToolSecrets.mockReset().mockResolvedValue([GITHUB]);
  toolsMock.getToolDetail.mockReset().mockResolvedValue(DETAIL);
  libraryMock.listSkills.mockReset().mockResolvedValue([]);
  libraryMock.getSkill.mockReset().mockResolvedValue({ allowedTools: [] });
});

describe('ToolPage: frame', () => {
  it('loads, then shows the title, the lede and the ownerline, with no kicker', async () => {
    renderPage();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    expect(await screen.findByRole('heading', { name: 'heyreach', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/Tool · /)).toBeNull();
    expect(await screen.findByText('Runs LinkedIn outreach campaigns.')).toBeInTheDocument();
    expect(screen.getByText('Managed by the Admins.')).toBeInTheDocument();
  });

  it('shows no kicker for a legacy ungrouped path either', async () => {
    secretsMock.listToolSecrets.mockResolvedValue([
      { ...GITHUB, slug: 'slack', name: 'slack', path: 'Tools/slack.tool' },
    ]);
    toolsMock.getToolDetail.mockResolvedValue({ ...DETAIL, slug: 'slack', name: 'slack' });
    renderPage({ slug: 'slack' });

    await screen.findByRole('heading', { name: 'slack', level: 1 });
    expect(screen.queryByText(/^Tool$/)).toBeNull();
    expect(screen.queryByText(/Tool · /)).toBeNull();
  });

  it("goes back to the tool's own plugin from the back link", async () => {
    // Not the Library root: the reader opened this tool off its plugin page,
    // and "back" should land where the tool lives. Derived from the path, so
    // a deep link gets the same destination as a click.
    renderPage();
    await screen.findByRole('heading', { name: 'heyreach', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: '‹ GTM' }));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname').textContent).toBe('/skills-and-tools/plugins/GTM'),
    );
  });

  it('shows the fail-closed not-found copy for a slug nobody can reach', async () => {
    secretsMock.listToolSecrets.mockResolvedValue([]);
    renderPage({ slug: 'ghost' });

    expect(
      await screen.findByText("This tool doesn't exist, or you don't have access to it."),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '‹ All skills & tools' })).toBeInTheDocument();
  });

  it('offers Try again when the secrets listing fails, and refetches on click', async () => {
    secretsMock.listToolSecrets.mockRejectedValueOnce(new Error("Couldn't load tool secrets."));
    renderPage();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent("Couldn't load tool secrets.");

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'heyreach', level: 1 })).toBeInTheDocument();
    expect(secretsMock.listToolSecrets).toHaveBeenCalledTimes(2);
  });

  it('renders without the lede or capabilities when the detail read fails', async () => {
    toolsMock.getToolDetail.mockRejectedValue(new Error('no such endpoint'));
    renderPage();

    await screen.findByRole('heading', { name: 'heyreach', level: 1 });
    expect(screen.queryByText('Runs LinkedIn outreach campaigns.')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'What it lets the assistant do' })).toBeNull();
    // The connection section still works — this is what makes the page
    // shippable against a backend without the detail endpoint.
    expect(screen.getByRole('heading', { name: 'Your connection' })).toBeInTheDocument();
  });
});

describe('ToolPage: capabilities', () => {
  it('lists each capability, falling back to its name when it has no description', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'What it lets the assistant do' }),
    ).toBeInTheDocument();
    expect(screen.getByText('· Add leads to a campaign.')).toBeInTheDocument();
    expect(screen.getByText('· get_campaign')).toBeInTheDocument();
  });

  it('hides the section on emptiness, not on type (mcp tools always report [])', async () => {
    toolsMock.getToolDetail.mockResolvedValue({ ...DETAIL, type: 'mcp', capabilities: [] });
    renderPage();

    await screen.findByRole('heading', { name: 'heyreach', level: 1 });
    expect(screen.queryByRole('heading', { name: 'What it lets the assistant do' })).toBeNull();
  });
});

describe('ToolPage: powers these skills', () => {
  it('links each matching skill at the reserved skill route', async () => {
    libraryMock.listSkills.mockResolvedValue([
      { name: 'outreach', description: '', path: 'Plugins/GTM/outreach' },
      { name: 'roadmap', description: '', path: 'Plugins/Product/roadmap' },
    ]);
    libraryMock.getSkill.mockImplementation(async (name: string) =>
      name === 'outreach' ? { allowedTools: ['heyreach_add_leads'] } : { allowedTools: ['Bash'] },
    );

    renderPage();
    const chip = await screen.findByRole('link', { name: 'outreach' });
    expect(chip).toHaveAttribute('href', '/skills-and-tools/skills/outreach');
    expect(screen.queryByRole('link', { name: 'roadmap' })).toBeNull();
  });

  it('claims no skills use it only once the catalog has actually loaded', async () => {
    let releaseSkills: (skills: unknown[]) => void = () => {};
    libraryMock.listSkills.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSkills = resolve as (skills: unknown[]) => void;
        }),
    );

    renderPage();
    await screen.findByRole('heading', { name: 'Powers these skills' });
    // Not yet: an empty index we haven't loaded is not proof of absence.
    expect(screen.queryByText('No skills use this yet.')).toBeNull();

    releaseSkills([]);
    expect(await screen.findByText('No skills use this yet.')).toBeInTheDocument();
  });
});

describe('ToolPage: connection', () => {
  it('says there is nothing to set up when the tool declares no variables', async () => {
    renderPage();
    expect(await screen.findByText('Nothing to set up')).toBeInTheDocument();
  });

  it('surfaces a failed write as a page-level alert', async () => {
    secretsMock.setAdminVar.mockRejectedValue(new Error('Forbidden'));
    secretsMock.listToolSecrets.mockResolvedValue([
      {
        ...GITHUB,
        canWrite: true,
        variables: [
          {
            name: 'API_KEY',
            scope: 'admin',
            label: null,
            key: 'heyreach_API_KEY',
            adminConfigured: false,
            userConfigured: false,
          },
        ],
      },
    ]);

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Set key' }));
    fireEvent.change(screen.getByLabelText('Value for API_KEY'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Forbidden');
  });
});

describe('ToolPage: manage access', () => {
  it('offers none, to anyone, including an admin', async () => {
    // Access is decided at the PLUGIN. A tool inherits its folder's rules, so an
    // editor here would either duplicate the plugin's or quietly write a
    // per-file override nobody looking at the plugin would ever see.
    renderPage({ isAdmin: true });
    await screen.findByRole('heading', { name: 'heyreach', level: 1 });
    expect(screen.queryByRole('button', { name: 'Manage access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();
  });
});

describe('ToolPage: OAuth round-trip', () => {
  it('announces a successful sign-in and consumes the fragment', async () => {
    window.history.replaceState(null, '', '/skills-and-tools/tools/heyreach#authorized=sec_1');
    renderPage();

    expect(await screen.findByRole('status')).toHaveTextContent('Signed in to heyreach.');
    // Consumed, so a refresh doesn't re-announce it.
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.pathname).toBe('/skills-and-tools/tools/heyreach');
  });

  it('shows the callback error verbatim, decoded exactly once', async () => {
    window.history.replaceState(
      null,
      '',
      '/skills-and-tools/tools/heyreach#error=Access%20denied%20100%25',
    );
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Access denied 100%');
    await waitFor(() => expect(window.location.hash).toBe(''));
  });
});
