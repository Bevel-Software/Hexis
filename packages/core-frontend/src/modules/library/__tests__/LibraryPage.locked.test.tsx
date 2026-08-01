import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { GroupSummary, GroupAccessRequestEntry } from '../services/groups.api';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';

/**
 * Locked groups end to end, through the real route table.
 *
 * Selection is a URL now, not filter state, so these cases navigate rather than
 * click a filter: a locked group is reached at `/skills-and-tools/groups/:group`
 * exactly like a readable one, and the page — not the router, not the sidebar —
 * decides which view the caller gets. The admin banner is asserted from the two
 * places it is allowed to appear, and nowhere else.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const groupsMock = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listGroupAccessRequests: vi.fn(),
  dismissGroupAccessRequest: vi.fn(),
  requestGroupAccess: vi.fn(),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));
vi.mock('../services/groups.api', () => ({
  listGroups: groupsMock.listGroups,
  listGroupAccessRequests: groupsMock.listGroupAccessRequests,
  dismissGroupAccessRequest: groupsMock.dismissGroupAccessRequest,
  requestGroupAccess: groupsMock.requestGroupAccess,
  AlreadyReadableError: groupsMock.AlreadyReadableError,
}));

/**
 * The access dialog is somebody else's surface and it talks to four endpoints;
 * what these cases are about is WHICH file the Library hands it and what happens
 * when it closes, so it is stubbed down to exactly those two facts.
 */
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

import { LibraryRoutes } from '../routes/LibraryRoutes';
import { withAuth } from './auth-harness';

const tool = (over: Partial<ToolSecrets> = {}): ToolSecrets => ({
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Groups/GTM/heyreach.tool',
  type: 'inline',
  setup: null,
  canWrite: false,
  variables: [],
  ...over,
});

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [{ name: 'outreach', description: 'Runs the GTM outreach.', path: 'Groups/GTM/outreach' }],
  tools: [tool()],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const summary = (over: Partial<GroupSummary> = {}): GroupSummary => ({
  name: 'GTM',
  folders: ['Groups/GTM'],
  canRead: true,
  canWrite: true,
  skillCount: 1,
  toolCount: 1,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
  writers: { roles: ['Admin'], users: [] },
  readers: { restricted: true, roles: ['GTM Team'], users: [] },
  hasRequested: false,
  ...over,
});

const FINANCE = summary({
  name: 'Finance',
  folders: ['Groups/Finance'],
  canRead: false,
  canWrite: false,
  skillCount: 3,
  toolCount: 1,
  owners: { roles: [], users: [{ name: 'Olga Ivanova', email: null }] },
  readers: null,
});

const request = (over: Partial<GroupAccessRequestEntry> = {}): GroupAccessRequestEntry => ({
  id: 'req-finance',
  group: 'Finance',
  requesterName: 'Juan Viera',
  requesterEmail: 'juan@bevel.software',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const ASKED_FINANCE = 'Juan Viera asked to join Finance — grant read access to let them in.';
const ASKED_GTM = 'Ali Baba asked to join GTM — grant read access to let them in.';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {withAuth(
        <WorkspaceContext.Provider value={workspace}>
          <Routes>
            <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
          </Routes>
        </WorkspaceContext.Provider>,
      )}
    </MemoryRouter>,
  );
}

