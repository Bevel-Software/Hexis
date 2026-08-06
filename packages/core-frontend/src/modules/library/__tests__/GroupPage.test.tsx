import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { GroupSummary } from '../services/groups.api';
import { withAuth } from './auth-harness';

/**
 * The group page: which view a caller gets, what the page says about who runs
 * the group, and where its one action goes. The catalog and the group index are
 * mocked at their two seams — what is under test is the page's judgement, not
 * the fetching underneath it.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const groupsMock = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listJoinRequests: vi.fn(),
  reconcileJoinRequest: vi.fn(),
  requestGroupAccess: vi.fn(),
}));
vi.mock('../services/groups.api', () => ({
  listGroups: groupsMock.listGroups,
  listJoinRequests: groupsMock.listJoinRequests,
  reconcileJoinRequest: groupsMock.reconcileJoinRequest,
  requestGroupAccess: groupsMock.requestGroupAccess,
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

// The ONE access surface — the separate summary section this page was designed
// with never shipped, so there is no `GroupAccessSection.test.tsx` to defer to.
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
import { GroupPage } from '../components/GroupPage';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

const connectedTool = (over: Partial<ToolSecrets> = {}): ToolSecrets => ({
  slug: 'heyreach',
  name: 'heyreach',
  path: 'Groups/GTM/heyreach.tool',
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
    path: 'Groups/GTM/apollo.tool',
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
    { name: 'outreach', description: 'Runs the GTM outreach.', path: 'Groups/GTM/outreach' },
    { name: 'roadmap', description: 'Keeps the roadmap.', path: 'Groups/Product/roadmap' },
  ],
  pendingSkills: [],
  tools: [connectedTool()],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const gtm = (over: Partial<GroupSummary> = {}): GroupSummary => ({
  name: 'GTM',
  folders: ['Groups/GTM'],
  canRead: true,
  canWrite: false,
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

function renderGroup(name: string, children?: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[`/skills-and-tools/groups/${encodeURIComponent(name)}`]}>
      <WorkspaceContext.Provider value={workspace}>
        <LibraryToastProvider>
          <LibraryProvider>
            {/* The add dialog's create half signs the new skill's change
                request with the caller, so it reads `useAuth` — which throws
                rather than returning null when nothing provides it. */}
            {withAuth(
              <>
                <Routes>
                  <Route path="/skills-and-tools/groups/:group" element={<GroupPage />} />
                  <Route path="*" element={<div />} />
                </Routes>
                <LocationProbe />
                {children}
              </>,
            )}
          </LibraryProvider>
        </LibraryToastProvider>
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  );
}

const href = () => screen.getByLabelText('href').textContent;

