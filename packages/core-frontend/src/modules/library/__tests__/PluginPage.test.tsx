import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { PluginSummary } from '../services/plugins.api';
import { withAuth } from './auth-harness';

/**
 * The plugin page: which view a caller gets, what the page says about who runs
 * the plugin, and where its one action goes. The catalog and the plugin index are
 * mocked at their two seams — what is under test is the page's judgement, not
 * the fetching underneath it.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const pluginsMock = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  listJoinRequests: vi.fn(),
  reconcileJoinRequest: vi.fn(),
  requestPluginAccess: vi.fn(),
}));
const libApiMock = vi.hoisted(() => ({ removeLibraryItem: vi.fn() }));
vi.mock('../services/library.api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  removeLibraryItem: libApiMock.removeLibraryItem,
}));

vi.mock('../services/plugins.api', () => ({
  listPlugins: pluginsMock.listPlugins,
  listJoinRequests: pluginsMock.listJoinRequests,
  reconcileJoinRequest: pluginsMock.reconcileJoinRequest,
  requestPluginAccess: pluginsMock.requestPluginAccess,
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

// The ONE access surface — the separate summary section this page was designed
// with never shipped, so there is no `PluginAccessSection.test.tsx` to defer to.
// Mocked at the component: the dialog fetches on mount, and stubbing that seam
// keeps these tests on the page's judgement rather than the network. Its own
// behaviour lives in the access module's tests; what this file owes is that the
// page opens it on the right DIRECTORY.
vi.mock('../../access/components/ManageAccessDialog', () => ({
  ManageAccessDialog: ({
    entry,
    onClose,
  }: {
    entry: { relativePath: string; type: string };
    onClose(): void;
  }) => (
    <div role="dialog" aria-label={`Manage access ${entry.type} ${entry.relativePath}`}>
      <button type="button" onClick={onClose}>
        Close access
      </button>
    </div>
  ),
}));

import { LibraryProvider } from '../state/library-data';
import { LibraryToastProvider } from '../state/toast';
import { PluginPage } from '../components/PluginPage';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

const nonAdmin: AdminContextValue = {
  isAdmin: false,
  unreadCount: 0,
  lastSeen: null,
  markSeen: vi.fn(),
  refresh: vi.fn(),
  rolesConfigCorrupted: false,
  rolesConfigErrors: [],
  runRolesRecovery: vi.fn(),
};

/** The same caller with the admin bit set — the empty band's doorway is theirs. */
const asAdmin: AdminContextValue = { ...nonAdmin, isAdmin: true };

const connectedTool = (over: Partial<ToolSecrets> = {}): ToolSecrets => ({
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Plugins/GTM/heyreach.tool',
  type: 'inline',
  setup: null,
  canWrite: false,
  variables: [],
  ...over,
});

/** A tool whose user key is missing — one unit of amber. */
const unsetTool = (over: Partial<ToolSecrets> = {}): ToolSecrets =>
  connectedTool({
    slug: 'apollo',
    name: 'apollo',
    path: 'Plugins/GTM/apollo.tool',
    variables: [
      {
        name: 'API_KEY',
        scope: 'user',
        label: null,
        key: 'apollo_API_KEY',
        adminConfigured: false,
        userConfigured: false,
      },
    ],
    ...over,
  });

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [
    { name: 'outreach', description: 'Runs the GTM outreach.', path: 'Plugins/GTM/outreach' },
    { name: 'roadmap', description: 'Keeps the roadmap.', path: 'Plugins/Product/roadmap' },
  ],
  pendingSkills: [],
  tools: [connectedTool()],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const gtm = (over: Partial<PluginSummary> = {}): PluginSummary => ({
  name: 'GTM',
  folders: ['Plugins/GTM'],
  canRead: true,
  canWrite: false,
  isOwner: false,
  skillCount: 1,
  toolCount: 1,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: ['Admin'], users: [] },
  readers: {
    restricted: true,
    roles: ['GTM Team'],
    users: [{ name: 'Ali Baba', email: 'ali@bevel.software' }],
  },
  hasRequested: false,
  requestNumber: null,
  ...over,
});

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname + location.search}</div>;
}