describe('Library — locked groups', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    groupsMock.listGroups.mockResolvedValue([summary(), FINANCE]);
    groupsMock.listGroupAccessRequests.mockResolvedValue([]);
    groupsMock.dismissGroupAccessRequest.mockResolvedValue(undefined);
    groupsMock.requestGroupAccess.mockResolvedValue(undefined);
  });

  it('lists a group the caller cannot read in the sidebar, locked', async () => {
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('button', { name: 'Finance (locked)' })).toBeInTheDocument();
    // A readable group keeps its ordinary row and its count.
    expect(screen.getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });

  it("a locked group's URL renders the locked view, with no search and no grid", async () => {
    renderAt('/skills-and-tools/groups/Finance');
    expect(
      await screen.findByRole('button', { name: 'Subscribe to its skills and tools' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finance', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('3 skills · 1 tool — visible to members only.')).toBeInTheDocument();
    // There is nothing to search, so the search field is not offered.
    expect(screen.queryByLabelText('Search the library')).not.toBeInTheDocument();
    expect(screen.queryByTestId('library-card-skill-outreach')).not.toBeInTheDocument();
  });

  it('lets a locked-out admin unlock themselves from the locked page', async () => {
    // Admin rescue applies to WRITING access.md, never to reading a folder, so a
    // platform Admin can genuinely be locked out of a group they are the right
    // person to open. `canWrite` is that verdict, and this is the way out.
    groupsMock.listGroups.mockResolvedValue([summary(), { ...FINANCE, canWrite: true }]);
    renderAt('/skills-and-tools/groups/Finance');

    fireEvent.click(await screen.findByRole('button', { name: 'Manage access' }));
    expect(
      screen.getByRole('dialog', { name: 'Manage access directory knowledge-base/Groups/Finance' }),
    ).toBeInTheDocument();
  });

  it('asks to join from the locked page and remembers it after the index refetches', async () => {
    renderAt('/skills-and-tools/groups/Finance');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Subscribe to its skills and tools' }),
    );
    await waitFor(() => expect(groupsMock.requestGroupAccess).toHaveBeenCalledWith('Finance'));
    groupsMock.listGroups.mockResolvedValue([summary(), { ...FINANCE, hasRequested: true }]);
    expect(
      await screen.findByText('Requested — Olga Ivanova decides who joins.'),
    ).toBeInTheDocument();
  });

  it('unlocks a group in the sidebar when an item grant reaches inside it', async () => {
    // Access resolves closeness-first, so a per-file grant can hand somebody one
    // skill in a folder they cannot read. The catalog wins over the folder
    // verdict — the row and the page it opens have to agree.
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'budget', description: '', path: 'Groups/Finance/budget' }],
      tools: [],
    });
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('button', { name: /^Finance/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finance (locked)' })).not.toBeInTheDocument();
  });

  it('gathers every pending request on Everything — where an admin actually lands', async () => {
    groupsMock.listGroupAccessRequests.mockResolvedValue([
      request(),
      request({ id: 'req-gtm', group: 'GTM', requesterName: 'Ali Baba' }),
    ]);
    renderAt('/skills-and-tools');
    expect(await screen.findByText(ASKED_FINANCE)).toBeInTheDocument();
    expect(screen.getByText(ASKED_GTM)).toBeInTheDocument();
  });

  it("shows a group page only its own group's requests", async () => {
    groupsMock.listGroupAccessRequests.mockResolvedValue([
      request(),
      request({ id: 'req-gtm', group: 'GTM', requesterName: 'Ali Baba' }),
    ]);
    renderAt('/skills-and-tools/groups/GTM');
    expect(await screen.findByText(ASKED_GTM)).toBeInTheDocument();
    expect(screen.queryByText(ASKED_FINANCE)).not.toBeInTheDocument();
  });

  it('keeps requests off the personal views, which are about your own things', async () => {
    groupsMock.listGroupAccessRequests.mockResolvedValue([request()]);
    renderAt('/skills-and-tools/owned');
    expect(await screen.findByRole('heading', { name: 'Owned by me' })).toBeInTheDocument();
    expect(screen.queryByText(ASKED_FINANCE)).not.toBeInTheDocument();
  });

  it('opens the access dialog on the group DIRECTORY and refetches when it closes', async () => {
    groupsMock.listGroupAccessRequests.mockResolvedValue([request()]);
    renderAt('/skills-and-tools');

    fireEvent.click(await screen.findByRole('button', { name: 'Manage access' }));
    expect(
      screen.getByRole('dialog', { name: 'Manage access directory knowledge-base/Groups/Finance' }),
    ).toBeInTheDocument();

    const groupsCalls = groupsMock.listGroups.mock.calls.length;
    const requestCalls = groupsMock.listGroupAccessRequests.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Close access' }));

    // Granting IS approving: the row retires itself server-side, so closing the
    // dialog asks again rather than marking anything approved in the browser.
    await waitFor(() => {
      expect(groupsMock.listGroups.mock.calls.length).toBe(groupsCalls + 1);
      expect(groupsMock.listGroupAccessRequests.mock.calls.length).toBe(requestCalls + 1);
    });
  });

  it('dismisses a request by its requester and drops the row', async () => {
    groupsMock.listGroupAccessRequests.mockResolvedValue([request()]);
    renderAt('/skills-and-tools');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Dismiss request from Juan Viera' }),
    );
    expect(groupsMock.dismissGroupAccessRequest).toHaveBeenCalledWith('req-finance');
    groupsMock.listGroupAccessRequests.mockResolvedValue([]);
    await waitFor(() => expect(screen.queryByText(ASKED_FINANCE)).not.toBeInTheDocument());
  });

  it('says so when the dismiss fails, and keeps the row', async () => {
    groupsMock.listGroupAccessRequests.mockResolvedValue([request()]);
    groupsMock.dismissGroupAccessRequest.mockRejectedValue(new Error('gone'));
    renderAt('/skills-and-tools');

    fireEvent.click(
      await screen.findByRole('button', { name: 'Dismiss request from Juan Viera' }),
    );
    expect(await screen.findByText("Couldn't dismiss that — try again.")).toBeInTheDocument();
  });

  it('degrades to no banner when the requests endpoint is down', async () => {
    groupsMock.listGroupAccessRequests.mockRejectedValue(new Error('nope'));
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect(screen.queryByText(ASKED_FINANCE)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage access' })).not.toBeInTheDocument();
  });
});
