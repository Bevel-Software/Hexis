import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

function renderOps() {
  return render(
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
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;

describe('a tool proposed on an open change request', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(emptyCatalog);
    pluginsMock.listPlugins.mockResolvedValue([ops()]);
    pluginsMock.listJoinRequests.mockResolvedValue([]);
    pluginsMock.reconcileJoinRequest.mockResolvedValue(false);
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
   * The card says which FILE the request adds, because that is what an
   * approver is about to decide on — and a proposed `mcp.json` server and a
   * proposed `.tool` manual are two different decisions.
   */
  it('says how the proposed tool is declared', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...emptyCatalog,
      pendingTools: [pendingTool({ slug: 'tickets', name: 'tickets', path: 'Plugins/Ops/mcp.json', type: 'mcp' })],
    });
    renderOps();
    expect(await screen.findByTestId('library-card-integration-tickets')).toHaveTextContent(
      'MCP server',
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
    view.unmount();

    dataMock.useLibraryData.mockReturnValue(emptyCatalog);
    renderOps();
    await screen.findByText('No tools yet.');
    expect(screen.queryByTestId('library-card-integration-weather')).not.toBeInTheDocument();
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
