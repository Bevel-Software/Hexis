import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { GroupSummary } from '../services/groups.api';

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
  listGroupAccessRequests: vi.fn(),
  dismissGroupAccessRequest: vi.fn(),
  requestGroupAccess: vi.fn(),
}));
vi.mock('../services/groups.api', () => ({
  listGroups: groupsMock.listGroups,
  listGroupAccessRequests: groupsMock.listGroupAccessRequests,
  dismissGroupAccessRequest: groupsMock.dismissGroupAccessRequest,
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
            <Routes>
              <Route path="/skills-and-tools/groups/:group" element={<GroupPage />} />
              <Route path="*" element={<div />} />
            </Routes>
            <LocationProbe />
            {children}
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
    groupsMock.listGroupAccessRequests.mockResolvedValue([]);
    groupsMock.requestGroupAccess.mockResolvedValue(undefined);
    groupsMock.dismissGroupAccessRequest.mockResolvedValue(undefined);
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

  it('offers a writer the Add dialog, with the group in its title', async () => {
    groupsMock.listGroups.mockResolvedValue([gtm({ canWrite: true })]);
    renderGroup('GTM');
    fireEvent.click(await screen.findByRole('button', { name: 'Add skills or tools' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a skill or tool to GTM' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Propose a skill or tool' })).not.toBeInTheDocument();
  });

  it('sends everyone else to the propose seam with the group in the query', async () => {
    renderGroup('GTM');
    fireEvent.click(await screen.findByRole('button', { name: 'Propose a skill or tool' }));
    await waitFor(() => expect(href()).toBe('/skills-and-tools/propose?group=GTM'));
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

  it('a group the caller cannot access renders exactly like one that does not exist', async () => {
    // Fail-closed: the endpoint omits inaccessible groups, so the page cannot
    // tell "hidden from you" apart from "absent" — which is the point.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([]);
    renderGroup('Finance');
    expect(await screen.findByText("This group doesn't exist yet.")).toBeInTheDocument();
  });

  it('a locked-out admin (canWrite via admin-rescue) still gets the page and Share', async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, skills: [], tools: [] });
    groupsMock.listGroups.mockResolvedValue([
      gtm({ name: 'Finance', folders: ['Groups/Finance'], canRead: false, canWrite: true }),
    ]);
    renderGroup('Finance');
    expect(await screen.findByRole('button', { name: 'Share' })).toBeInTheDocument();
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
      '/skills-and-tools/groups',
    );
  });

  it('degrades to the catalog when the groups endpoint fails', async () => {
    groupsMock.listGroups.mockRejectedValue(new Error("Couldn't load groups."));
    renderGroup('GTM');
    expect(await screen.findByTestId('library-card-skill-outreach')).toBeInTheDocument();
    // No verified principals, so no claim about them — and never the write action.
    expect(screen.queryByText(/^Run by/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Propose a skill or tool' })).toBeInTheDocument();
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
});
