import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AdminContext } from '../../admin/state/admin.context';
import type { LibraryData } from '../hooks/useLibraryData';

/**
 * The canonical /workspace item URLs, rendered INSIDE the library surface:
 * dispatch is by URL shape (`isLibraryLocation` — the shell's rule), page
 * resolution by catalog, and the catalog answering "not yet" holds the slot
 * instead of surrendering the surface. The item pages themselves are mocked
 * to markers; their behaviour lives in their own test files.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

vi.mock('../services/groups.api', () => ({
  listGroups: vi.fn().mockResolvedValue([]),
  listJoinRequests: vi.fn().mockResolvedValue([]),
}));

vi.mock('../components/skill-page/SkillPage', () => ({
  SkillPage: ({ name, activeFile }: { name?: string; activeFile?: string }) => (
    <div aria-label="skill-page">{`${name}::${activeFile}`}</div>
  ),
}));
vi.mock('../components/tool-page/ToolPage', () => ({
  ToolPage: ({ slug }: { slug?: string }) => <div aria-label="tool-page">{slug}</div>,
}));

import { LibraryRoutes } from '../routes/LibraryRoutes';
import { isLibraryLocation } from '../routes/library-paths';
import { withAuth } from './auth-harness';

const CATALOG: LibraryData = {
  loading: false,
  error: null,
  skills: [
    { name: 'create-sales-deck', description: '', path: 'Groups/Sales/create-sales-deck' },
  ],
  pendingSkills: [],
  tools: [
    {
      slug: 'notion',
      name: 'notion',
      path: 'Groups/Support/notion.tool',
      type: 'mcp',
      setup: null,
      canWrite: false,
      variables: [],
    },
  ],
  ownedSkills: new Set<string>(),
  allowedToolsBySkill: new Map(),
  crs: [],
  myCrNumbers: new Set<number>(),
  reload: vi.fn(),
};

const KB = 'knowledge-base';

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
    workspaceId: 'ws',
    kbDirName: KB,
  } as unknown as WorkspaceContextValue;
  return (
    <AdminContext.Provider value={adminValue}>
      <WorkspaceContext.Provider value={workspaceValue}>
        {withAuth(children)}
      </WorkspaceContext.Provider>
    </AdminContext.Provider>
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div aria-label="pathname">{location.pathname}</div>;
}

function renderAt(url: string) {
  // The same two mounts the shell's CoreSurfaces gives this surface.
  return render(
    <MemoryRouter initialEntries={[url]}>
      {wrap(
        <Routes>
          <Route path="/skills-and-tools/*" element={<LibraryRoutes />} />
          <Route path="/workspace/*" element={<LibraryRoutes />} />
        </Routes>,
      )}
      <LocationProbe />
    </MemoryRouter>,
  );
}

const itemUrl = (repoRel: string, branch = DEFAULT_BRANCH) =>
  `/workspace/${encodeURIComponent(branch)}/${KB}/${repoRel
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

beforeEach(() => {
  dataMock.useLibraryData.mockReturnValue(CATALOG);
});

describe('WorkspaceItemRoute', () => {
  it("a skill file's URL renders the skill page on that file's tab, inside the library nav", async () => {
    renderAt(itemUrl('Groups/Sales/create-sales-deck/reference/LESSONS.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::reference/LESSONS.md',
    );
    // The ONE library sidebar is on screen with it — same surface, not a copy.
    expect(screen.getByRole('button', { name: /^All groups/ })).toBeInTheDocument();
  });

  it('a bare skill-folder URL opens SKILL.md', async () => {
    renderAt(itemUrl('Groups/Sales/create-sales-deck'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::SKILL.md',
    );
  });

  it("a `.tool` manual's URL renders the tool page", async () => {
    renderAt(itemUrl('Groups/Support/notion.tool'));
    expect(await screen.findByLabelText('tool-page')).toHaveTextContent('notion');
  });

  it('resolves a skill from the URL alone — a just-created skill needs no catalog', async () => {
    // The regression this exists for: right after "create empty skill" the
    // catalog reload hasn't landed. Resolution is structural (the folder name
    // IS the skill id), so the page opens instantly anyway.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderAt(itemUrl('Groups/Sales/brand-new-skill/SKILL.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'brand-new-skill::SKILL.md',
    );
    // …inside the library surface, never the Knowledge view.
    expect(screen.getByRole('button', { name: /^All groups/ })).toBeInTheDocument();
  });

  it("a `.tool` URL falls back to the filename slug when the catalog hasn't loaded", async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderAt(itemUrl('Groups/Support/notion.tool'));
    expect(await screen.findByLabelText('tool-page')).toHaveTextContent('notion');
  });

  it("a Groups path that is no item lands on its group's page", async () => {
    renderAt(itemUrl('Groups/Sales/access.md'));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent('/skills-and-tools/groups/Sales'),
    );
  });

  it('a non-default branch never renders an item page', async () => {
    renderAt(itemUrl('Groups/Sales/create-sales-deck/SKILL.md', 'razvan/some-draft'));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent(/^\/skills-and-tools$/),
    );
  });
});

describe('isLibraryLocation — the surface rule', () => {
  it.each([
    ['/skills-and-tools', true],
    ['/skills-and-tools/groups/Sales', true],
    [itemUrl('Groups/Sales/create-sales-deck/SKILL.md'), true],
    [itemUrl('Groups/Support/notion.tool'), true],
    // KnowledgeBase paths are the Knowledge app's, whatever the file.
    [`/workspace/${DEFAULT_BRANCH}/${KB}/KnowledgeBase/Handbook/Tone of voice.md`, false],
    // Drafts review raw, in Knowledge — the library speaks the default branch.
    [itemUrl('Groups/Sales/create-sales-deck/SKILL.md', 'razvan/draft'), false],
    // Too shallow to name an item (`Groups/` itself, a group folder alone).
    [`/workspace/${DEFAULT_BRANCH}/${KB}/Groups`, false],
    [`/workspace/${DEFAULT_BRANCH}/${KB}/Groups/Sales`, false],
    ['/workspace', false],
    ['/secrets', false],
  ])('%s → %s', (pathname, expected) => {
    expect(isLibraryLocation(pathname)).toBe(expected);
  });
});
