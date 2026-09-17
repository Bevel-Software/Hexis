import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
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
  ManageAccessDialog: ({
    entry,
    workspaceId,
    onManageAncestor,
  }: {
    entry: { relativePath: string; type: string };
    workspaceId?: string;
    onManageAncestor?(entry: { name: string; relativePath: string; type: string }): void;
  }) => (
    // Which branch the rules are read and written on, and whether a grant the
    // skill inherits can be managed where it lives, are both the page's to
    // hand over — so the stub surfaces both.
    <div
      role="dialog"
      aria-label={`Manage access ${entry.type} ${entry.relativePath}`}
      data-workspace={workspaceId}
    >
      {onManageAncestor && (
        <button
          type="button"
          onClick={() =>
            onManageAncestor({
              name: 'personal-juan',
              relativePath: 'knowledge-base/Plugins/personal-juan',
              type: 'directory',
            })
          }
        >
          Manage personal-juan →
        </button>
      )}
    </div>
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

/** `ambient` is the branch the app happens to have OPEN — the default one
 * everywhere but the access test, which is about the page not following it. */
function renderPage(ambient: WorkspaceContextValue = workspace) {
  render(
    <MemoryRouter initialEntries={['/skills-and-tools/yours']}>
      <AdminContext.Provider value={admin}>
        <WorkspaceContext.Provider value={ambient}>
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

  /**
   * Two things the skill page's Share does that a card's has to do as well, or
   * the same dialog behaves differently depending on where it was opened from:
   * it edits the DEFAULT branch (the one the catalog was read from — a grant
   * spliced into an open change-request branch is a rule nobody merges), and
   * it offers the walk up to a folder above the skill, without which an
   * inherited grant is read-only here and editable on the skill's own page.
   */
  it("edits the default branch's rules, and can walk up to the folder above the skill", async () => {
    renderPage({ ...workspace, workspaceId: 'a-change-request-branch' } as WorkspaceContextValue);

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for rfi' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('data-workspace')).toBe(encodeURIComponent(DEFAULT_BRANCH));
    expect(dialog.getAttribute('data-workspace')).not.toBe('a-change-request-branch');

    fireEvent.click(screen.getByRole('button', { name: 'Manage personal-juan →' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access directory knowledge-base/Plugins/personal-juan',
      }),
    ).toBeInTheDocument();
  });

  it('leaves the tool card alone', async () => {
    renderPage();

    expect(await screen.findByRole('button', { name: 'Actions for rfi' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions for Weather' })).toBeNull();
  });
});
