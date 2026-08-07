import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { GroupSummary } from '../services/groups.api';
import type { ToolPageState } from '../hooks/useToolPage';

/**
 * The routing skeleton: what each URL renders, what the sidebar marks as
 * current, and where a click lands. The catalog is mocked at the hook (one
 * seam) rather than at six endpoints — what's under test is the route table,
 * not the fetching. The tool page's own data hook is mocked for the same
 * reason; `ToolPage.test.tsx` is where its behaviour lives.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

const groupsMock = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listJoinRequests: vi.fn(),
}));
vi.mock('../services/groups.api', () => ({
  listGroups: groupsMock.listGroups,
  listJoinRequests: groupsMock.listJoinRequests,
  reconcileJoinRequest: vi.fn(),
  requestGroupAccess: vi.fn(),
  AlreadyReadableError: class AlreadyReadableError extends Error {},
}));

const toolPageMock = vi.hoisted(() => ({ useToolPage: vi.fn() }));
vi.mock('../hooks/useToolPage', () => ({ useToolPage: toolPageMock.useToolPage }));

// ManageAccessDialog (reachable from the group page's Share) fetches through
// this module. Nothing opens it in a routing test, but the stub keeps any
// accidental mount from waiting on a refused connection.
vi.mock('../../access/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../access/api')>();
  return {
    ...actual,
    fetchFileAccess: vi.fn().mockResolvedValue({
      canRead: true,
      canWrite: false,
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

const tool = (over: Partial<ToolSecrets>): ToolSecrets => ({
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
  skills: [
    { name: 'outreach', description: 'Runs the GTM outreach.', path: 'Groups/GTM/outreach' },
    { name: 'roadmap', description: 'Keeps the roadmap.', path: 'Groups/Product/roadmap' },
    { name: 'scratch', description: 'A skill in no group.', path: 'Skills/scratch' },
  ],
  pendingSkills: [],
  tools: [
    tool({}),
    // Ungrouped tool (`Tools/slack.tool` is two segments) — "Yours alone".
    tool({ slug: 'slack', name: 'slack', path: 'Tools/slack.tool' }),
  ],
  ownedSkills: new Set(['outreach']),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set(),
  reload: vi.fn(),
};

const GROUPS: GroupSummary[] = [
  {
    name: 'GTM',
    folders: ['Groups/GTM'],
    canRead: true,
    canWrite: true,
    isOwner: false,
    skillCount: 1,
    toolCount: 1,
    owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
    writers: { roles: ['Admin'], users: [] },
    readers: { restricted: true, roles: ['GTM Team'], users: [] },
    hasRequested: false,
    requestNumber: null,
  },
];

const TOOL_PAGE_STATE: ToolPageState = {
  loading: false,
  error: null,
  notFound: false,
  tool: tool({}),
  detail: null,
  skillsLoaded: true,
  poweredSkills: [],
  reload: vi.fn(),
};

/** Exposes the router's current pathname without a testid. */
function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

/**
 * The shell's providers, which the Library sits inside for real
 * (`CoreAppShell` mounts both above every app surface). The tool page reads
 * `isAdmin` and `kbDirName` from them; the locked-group and request surfaces
 * read `kbDirName` to address `access.md`.
 */
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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
        </Routes>,
      )}
      <LocationProbe />
    </MemoryRouter>,
  );
}

const pathname = () => screen.getByLabelText('pathname').textContent;

