import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { PluginSummary } from '../services/plugins.api';

/**
 * The all-plugins index: which section a plugin lands in, what each row says, and
 * where it goes. The locked section is the reason this page exists, so most of
 * what is asserted here is about plugins the caller cannot enter.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const pluginsMock = vi.hoisted(() => ({ listPlugins: vi.fn(), listJoinRequests: vi.fn() }));
vi.mock('../services/plugins.api', () => ({
  listPlugins: pluginsMock.listPlugins,
  // The page carries the managers' join-request banners now — it is where the
  // Library lands, so it is where an unanswered request is certain to be seen.
  listJoinRequests: pluginsMock.listJoinRequests,
  reconcileJoinRequest: vi.fn(),
}));

import { LibraryProvider } from '../state/library-data';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { PluginsIndexPage } from '../components/PluginsIndexPage';
import { withAuth, TEST_PERSONAL_GROUP } from './auth-harness';

const tool = (over: Partial<ToolSecrets> = {}): ToolSecrets => ({
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
    { name: 'outreach', description: '', path: 'Plugins/GTM/outreach' },
    { name: 'scratch', description: '', path: 'Skills/scratch' },
  ],
  pendingSkills: [],
  tools: [
    tool(),
    // An ungrouped sign-in — `Tools/slack.tool` is two segments, so no plugin.
    tool({
      slug: 'slack',
      name: 'slack',
      path: 'Tools/slack.tool',
      variables: [
        {
          name: 'API_KEY',
          scope: 'user',
          label: null,
          key: 'slack_API_KEY',
          adminConfigured: false,
          userConfigured: false,
        },
      ],
    }),
  ],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const summary = (over: Partial<PluginSummary> = {}): PluginSummary => ({
  name: 'GTM',
  folders: ['Plugins/GTM'],
  canRead: true,
  canWrite: false,
  isOwner: false,
  skillCount: 4,
  toolCount: 2,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: ['Admin'], users: [] },
  readers: { restricted: true, roles: ['GTM Team'], users: [] },
  hasRequested: false,
  requestNumber: null,
  ...over,
});

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname + location.search}</div>;
}

/** `kbDirName` is what the request banners' Manage-access affordance needs. */
const WORKSPACE = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function renderIndex() {
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools']}>
      {withAuth(
      <WorkspaceContext.Provider value={WORKSPACE}>
        <LibraryProvider>
          <Routes>
            <Route path="/skills-and-tools" element={<PluginsIndexPage />} />
            <Route path="*" element={<div />} />
          </Routes>
          <LocationProbe />
        </LibraryProvider>
      </WorkspaceContext.Provider>,
      )}
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;
const row = (name: RegExp | string) => screen.getByRole('button', { name });

describe('PluginsIndexPage', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    pluginsMock.listPlugins.mockResolvedValue([summary()]);
    pluginsMock.listJoinRequests.mockResolvedValue([]);
  });

  it('names itself and its two sections', async () => {
    renderIndex();
    expect(await screen.findByRole('heading', { name: 'All plugins', level: 1 })).toBeInTheDocument();
    expect(
      screen.getByText('A plugin carries skills and tools for the people in it.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Yours' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: "Your plugins" })).toBeInTheDocument();
  });

  it("offers the caller's own plugin under Yours, and opens it", async () => {
    renderIndex();
    expect(
      await screen.findByText('Your sign-ins and the skills no plugin carries'),
    ).toBeInTheDocument();
    // The lens is gone from this page — it lives in the sidebar.
    expect(screen.queryByText('The skills you answer for')).not.toBeInTheDocument();
    fireEvent.click(row(new RegExp(`^${TEST_PERSONAL_GROUP}`)));
    await waitFor(() => expect(href()).toBe('/skills-and-tools/yours'));
  });

  it("keeps the caller's own plugin listed even when nothing sits outside a plugin", async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'outreach', description: '', path: 'Plugins/GTM/outreach' }],
      tools: [tool()],
    });
    renderIndex();
    await screen.findByRole('heading', { name: 'All plugins', level: 1 });
    expect(screen.getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeInTheDocument();
    // And never the lens: "Owned by me" is a view across plugins, not a plugin.
    expect(screen.queryByRole('button', { name: /^Owned by me/ })).not.toBeInTheDocument();
  });

  it("puts a readable plugin under Your plugins, with its run-by line and totals", async () => {
    renderIndex();
    const gtm = await screen.findByRole('button', { name: /^GTM/ });
    expect(gtm).toHaveAccessibleName('GTM Run by Olga Ivanova 4 skills · 2 tools');
    fireEvent.click(gtm);
    await waitFor(() => expect(href()).toBe('/skills-and-tools/plugins/GTM'));
  });

  it('marks a plugin the caller can change with an Owner badge', async () => {
    pluginsMock.listPlugins.mockResolvedValue([summary({ canWrite: true })]);
    renderIndex();
    expect(await screen.findByRole('button', { name: /^GTM Owner/ })).toBeInTheDocument();
  });

  it('shows the amber count when a plugin has integrations to set up', async () => {
    pluginsMock.listPlugins.mockResolvedValue([
      summary({
        name: 'Yours',
        folders: ['Plugins/Yours'],
      }),
      summary(),
    ]);
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [
        tool({
          variables: [
            {
              name: 'API_KEY',
              scope: 'user',
              label: null,
              key: 'heyreach_API_KEY',
              adminConfigured: false,
              userConfigured: false,
            },
          ],
        }),
      ],
    });
    renderIndex();
    expect(await screen.findByRole('button', { name: /^GTM .* 1$/ })).toBeInTheDocument();
  });

  it('lists a DISCOVERABLE locked plugin under Request access, Locked or Requested', async () => {
    pluginsMock.listPlugins.mockResolvedValue([
      summary(),
      summary({ name: 'Finance', folders: ['Plugins/Finance'], canRead: false, canWrite: false }),
    ]);
    renderIndex();
    expect(await screen.findByRole('heading', { name: 'Request access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Finance/ })).toBeInTheDocument();
    expect(screen.getByTitle('Locked')).toBeInTheDocument();

    // Once the caller's join request is open, the chip says THAT instead —
    // the one thing the row can tell you that you did not already know.
    pluginsMock.listPlugins.mockResolvedValue([
      summary({
        name: 'Finance',
        folders: ['Plugins/Finance'],
        canRead: false,
        canWrite: false,
        hasRequested: true,
        requestNumber: 9,
      }),
    ]);
    renderIndex();
    expect(await screen.findByTitle('Requested')).toBeInTheDocument();
  });

  it('never lists a plugin the endpoint omitted (fail-closed: absent = invisible)', async () => {
    // The backend only returns accessible plugins, and this page adds nothing
    // on top: a plugin the caller cannot access has no row, no name, no counts.
    pluginsMock.listPlugins.mockResolvedValue([summary()]);
    renderIndex();
    await screen.findByRole('button', { name: /^GTM/ });
    expect(screen.queryByRole('button', { name: /^Finance/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Request access' })).not.toBeInTheDocument();
  });

  it('lists a plugin an item grant reaches inside, even without a summary', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'budget', description: '', path: 'Plugins/Finance/budget' }],
    });
    renderIndex();
    expect(await screen.findByRole('button', { name: /^Finance/ })).toBeInTheDocument();
  });

  it('lists a catalog-derived plugin with counts alone when no summary vouches for it', async () => {
    pluginsMock.listPlugins.mockResolvedValue([]);
    renderIndex();
    // One skill and one tool in Plugins/GTM, and nothing claiming to know who
    // runs it — so the row states what it can count, not what it cannot.
    expect(await screen.findByRole('button', { name: 'GTM 1 skills · 1 tools' })).toBeInTheDocument();
  });

  it('offers a retry when the plugins endpoint fails, and keeps Yours', async () => {
    pluginsMock.listPlugins.mockRejectedValue(new Error("Couldn't load plugins."));
    renderIndex();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent("Couldn't load plugins.");
    expect(screen.getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: "Your plugins" })).not.toBeInTheDocument();

    pluginsMock.listPlugins.mockResolvedValue([summary()]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });

  it('says it is loading before the first plugin index arrives', () => {
    pluginsMock.listPlugins.mockReturnValue(new Promise(() => {}));
    renderIndex();
    expect(screen.getByText('Loading plugins…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toBeInTheDocument();
  });
});
