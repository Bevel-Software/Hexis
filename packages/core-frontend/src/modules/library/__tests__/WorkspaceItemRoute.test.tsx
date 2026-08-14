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
    { name: 'create-sales-deck', description: '', path: 'Plugins/Sales/create-sales-deck' },
  ],
  pendingSkills: [],
  tools: [
    {
      slug: 'notion',
      name: 'notion',
      path: 'Plugins/Support/notion.tool',
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
    renderAt(itemUrl('Plugins/Sales/create-sales-deck/reference/LESSONS.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::reference/LESSONS.md',
    );
    // The ONE library sidebar is on screen with it — same surface, not a copy.
    expect(screen.getByRole('button', { name: /^All groups/ })).toBeInTheDocument();
  });

  it('a bare skill-folder URL opens SKILL.md', async () => {
    renderAt(itemUrl('Plugins/Sales/create-sales-deck'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::SKILL.md',
    );
  });

  it("a `.tool` manual's URL renders the tool page", async () => {
    renderAt(itemUrl('Plugins/Support/notion.tool'));
    expect(await screen.findByLabelText('tool-page')).toHaveTextContent('notion');
  });

  it('resolves a skill from the URL alone — a just-created skill needs no catalog', async () => {
    // The regression this exists for: right after "create empty skill" the
    // catalog reload hasn't landed. Resolution is structural (the folder name
    // IS the skill id), so the page opens instantly anyway.
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderAt(itemUrl('Plugins/Sales/brand-new-skill/SKILL.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'brand-new-skill::SKILL.md',
    );
    // …inside the library surface, never the Knowledge view.
    expect(screen.getByRole('button', { name: /^All groups/ })).toBeInTheDocument();
  });

  it("a `.tool` URL falls back to the filename slug when the catalog hasn't loaded", async () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderAt(itemUrl('Plugins/Support/notion.tool'));
    expect(await screen.findByLabelText('tool-page')).toHaveTextContent('notion');
  });

  it("a Groups path that is no item lands on its group's page", async () => {
    renderAt(itemUrl('Plugins/Sales/access.md'));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent('/skills-and-tools/groups/Sales'),
    );
  });

  /**
   * A group may carry CATEGORY folders: `skills.service` walks until it finds
   * a `SKILL.md` and treats that folder as the skill, so `Plugins/Engineering/
   * coding/create-ticket/SKILL.md` is a skill named `create-ticket`.
   *
   * Reading the first segment below the group asked for the category —
   * "coding", which no skill answers to — so every nested skill listed
   * perfectly and then reported "doesn't exist, or you don't have access to
   * it" on click. Every fixture here used to be flat, which is exactly why
   * that shipped.
   */
  describe('a skill nested under a category folder', () => {
    const NESTED: LibraryData = {
      ...CATALOG,
      skills: [
        { name: 'create-ticket', description: '', path: 'Plugins/Engineering/coding/create-ticket' },
        {
          name: 'architecture-review',
          description: '',
          path: 'Plugins/Engineering/review/architecture-review',
        },
      ],
    };

    beforeEach(() => {
      dataMock.useLibraryData.mockReturnValue(NESTED);
    });

    it('resolves its SKILL.md to the folder holding it, not the category', async () => {
      renderAt(itemUrl('Plugins/Engineering/coding/create-ticket/SKILL.md'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'create-ticket::SKILL.md',
      );
    });

    it('resolves a bundled file below a category folder', async () => {
      renderAt(itemUrl('Plugins/Engineering/review/architecture-review/check-vocab.mjs'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'architecture-review::check-vocab.mjs',
      );
    });

    it('resolves a bare nested skill folder to SKILL.md', async () => {
      renderAt(itemUrl('Plugins/Engineering/coding/create-ticket'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'create-ticket::SKILL.md',
      );
    });

    it('resolves a nested SKILL.md with no catalog at all', async () => {
      // The SKILL.md rule reads the URL alone, so the just-created case above
      // keeps working at depth: the folder holding SKILL.md IS the skill.
      dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
      renderAt(itemUrl('Plugins/Engineering/coding/brand-new-skill/SKILL.md'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'brand-new-skill::SKILL.md',
      );
    });

    it('resolves a `.tool` filed under a category folder, by its catalog slug', async () => {
      // `walkFiles` finds manuals at ANY depth, so this is a real listed tool;
      // matching only the group's top level listed it and 404'd the click. The
      // slug is the manual's declared `id`, which need not match the filename —
      // so a fixture whose slug equals its filename would prove nothing.
      dataMock.useLibraryData.mockReturnValue({
        ...NESTED,
        tools: [
          {
            slug: 'internal_deploy',
            name: 'internal_deploy',
            path: 'Plugins/Engineering/coding/deploy.tool',
            type: 'mcp' as const,
            setup: null,
            canWrite: false,
            variables: [],
          },
        ],
      });
      renderAt(itemUrl('Plugins/Engineering/coding/deploy.tool'));
      expect(await screen.findByLabelText('tool-page')).toHaveTextContent('internal_deploy');
    });

    it("sends a category folder's own access.md to the group page", async () => {
      // The same answer a stray file at the group's top level gets. Before, it
      // fell through to a SkillPage named after the category.
      renderAt(itemUrl('Plugins/Engineering/coding/access.md'));
      await waitFor(() =>
        expect(screen.getByLabelText('pathname')).toHaveTextContent(
          '/skills-and-tools/groups/Engineering',
        ),
      );
    });

    it('waits for the catalog rather than guessing a category is the skill', async () => {
      // A bare nested folder is ambiguous without the catalog. Guessing sent
      // SkillPage after a skill named "coding" and flashed a not-found error;
      // the catalog is what settles it, so hold the slot until it lands.
      dataMock.useLibraryData.mockReturnValue({ ...NESTED, loading: true, skills: [], tools: [] });
      renderAt(itemUrl('Plugins/Engineering/coding/create-ticket'));
      expect(await screen.findByRole('button', { name: /^All groups/ })).toBeInTheDocument();
      expect(screen.queryByLabelText('skill-page')).toBeNull();
    });

    it('sends a bare CATEGORY folder to its group, not to a skill page', async () => {
      // A category is not a skill, and `coding` names none. What tells it apart
      // from a just-created skill the catalog hasn't caught up with is that the
      // catalog knows skills UNDER it.
      renderAt(itemUrl('Plugins/Engineering/coding'));
      await waitFor(() =>
        expect(screen.getByLabelText('pathname')).toHaveTextContent(
          '/skills-and-tools/groups/Engineering',
        ),
      );
      expect(screen.queryByLabelText('skill-page')).toBeNull();
    });

    it('still opens a folder the catalog has no skills under — a stale new skill', async () => {
      renderAt(itemUrl('Plugins/Engineering/coding/brand-new-skill'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'brand-new-skill::SKILL.md',
      );
    });

    it('opens a bundled file of a skill the catalog has not caught up with', async () => {
      // STALE, not failed: the catalog loaded fine, it just predates the skill.
      // Concluding "nothing owns this file, so it is not a page" bounced the
      // reader to the group — the very symptom this change exists to remove,
      // reached through a different unsettled state. Absence proves nothing;
      // only positive evidence (a known category above it) redirects.
      renderAt(itemUrl('Plugins/Engineering/coding/brand-new-skill/notes.md'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'brand-new-skill::notes.md',
      );
    });

    it('still routes a known category by its CACHED skills after a failed refresh', async () => {
      // `useLibraryData` keeps the previous entries when a refresh fails, and
      // what the catalog KNOWS stays true — a category is still a category.
      dataMock.useLibraryData.mockReturnValue({
        ...NESTED,
        error: "Couldn't refresh the catalog.",
      });
      renderAt(itemUrl('Plugins/Engineering/coding'));
      await waitFor(() =>
        expect(screen.getByLabelText('pathname')).toHaveTextContent(
          '/skills-and-tools/groups/Engineering',
        ),
      );
    });

    it('does not let a prefix-sharing sibling claim a bundled file', async () => {
      // Ownership compares whole segments: `create-ticket-v2` shares a string
      // prefix with `create-ticket` and must not swallow its files.
      dataMock.useLibraryData.mockReturnValue({
        ...NESTED,
        skills: [
          ...NESTED.skills,
          {
            name: 'create-ticket-v2',
            description: '',
            path: 'Plugins/Engineering/coding/create-ticket-v2',
          },
        ],
      });
      renderAt(itemUrl('Plugins/Engineering/coding/create-ticket-v2/notes.md'));
      expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
        'create-ticket-v2::notes.md',
      );
    });
  });

  /**
   * A skill's id is its frontmatter `id`/`name`, and only FALLS BACK to the
   * folder name — so the URL cannot be trusted to spell it. The catalog can.
   */
  it('resolves a skill whose declared id differs from its folder name', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      skills: [{ name: 'deck-builder', description: '', path: 'Plugins/Sales/create-sales-deck' }],
    });
    renderAt(itemUrl('Plugins/Sales/create-sales-deck/SKILL.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent('deck-builder::SKILL.md');
  });

  it("keeps a SKILL.md bundled INSIDE a skill as that skill's file", async () => {
    // `skills.service` stops at the first `SKILL.md` and treats that folder as
    // the skill, so a nested one is a bundled asset — never a skill called
    // `examples`.
    renderAt(itemUrl('Plugins/Sales/create-sales-deck/examples/SKILL.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::examples/SKILL.md',
    );
  });

  /**
   * A failed catalog is "we couldn't ask", not "no such item" — the same
   * distinction GroupPage draws. Reading it as proof that nothing owns the
   * file would bounce every bundled-file deep link to the group page during a
   * transient outage, losing the URL; the skill detail comes from a different
   * endpoint and can still answer.
   */
  it('keeps a bundled-file deep link on the skill page when the catalog failed', async () => {
    dataMock.useLibraryData.mockReturnValue({
      ...CATALOG,
      loading: false,
      error: "Couldn't load the catalog.",
      skills: [],
      tools: [],
    });
    // The file's own folder is the best available reading without a catalog
    // (an asset nested deeper simply cannot be attributed) — the point is that
    // the reader stays on a skill page instead of being bounced to the group.
    renderAt(itemUrl('Plugins/Sales/create-sales-deck/notes.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::notes.md',
    );
  });

  it('a non-default branch never renders an item page', async () => {
    renderAt(itemUrl('Plugins/Sales/create-sales-deck/SKILL.md', 'razvan/some-draft'));
    await waitFor(() =>
      expect(screen.getByLabelText('pathname')).toHaveTextContent(/^\/skills-and-tools$/),
    );
  });
});

describe('isLibraryLocation — the surface rule', () => {
  it.each([
    ['/skills-and-tools', true],
    ['/skills-and-tools/groups/Sales', true],
    [itemUrl('Plugins/Sales/create-sales-deck/SKILL.md'), true],
    [itemUrl('Plugins/Support/notion.tool'), true],
    // KnowledgeBase paths are the Knowledge app's, whatever the file.
    [`/workspace/${DEFAULT_BRANCH}/${KB}/KnowledgeBase/Handbook/Tone of voice.md`, false],
    // Drafts review raw, in Knowledge — the library speaks the default branch.
    [itemUrl('Plugins/Sales/create-sales-deck/SKILL.md', 'razvan/draft'), false],
    // Too shallow to name an item (`Plugins/` itself, a group folder alone).
    [`/workspace/${DEFAULT_BRANCH}/${KB}/Groups`, false],
    [`/workspace/${DEFAULT_BRANCH}/${KB}/Plugins/Sales`, false],
    ['/workspace', false],
    ['/secrets', false],
  ])('%s → %s', (pathname, expected) => {
    expect(isLibraryLocation(pathname)).toBe(expected);
  });
});