describe('LibraryRoutes', () => {
  beforeEach(() => {
    dataMock.useLibraryData.mockReturnValue(CATALOG);
    groupsMock.listGroups.mockResolvedValue(GROUPS);
    toolPageMock.useToolPage.mockReturnValue(TOOL_PAGE_STATE);
    groupsMock.listJoinRequests.mockResolvedValue([]);
  });

  it('opens on the all-groups index at /skills-and-tools', async () => {
    renderAt('/skills-and-tools');
    expect(
      await screen.findByRole('heading', { name: 'All groups', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^All groups/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // The lenses are lenses: landing home selects neither.
    expect(screen.getByRole('button', { name: /^Everything/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
  });

  it('/skills-and-tools/everything is the whole catalog as cards', async () => {
    renderAt('/skills-and-tools/everything');
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Everything/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
  });

  it('/skills-and-tools/owned selects Owned by me', async () => {
    renderAt('/skills-and-tools/owned');
    expect(await screen.findByRole('heading', { name: 'Owned by me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toHaveAttribute('aria-current', 'true');
  });

  it("/skills-and-tools/yours is the caller's own group, as a group page", async () => {
    renderAt('/skills-and-tools/yours');
    expect(
      await screen.findByRole('heading', { name: TEST_PERSONAL_GROUP, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(`^${TEST_PERSONAL_GROUP}`) })).toHaveAttribute(
      'aria-current',
      'true',
    );
    // The group-page furniture, not a filtered gallery: sections and a trail.
    expect(screen.getByRole('heading', { name: 'Skills', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tools', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('a group you are in appears in the nav even when it is EMPTY', async () => {
    // Membership is what puts a group in your MCP; content is not. Deriving
    // the member rows from catalog items alone made a freshly created group
    // vanish from the very list headed "Included in your MCP".
    groupsMock.listGroups.mockResolvedValue([
      ...GROUPS,
      {
        name: 'Fresh',
        folders: ['Groups/Fresh'],
        canRead: true,
        canWrite: true,
        skillCount: 0,
        toolCount: 0,
        owners: { roles: [], users: [] },
        writers: { roles: [], users: [] },
        readers: { restricted: true, roles: [], users: [] },
        hasRequested: false,
        requestNumber: null,
      },
    ]);
    renderAt('/skills-and-tools');
    const nav = await screen.findByRole('navigation', { name: 'Library groups' });
    // In the member half, with a zero count — never below the gap as locked.
    expect(await within(nav).findByRole('button', { name: /^Fresh/ })).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: 'Fresh (locked)' })).toBeNull();
  });

  it('a sidebar group click navigates to /skills-and-tools/groups/<name>', async () => {
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /^GTM/ }));
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/groups/GTM'));
    // The group page itself lands in a later work package; the ROUTE resolves
    // now, which is why the sidebar can already point at it.
    expect(screen.getByRole('button', { name: /^GTM/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('heading', { name: 'All groups', level: 1 })).not.toBeInTheDocument();
  });

  it('sends the old /groups index path home, where the index lives now', async () => {
    renderAt('/skills-and-tools/groups');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(
      await screen.findByRole('heading', { name: 'All groups', level: 1 }),
    ).toBeInTheDocument();
  });

  it("a group deep link renders that group's cards and no others", async () => {
    renderAt('/skills-and-tools/groups/GTM');
    expect(await screen.findByRole('heading', { name: 'GTM', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('library-card-skill-outreach')).toBeInTheDocument();
    expect(screen.getByTestId('library-card-integration-heyreach')).toBeInTheDocument();
    expect(screen.queryByTestId('library-card-skill-roadmap')).not.toBeInTheDocument();
  });

  // `/propose` was retired with the role fork it served. An unknown path under
  // the Library falls back to the root, which is what this now asserts.
  it('sends the retired propose path back home', async () => {
    renderAt('/skills-and-tools/propose?group=GTM');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
  });

  it("reaches the index from a group page breadcrumb, at the root it lives at", async () => {
    renderAt('/skills-and-tools/groups/GTM');
    fireEvent.click(await screen.findByRole('link', { name: 'All groups' }));
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(
      await screen.findByRole('heading', { name: 'All groups', level: 1 }),
    ).toBeInTheDocument();
  });

  it('leads the sidebar with All groups, from anywhere in the Library', async () => {
    renderAt('/skills-and-tools/groups/GTM');
    const allGroups = await screen.findByRole('button', { name: /^All groups/ });
    expect(allGroups).toHaveAttribute('aria-current', 'false');
    fireEvent.click(allGroups);
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(screen.getByRole('button', { name: /^All groups/ })).toHaveAttribute(
      'aria-current',
      'true',
    );
  });

  it('a group deep link with a URL-hostile name round-trips', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'pricing', description: '', path: 'Groups/Sales & Ops/pricing' }],
      tools: [],
    });
    renderAt(`/skills-and-tools/groups/${encodeURIComponent('Sales & Ops')}`);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Sales & Ops/ })).toHaveAttribute('aria-current', 'true'),
    );
  });

  it('/skills-and-tools/tools/:slug renders the tool page', async () => {
    renderAt('/skills-and-tools/tools/heyreach');
    expect(await screen.findByRole('heading', { name: 'heyreach', level: 1 })).toBeInTheDocument();
    expect(toolPageMock.useToolPage).toHaveBeenCalledWith('heyreach');
    // An item page is not a filtered view of the catalog — no gallery row is lit.
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
  });

  it('an integration card opens the tool page instead of the dialog', async () => {
    renderAt('/skills-and-tools/everything');
    fireEvent.click(await screen.findByRole('button', { name: /^heyreach/ }));

    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/tools/heyreach'));
    expect(await screen.findByRole('heading', { name: 'heyreach', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an unknown subpath redirects home', async () => {
    renderAt('/skills-and-tools/nope');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(
      await screen.findByRole('heading', { name: 'All groups', level: 1 }),
    ).toBeInTheDocument();
  });

  it('renders the gallery even when the groups endpoint fails', async () => {
    groupsMock.listGroups.mockRejectedValue(new Error("Couldn't load groups."));
    renderAt('/skills-and-tools/everything');
    expect(await screen.findByRole('heading', { name: 'Everything', level: 1 })).toBeInTheDocument();
    // Sidebar groups are catalog-derived, so they survive the endpoint being down.
    expect(screen.getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });
});
