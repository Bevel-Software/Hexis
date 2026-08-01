import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

const groupsMock = vi.hoisted(() => ({ listGroups: vi.fn() }));
vi.mock('../services/groups.api', () => ({ listGroups: groupsMock.listGroups }));

const toolPageMock = vi.hoisted(() => ({ useToolPage: vi.fn() }));
vi.mock('../hooks/useToolPage', () => ({ useToolPage: toolPageMock.useToolPage }));

import { LibraryRoutes } from '../routes/LibraryRoutes';

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
    skillCount: 1,
    toolCount: 1,
    owners: { roles: [], users: [{ name: 'Olga Ivanova', email: 'olga@bevel.software' }] },
    writers: { roles: ['Admin'], users: [] },
    readers: { restricted: true, roles: ['GTM Team'], users: [] },
    hasRequested: false,
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
 * `isAdmin` and `kbDirName` from them.
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
      <WorkspaceContext.Provider value={workspaceValue}>{children}</WorkspaceContext.Provider>
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
  });

  it('renders the gallery at /skills-and-tools with heading Library', async () => {
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Everything/ })).toHaveAttribute('aria-current', 'true');
  });

  it('/skills-and-tools/owned selects Owned by me', async () => {
    renderAt('/skills-and-tools/owned');
    expect(await screen.findByRole('heading', { name: 'Owned by me' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Owned by me/ })).toHaveAttribute('aria-current', 'true');
  });

  it('/skills-and-tools/yours selects Yours alone', async () => {
    renderAt('/skills-and-tools/yours');
    expect(await screen.findByRole('heading', { name: 'Yours alone' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Yours alone/ })).toHaveAttribute('aria-current', 'true');
  });

  it('a sidebar group click navigates to /skills-and-tools/groups/<name>', async () => {
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /^GTM/ }));
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/groups/GTM'));
    // The group page itself lands in a later work package; the ROUTE resolves
    // now, which is why the sidebar can already point at it.
    expect(screen.getByRole('button', { name: /^GTM/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.queryByRole('heading', { name: 'Library' })).not.toBeInTheDocument();
  });

  it('/skills-and-tools/groups renders the all-groups index', async () => {
    renderAt('/skills-and-tools/groups');
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

  it('the propose seam reads its group out of the query', async () => {
    renderAt('/skills-and-tools/propose?group=GTM');
    expect(
      await screen.findByRole('heading', { name: 'Propose a skill or tool for GTM', level: 1 }),
    ).toBeInTheDocument();
  });

  it('the All groups row navigates to the index and stays current there', async () => {
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /^All groups/ }));
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/groups'));
    expect(screen.getByRole('button', { name: /^All groups/ })).toHaveAttribute('aria-current', 'true');
  });

  it('keeps All groups current on the propose page', async () => {
    renderAt('/skills-and-tools/propose?group=GTM');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^All groups/ })).toHaveAttribute('aria-current', 'true'),
    );
    expect(pathname()).toBe('/skills-and-tools/propose');
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
    expect(screen.getByRole('button', { name: /^Everything/ })).toHaveAttribute(
      'aria-current',
      'false',
    );
  });

  it('an integration card opens the tool page instead of the dialog', async () => {
    renderAt('/skills-and-tools');
    fireEvent.click(await screen.findByRole('button', { name: /^heyreach/ }));

    await waitFor(() => expect(pathname()).toBe('/skills-and-tools/tools/heyreach'));
    expect(await screen.findByRole('heading', { name: 'heyreach', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('an unknown subpath redirects to the gallery', async () => {
    renderAt('/skills-and-tools/nope');
    await waitFor(() => expect(pathname()).toBe('/skills-and-tools'));
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
  });

  it('renders the gallery even when the groups endpoint fails', async () => {
    groupsMock.listGroups.mockRejectedValue(new Error("Couldn't load groups."));
    renderAt('/skills-and-tools');
    expect(await screen.findByRole('heading', { name: 'Library' })).toBeInTheDocument();
    // Sidebar groups are catalog-derived, so they survive the endpoint being down.
    expect(screen.getByRole('button', { name: /^GTM/ })).toBeInTheDocument();
  });
});