function renderPlugin(name: string, children?: ReactNode, admin: AdminContextValue = nonAdmin) {
  return render(
    <MemoryRouter initialEntries={[`/skills-and-tools/plugins/${encodeURIComponent(name)}`]}>
      <AdminContext.Provider value={admin}>
        <WorkspaceContext.Provider value={workspace}>
          <LibraryToastProvider>
            <LibraryProvider>
              {withAuth(
                <>
                  <Routes>
                    <Route path="/skills-and-tools/plugins/:plugin" element={<PluginPage />} />
                    <Route path="*" element={<div />} />
                  </Routes>
                  <LocationProbe />
                  {children}
                </>,
              )}
            </LibraryProvider>
          </LibraryToastProvider>
        </WorkspaceContext.Provider>
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;

describe('PluginPage', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    pluginsMock.listPlugins.mockResolvedValue([gtm()]);
    pluginsMock.listJoinRequests.mockResolvedValue([]);
    pluginsMock.reconcileJoinRequest.mockResolvedValue(false);
    pluginsMock.requestPluginAccess.mockResolvedValue(undefined);
  });

  it('lets a plugin MANAGER remove a skill, behind a confirm that says who loses it', async () => {
    pluginsMock.listPlugins.mockResolvedValue([gtm({ canWrite: true })]);
    libApiMock.removeLibraryItem.mockResolvedValue(undefined);
    renderPlugin('GTM');

    fireEvent.click(await screen.findByRole('button', { name: 'Remove outreach' }));
    expect(await screen.findByText(/Everyone here loses it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    // The skill FOLDER, repo-relative — the recursive delete under it runs
    // per-file through the same ACL gate that governs editing the plugin.
    await waitFor(() =>
      expect(libApiMock.removeLibraryItem).toHaveBeenCalledWith('Plugins/GTM/outreach'),
    );
    expect(await screen.findByText(/Removed outreach from GTM/)).toBeInTheDocument();
  });

  it('offers no remove affordance to a non-manager', async () => {
    renderPlugin('GTM'); // gtm() defaults to canWrite: false
    await screen.findByText('outreach');
    expect(screen.queryByRole('button', { name: 'Remove outreach' })).toBeNull();
  });

  it("shows only the plugin's own skills and tools", async () => {
    renderPlugin('GTM');
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
    expect(screen.getByTestId('library-card-integration-heyreach')).toBeInTheDocument();
    // Product's skill belongs to another plugin and never appears here.
    expect(screen.queryByTestId('library-card-skill-roadmap')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument();
  });

  it('opens an mcp-declared tool card at its `?server=` URL, not the bare file URL', async () => {
    // Several servers share one declaring mcp.json, so the bare file URL is
    // ambiguous — navigating there bounced the click straight back to this
    // plugin page. The query param names which server's page to open.
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [
        connectedTool(),
        connectedTool({ slug: 'granola', name: 'granola', path: 'Plugins/GTM/mcp.json', type: 'mcp' }),
      ],
    });
    renderPlugin('GTM');
    fireEvent.click(await screen.findByRole('button', { name: /^granola/ }));
    await waitFor(() =>
      expect(href()).toBe(
        `/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/GTM/mcp.json?server=granola`,
      ),
    );
  });

  it('opens a `.tool`-declared card at its bare canonical file URL — unchanged', async () => {
    renderPlugin('GTM');
    fireEvent.click(await screen.findByRole('button', { name: /^heyreach/ }));
    await waitFor(() =>
      expect(href()).toBe(`/workspace/${DEFAULT_BRANCH}/knowledge-base/Plugins/GTM/heyreach.tool`),
    );
  });

  it('leads with the plugin, not with who runs it', async () => {
    renderPlugin('GTM');
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    // The run-by/shared-with lede is gone: it restated, above every plugin, what
    // the Share panel says once and on demand.
    expect(screen.queryByText(/^Run by /)).not.toBeInTheDocument();
    expect(screen.queryByText(/shared with/)).not.toBeInTheDocument();
  });

  // ONE door, for every role. The page used to fork on `canWrite` into "Add
  // skills or tools" (a dialog) and "Propose a skill or tool" (a whole other
  // page) — the same button, in the same spot, opening a different flow with
  // different words depending on who pressed it. Who reviews what is a property
  // of the plugin, not of the door.
  it('opens the same add dialog for a writer', async () => {
    pluginsMock.listPlugins.mockResolvedValue([gtm({ canWrite: true })]);
    renderPlugin('GTM');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a skill or tool to GTM' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No review step/)).toBeInTheDocument();
    expect(screen.queryByText('Start an empty SKILL.md')).not.toBeInTheDocument();
  });

  it('opens the same add dialog for everyone else, and says review is coming', async () => {
    renderPlugin('GTM');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a skill or tool to GTM' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/change request for an owner to review/)).toBeInTheDocument();
    expect(screen.queryByText('Start an empty SKILL.md')).not.toBeInTheDocument();
  });

  it('offers no separate propose door to anybody', async () => {
    renderPlugin('GTM');
    await screen.findByRole('button', { name: 'Add a skill or tool to GTM' });
    expect(screen.queryByRole('button', { name: /Propose/i })).not.toBeInTheDocument();
  });

  it('warns about integrations that need setup and sends them to Connect', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [connectedTool(), unsetTool()],
    });
    renderPlugin('GTM');
    expect(
      await screen.findByText(
        "1 integration needs setup: connect it to unblock this plugin's skills.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(href()).toBe('/connect'));
  });

  it('pluralises the attention banner', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [unsetTool(), unsetTool({ slug: 'clay', name: 'clay', path: 'Plugins/GTM/clay.tool' })],
    });
    renderPlugin('GTM');
    expect(
      await screen.findByText(
        "2 integrations need setup: connect them to unblock this plugin's skills.",
      ),
    ).toBeInTheDocument();
  });

  it('renders both empty states for a plugin with nothing in it', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([gtm({ skillCount: 0, toolCount: 0 })]);
    renderPlugin('GTM');
    // A non-admin reads one plain sentence: the fact, and the agent as the
    // door that IS theirs. No inline action, so nothing is split around it.
    expect(
      await screen.findByText('No skills yet. Ask your agent to write one for GTM.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No tools yet.')).toBeInTheDocument();
  });

  it('keeps the empty band a dead end for a non-admin — no doorway, no arrow', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([gtm({ skillCount: 0, toolCount: 0 })]);
    renderPlugin('GTM');
    await screen.findByText(/No skills yet/);
    expect(screen.queryByRole('button', { name: 'Add the first skill' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('chalk-arrow')).not.toBeInTheDocument();
  });

  it('keeps the doorway but not the dialog-less click when the plugins endpoint failed', async () => {
    // The add dialog mounts only with a summary and its primary folder. When
    // the endpoint failed there is neither, so an admin's "Add the first
    // skill" would be a button that does nothing — the band must fall back to
    // the sentence whose one door (the agent) still works.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockRejectedValue(new Error('boom'));
    renderPlugin('GTM', undefined, asAdmin);
    expect(
      await screen.findByText('No skills yet. Ask your agent to write one for GTM.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add the first skill' })).not.toBeInTheDocument();
    // The title row's `+` is under the same prerequisite: both ways to add
    // must agree that adding is impossible here.
    expect(
      screen.queryByRole('button', { name: 'Add a skill or tool to GTM' }),
    ).not.toBeInTheDocument();
  });

  it('makes the empty Skills band a doorway for an admin: its link opens the same add dialog as `+`', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([gtm({ skillCount: 0, toolCount: 0 })]);
    renderPlugin('GTM', undefined, asAdmin);
    // The sentence is split around its inline action, so it is asserted in its
    // parts: the fact, the doorway, and the agent as the other door.
    expect(await screen.findByText(/No skills yet/)).toBeInTheDocument();
    expect(screen.getByText(/or ask your agent to write one for GTM/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add the first skill' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
  });

  it('drops the nudge once a skill exists — the arrow belongs to the empty band only', async () => {
    renderPlugin('GTM', undefined, asAdmin); // CATALOG carries outreach in GTM
    await screen.findByRole('button', { name: /^outreach/ });
    expect(screen.queryByRole('button', { name: 'Add the first skill' })).not.toBeInTheDocument();
  });

  it('keeps Share on an EMPTY plugin. The folder is what carries access, not the items', async () => {
    // Plugins used to be derived from their items, which meant a plugin with
    // nothing in it had no folder to manage and silently lost its access
    // surface. `folders` now comes from the backend's readdir, so an empty
    // plugin is still a place whose sharing can be changed.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([gtm({ skillCount: 0, toolCount: 0 })]);
    renderPlugin('GTM');

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access directory knowledge-base/Plugins/GTM',
      }),
    ).toBeInTheDocument();
  });

  it('Share IS the manage-access dialog, opened on this plugin\'s directory', async () => {
    renderPlugin('GTM');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    // One dialog for every access path — no intermediate read-only panel.
    // The entry is the plugin DIRECTORY under the KB dir, so the rules land on
    // the folder, never on one file inside it.
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access directory knowledge-base/Plugins/GTM',
      }),
    ).toBeInTheDocument();
  });

  it('an UNDISCOVERABLE plugin renders exactly like one that does not exist', async () => {
    // Fail-closed: the endpoint omits plugins with no verdict at all, so the
    // page cannot tell "hidden from you" apart from "absent" — the point.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([]);
    renderPlugin('Finance');
    expect(await screen.findByText("This plugin doesn't exist yet.")).toBeInTheDocument();
  });

  it('a DISCOVERABLE plugin the caller cannot read shows the locked view', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([
      gtm({ name: 'Finance', folders: ['Plugins/Finance'], canRead: false }),
    ]);
    renderPlugin('Finance');
    expect(
      await screen.findByRole('button', { name: 'Subscribe to its skills and tools' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Skills' })).not.toBeInTheDocument();
    // A locked plugin offers no way in at all — not an add door, not a propose one.
    expect(screen.queryByRole('button', { name: /Add a skill or tool/ })).not.toBeInTheDocument();
  });

  it('a locked-out admin (canWrite via admin-rescue) gets the locked view with Manage access', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    pluginsMock.listPlugins.mockResolvedValue([
      gtm({ name: 'Finance', folders: ['Plugins/Finance'], canRead: false, canWrite: true }),
    ]);
    renderPlugin('Finance');
    expect(await screen.findByRole('button', { name: 'Manage access' })).toBeInTheDocument();
  });

  it('keeps the member view when an item-level grant beats the folder verdict', async () => {
    // Closeness-first resolution hands this caller one skill inside a folder
    // they cannot read; the plugin itself is absent from the (fail-closed)
    // summaries. The platform already returned the item; the page shows it.
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'budget', description: '', path: 'Plugins/Finance/budget' }],
      tools: [],
    });
    pluginsMock.listPlugins.mockResolvedValue([]);
    renderPlugin('Finance');
    expect(await screen.findByTestId('library-card-skill-budget')).toBeInTheDocument();
  });

  it('says so when the plugin does not exist', async () => {
    renderPlugin('Nope');
    expect(await screen.findByText("This plugin doesn't exist yet.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All plugins' })).toHaveAttribute(
      'href',
      '/skills-and-tools',
    );
  });

  it('degrades to the catalog when the plugins endpoint fails', async () => {
    pluginsMock.listPlugins.mockRejectedValue(new Error("Couldn't load plugins."));
    renderPlugin('GTM');
    expect(await screen.findByTestId('library-card-skill-outreach')).toBeInTheDocument();
    // No verified principals, so no claim about them.
    expect(screen.queryByText(/^Run by/)).not.toBeInTheDocument();
    // The add door is GONE. It used to be asserted present-and-enabled, on
    // the reasoning that adding writes nothing a permission could be wrong
    // about — but permission was never what stops it here: `AddToPluginDialog`
    // needs `summary && primaryFolder` to mount, and the failed endpoint left
    // neither, so the button opened nothing at all. Omitted, like `Share`
    // is when there is no folder to manage.
    expect(
      screen.queryByRole('button', { name: 'Add a skill or tool to GTM' }),
    ).not.toBeInTheDocument();
  });

  it('brings the add door back once plugin discovery lands', async () => {
    // The page renders as soon as the CATALOG has items, so the summary can be
    // missing simply because plugins are still on their way. The button is
    // absent for that moment and appears when there is something behind it —
    // an affordance arriving, never one that was there and stopped working.
    let settle!: (plugins: PluginSummary[]) => void;
    pluginsMock.listPlugins.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    renderPlugin('GTM');
    await screen.findByTestId('library-card-skill-outreach');
    expect(
      screen.queryByRole('button', { name: 'Add a skill or tool to GTM' }),
    ).not.toBeInTheDocument();

    settle([gtm()]);
    expect(
      await screen.findByRole('button', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
  });

  it('offers no add door to a caller who only reached the plugin through an item grant', async () => {
    // A per-file grant puts one skill from GTM in this caller's catalog while
    // no summary vouches for the plugin. Discovery worked — they simply have
    // no folder of their own to add into, so there is no door to offer.
    pluginsMock.listPlugins.mockResolvedValue([]);
    renderPlugin('GTM');
    await screen.findByTestId('library-card-skill-outreach');
    expect(
      screen.queryByRole('button', { name: 'Add a skill or tool to GTM' }),
    ).not.toBeInTheDocument();
  });

  it('does not claim a missing plugin is gone while the endpoint is still failing', async () => {
    pluginsMock.listPlugins.mockRejectedValue(new Error("Couldn't load plugins."));
    renderPlugin('Finance');
    await waitFor(() =>
      expect(screen.queryByText('Loading the library…')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("This plugin doesn't exist yet.")).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finance', level: 1 })).toBeInTheDocument();
  });

  it('decodes a URL-hostile plugin name', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'pricing', description: '', path: 'Plugins/Sales & Ops/pricing' }],
      tools: [],
    });
    renderPlugin('Sales & Ops');
    expect(
      await screen.findByRole('heading', { name: 'Sales & Ops', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-pricing')).toBeInTheDocument();
  });

  it('waits rather than guessing while the catalog is still loading', () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderPlugin('GTM');
    expect(screen.getByText('Loading the library…')).toBeInTheDocument();
    expect(screen.queryByText("This plugin doesn't exist yet.")).not.toBeInTheDocument();
  });

  /**
   * "Last updated just now" is a CLAIM, and the page has to be able to back it.
   * Both refetches behind the button return `void`, so the only honest end of
   * the spin is the loads settling — which is what these two pin. The spinner
   * is read off `animate-spin` because that class is the only thing in the DOM
   * that distinguishes "checking" from "idle": both states render the same
   * button with the same name.
   */
  describe('checking for updates', () => {
    const refreshButton = () => screen.getByRole('button', { name: 'Check for updates' });
    const spinning = () => refreshButton().querySelector('.animate-spin') !== null;

    it('claims freshness only once the refetch has actually landed', async () => {
      renderPlugin('GTM');
      await screen.findByRole('heading', { name: 'GTM', level: 1 });

      let land!: (plugins: PluginSummary[]) => void;
      pluginsMock.listPlugins.mockReturnValueOnce(
        new Promise<PluginSummary[]>((resolve) => {
          land = resolve;
        }),
      );

      fireEvent.click(refreshButton());
      await waitFor(() => expect(spinning()).toBe(true));
      // Still in flight — the page says nothing about being up to date.
      expect(screen.queryByText('Last updated just now')).not.toBeInTheDocument();

      await act(async () => {
        land([gtm()]);
      });
      expect(await screen.findByText('Last updated just now')).toBeInTheDocument();
    });

    it('does not report success when the refetch fails', async () => {
      renderPlugin('GTM');
      await screen.findByRole('heading', { name: 'GTM', level: 1 });

      pluginsMock.listPlugins.mockRejectedValueOnce(new Error("Couldn't load plugins."));
      fireEvent.click(refreshButton());

      await waitFor(() => expect(spinning()).toBe(false));
      expect(screen.queryByText('Last updated just now')).not.toBeInTheDocument();
    });
  });
});
