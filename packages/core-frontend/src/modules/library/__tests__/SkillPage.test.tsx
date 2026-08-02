import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import type { LibraryContextValue } from '../state/library-data';

// The page's data loading goes through the module's api service (which wraps
// authFetch), so the mocks sit there — same pattern as the other modules.
const apiMock = vi.hoisted(() => ({
  getSkill: vi.fn(),
  getSkillFile: vi.fn(),
  readFileOnBranch: vi.fn(),
  suggestChange: vi.fn(),
}));
vi.mock('../services/library.api', () => ({
  DEFAULT_WORKSPACE_ID: 'target-company-state',
  getSkill: apiMock.getSkill,
  getSkillFile: apiMock.getSkillFile,
  readFileOnBranch: apiMock.readFileOnBranch,
  suggestChange: apiMock.suggestChange,
  listSkills: vi.fn(),
  listOpenChangeRequests: vi.fn(),
  listMyChangeRequests: vi.fn(),
  suggestionBranchFor: vi.fn(),
}));

// Keep the markdown pipeline (mermaid etc.) out of this test — the stub renders
// the raw source so assertions can see the body text.
vi.mock('../../workspace/components/renderers/KbMarkdownView', () => ({
  KbMarkdownView: ({ source }: { source: string }) => <div data-testid="md-view">{source}</div>,
}));

// The page reads the catalog through `useLibrary()`. Mocking the hook rather
// than mounting `LibraryProvider` keeps the provider's real fetch (and its N+1
// `getSkill`) out of a test about one page.
const libraryMock = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../state/library-data', () => ({
  useLibrary: () => libraryMock.value,
}));

import { SkillPage } from '../components/skill-page/SkillPage';

const workspace = {
  workspaceId: 'target-company-state',
  kbDirName: 'knowledge-base',
} as unknown as WorkspaceContextValue;

const auth = {
  user: { id: 'u1', email: 'razvan@bevel.software', name: 'Razvan' },
  token: 't',
  isLoading: false,
  login: async () => {},
  logout: () => {},
} as AuthContextValue;

const skillSummary = {
  name: 'newsletter',
  description: 'Drafts the Friday newsletter for review.',
  path: 'Skills/newsletter',
};

const skillDetail = {
  ...skillSummary,
  body: '# Newsletter drafter\nCollect the news and draft the letter.',
  allowedTools: ['slack_post_message'],
  files: ['Skills/newsletter/sources.yaml'],
};

const slackTool: ToolSecrets = {
  slug: 'slack',
  name: 'slack',
  path: 'Tools/slack.tool',
  type: 'http',
  setup: null,
  canWrite: false,
  variables: [
    {
      name: 'SIGNIN',
      scope: 'user',
      label: 'Slack sign-in',
      key: 'slack_SIGNIN',
      adminConfigured: true,
      userConfigured: false,
      oauth: true,
      authorized: false,
    },
  ],
};

function libraryValue(owned: boolean): LibraryContextValue {
  return {
    items: [
      {
        kind: 'skill',
        id: 'newsletter',
        name: 'newsletter',
        description: skillSummary.description,
        owned,
        group: null,
        path: skillSummary.path,
        status: { state: 'ok', text: '' },
      },
    ],
    skills: [skillSummary],
    tools: [slackTool],
    allowedToolsBySkill: new Map([['newsletter', ['slack_post_message']]]),
    ownedSkills: owned ? new Set(['newsletter']) : new Set<string>(),
    crs: [],
    myCrNumbers: new Set<number>(),
    loading: false,
    error: null,
    reload: () => {},
    groupSummaries: [],
    groupsLoading: false,
    groupsError: null,
    reloadGroups: () => {},
  } as unknown as LibraryContextValue;
}

function renderPage(owned: boolean) {
  libraryMock.value = libraryValue(owned);
  return render(
    <MemoryRouter initialEntries={['/skills-and-tools/skills/newsletter']}>
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>
          <Routes>
            <Route path="/skills-and-tools/skills/:name" element={<SkillPage />} />
          </Routes>
        </WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMock.getSkill.mockReset().mockResolvedValue(skillDetail);
  apiMock.getSkillFile.mockReset().mockResolvedValue('watchlist:\n  - topic: AI');
  apiMock.readFileOnBranch.mockReset().mockResolvedValue('');
  apiMock.suggestChange.mockReset();
});

describe('SkillPage', () => {
  it('loads the skill and shows its name, description, needed integrations and files', async () => {
    renderPage(false);

    expect(await screen.findByRole('heading', { name: 'newsletter' })).toBeInTheDocument();
    expect(screen.getByText('Drafts the Friday newsletter for review.')).toBeInTheDocument();
    expect(apiMock.getSkill).toHaveBeenCalledWith('newsletter');

    // Needed integration derived from allowed-tools, with its connection state.
    expect(screen.getByText('slack')).toBeInTheDocument();
    expect(screen.getByText('Needs your sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();

    // The files are TABS now, not a stacked list.
    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /sources\.yaml/ })).toBeInTheDocument();

    // SKILL.md body renders through the markdown view.
    expect(screen.getByTestId('md-view').textContent).toContain('Collect the news');
  });

  it('marks the open tab selected and loads a bundled file on click', async () => {
    renderPage(false);
    const tab = await screen.findByRole('tab', { name: /sources\.yaml/ });

    expect(screen.getByRole('tab', { name: /SKILL\.md/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    fireEvent.click(tab);
    await waitFor(() =>
      expect(apiMock.getSkillFile).toHaveBeenCalledWith('newsletter', 'sources.yaml'),
    );
    expect(await screen.findByText(/topic: AI/)).toBeInTheDocument();
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('shows owner-only Edit and the Owner badge — but never access', async () => {
    renderPage(true);
    await screen.findByRole('heading', { name: 'newsletter' });

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
    // A skill inherits its group folder's rules; the group's Share panel is the
    // one place they are decided, for owner and non-owner alike.
    expect(screen.queryByRole('button', { name: 'Manage access' })).toBeNull();
  });

  it('hides Edit and the badge for non-owners', async () => {
    renderPage(false);
    await screen.findByRole('heading', { name: 'newsletter' });

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('Owner')).toBeNull();
  });

  it('says so plainly when the skill cannot be loaded', async () => {
    apiMock.getSkill.mockRejectedValueOnce(new Error('nope'));
    renderPage(false);

    expect(
      await screen.findByText(/doesn't exist, or you don't have access to it/),
    ).toBeInTheDocument();
  });
});
