import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { GroupSummary } from '../services/groups.api';

/**
 * The Library nav's right-click menu, wired up for real.
 *
 * `GroupsSidebar.contextmenu` proves the nav REPORTS the gesture and
 * `GroupsSidebarMenu` proves the panel behaves; neither can prove the thing
 * that actually matters, which is that the layout hands each kind of row the
 * verbs that are true of it. That decision needs the group summaries and the
 * workspace's KB dir, so it only exists once the whole surface is mounted —
 * hence this file.
 *
 * Same seams as `LibraryRoutes.test.tsx`: the catalog is mocked at its hook and
 * the group index at its API, because what is under test is the menu, not the
 * fetching.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const groupsMock = vi.hoisted(() => ({ listGroups: vi.fn(), listJoinRequests: vi.fn() }));
vi.mock('../services/groups.api', () => ({
  listGroups: groupsMock.listGroups,
  listJoinRequests: groupsMock.listJoinRequests,
  reconcileJoinRequest: vi.fn(),
  requestGroupAccess: vi.fn(),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

// `Manage access` opens a dialog that fetches the verdict. Stub it so the sheet
// can actually mount without waiting on a refused connection.
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return {
    ...actual,
    fetchFileAccess: vi.fn().mockResolvedValue({
      canRead: true,
      canWrite: true,
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

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [
    { name: 'outreach', description: 'Runs the GTM outreach.', path: 'Groups/GTM/outreach' },
    { name: 'scratch', description: 'A skill in no group.', path: 'Skills/scratch' },
  ],
  tools: [],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  pendingSkills: [],
  crs: [],
  myCrNumbers: new Set(),
  reload: vi.fn(),
};

const summary = (over: Partial<GroupSummary>): GroupSummary => ({
  name: 'GTM',
  folders: ['Groups/GTM'],
  canRead: true,
  canWrite: true,
  skillCount: 1,
  toolCount: 0,
  owners: { roles: [], users: [] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  hasRequested: false,
  requestNumber: null,
  ...over,
});

const GROUPS: GroupSummary[] = [
  summary({}),
  // Not readable and not writable, and no item of it reaches the catalog — the
  // sidebar's locked half.
  summary({ name: 'Finance', folders: ['Groups/Finance'], canRead: false, canWrite: false }),
];

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
      <WorkspaceContext.Provider value={workspaceValue}>
        {withAuth(children)}
      </WorkspaceContext.Provider>
    </AdminContext.Provider>
  );
}

function renderLibrary(path = '/skills-and-tools') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
        </Routes>,
      )}
    </MemoryRouter>,
  );
}

const nav = () => screen.getByRole('navigation', { name: 'Library groups' });
const menuItems = () =>
  within(screen.getByRole('menu'))
    .getAllByRole('menuitem')
    .map((i) => i.textContent);

/**
 * A row in the NAV, by name. Scoped rather than global because the Library
 * opens on the all-groups index, whose rows name the same groups the nav does —
 * `GTM` is two buttons on this screen, and only one of them is the nav's.
 */
const navRow = (name: RegExp | string) => within(nav()).findByRole('button', { name });

/** Right-click a row and wait for the menu the layout renders in response. */
async function openMenuOn(name: RegExp | string) {
  const row = await navRow(name);
  fireEvent.contextMenu(row, { clientX: 60, clientY: 180 });
  await screen.findByRole('menu');
  return row;
}

