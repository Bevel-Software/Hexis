import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { PluginSummary } from '../services/plugins.api';

/**
 * The public-demo lockdown's face: "New plugin" answers with the
 * self-host-it dialog instead of the create form. The endpoint refusal is the
 * backend's test (plugins.routes.test.ts); this one proves a visitor is TOLD,
 * not just refused.
 *
 * Wired like LibraryRoutes.test.tsx: the catalog and the plugin index are
 * stubbed at the data seam, everything from the router down is real, and the
 * verb is reached the way a person reaches it — the nav's context menu.
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
  repairPluginLinks: vi.fn().mockResolvedValue({ repaired: [], skipped: [] }),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

const teamsMock = vi.hoisted(() => ({ listTeams: vi.fn() }));
vi.mock('../services/teams.api', () => ({ listTeams: teamsMock.listTeams }));
// The sidebar's change-request dock pulls in git wiring these routes do not exercise.
vi.mock('../../git/components/PullRequestsForMe', () => ({ PullRequestsForMe: () => null }));

const bootstrapMock = vi.hoisted(() => ({ isPublicDemo: vi.fn() }));
vi.mock('../../../core/bootstrap', () => ({ isPublicDemo: bootstrapMock.isPublicDemo }));

import { LibraryRoutes } from '../routes/LibraryRoutes';
import { withAuth } from './auth-harness';

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [{ name: 'outreach', description: 'Runs the GTM outreach.', path: 'Plugins/GTM/outreach' }],
  pendingSkills: [],
  pendingTools: [],
  tools: [],
  ownedSkills: new Set<string>(),
  writableSkills: new Set<string>(),
  ownedTools: new Set<string>(),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
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
    toolCount: 0,
    owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
    writers: { roles: ['Admin'], users: [] },
    readers: { restricted: true, roles: ['GTM Team'], users: [] },
    hasRequested: false,
    requestNumber: null,
  },
];

const TEAMS = [{ name: 'GTM Team', plugins: ['GTM'], skills: ['outreach'], tools: [] }];

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

function renderLibrary() {
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools']}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
        </Routes>,
      )}
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Library navigation' });

/** Right-click the team's nav row, wait for its menu, and pick "New plugin". */
async function chooseNewPlugin() {
  const row = await within(nav()).findByRole('button', { name: /^GTM Team/ });
  fireEvent.contextMenu(row, { clientX: 60, clientY: 180 });
  await screen.findByRole('menu');
  fireEvent.click(screen.getByRole('menuitem', { name: 'New plugin' }));
}

beforeEach(() => {
  dataMock.useLibraryData.mockReturnValue(CATALOG);
  pluginsMock.listPlugins.mockResolvedValue(PLUGINS);
  pluginsMock.listJoinRequests.mockResolvedValue([]);
  teamsMock.listTeams.mockResolvedValue(TEAMS);
});

afterEach(() => cleanup());

describe('public-demo lockdown', () => {
  it('New plugin opens the self-host dialog instead of the create form', async () => {
    bootstrapMock.isPublicDemo.mockReturnValue(true);
    renderLibrary();
    await chooseNewPlugin();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Not in this demo')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Get your own on GitHub' })).toBeInTheDocument();
    // The create form never mounts — there is nothing to fill in.
    expect(screen.queryByLabelText('Plugin name')).toBeNull();
  });

  it('outside the demo, New plugin still opens the create form', async () => {
    bootstrapMock.isPublicDemo.mockReturnValue(false);
    renderLibrary();
    await chooseNewPlugin();

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New plugin')).toBeInTheDocument();
    expect(screen.queryByText('Not in this demo')).toBeNull();
  });
});
