import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../workspace/state/workspace.context';
import { AuthContext, type AuthContextValue } from '../../auth/state/auth.context';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';

// Service mocks — the dialog's data loading goes through the module's api
// service (which wraps authFetch), so mocking here follows the same pattern
// as the other modules' tests.
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

// Keep the markdown pipeline (mermaid etc.) out of this test — the stub
// renders the raw source so assertions can see the body text.
vi.mock('../../workspace/components/renderers/KbMarkdownView', () => ({
  KbMarkdownView: ({ source }: { source: string }) => <div data-testid="md-view">{source}</div>,
}));

import { DetailDialog } from '../components/DetailDialog';

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

function wrap(children: ReactNode) {
  return (
    <MemoryRouter>
      <AuthContext.Provider value={auth}>
        <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

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

function renderDialog(owned: boolean) {
  return render(
    wrap(
      <DetailDialog
        target={{ kind: 'skill', skill: skillSummary, owned }}
        tools={[slackTool]}
        skills={[skillSummary]}
        allowedToolsBySkill={new Map([['newsletter', ['slack_post_message']]])}
        crs={[]}
        myCrNumbers={new Set()}
        inLoadout={false}
        onToggleLoadout={() => {}}
        onClose={() => {}}
        onDataChanged={() => {}}
      />,
    ),
  );
}

beforeEach(() => {
  apiMock.getSkill.mockReset().mockResolvedValue(skillDetail);
  apiMock.getSkillFile.mockReset().mockResolvedValue('watchlist:\n  - topic: AI');
  apiMock.readFileOnBranch.mockReset().mockResolvedValue('');
  apiMock.suggestChange.mockReset();
});

describe('DetailDialog (skill)', () => {
  it('loads the skill detail and shows description, needed integrations and files', async () => {
    renderDialog(false);

    expect(await screen.findByText('Drafts the Friday newsletter for review.')).toBeInTheDocument();
    expect(apiMock.getSkill).toHaveBeenCalledWith('newsletter');

    // Needed integration derived from allowed-tools, with its connection state.
    expect(screen.getByText('slack')).toBeInTheDocument();
    expect(screen.getByText('Needs your sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();

    // File browser: SKILL.md tagged MAIN + the bundled file.
    expect(screen.getAllByText('SKILL.md').length).toBeGreaterThan(0);
    expect(screen.getByText('MAIN')).toBeInTheDocument();
    expect(screen.getByText('sources.yaml')).toBeInTheDocument();

    // SKILL.md body renders through the markdown view.
    expect(screen.getByTestId('md-view').textContent).toContain('Collect the news');
  });

  it('loads a bundled file on click and renders it as code', async () => {
    renderDialog(false);
    await screen.findByText('sources.yaml');

    fireEvent.click(screen.getByText('sources.yaml'));
    await waitFor(() =>
      expect(apiMock.getSkillFile).toHaveBeenCalledWith('newsletter', 'sources.yaml'),
    );
    expect(await screen.findByText(/topic: AI/)).toBeInTheDocument();
  });

  it('shows owner-only Edit and Manage access when the caller owns the skill', async () => {
    renderDialog(true);
    await screen.findByText('Drafts the Friday newsletter for review.');

    expect(screen.getByRole('button', { name: 'Manage access' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByText('OWNER')).toBeInTheDocument();
  });

  it('hides Edit and Manage access for non-owners', async () => {
    renderDialog(false);
    await screen.findByText('Drafts the Friday newsletter for review.');

    expect(screen.queryByRole('button', { name: 'Manage access' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText('OWNER')).toBeNull();
  });
});

describe('DetailDialog (integration)', () => {
  it('shows per-connection status with a Connect action and the skills using it', async () => {
    render(
      wrap(
        <DetailDialog
          target={{ kind: 'integration', tool: slackTool }}
          tools={[slackTool]}
          skills={[skillSummary]}
          allowedToolsBySkill={new Map([['newsletter', ['slack_post_message']]])}
          crs={[]}
          myCrNumbers={new Set()}
          inLoadout={false}
          onToggleLoadout={() => {}}
          onClose={() => {}}
          onDataChanged={() => {}}
        />,
      ),
    );

    expect(screen.getByText('Slack sign-in')).toBeInTheDocument();
    expect(screen.getByText('Needs your sign-in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect/ })).toBeInTheDocument();
    // Used by: derived from the skills' allowed-tools.
    expect(screen.getByText('newsletter')).toBeInTheDocument();
  });
});
