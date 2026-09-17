import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';

/**
 * Your own space — the items in no plugin folder, given the page every plugin
 * gets.
 *
 * What this file owes is the distinction the page's docstring draws: the SPACE
 * has nothing to share, because it is defined as the items in no folder and
 * there is no `access.md` to point a dialog at — so no Share in the title row,
 * still. A SKILL on it is a folder of its own with its own rules, which is
 * exactly the standalone skill the skill page shares, so its card carries the
 * same menu it carries everywhere else. A tool does not: what a tool shares is
 * decided at the plugin that carries it, and here there is no plugin at all.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));
vi.mock('../services/plugins.api', () => ({ listPlugins: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/teams.api', () => ({ listTeams: vi.fn().mockResolvedValue([]) }));
vi.mock('../../access/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../access/api')>()),
  fetchFileAccessBatch: vi.fn(async (_ws: string, paths: string[]) => ({
    results: Object.fromEntries(paths.map((p) => [p, true])),
  })),
}));
// The dialog fetches on mount; stubbed at the component so this stays on the
// page's judgement — WHICH directory it opens on — as `PluginPage.test` does.
vi.mock('../../access/components/ManageAccessDialog', () => ({
  ManageAccessDialog: ({ entry }: { entry: { relativePath: string; type: string } }) => (
    <div role="dialog" aria-label={`Manage access ${entry.type} ${entry.relativePath}`} />
  ),
}));

import { LibraryProvider } from '../state/library-data';
import { LibraryToastProvider } from '../state/toast';
import { PersonalPluginPage } from '../components/PersonalPluginPage';

const admin = {
  isAdmin: false,
  unreadCount: 0,
  lastSeen: null,
  markSeen: vi.fn(),
  refresh: vi.fn(),
  rolesConfigCorrupted: false,
  rolesConfigErrors: [],
  runRolesRecovery: vi.fn(),
} as unknown as AdminContextValue;

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

/** One skill and one tool, both in no plugin folder — what this page lists. */
const CATALOG: LibraryData = {
  loading: false,
  error: null,
  // A personal shelf (`Plugins/personal-<uid>`) is the skill path this page is
  // about: the catalog never lists it as a plugin, and it is not under the
  // shared `Skills/` root either, so `isUngrouped` says yes to it and to
  // nothing else.
  skills: [{ name: 'rfi', description: 'Answers an RFI.', path: 'Plugins/personal-juan/rfi' }],
  pendingSkills: [],
  tools: [
    {
      slug: 'weather',
      name: 'Weather',
      path: 'Tools/weather.tool',
      type: 'http',
      setup: null,
      canWrite: true,
      variables: [],
    },
  ],
  ownedSkills: new Set(['rfi']),
  writableSkills: new Set(['rfi']),
  ownedTools: new Set(['weather']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
} as unknown as LibraryData;

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/skills-and-tools/yours']}>
      <AdminContext.Provider value={admin}>
        <WorkspaceContext.Provider value={workspace}>
          <LibraryToastProvider>
            <LibraryProvider>
              <PersonalPluginPage />
            </LibraryProvider>
          </LibraryToastProvider>
        </WorkspaceContext.Provider>
      </AdminContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dataMock.useLibraryData.mockReturnValue(CATALOG);
});

describe('your own space', () => {
  it("shares a skill on the skill's own folder, though the space itself has none to share", async () => {
    renderPage();

    // The title row still offers no Share: there is no folder behind the page.
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for rfi' }));
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Open', 'Share']);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access directory knowledge-base/Plugins/personal-juan/rfi',
      }),
    ).toBeInTheDocument();
  });

  it('leaves the tool card alone', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Actions for rfi' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Weather' })).toBeNull();
  });
});
