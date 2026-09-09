import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { PluginSummary } from '../services/plugins.api';
import type { ToolPageState } from '../hooks/useToolPage';

/**
 * The Library's routes, end to end through the layout: URL in, page + lit
 * sidebar row out. The catalog and the plugin index are stubbed at the data
 * seam; everything from the router down is real.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const pluginsMock = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  listJoinRequests: vi.fn(),
}));
vi.mock('../services/plugins.api', () => ({
  listPlugins: pluginsMock.listPlugins,
  listJoinRequests: pluginsMock.listJoinRequests,
  reconcileJoinRequest: vi.fn(),
  requestPluginAccess: vi.fn(),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

const teamsMock = vi.hoisted(() => ({ listTeams: vi.fn() }));
vi.mock('../services/teams.api', () => ({ listTeams: teamsMock.listTeams }));
// The sidebar's change-request dock pulls in git wiring these routes do not exercise.
vi.mock('../../git/components/PullRequestsForMe', () => ({ PullRequestsForMe: () => null }));

const toolPageMock = vi.hoisted(() => ({ useToolPage: vi.fn() }));
vi.mock('../hooks/useToolPage', () => ({ useToolPage: toolPageMock.useToolPage }));

vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return {
    ...actual,
    fetchFileAccess: vi.fn().mockResolvedValue({
      canRead: true,
      canWrite: false,
      canDownload: false,
      canOwner: false,
      eligible: { roles: [], users: [] },
      readers: { restricted: true, roles: [], users: [] },
      owners: { roles: [], users: [] },
      downloaders: { roles: [], users: [] },
      sources: {},
    }),
    fetchAccessOverrides: vi.fn().mockResolvedValue({ overrides: [], truncated: false }),
  };
});

import { LibraryRoutes } from '../routes/LibraryRoutes';
import { withAuth, TEST_PERSONAL_GROUP } from './auth-harness';

const tool = (over: Partial<ToolSecrets>): ToolSecrets => ({
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Plugins/GTM/heyreach.tool',
  type: 'inline',
  setup: null,
  canWrite: false,
  variables: [],
  ...over,
});

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [
    { name: 'outreach', description: 'Runs the GTM outreach.', path: 'Plugins/GTM/outreach' },
    { name: 'roadmap', description: 'Keeps the roadmap.', path: 'Plugins/Product/roadmap' },
    { name: 'scratch', description: 'A skill in no plugin.', path: 'Skills/scratch' },
  ],
  pendingSkills: [],
  tools: [tool({}), tool({ slug: 'slack', name: 'slack', path: 'Tools/slack.tool' })],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set(),
  reload: vi.fn(),
};

const PLUGINS: PluginSummary[] = [
  {
    name: 'GTM',
    folders: ['Plugins/GTM'],
    canRead: true,
    canWrite: true,
    isOwner: false,
    skillCount: 1,
    toolCount: 1,
    owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
    writers: { roles: ['Admin'], users: [] },
    readers: { restricted: true, roles: ['GTM Team'], users: [] },
    hasRequested: false,
    requestNumber: null,
  },
];

const TEAMS = [
  { name: 'GTM Team', plugins: ['GTM'], skills: ['outreach'], tools: ['heyreach'] },
  { name: 'Everyone Else', plugins: [], skills: ['scratch'], tools: [] },
];

const TOOL_PAGE_STATE: ToolPageState = {
  loading: false,
  error: null,
  notFound: false,
  tool: tool({}),
  detail: null,
  skillsLoaded: true,
  poweredSkills: [],
  revision: 0,
  reload: vi.fn(),
};

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}{location.search}{location.hash}</div>;
}

function wrap(children: ReactNode) {
  const adminValue = {
    isAdmin: false,
    unreadCount: 0,
    lastSeen: null,
    markSeen: vi.fn(),
    refresh: vi.fn(),
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: vi.fn(),
  };
  const workspaceValue = {
    workspaceId: 'target-company-state',
    kbDirName: 'knowledge-base',
  } as unknown as WorkspaceContextValue;
  return (
    <AdminContext.Provider value={adminValue}>
      <WorkspaceContext.Provider value={workspaceValue}>{withAuth(children)}</WorkspaceContext.Provider>
    </AdminContext.Provider>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
        </Routes>,
      )}
      <LocationProbe />
    </MemoryRouter>,
  );
}

const pathname = () => screen.getByLabelText('pathname').textContent;
const nav = () => screen.getByRole('navigation', { name: 'Library navigation' });
const main = () => screen.getByRole('main');

describe('LibraryRoutes', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    pluginsMock.listPlugins.mockResolvedValue(PLUGINS);
    teamsMock.listTeams.mockResolvedValue(TEAMS);
    toolPageMock.useToolPage.mockReturnValue(TOOL_PAGE_STATE);
    pluginsMock.listJoinRequests.mockResolvedValue([]);
  });

  it('opens on Everything at /skills-and-tools — plugins as rows above the cards', async () => {
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: /^Everything/ })).toHaveAttribute('aria-current', 'true');
    expect(within(nav()).getByRole('button', { name: /^Owned by me/ })).toHaveAttribute('aria-current', 'false');
    // The plugin rows: the caller's own space first, then the index.
    expect(await within(main()).findByRole('heading', { name: 'Plugins', level: 2 })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
  });

  it('sends the old /everything address to the root, where the same page lives', async () => {
    renderAt('/skills-and-tools/everything');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
  });

  it('/skills-and-tools/owned selects Owned by me', async () => {
    renderAt('/skills-and-tools/owned');
    expect(await screen.findByRole('heading', { name: 'Owned by me' })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: /^Owned by me/ })).toHaveAttribute('aria-current', 'true');
    // GTM is managed by the caller (canWrite): it is theirs. Product is not.
    expect(await within(main()).findByRole('button', { name: /^GTM/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: /^Product/ })).toBeNull();
  });

  it("/skills-and-tools/yours is the caller's own plugin, as a plugin page", async () => {
    renderAt('/skills-and-tools/yours');
    expect(await screen.findByRole('heading', { name: TEST_PERSONAL_GROUP, level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Skills', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tools', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('lists the teams in the nav, and a team row opens what that team can use', async () => {
    renderAt('/skills-and-tools');
    const row = await within(nav()).findByRole('button', { name: /^GTM Team/ });
    fireEvent.click(row);
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/teams/GTM%20Team'));
    expect(await screen.findByRole('heading', { name: 'GTM Team', level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: /^GTM Team/ })).toHaveAttribute('aria-current', 'true');
    // The server's slice: GTM's row, outreach and heyreach — nothing of Product's, and no personal row.
    expect(await within(main()).findByRole('button', { name: /^GTM/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeNull();
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
    expect(screen.getByTestId('library-card-integration-heyreach')).toBeInTheDocument();
    expect(screen.queryByTestId('library-card-skill-roadmap')).toBeNull();
    expect(screen.queryByTestId('library-card-integration-slack')).toBeNull();
  });

  it('a team deep link with a URL-hostile name lands, and an unknown team says so', async () => {
    teamsMock.listTeams.mockResolvedValue([{ name: 'Sales & Ops', plugins: [], skills: ['scratch'], tools: [] }]);
    renderAt(`/skills-and-tools/teams/${encodeURIComponent('Sales & Ops')}`);
    expect(await screen.findByRole('heading', { name: 'Sales & Ops', level: 1 })).toBeInTheDocument();
    expect(await screen.findByTestId('library-card-skill-scratch')).toBeInTheDocument();
    await waitFor(() =>
      expect(within(nav()).getByRole('button', { name: /^Sales & Ops/ })).toHaveAttribute('aria-current', 'true'),
    );

    renderAt('/skills-and-tools/teams/Nope');
    expect(await screen.findByText("There's no team called Nope.")).toBeInTheDocument();
  });

  it('a plugin you are in appears on Everything even when it is EMPTY', async () => {
    pluginsMock.listPlugins.mockResolvedValue([
      ...PLUGINS,
      {
        name: 'Fresh',
        folders: ['Plugins/Fresh'],
        canRead: true,
        canWrite: true,
        skillCount: 0,
        toolCount: 0,
        owners: { roles: [], users: [] },
        writers: { roles: [], users: [] },
        readers: { restricted: true, roles: [], users: [] },
        hasRequested: false,
        requestNumber: null,
      },
    ]);
    renderAt('/skills-and-tools');
    expect(await within(main()).findByRole('button', { name: /^Fresh/ })).toBeInTheDocument();
    // And nowhere in the nav: plugins are reached through the page, not listed beside the teams.
    expect(within(nav()).queryByRole('button', { name: /^Fresh/ })).toBeNull();
    expect(within(nav()).queryByRole('button', { name: /^GTM$/ })).toBeNull();
  });

  it('a plugin row on Everything navigates to /skills-and-tools/plugins/<name>', async () => {
    renderAt('/skills-and-tools');
    fireEvent.click(await within(main()).findByRole('button', { name: /^GTM/ }));
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/plugins/GTM'));
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    // A plugin page lights no lens — it is a place, not a slice.
    for (const button of within(nav()).getAllByRole('button')) {
      expect(button).not.toHaveAttribute('aria-current', 'true');
    }
  });

  it('sends the old /plugins index path home, where Everything lives now', async () => {
    renderAt('/skills-and-tools/plugins');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
  });

  it("a plugin deep link renders that plugin's cards and no others", async () => {
    renderAt('/skills-and-tools/plugins/GTM');
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
    expect(screen.getByTestId('library-card-integration-heyreach')).toBeInTheDocument();
    expect(screen.queryByTestId('library-card-skill-roadmap')).not.toBeInTheDocument();
  });

  it('sends the retired propose path back home', async () => {
    renderAt('/skills-and-tools/propose?plugin=GTM');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
  });

  it('reaches Everything from a plugin page breadcrumb, at the root it lives at', async () => {
    renderAt('/skills-and-tools/plugins/GTM');
    fireEvent.click(await screen.findByRole('link', { name: 'Everything' }));
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
  });

  it('leads the sidebar with Everything, from anywhere in the Library', async () => {
    renderAt('/skills-and-tools/plugins/GTM');
    const everything = await within(nav()).findByRole('button', { name: /^Everything/ });
    expect(within(nav()).getAllByRole('button')[0]).toBe(everything);
    expect(everything).toHaveAttribute('aria-current', 'false');
    fireEvent.click(everything);
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(within(nav()).getByRole('button', { name: /^Everything/ })).toHaveAttribute('aria-current', 'true');
  });

  it('a plugin deep link with a URL-hostile name round-trips', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'pricing', description: '', path: 'Plugins/Sales & Ops/pricing' }],
      tools: [],
    });
    renderAt(`/skills-and-tools/plugins/${encodeURIComponent('Sales & Ops')}`);
    expect(await screen.findByRole('heading', { name: 'Sales & Ops', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-pricing')).toBeInTheDocument();
  });

  it('redirects a legacy /groups/:plugin deep link to the plugin page', async () => {
    // The pre-rename URL shape. Links to it exist in the wild; without the
    // alias the `*` fallback would send them home instead of to the plugin.
    renderAt('/skills-and-tools/groups/GTM');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/plugins/GTM'));
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
  });

  it('redirects a legacy /groups link with a URL-hostile name, encoding intact', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'pricing', description: '', path: 'Plugins/Sales & Ops/pricing' }],
      tools: [],
    });
    renderAt(`/skills-and-tools/groups/${encodeURIComponent('Sales & Ops')}`);
    await waitFor(() =>
      expect(pathname()).toBe(`/skills-and-tools/plugins/${encodeURIComponent('Sales & Ops')}`),
    );
  });

  it('sends the legacy /groups index home, like /plugins', async () => {
    renderAt('/skills-and-tools/groups');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
  });

  it('/skills-and-tools/tools/:slug redirects to the canonical workspace URL, hash intact', async () => {
    // The legacy address is the OAuth callback's landing target, so the
    // redirect must carry the `#…` outcome fragment to the canonical page.
    renderAt('/skills-and-tools/tools/heyreach#authorized');
    await waitFor(() =>
      expect(pathname()).toBe(
        `/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/GTM/heyreach.tool#authorized`,
      ),
    );
  });

  it('redirects an mcp-declared tool to its mcp.json URL with `?server=`, hash intact', async () => {
    // One mcp.json declares several servers, so the redirect must carry the
    // slug in the query — the bare file URL is ambiguous and would bounce to
    // the plugin page, swallowing the OAuth outcome fragment with it.
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [
        tool({ slug: 'granola', name: 'granola', path: 'Plugins/Everyone/mcp.json', type: 'mcp' }),
        tool({ slug: 'linear', name: 'linear', path: 'Plugins/Everyone/mcp.json', type: 'mcp' }),
      ],
    });
    renderAt('/skills-and-tools/tools/granola#authorized=granola_KEY');
    await waitFor(() =>
      expect(pathname()).toBe(
        `/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/Everyone/mcp.json?server=granola#authorized=granola_KEY`,
      ),
    );
  });

  it("/skills-and-tools/skills/:name redirects to the skill's canonical workspace URL", async () => {
    renderAt('/skills-and-tools/skills/outreach');
    await waitFor(() =>
      expect(pathname()).toBe(`/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/GTM/outreach/SKILL.md`),
    );
  });

  it('an integration card navigates to the canonical workspace URL, not a dialog', async () => {
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /^heyreach/ }));

    await waitFor(() =>
      expect(pathname()).toBe(`/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/GTM/heyreach.tool`),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an mcp-declared integration card navigates to the `?server=` URL', async () => {
    // The declaring file is shared with sibling servers, so the card cannot
    // navigate to the bare file URL — that address is ambiguous and redirects
    // to the plugin page, which is exactly the round-trip bug this pins.
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [
        tool({ slug: 'granola', name: 'granola', path: 'Plugins/Everyone/mcp.json', type: 'mcp' }),
        tool({ slug: 'linear', name: 'linear', path: 'Plugins/Everyone/mcp.json', type: 'mcp' }),
      ],
    });
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /^granola/ }));
    await waitFor(() =>
      expect(pathname()).toBe(
        `/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/Everyone/mcp.json?server=granola`,
      ),
    );
  });

  it('an unknown subpath redirects home', async () => {
    renderAt('/skills-and-tools/nope');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
  });

  it('renders the gallery, with its catalog-derived plugin rows, even when the plugins endpoint fails', async () => {
    pluginsMock.listPlugins.mockRejectedValue(new Error("Couldn't load plugins."));
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
    // GTM is proven by the catalog (an item lives in its folder), so its row survives the endpoint being down.
    expect(await within(main()).findByRole('button', { name: /^GTM/ })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load plugins.");
  });

  it('keeps the Library up when the teams endpoint fails — the nav lists no teams, and a team page says why', async () => {
    teamsMock.listTeams.mockRejectedValue(new Error("Couldn't load teams."));
    renderAt('/skills-and-tools/teams/GTM%20Team');
    // The failure is the settlement signal: once the page reports it, the
    // request is over, and what the nav shows is the post-failure nav.
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load teams.");
    expect(screen.queryByText(/There's no team called/)).toBeNull();
    expect(await screen.findByRole('heading', { name: 'GTM Team', level: 1 })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeInTheDocument();
    expect(within(nav()).queryByRole('button', { name: /^GTM Team/ })).toBeNull();
  });

  it('says it is loading teams on a team page until the slice arrives — never "can use nothing" first', async () => {
    let resolve: (teams: typeof TEAMS) => void = () => {};
    teamsMock.listTeams.mockReturnValue(new Promise<typeof TEAMS>((r) => (resolve = r)));
    renderAt('/skills-and-tools/teams/GTM%20Team');
    expect(await screen.findByText('Loading teams…')).toBeInTheDocument();
    expect(screen.queryByText(/can't use anything/)).toBeNull();
    expect(screen.queryByText(/There's no team called/)).toBeNull();
    resolve(TEAMS);
    expect(await screen.findByTestId('library-card-skill-outreach')).toBeInTheDocument();
  });

  it('keeps the own-space row on screen while the plugin index is still loading', async () => {
    pluginsMock.listPlugins.mockReturnValue(new Promise<PluginSummary[]>(() => {}));
    renderAt('/skills-and-tools');
    expect(await screen.findByText('Loading plugins…')).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeInTheDocument();
    // And what the catalog proves is there is a row already: the index is not the only witness.
    expect(within(main()).getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });

  it('reports a teams failure that carries no message with the fallback, not as an empty team', async () => {
    teamsMock.listTeams.mockRejectedValue(new Error(''));
    renderAt('/skills-and-tools/teams/GTM%20Team');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load teams.");
    expect(screen.queryByText(/can't use anything/)).toBeNull();
  });

  it("a team row's counts are the team's slice, not the plugin's totals", async () => {
    // GTM holds 1 skill + 1 tool by its summary; the team may use the skill only.
    teamsMock.listTeams.mockResolvedValue([{ name: 'GTM Team', plugins: ['GTM'], skills: ['outreach'], tools: [] }]);
    renderAt('/skills-and-tools/teams/GTM%20Team');
    const row = await within(main()).findByRole('button', { name: /^GTM/ });
    expect(row).toHaveTextContent('1 skills · 0 tools');
    expect(screen.queryByTestId('library-card-integration-heyreach')).toBeNull();
  });
});
