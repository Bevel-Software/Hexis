import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { AppClaimContext } from '../../../core/registry';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import type { LibraryData } from '../hooks/useLibraryData';

/**
 * The gate's contract is DISPATCH: which URL renders which surface. The pages
 * themselves are mocked to markers — their behaviour lives in their own test
 * files — and the catalog is mocked at the same one seam the routing tests
 * use.
 */

const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));

vi.mock('../services/groups.api', () => ({
  listGroups: vi.fn().mockResolvedValue([]),
}));

vi.mock('../components/LibraryLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { LibraryLayout: () => <Outlet /> };
});
vi.mock('../components/skill-page/SkillPage', () => ({
  SkillPage: ({ name, activeFile }: { name?: string; activeFile?: string }) => (
    <div aria-label="skill-page">{`${name}::${activeFile}`}</div>
  ),
}));
vi.mock('../components/tool-page/ToolPage', () => ({
  ToolPage: ({ slug }: { slug?: string }) => <div aria-label="tool-page">{slug}</div>,
}));

import { WorkspaceItemGate } from '../routes/WorkspaceItemGate';

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

function renderAt(url: string, opts: { state?: unknown; claim?: (id: string | null) => void } = {}) {
  const workspaceValue = {
    workspaceId: 'ws',
    kbDirName: KB,
  } as unknown as WorkspaceContextValue;
  return render(
    <MemoryRouter initialEntries={[{ pathname: url, state: opts.state }]}>
      <AppClaimContext.Provider value={opts.claim ?? (() => {})}>
        <WorkspaceContext.Provider value={workspaceValue}>
          <WorkspaceItemGate knowledge={<div aria-label="knowledge-surface" />} />
        </WorkspaceContext.Provider>
      </AppClaimContext.Provider>
    </MemoryRouter>,
  );
}

const itemUrl = (repoRel: string, branch = DEFAULT_BRANCH) =>
  `/workspace/${branch}/${KB}/${repoRel.split('/').map(encodeURIComponent).join('/')}`;

beforeEach(() => {
  dataMock.useLibraryData.mockReturnValue(CATALOG);
});

describe('WorkspaceItemGate', () => {
  it("a skill file's workspace URL renders the skill page on that file's tab", async () => {
    renderAt(itemUrl('Groups/Sales/create-sales-deck/reference/LESSONS.md'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::reference/LESSONS.md',
    );
  });

  it('a bare skill-folder URL opens SKILL.md', async () => {
    renderAt(itemUrl('Groups/Sales/create-sales-deck'));
    expect(await screen.findByLabelText('skill-page')).toHaveTextContent(
      'create-sales-deck::SKILL.md',
    );
  });

  it("a `.tool` manual's workspace URL renders the tool page", async () => {
    renderAt(itemUrl('Groups/Support/notion.tool'));
    expect(await screen.findByLabelText('tool-page')).toHaveTextContent('notion');
  });

  it("a Groups path that is no catalog item falls through to the knowledge surface", async () => {
    renderAt(itemUrl('Groups/Sales/access.md'));
    expect(await screen.findByLabelText('knowledge-surface')).toBeInTheDocument();
  });

  it('a knowledge document never touches the gate', () => {
    renderAt(itemUrl('KnowledgeBase/Handbook/Tone of voice.md'));
    expect(screen.getByLabelText('knowledge-surface')).toBeInTheDocument();
  });

  it('a non-default branch shows the raw file view — drafts are reviewed raw', () => {
    renderAt(itemUrl('Groups/Sales/create-sales-deck/SKILL.md', 'razvan/some-draft'));
    expect(screen.getByLabelText('knowledge-surface')).toBeInTheDocument();
  });

  it('router state `rawFile` steps past the gate to the raw view', () => {
    renderAt(itemUrl('Groups/Support/notion.tool'), { state: { rawFile: true } });
    expect(screen.getByLabelText('knowledge-surface')).toBeInTheDocument();
  });

  it('claims the Skills & Tools app while an item page is on screen, and releases it', async () => {
    const claims: (string | null)[] = [];
    const { unmount } = renderAt(itemUrl('Groups/Support/notion.tool'), {
      claim: (id) => claims.push(id),
    });
    await waitFor(() => expect(claims).toContain('skills-tools'));
    unmount();
    expect(claims[claims.length - 1]).toBeNull();
  });

  it('holds blank (not the wrong surface) while the catalog loads a candidate path', () => {
    dataMock.useLibraryData.mockReturnValue({ ...CATALOG, loading: true, skills: [], tools: [] });
    renderAt(itemUrl('Groups/Sales/create-sales-deck/SKILL.md'));
    expect(screen.queryByLabelText('knowledge-surface')).toBeNull();
    expect(screen.queryByLabelText('skill-page')).toBeNull();
  });
});