describe('GroupPage', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    groupsMock.listGroups.mockResolvedValue([gtm()]);
    groupsMock.listJoinRequests.mockResolvedValue([]);
    groupsMock.reconcileJoinRequest.mockResolvedValue(false);
    groupsMock.requestGroupAccess.mockResolvedValue(undefined);
  });

  it("shows only the group's own skills and tools", async () => {
    renderGroup('GTM');
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
    expect(screen.getByTestId('library-card-integration-heyreach')).toBeInTheDocument();
    // Product's skill belongs to another group and never appears here.
    expect(screen.queryByTestId('library-card-skill-roadmap')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument();
  });

  it('leads with the group, not with who runs it', async () => {
    renderGroup('GTM');
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    // The run-by/shared-with lede is gone: it restated, above every group, what
    // the Share panel says once and on demand.
    expect(screen.queryByText(/^Run by /)).not.toBeInTheDocument();
    expect(screen.queryByText(/shared with/)).not.toBeInTheDocument();
  });

  // ONE door, for every role. The page used to fork on `canWrite` into "Add
  // skills or tools" (a dialog) and "Propose a skill or tool" (a whole other
  // page) — the same button, in the same spot, opening a different flow with
  // different words depending on who pressed it. Who reviews what is a property
  // of the group, not of the door.
  it('opens the same add dialog for a writer', async () => {
    groupsMock.listGroups.mockResolvedValue([gtm({ canWrite: true })]);
    renderGroup('GTM');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a skill or tool to GTM' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no review step/)).toBeInTheDocument();
  });

  it('opens the same add dialog for everyone else, and says review is coming', async () => {
    renderGroup('GTM');
    fireEvent.click(await screen.findByRole('button', { name: 'Add a skill or tool to GTM' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/an owner reviews it before it joins/)).toBeInTheDocument();
  });

  it('offers no separate propose door to anybody', async () => {
    renderGroup('GTM');
    await screen.findByRole('button', { name: 'Add a skill or tool to GTM' });
    expect(screen.queryByRole('button', { name: /Propose/i })).not.toBeInTheDocument();
  });

  it('warns about integrations that need setup and sends them to Connect', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [connectedTool(), unsetTool()],
    });
    renderGroup('GTM');
    expect(
      await screen.findByText(
        "1 integration needs setup — connect them to unblock this group's skills.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(href()).toBe('/connect'));
  });

  it('pluralises the attention banner', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      tools: [unsetTool(), unsetTool({ slug: 'clay', name: 'clay', path: 'Groups/GTM/clay.tool' })],
    });
    renderGroup('GTM');
    expect(
      await screen.findByText(
        "2 integrations need setup — connect them to unblock this group's skills.",
      ),
    ).toBeInTheDocument();
  });

  it('renders both empty states for a group with nothing in it', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([gtm({ skillCount: 0, toolCount: 0 })]);
    renderGroup('GTM');
    expect(
      await screen.findByText('No skills yet. Add one, or ask your agent to write one for GTM.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No tools yet.')).toBeInTheDocument();
  });

  it('keeps Share on an EMPTY group — the folder is what carries access, not the items', async () => {
    // Groups used to be derived from their items, which meant a group with
    // nothing in it had no folder to manage and silently lost its access
    // surface. `folders` now comes from the backend's readdir, so an empty
    // group is still a place whose sharing can be changed.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([gtm({ skillCount: 0, toolCount: 0 })]);
    renderGroup('GTM');

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access directory knowledge-base/Groups/GTM',
      }),
    ).toBeInTheDocument();
  });

  it('Share IS the manage-access dialog, opened on this group\'s directory', async () => {
    renderGroup('GTM');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: 'Share' }));
    // One dialog for every access path — no intermediate read-only panel.
    // The entry is the group DIRECTORY under the KB dir, so the rules land on
    // the folder, never on one file inside it.
    expect(
      await screen.findByRole('dialog', {
        name: 'Manage access directory knowledge-base/Groups/GTM',
      }),
    ).toBeInTheDocument();
  });

  it('an UNDISCOVERABLE group renders exactly like one that does not exist', async () => {
    // Fail-closed: the endpoint omits groups with no verdict at all, so the
    // page cannot tell "hidden from you" apart from "absent" — the point.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([]);
    renderGroup('Finance');
    expect(await screen.findByText("This group doesn't exist yet.")).toBeInTheDocument();
  });

  it('a DISCOVERABLE group the caller cannot read shows the locked view', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([
      gtm({ name: 'Finance', folders: ['Groups/Finance'], canRead: false }),
    ]);
    renderGroup('Finance');
    expect(
      await screen.findByRole('button', { name: 'Subscribe to its skills and tools' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Skills' })).not.toBeInTheDocument();
    // A locked group offers no way in at all — not an add door, not a propose one.
    expect(screen.queryByRole('button', { name: /Add a skill or tool/ })).not.toBeInTheDocument();
  });

  it('a locked-out admin (canWrite via admin-rescue) gets the locked view with Manage access', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([
      gtm({ name: 'Finance', folders: ['Groups/Finance'], canRead: false, canWrite: true }),
    ]);
    renderGroup('Finance');
    expect(await screen.findByRole('button', { name: 'Manage access' })).toBeInTheDocument();
  });

  it('keeps the member view when an item-level grant beats the folder verdict', async () => {
    // Closeness-first resolution hands this caller one skill inside a folder
    // they cannot read; the group itself is absent from the (fail-closed)
    // summaries. The platform already returned the item; the page shows it.
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'budget', description: '', path: 'Groups/Finance/budget' }],
      tools: [],
    });
    groupsMock.listGroups.mockResolvedValue([]);
    renderGroup('Finance');
    expect(await screen.findByTestId('library-card-skill-budget')).toBeInTheDocument();
  });

  it('says so when the group does not exist', async () => {
    renderGroup('Nope');
    expect(await screen.findByText("This group doesn't exist yet.")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All groups' })).toHaveAttribute(
      'href',
      '/skills-and-tools',
    );
  });

  it('degrades to the catalog when the groups endpoint fails', async () => {
    groupsMock.listGroups.mockRejectedValue(new Error("Couldn't load groups."));
    renderGroup('GTM');
    expect(await screen.findByTestId('library-card-skill-outreach')).toBeInTheDocument();
    // No verified principals, so no claim about them. The add door still opens
    // — it writes nothing, so there is no permission to be wrong about.
    expect(screen.queryByText(/^Run by/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a skill or tool to GTM' })).toBeInTheDocument();
  });

  it('does not claim a missing group is gone while the endpoint is still failing', async () => {
    groupsMock.listGroups.mockRejectedValue(new Error("Couldn't load groups."));
    renderGroup('Finance');
    await waitFor(() =>
      expect(screen.queryByText('Loading the library…')).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("This group doesn't exist yet.")).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finance', level: 1 })).toBeInTheDocument();
  });

  it('decodes a URL-hostile group name', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'pricing', description: '', path: 'Groups/Sales & Ops/pricing' }],
      tools: [],
    });
    renderGroup('Sales & Ops');
    expect(
      await screen.findByRole('heading', { name: 'Sales & Ops', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-pricing')).toBeInTheDocument();
  });

  it('waits rather than guessing while the catalog is still loading', () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderGroup('GTM');
    expect(screen.getByText('Loading the library…')).toBeInTheDocument();
    expect(screen.queryByText("This group doesn't exist yet.")).not.toBeInTheDocument();
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
      renderGroup('GTM');
      await screen.findByRole('heading', { name: 'GTM', level: 1 });

      let land!: (groups: GroupSummary[]) => void;
      groupsMock.listGroups.mockReturnValueOnce(
        new Promise<GroupSummary[]>((resolve) => {
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
      renderGroup('GTM');
      await screen.findByRole('heading', { name: 'GTM', level: 1 });

      groupsMock.listGroups.mockRejectedValueOnce(new Error("Couldn't load groups."));
      fireEvent.click(refreshButton());

      await waitFor(() => expect(spinning()).toBe(false));
      expect(screen.queryByText('Last updated just now')).not.toBeInTheDocument();
    });
  });
});