describe('Library sidebar: right-click, end to end', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    groupsMock.listGroups.mockResolvedValue(GROUPS);
    groupsMock.listJoinRequests.mockResolvedValue([]);
  });

  // Only the globals this file stubs — NOT `restoreAllMocks`, which would strip
  // the resolved values off the module mocks above and leave `fetchFileAccess`
  // returning undefined for whichever test happens to run next.
  afterEach(() => vi.unstubAllGlobals());

  it('gives a group row the full menu, titled after the group', async () => {
    renderLibrary();
    await openMenuOn(/^GTM/);
    expect(screen.getByRole('menu', { name: 'Actions for GTM' })).toBeInTheDocument();
    expect(menuItems()).toEqual(['Add a skill or tool', 'New group', 'Copy link', 'Manage access']);
  });

  /**
   * A lens is a slice of the catalog, not a folder — there is nothing to add a
   * skill TO and no `access.md` behind it. The same call the group page's
   * `PageActions` makes when it hides `Share` on the personal page.
   */
  it('gives a lens row only the verbs a slice of the catalog can answer', async () => {
    renderLibrary();
    await openMenuOn(/^Owned by me/);
    expect(menuItems()).toEqual(['New group', 'Copy link']);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    await openMenuOn(new RegExp(`^${TEST_PERSONAL_GROUP}`));
    expect(menuItems()).toEqual(['New group', 'Copy link']);
  });

  /**
   * `Manage access` is UNGATED on `canWrite`, exactly as the group page's
   * `Share` is: for a non-writer the dialog renders read-only, which is
   * precisely what "who is this shared with?" should answer — and for an admin
   * locked out of a group it is the self-service way back in.
   */
  it('offers Manage access on a locked group too', async () => {
    renderLibrary();
    await openMenuOn('Finance (locked)');
    expect(screen.getByRole('menu', { name: 'Actions for Finance' })).toBeInTheDocument();
    expect(menuItems()).toContain('Manage access');
  });

  it('gives the empty nav space the one verb that belongs to the nav itself', async () => {
    renderLibrary();
    await navRow(/^GTM/);
    fireEvent.contextMenu(nav(), { clientX: 40, clientY: 400 });
    await screen.findByRole('menu');
    expect(menuItems()).toEqual(['New group']);
  });

  it('opens the new-group dialog from the menu', async () => {
    renderLibrary();
    await openMenuOn(/^GTM/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'New group' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the add dialog for the group that was clicked, not the page you are on', async () => {
    renderLibrary('/skills-and-tools/owned');
    await openMenuOn(/^GTM/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Add a skill or tool' }));
    // The dialog titles itself with its group — proof the layout captured the
    // ROW's group, and not the route it happened to be sitting on.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Add a skill or tool to GTM')).toBeInTheDocument();
  });

  it('opens Manage access on the group folder, under the KB dir', async () => {
    const access = await import('../../access/api');
    renderLibrary();
    await openMenuOn(/^GTM/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage access' }));

    await waitFor(() => expect(access.fetchFileAccess).toHaveBeenCalled());
    /**
     * The whole round trip, in one assertion. The layout hands the dialog a
     * WORKSPACE path (`<kbDirName>/<folder>`), the dialog strips that prefix
     * back off, and what reaches the resolver is the REPO-relative folder —
     * which is the only address `access.md` is written at. Get either half
     * wrong and this is `undefined/Groups/GTM` or `knowledge-base/Groups/GTM`,
     * and the dialog silently resolves a folder that does not exist. It is the
     * same handoff `GroupPage` makes, which is why it has to match exactly.
     */
    expect(vi.mocked(access.fetchFileAccess).mock.calls[0][1]).toBe('Groups/GTM');
  });

  it("copies the clicked row's own URL, not the one you are standing on", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });

    renderLibrary('/skills-and-tools/owned');
    await openMenuOn(/^GTM/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/skills-and-tools/groups/GTM`,
      ),
    );
    expect(await screen.findByText('Link copied.')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('says so when the clipboard refuses, instead of a silent no-op', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('not allowed')) },
    });

    renderLibrary();
    await openMenuOn(/^GTM/);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));

    // The pill itself, not `getByRole('status')` — the tree carries a second
    // live region (the route announcer), so the role alone is ambiguous.
    const pill = await screen.findByText("Couldn't copy: open the row and copy its address.");
    expect(pill).toBeInTheDocument();
    // And it has to LOOK like a failure. A refusal rendered on the same ink
    // plate as a confirmation is the silent no-op this test exists to prevent,
    // one step removed — the user reads "copied" from the colour and stops.
    expect(pill).toHaveClass('bg-danger');
    vi.unstubAllGlobals();
  });

  it('closes on an outside click, and a left click still navigates', async () => {
    renderLibrary();
    await openMenuOn(/^GTM/);
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    fireEvent.click(await navRow(/^GTM/));
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
  });

  it('hands focus back to the row on Escape', async () => {
    renderLibrary();
    const row = await openMenuOn(/^GTM/);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(row);
  });
});
