import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { PendingToolSummary } from '../services/tools.api';
import type { PluginSummary } from '../services/plugins.api';
import { withAuth } from './auth-harness';

/**
 * A tool proposed on an open change request, in the library.
 *
 * The bug, told by the tester: they asked the agent for a tool, a change
 * request opened — and the tools UI showed nothing at all until somebody
 * approved it. Skills already had the answer (a Proposed card linked to its
 * request); these tests pin the same answer for tools, and pin the two things
 * a proposal must NOT become: an openable tool page, and a unit of "needs
 * setup" amber.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const pluginsMock = vi.hoisted(() => ({
  listPlugins: vi.fn(),
  listJoinRequests: vi.fn(),
  reconcileJoinRequest: vi.fn(),
  requestPluginAccess: vi.fn(),
  unlinkSkill: vi.fn(),
  renamePlugin: vi.fn(),
}));
vi.mock('../services/teams.api', () => ({ listTeams: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/plugins.api', () => ({
  listPlugins: pluginsMock.listPlugins,
  listJoinRequests: pluginsMock.listJoinRequests,
  reconcileJoinRequest: pluginsMock.reconcileJoinRequest,
  requestPluginAccess: pluginsMock.requestPluginAccess,
  unlinkSkill: pluginsMock.unlinkSkill,
  renamePlugin: pluginsMock.renamePlugin,
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

// The review dialog is the CARD'S LINK to the change request: the whole of what
// there is to read about a proposal, and the only place the decision is made.
// Stubbed so these tests can see WHICH request the card reached for, without
// the dialog's own fetching.
vi.mock('../../change-requests/components/ChangeRequestDialog', () => ({
  ChangeRequestDialog: ({
    cr,
    onClose,
  }: {
    cr: { number: number; title: string };
    onClose(): void;
  }) => (
    <div role="dialog" aria-label={`Change request ${cr.number}`}>
      <p>{cr.title}</p>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

import { LibraryProvider, attentionOf, type LibraryItem } from '../state/library-data';
import { LibraryToastProvider } from '../state/toast';
import { PluginPage } from '../components/PluginPage';
import { PersonalPluginPage } from '../components/PersonalPluginPage';

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

const pendingTool = (over: Partial<PendingToolSummary> = {}): PendingToolSummary => ({
  slug: 'weather',
  name: 'weather',
  path: 'Plugins/Ops/weather.tool',
  type: 'http',
  plugin: 'Ops',
  changeRequestNumber: 7,
  branch: 'agent/weather',
  authorName: 'Ali Raza',
  createdAt: '2026-09-06T09:00:00.000Z',
  isAuthor: false,
  ...over,
});

const emptyCatalog: LibraryData = {
  loading: false,
  error: null,
  skills: [],
  pendingSkills: [],
  pendingTools: [],
  tools: [],
  ownedSkills: new Set(),
  writableSkills: new Set(),
  ownedTools: new Set(),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const ops = (over: Partial<PluginSummary> = {}): PluginSummary => ({
  name: 'Ops',
  folders: ['Plugins/Ops'],
  canRead: true,
  canWrite: false,
  isOwner: false,
  skillCount: 0,
  toolCount: 0,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: ['Admin'], users: [] },
  readers: { restricted: false, roles: [], users: [] },
  hasRequested: false,
  requestNumber: null,
  ...over,
});

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="href">{location.pathname + location.search}</div>;
}

/** The whole tree the tests mount, so a re-render can reuse it verbatim. */
function opsTree() {
  return (
    <MemoryRouter initialEntries={['/skills-and-tools/plugins/Ops']}>
      <AdminContext.Provider value={nonAdmin}>
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
                </>,
              )}
            </LibraryProvider>
          </LibraryToastProvider>
        </WorkspaceContext.Provider>
      </AdminContext.Provider>
    </MemoryRouter>
  );
}

function renderOps() {
  return render(opsTree());
}

