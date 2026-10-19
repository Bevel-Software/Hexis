import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { useState, type ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { PluginSummary } from '../services/plugins.api';
import type { ToolPageState } from '../hooks/useToolPage';
import { PAGE_HEADER_TESTID } from '../../../shared/theme/header';
import { expectTitleKeepsItsInk } from '../../../__tests__/title-ink-room';
import { LockedPluginView } from '../components/LockedPluginView';

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
  // The plugin page repairs its links on open for a manager; these fixtures
  // are members, so it never fires — but the module still has to export it.
  repairPluginLinks: vi.fn().mockResolvedValue({ repaired: [], skipped: [] }),
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

/** A tool as the catalog carries it — the shape the stubbed data hook answers with, nothing another module exports. */
type CatalogTool = LibraryData['tools'][number];

const tool = (over: Partial<CatalogTool>): CatalogTool => ({
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
  pendingTools: [],
  tools: [tool({}), tool({ slug: 'slack', name: 'slack', path: 'Tools/slack.tool' })],
  ownedSkills: new Set(['outreach']),
  writableSkills: new Set(['outreach']),
  ownedTools: new Set(),
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
    isOwner: true,
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
  // The server opens with the org-wide entry: Product admits everyone here.
  { name: 'Everyone', plugins: ['Product'], skills: ['roadmap'], tools: ['slack'] },
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

  /**
   * Every Library page title keeps the tails of its g, y and p: the title
   * truncates, and it and every wrapper that clips it carry the ink room
   * (`expectTitleKeepsItsInk`). The plugin pages are the ones that group the
   * title with its breadcrumb in an `overflow-hidden` wrapper, where a room
   * on the title alone was not enough.
   */
  it.each([
    ['Everything', '/skills-and-tools', 'Everything'],
    ['a group', '/skills-and-tools/teams/GTM%20Team', 'GTM Team'],
    ['a plugin', '/skills-and-tools/plugins/GTM', 'GTM'],
    ['your own space', '/skills-and-tools/yours', TEST_PERSONAL_GROUP],
  ])('the title of %s keeps its ink', async (_what, path, heading) => {
    renderAt(path);
    await screen.findByRole('heading', { name: heading, level: 1 });
    expectTitleKeepsItsInk(screen.getByTestId(PAGE_HEADER_TESTID));
  });

  it("the title of a plugin you cannot read keeps its ink", () => {
    render(
      <MemoryRouter>
        {wrap(
          <LockedPluginView
            plugin={{ ...PLUGINS[0]!, canRead: false, canWrite: false, isOwner: false }}
            onRequested={() => {}}
            onUnlocked={() => {}}
            onManage={() => {}}
          />,
        )}
      </MemoryRouter>,
    );
    screen.getByRole('heading', { name: 'GTM', level: 1 });
    expectTitleKeepsItsInk(screen.getByTestId(PAGE_HEADER_TESTID));
  });

  it('sends the old /everything address to the root, where the same page lives', async () => {
    renderAt('/skills-and-tools/everything');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
  });

  it('/skills-and-tools/owned selects Owned by me', async () => {
    pluginsMock.listPlugins.mockResolvedValue([
      ...PLUGINS,
      // Managed (an Admin writes it) but not owner-listed: not theirs.
      { ...PLUGINS[0]!, name: 'Ops', folders: ['Plugins/Ops'], canWrite: true, isOwner: false },
    ]);
    renderAt('/skills-and-tools/owned');
    expect(await screen.findByRole('heading', { name: 'Owned by me' })).toBeInTheDocument();
    expect(within(nav()).getByRole('button', { name: /^Owned by me/ })).toHaveAttribute('aria-current', 'true');
    // GTM names the caller in its owner list (`isOwner`): it is theirs. Ops is
    // only managed by them, and Product is neither.
    expect(await within(main()).findByRole('button', { name: /^GTM/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: /^Ops/ })).toBeNull();
    expect(within(main()).queryByRole('button', { name: /^Product/ })).toBeNull();
  });

  it("/skills-and-tools/yours is the caller's own plugin, as a plugin page", async () => {
    renderAt('/skills-and-tools/yours');
    expect(await screen.findByRole('heading', { name: TEST_PERSONAL_GROUP, level: 1 })).toBeInTheDocument();
    // Your own space is not a group: no nav row for it, and nothing else lights up.
    expect(within(nav()).queryByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeNull();
    expect(within(nav()).queryByRole('button', { current: true })).toBeNull();
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

  it('Everyone leads the groups, right after the lenses, and opens what is org-wide', async () => {
    renderAt('/skills-and-tools');
    // "Everyone Else" is a team in the fixture: the org-wide row is the one
    // whose whole label is the name plus its count.
    await within(nav()).findByRole('button', { name: /^Everyone \d+$/ });
    const rows = within(nav()).getAllByRole('button');
    const names = rows.map((r) => r.textContent ?? '');
    const owned = names.findIndex((n) => n.startsWith('Owned by me'));
    const everyone = names.findIndex((n) => /^Everyone\d+$/.test(n));
    const gtm = names.findIndex((n) => n.startsWith('GTM Team'));
    expect(owned).toBeGreaterThan(-1);
    expect(everyone).toBe(owned + 1);
    expect(gtm).toBeGreaterThan(everyone);
    // Your own space is a plugin, not a group: no row for it here.
    expect(names.some((n) => n.startsWith(TEST_PERSONAL_GROUP))).toBe(false);

    fireEvent.click(rows[everyone]!);
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/teams/Everyone'));
    expect(await screen.findByRole('heading', { name: 'Everyone', level: 1 })).toBeInTheDocument();
    expect(screen.getByText(/^Org-wide: what every signed-in person/)).toBeInTheDocument();
    // The server's slice: Product's row, roadmap and slack — nothing of GTM's.
    expect(await within(main()).findByRole('button', { name: /^Product/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('button', { name: /^GTM/ })).toBeNull();
    expect(screen.getByTestId('library-card-skill-roadmap')).toBeInTheDocument();
    expect(screen.getByTestId('library-card-integration-slack')).toBeInTheDocument();
    expect(screen.queryByTestId('library-card-skill-outreach')).toBeNull();
  });

  it('holds the org-wide line until the team list has settled and names Everyone', async () => {
    let resolve: (teams: typeof TEAMS) => void = () => {};
    teamsMock.listTeams.mockReturnValue(new Promise<typeof TEAMS>((r) => (resolve = r)));
    renderAt('/skills-and-tools/teams/Everyone');
    expect(await screen.findByText('Loading teams…')).toBeInTheDocument();
    expect(screen.queryByText(/^Org-wide:/)).toBeNull();
    resolve(TEAMS);
    expect(await screen.findByText(/^Org-wide:/)).toBeInTheDocument();
  });

  it('keeps the org-wide line off a failed team list — the error is the whole story', async () => {
    teamsMock.listTeams.mockRejectedValue(new Error("Couldn't load teams."));
    renderAt('/skills-and-tools/teams/Everyone');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load teams.");
    expect(screen.queryByText(/^Org-wide:/)).toBeNull();
  });

  it('says so when nothing is shared with everyone yet', async () => {
    teamsMock.listTeams.mockResolvedValue([{ name: 'Everyone', plugins: [], skills: [], tools: [] }]);
    renderAt('/skills-and-tools/teams/Everyone');
    expect(await screen.findByText('Nothing is shared with everyone yet.')).toBeInTheDocument();
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

  it('marks a plugin Private on its row when its access.md says so — and your own space always', async () => {
    pluginsMock.listPlugins.mockResolvedValue([
      ...PLUGINS,
      { ...PLUGINS[0]!, name: 'Mine', folders: ['Plugins/Mine'], canWrite: false, isOwner: false, isPrivate: true },
    ]);
    renderAt('/skills-and-tools');
    const mine = await within(main()).findByRole('button', { name: /^Mine/ });
    expect(within(mine).getByText('Private')).toBeInTheDocument();
    // GTM's access.md makes no such statement: Owner, and nothing else.
    const gtm = within(main()).getByRole('button', { name: /^GTM/ });
    expect(within(gtm).getByText('Owner')).toBeInTheDocument();
    expect(within(gtm).queryByText('Private')).toBeNull();
    // The personal space is private by construction.
    const own = within(main()).getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) });
    expect(within(own).getByText('Private')).toBeInTheDocument();
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

  it('carries the breadcrumb ON the title band, not in a row above it', async () => {
    // The band's TOP EDGE is the seam it holds with the sidebar's header row
    // (`shared/theme/header`). A breadcrumb in its own row above the band
    // pushes the title bar down by that row's height, and the two headers
    // stop lining up however exactly their heights agree — which is the
    // whole bug. So the trail rides on the band, and this is what says so.
    renderAt('/skills-and-tools/plugins/GTM');
    const band = await screen.findByTestId(PAGE_HEADER_TESTID);
    expect(band).toContainElement(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(band).toContainElement(screen.getByRole('heading', { name: 'GTM', level: 1 }));
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
    expect(within(nav()).getByRole('button', { name: /^Owned by me/ })).toBeInTheDocument();
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

/**
 * "Connect your tools" is a Skills & Tools page: inside the layout, so the
 * sidebar (and, in the shell, the toggle and the selected tab) are on screen
 * with it. The shell's `/connect` redirects here; see `ShellRoutes.test`.
 */
/**
 * The secrets endpoints "Connect your tools" talks to, answered at the HTTP
 * seam — the page's own services and the shared `authFetch` stay real, so
 * what is pinned is the page as it talks to the server. Anything else that
 * reaches `fetch` here is a mistake, and says so.
 */
/** What `/api/connect/pending` answers, as JSON on the wire: three lists, shaped by the fixtures below. */
type ConnectListing = { tools: object[]; oauth: object[]; toolOAuth: object[] };

interface SecretsServer {
  /** What `/api/connect/pending` answers. */
  listing: ConnectListing;
  /** Who is asking in agent-connect mode; null answers the lookup with 404. */
  oauthRequest: { clientName: string; scope: null; resource: null } | null;
  /** Every request, in order: method, path and the parsed JSON body. */
  calls: { method: string; path: string; body: unknown }[];
}

function serveSecrets(listing: ConnectListing): SecretsServer {
  const server: SecretsServer = { listing, oauthRequest: null, calls: [] };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://test');
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.pathname;
      server.calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'GET' && path === '/api/connect/pending') return json(server.listing);
      if (method === 'GET' && path === '/api/mcp/oauth/request') {
        return server.oauthRequest ? json(server.oauthRequest) : json({ error: 'Unknown request' }, 404);
      }
      if (method === 'POST' && /^\/api\/secrets\/tools\/[^/]+\/check$/.test(path)) {
        return json({ verdict: { status: 'ok', detail: null, checkedAt: new Date().toISOString() } });
      }
      if ((method === 'PUT' || method === 'DELETE') && /^\/api\/secrets\/tools\/[^/]+\/vars\/[^/]+\/user$/.test(path)) {
        return json({ ok: true });
      }
      // Skip / include: the server keeps the choice and reports it on every
      // row of the tool from then on.
      const skipped = /^\/api\/connect\/skipped\/([^/]+)$/.exec(path);
      if (skipped && (method === 'PUT' || method === 'DELETE')) {
        const slug = decodeURIComponent(skipped[1]);
        const mark = <T extends object>(row: T) =>
          (row as { slug?: string }).slug === slug ? { ...row, skipped: method === 'PUT' } : row;
        server.listing = {
          ...server.listing,
          tools: server.listing.tools.map(mark),
          toolOAuth: server.listing.toolOAuth.map(mark),
        };
        return new Response(null, { status: 204 });
      }
      throw new Error(`the test server has no answer for ${method} ${path}`);
    }),
  );
  return server;
}

describe('LibraryRoutes — Connect your tools', () => {
  /** heyreach, holding one per-person key that is or is not saved. */
  const keyedTool = (saved: boolean) =>
    tool({
      variables: [
        { name: 'API_KEY', scope: 'user', label: null, key: 'heyreach_API_KEY', adminConfigured: false, userConfigured: saved },
      ],
    });

  let server: SecretsServer;

  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    pluginsMock.listPlugins.mockResolvedValue(PLUGINS);
    teamsMock.listTeams.mockResolvedValue(TEAMS);
    pluginsMock.listJoinRequests.mockResolvedValue([]);
    window.history.replaceState(null, '', '/skills-and-tools/connect');
    sessionStorage.clear();
    server = serveSecrets({
      tools: [
        {
          slug: 'heyreach',
          name: 'heyreach',
          path: 'Plugins/GTM/heyreach.tool',
          type: 'inline',
          canWrite: false,
          variables: [
            { name: 'API_KEY', label: null, key: 'heyreach_API_KEY', scope: 'user', configured: false, ownerOnly: false },
          ],
        },
      ],
      oauth: [],
      toolOAuth: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the page inside the Skills & Tools layout, with no sidebar row selected', async () => {
    renderAt('/skills-and-tools/connect');
    expect(await screen.findByRole('heading', { name: 'Connect your tools' })).toBeInTheDocument();
    expect(within(main()).getByRole('heading', { name: 'Connect your tools' })).toBeInTheDocument();
    expect(nav()).toBeInTheDocument();
    // The page has no row of its own, so nothing is lit — not even Everything.
    await within(nav()).findByRole('button', { name: /^GTM Team/ });
    for (const row of within(nav()).getAllByRole('button')) {
      expect(row).not.toHaveAttribute('aria-current', 'true');
    }
    expect(pathname()).toBe('/skills-and-tools/connect');
    // The way back is the sidebar now, not a link of its own.
    expect(screen.queryByRole('link', { name: /Skills & tools/i })).toBeNull();
  });

  it('keeps agent-connect mode, with the same sidebar beside it', async () => {
    server.oauthRequest = { clientName: 'Claude', scope: null, resource: null };
    // The page reads the browser's own address, as the BrowserRouter keeps it.
    window.history.replaceState(null, '', '/skills-and-tools/connect?oauth=signed-state');
    renderAt('/skills-and-tools/connect?oauth=signed-state');
    expect(
      await screen.findByRole('button', { name: 'Finish & return to your agent' }),
    ).toBeInTheDocument();
    expect(nav()).toBeInTheDocument();
    const asked = (vi.mocked(fetch).mock.calls as [RequestInfo | URL, RequestInit?][]).map(([input]) => String(input));
    expect(asked).toContain('/api/mcp/oauth/request?state=signed-state');
  });

  it("the sidebar's setup reminder opens the page at its own address", async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, tools: [keyedTool(false)] });
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /1 integration needs setup/ }));
    expect(pathname()).toBe('/skills-and-tools/connect');
    expect(await screen.findByRole('heading', { name: 'Connect your tools' })).toBeInTheDocument();
  });

  // The sidebar now sits beside the page, so a count that lagged a save
  // would read as a bug. The page's announcement reaches the provider the
  // sidebar reads from; the mock stands in for the real hook's refetch.
  it('a key saved on the page updates the setup reminder without a reload', async () => {
    dataMock.useLibraryData.mockImplementation(() => {
      const [saved, setSaved] = useState(false);
      return { ...CATALOG, tools: [keyedTool(saved)], reload: () => setSaved(true) };
    });
    renderAt('/skills-and-tools/connect');
    expect(await screen.findByRole('button', { name: /1 integration needs setup/ })).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText('API_KEY value'), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /integrations? needs? setup/ })).toBeNull());
    expect(server.calls).toContainEqual({
      method: 'PUT',
      path: '/api/secrets/tools/heyreach/vars/API_KEY/user',
      body: { value: 'k', label: null },
    });
  });

  // The other direction: unticking a signed-in tool deletes the sign-in, and
  // the reminder has to come back for it — counted, not left at "all set".
  it('a sign-in removed on the page updates the setup reminder without a reload', async () => {
    const signedInTool = (authorized: boolean) =>
      tool({
        variables: [
          {
            name: 'TOKEN',
            scope: 'user',
            label: null,
            key: 'heyreach_TOKEN',
            adminConfigured: true,
            userConfigured: authorized,
            oauth: true,
            authorized,
          },
        ],
      });
    dataMock.useLibraryData.mockImplementation(() => {
      const [signedIn, setSignedIn] = useState(true);
      return { ...CATALOG, tools: [signedInTool(signedIn)], reload: () => setSignedIn(false) };
    });
    server.listing = {
      tools: [],
      oauth: [],
      toolOAuth: [
        {
          slug: 'heyreach',
          varName: 'TOKEN',
          toolName: 'heyreach',
          key: 'heyreach_TOKEN',
          label: null,
          authorized: true,
          needsReauth: false,
          ownerConfigured: true,
          ownerOnly: false,
        },
      ],
    };
    renderAt('/skills-and-tools/connect');

    const skip = await screen.findByRole('checkbox', {
      name: 'Skip this tool (removes your saved keys and sign-ins for it)',
    });
    expect(screen.queryByRole('button', { name: /integrations? needs? setup/ })).toBeNull();

    fireEvent.click(skip);

    await waitFor(() =>
      expect(server.calls).toContainEqual({
        method: 'DELETE',
        path: '/api/secrets/tools/heyreach/vars/TOKEN/user',
        body: null,
      }),
    );
    expect(await screen.findByRole('button', { name: /1 integration needs setup/ })).toBeInTheDocument();
  });
});