/** Your own space — the page for the items that belong to no plugin at all. */
function renderYours() {
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools/yours']}>
      <AdminContext.Provider value={nonAdmin}>
        <WorkspaceContext.Provider value={workspace}>
          <LibraryToastProvider>
            <LibraryProvider>{withAuth(<PersonalPluginPage />)}</LibraryProvider>
          </LibraryToastProvider>
        </WorkspaceContext.Provider>
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;

describe('a tool proposed on an open change request', () => {
  /** The `console.error` spy in flight, so `afterEach` can take it off again. */
  let consoleErrorSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(emptyCatalog);
    pluginsMock.listPlugins.mockResolvedValue([ops()]);
    pluginsMock.listJoinRequests.mockResolvedValue([]);
    pluginsMock.reconcileJoinRequest.mockResolvedValue(false);
  });

  // The spy a test installs on `console.error` comes off here, pass or fail:
  // an assertion that throws mid-test would otherwise leave it swallowed for
  // every later test in the file, hiding the next real failure behind this
  // one. Scoped to this one spy — `restoreAllMocks` would also tear down the
  // module mocks `beforeEach` depends on.
  afterEach(() => {
    consoleErrorSpy?.mockRestore();
    consoleErrorSpy = null;
  });

  it('shows in the plugin it targets, marked in review and named by its proposer', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...emptyCatalog, pendingTools: [pendingTool()] });
    renderOps();

    const card = await screen.findByTestId('library-card-integration-weather');
    expect(card).toHaveTextContent('weather');
    expect(card).toHaveTextContent('In review');
    expect(card).toHaveTextContent('From Ali Raza: waiting on you');
    // Not mixed in with the active tools: the dashed outline says "an outline
    // of a tool, not one" before a word of it is read.
    expect(card.className).toContain('border-dashed');
  });

  /**
   * A proposal spends its one badge on `In review` and keeps its name legible.
   *
   * The card sits in a fixed 260px grid track beside a monogram, and every
   * badge is `shrink-0` — so drawing the flavour badge as well left the
   * truncating name 25px of the 141px `prometheus_metrics` needs, and the card
   * read `p…`. The flavour answers "which file do I edit", a question about a
   * released tool; the reviewer clicking through is shown that file and its
   * diff by the change request itself.
   */
  it('keeps a long proposed tool’s name legible rather than spending the row on badges', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...emptyCatalog,
      pendingTools: [
        pendingTool({
          slug: 'prometheus_metrics',
          name: 'prometheus_metrics',
          path: 'Plugins/Ops/mcp.json',
          type: 'mcp',
        }),
      ],
    });
    renderOps();

    const card = await screen.findByTestId('library-card-integration-prometheus_metrics');
    expect(card).toHaveTextContent('In review');
    expect(card).not.toHaveTextContent('MCP server');
    // The row's only flexible item is the name; one badge is what it fits.
    // Badges are the round chips — the monogram beside them is a rounded
    // square, and rigid in just the same way.
    const title = within(card).getByText('prometheus_metrics').parentElement!;
    expect([...title.children].filter((el) => el.className.includes('rounded-full'))).toHaveLength(1);
    // Clipped or not, the whole name is one hover away.
    expect(within(card).getByText('prometheus_metrics')).toHaveAttribute(
      'title',
      'prometheus_metrics',
    );
  });

  /**
   * The card LINKS to the change request and opens nothing else. A tool page
   * would read the default branch, where the manual does not exist — and would
   * start probing a connection for a file nobody has approved.
   */
  it('opens its change request rather than a tool page', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...emptyCatalog, pendingTools: [pendingTool()] });
    renderOps();
    const before = href();

    fireEvent.click(await screen.findByTestId('library-card-integration-weather'));

    const dialog = await screen.findByRole('dialog', { name: 'Change request 7' });
    expect(dialog).toHaveTextContent('New tool: weather');
    // Still on the plugin page: the click navigated nowhere.
    expect(href()).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Change request 7' })).not.toBeInTheDocument(),
    );
  });

  /**
   * Once the request is no longer open the backend stops listing it, so the
   * next load simply has no proposal — and the card is gone, replaced by the
   * real tool when the request merged. Pinned here as the FRONTEND's half of
   * that: nothing on this side caches a proposal past the load it arrived on.
   */
  it('disappears on the next load once the request is resolved', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...emptyCatalog, pendingTools: [pendingTool()] });
    const view = renderOps();
    await screen.findByTestId('library-card-integration-weather');

    // The SAME mounted tree, re-rendered against the answer the reloaded
    // catalog now gives — the request merged or closed, so the backend lists
    // no proposal. Mounting a second, fresh tree would prove nothing: a
    // provider that cached proposals in state would still start empty there,
    // and the caching regression this guards against is exactly the one that
    // survives across a reload.
    dataMock.useLibraryData.mockReturnValue(emptyCatalog);
    view.rerender(opsTree());

    await screen.findByText('No tools yet.');
    expect(screen.queryByTestId('library-card-integration-weather')).not.toBeInTheDocument();
  });

  /**
   * A tool's plugin membership is DERIVED from where its file sits, and a
   * plugin can LINK a root outside its own folder. A released tool under such a
   * root is on that plugin's page; a proposal into the same root must be too,
   * or the card the reviewer is meant to act on is on no page at all.
   */
  it('shows under a plugin that only LINKS the root its declaration lands in', async () => {
    pluginsMock.listPlugins.mockResolvedValue([
      ops({ folders: ['Plugins/Ops'], linkedRoots: ['Integrations'] }),
    ]);
    dataMock.useLibraryData.mockReturnValue({
      ...emptyCatalog,
      pendingTools: [pendingTool({ path: 'Integrations/weather.tool', plugin: null })],
    });
    renderOps();

    const card = await screen.findByTestId('library-card-integration-weather');
    expect(card).toHaveTextContent('In review');
  });

  /**
   * A proposal in NO plugin folder lands on your own space — and its card says
   * "waiting on you" just as it does anywhere else. A card that names the
   * reader as the reviewer and then does nothing when clicked is the one
   * arrangement that cannot be right, so this page opens the request too.
   */
  it('opens its change request from your own space as well', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...emptyCatalog,
      pendingTools: [pendingTool({ path: 'Plugins/weather.tool', plugin: null })],
    });
    renderYours();

    const card = await screen.findByTestId('library-card-integration-weather');
    expect(card).toHaveTextContent('From Ali Raza: waiting on you');
    fireEvent.click(card);
    expect(await screen.findByRole('dialog', { name: 'Change request 7' })).toBeInTheDocument();
  });

  /**
   * Nothing has been approved yet, so nothing has been refused a collision:
   * one request can add the same basename to two plugin folders, and both
   * cards have to render. Keyed on the id and the request number alone they
   * would be one key, and React would drop one of them.
   */
  it('renders both proposals when one request adds the same name twice', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...emptyCatalog,
      pendingTools: [
        pendingTool({ path: 'Plugins/Ops/weather.tool' }),
        pendingTool({ path: 'Plugins/Ops/Field/weather.tool' }),
      ],
    });
    // Restored by the suite's `afterEach`, never here: an assertion below
    // that throws would otherwise leave `console.error` swallowed for every
    // later test in the file, hiding the next real failure behind this one.
    const complaints = vi.spyOn(console, 'error').mockImplementation(() => {});
    consoleErrorSpy = complaints;
    renderOps();
    expect(await screen.findAllByTestId('library-card-integration-weather')).toHaveLength(2);
    // Two same-keyed siblings still PAINT — React only warns — so the render
    // count alone would pass either way. The warning is the failure.
    expect(
      complaints.mock.calls.map((c) => String(c[0])).join('\n'),
    ).not.toMatch(/same key/i);
  });

  /**
   * A proposal is a REVIEW concern, never a setup one. Counting it would put
   * amber on the plugin's sidebar row and offer a "what needs you" filter for a
   * tool that does not exist — there is no credential to fill in.
   */
  it('is not counted as an integration needing setup', () => {
    const proposed: LibraryItem = {
      kind: 'integration',
      id: 'weather',
      name: 'weather',
      description: '',
      owned: false,
      canWrite: false,
      plugin: 'Ops',
      path: 'Plugins/Ops/weather.tool',
      status: { state: 'ok', text: 'In review' },
      pending: { changeRequestNumber: 7, branch: 'agent/weather', authorName: 'Ali Raza', mine: false },
    };
    expect(attentionOf([proposed], 'Ops').total).toBe(0);
    // Even if a proposal ever carried a non-`ok` status, it still must not.
    expect(attentionOf([{ ...proposed, status: { state: 'warn', text: 'Needs setup' } }], 'Ops').total).toBe(0);
    // …while a released tool in the same state is exactly what the count is for.
    const released: LibraryItem = { ...proposed, pending: undefined, status: { state: 'warn', text: 'Needs setup' } };
    expect(attentionOf([released], 'Ops').total).toBe(1);
  });
});
