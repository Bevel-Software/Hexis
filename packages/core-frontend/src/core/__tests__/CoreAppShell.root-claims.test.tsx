import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { WorkspaceContextValue } from '../../modules/workspace';
import type { GitContextValue } from '../../modules/git';
import { makeWorkspaceFixture } from '../../modules/workspace/__tests__/testFixtures';
import { CoreAppShell } from '../CoreAppShell';
import { KnowledgeSurface } from '../KnowledgeSurface';
import { makeRegistry, useActiveAppId, type AppDef, type FileRendererDef } from '../registry';

/*
 * The whole shell, mounted at a URL, with the session and the server stubbed:
 * which app a `/workspace` URL opens in is decided by the shell's own route
 * element, so it is asserted through the shell.
 */
const session = vi.hoisted(() => ({ workspace: null as WorkspaceContextValue | null }));

vi.mock('../../modules/auth/hooks/useAuthState', () => ({
  useAuthState: () => ({
    user: { email: 'ada@example.com', name: 'Ada', role: 'Admin' },
    token: 't',
    isLoading: false,
    login: async () => {},
    logout: () => {},
  }),
}));
vi.mock('../../modules/setup/components/SetupGate', () => ({
  SetupGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('../../modules/workspace/hooks/useWorkspaceState', () => ({
  useWorkspaceState: () => session.workspace,
}));
vi.mock('../../modules/git/hooks/useGitState', () => ({
  useGitState: (): GitContextValue => ({
    status: { branch: 'main', hasUpstream: true, unmergedFromUpstream: false },
    branches: [],
    availability: 'ready',
    lastError: null,
    refreshStatus: async () => null,
    refreshBranches: async () => {},
    createBranch: async () => {},
    deleteBranch: async () => {},
    pull: async () => {},
    fetchForkBase: async () => null,
    fetchFileHistory: async () => [],
    fetchFileDiff: async () => '',
    fetchFileAtChange: async () => ({ baseline: null, current: null }),
    fetchFileComparison: async () => '',
  }),
}));
vi.mock('../../modules/git/hooks/useAutoPullUpdates', () => ({ useAutoPullUpdates: () => null }));
vi.mock('../../modules/workspace/routing/kb-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/workspace/routing/kb-routes')>()),
  fetchNodeId: async () => null,
  fetchNodeWorkspacePath: async () => null,
}));
// The chrome around the surfaces: the toolbar says which app is active, and
// the rest is out of the way.
vi.mock('../../modules/toolbar/components/Toolbar', () => ({
  Toolbar: () => <output aria-label="active app">{useActiveAppId()}</output>,
}));
vi.mock('../../modules/layout/components/MaintenanceOverlay', () => ({ MaintenanceOverlay: () => null }));
vi.mock('../../modules/layout/components/DemoBanner', () => ({ DemoBanner: () => null }));
vi.mock('../../modules/layout/components/ReadOnlyBanner', () => ({ ReadOnlyBanner: () => null }));
vi.mock('../../modules/admin/components/RolesCorruptedBanner', () => ({ RolesCorruptedBanner: () => null }));
vi.mock('../../modules/onboarding/components/GetStartedColumn', () => ({ GetStartedColumn: () => null }));
vi.mock('../../modules/onboarding/components/ConnectAgentPill', () => ({ ConnectAgentPill: () => null }));
vi.mock('../../modules/git/components/PullRequestsForMe', () => ({ PullRequestsForMe: () => null }));

const KB = 'knowledge-base';
const AGENT = `${KB}/Agents/coder.agent`;
const PAGE = `${KB}/KnowledgeBase/Home.md`;

const file = (relativePath: string): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'file',
});
const folder = (relativePath: string, children: FileTreeEntry[] = []): FileTreeEntry => ({
  name: relativePath.split('/').pop()!,
  relativePath,
  type: 'directory',
  children,
});
const TREE = folder('', [
  folder(KB, [
    folder(`${KB}/KnowledgeBase`, [file(PAGE)]),
    folder(`${KB}/Agents`, [file(AGENT)]),
    folder(`${KB}/Workflows`),
  ]),
]);

/** The workspace with one file open, as the tab system would hold it. */
function workspaceOn(path: string, content: string): WorkspaceContextValue {
  const tab = { path, content, savedContent: content, isDirty: false, pendingFileContent: null };
  return makeWorkspaceFixture({
    fileTree: TREE,
    openTabs: [tab],
    activeTab: tab,
    openFilePath: path,
    openFileContent: content,
    openFileSavedContent: content,
    hydrateTabs: async () => ({ surviving: [path], dropped: [], denied: [], superseded: false }),
  });
}

/** The `.agent` renderer a distribution registers by extension. */
const agentRenderer: FileRendererDef = {
  extensions: ['.agent'],
  Component: ({ content }) => <div data-testid="agent-renderer">{content}</div>,
};

/** A distribution's app hosting `Agents/` and `Workflows/` in a frame of its own. */
const agentsApp: AppDef = {
  id: 'agents',
  label: 'Agents',
  path: '/agents',
  roots: ['Agents', 'Workflows'],
  element: (
    <div data-testid="agents-frame">
      <KnowledgeSurface roots={['Agents', 'Workflows']} />
    </div>
  ),
};

function renderShellAt(url: string, apps: AppDef[]) {
  window.history.replaceState(null, '', url);
  return render(<CoreAppShell registry={makeRegistry({ apps, renderers: [agentRenderer] })} />);
}

const explorer = () => within(screen.getByTestId('file-explorer-root'));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('CoreAppShell: a root folder an app claims', () => {
  it('opens a file under the claimed root in the claiming app, with its renderer', async () => {
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, [agentsApp]);

    expect(await screen.findByTestId('agents-frame')).toBeInTheDocument();
    expect(screen.getByLabelText('active app')).toHaveTextContent('agents');
    expect(within(screen.getByTestId('agents-frame')).getByTestId('agent-renderer')).toHaveTextContent('role: coder');
    // The frame's tree is the narrowed one: its roots, and not Knowledge.
    expect(explorer().getByText('Agents')).toBeInTheDocument();
    expect(explorer().getByText('Workflows')).toBeInTheDocument();
    expect(explorer().queryByText('Knowledge')).not.toBeInTheDocument();
  });

  it('leaves the claimed roots out of the Knowledge app', async () => {
    session.workspace = workspaceOn(PAGE, '# Home');
    renderShellAt(`/workspace/main/${PAGE}`, [agentsApp]);

    await waitFor(() => expect(screen.getByLabelText('active app')).toHaveTextContent('knowledge'));
    expect(screen.queryByTestId('agents-frame')).not.toBeInTheDocument();
    expect(explorer().getByText('Knowledge')).toBeInTheDocument();
    expect(explorer().queryByText('Agents')).not.toBeInTheDocument();
    expect(explorer().queryByText('Workflows')).not.toBeInTheDocument();
  });

  /*
   * A link inside a page opens its destination in a new browser tab at the
   * destination's plain URL (see `useFileNav`'s `linkTarget`); that URL is
   * what lands in the claiming app.
   */
  it('lands a link from a Knowledge page to a hosted file in the claiming app', async () => {
    session.workspace = workspaceOn(PAGE, '[The coder](../Agents/coder.agent)');
    const opened: string[] = [];
    const open = vi.spyOn(window, 'open').mockImplementation((url) => {
      opened.push(String(url));
      return {} as Window;
    });
    try {
      renderShellAt(`/workspace/main/${PAGE}`, [agentsApp]);
      fireEvent.click(await screen.findByRole('link', { name: 'The coder' }));
    } finally {
      open.mockRestore();
    }
    expect(opened).toEqual([`/workspace/main/${AGENT}`]);

    cleanup();
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(opened[0]!, [agentsApp]);
    expect(await screen.findByTestId('agents-frame')).toBeInTheDocument();
    expect(screen.getByLabelText('active app')).toHaveTextContent('agents');
  });

  it('opens the same URL in Knowledge, with every root a section, when no app claims it', async () => {
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, []);

    await waitFor(() => expect(screen.getByLabelText('active app')).toHaveTextContent('knowledge'));
    expect(screen.getByTestId('agent-renderer')).toHaveTextContent('role: coder');
    for (const name of ['Knowledge', 'Agents', 'Workflows']) {
      expect(explorer().getByText(name), name).toBeInTheDocument();
    }
  });

  it('refuses two apps claiming one root, naming the root and both apps', () => {
    const rival: AppDef = { id: 'runs', label: 'Runs', path: '/runs', roots: ['Workflows'], element: <div /> };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderShellAt('/workspace', [agentsApp, rival])).toThrow(
        'The root folder "Workflows" is claimed by two apps: "agents" and "runs".',
      );
    } finally {
      error.mockRestore();
    }
  });

  /*
   * Knowledge and Skills & Tools are built on these: the library's URLs open
   * on the library whatever the registry says, so a claim on one could never
   * be honoured.
   */
  it.each(['KnowledgeBase', 'Skills', 'Plugins', 'skills'])('refuses an app claiming core’s own root %s', (root) => {
    const greedy: AppDef = { id: 'greedy', label: 'Greedy', path: '/greedy', roots: [root], element: <div /> };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderShellAt('/workspace', [greedy])).toThrow(
        `The root folder "${root}" is core's own; the app "greedy" cannot claim it.`,
      );
    } finally {
      error.mockRestore();
    }
  });

  /* Root names compare case-insensitively, as the layout's do. */
  it('refuses two apps claiming one root in different cases', () => {
    const rival: AppDef = { id: 'runs', label: 'Runs', path: '/runs', roots: ['workflows'], element: <div /> };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderShellAt('/workspace', [agentsApp, rival])).toThrow(
        'The root folder "workflows" is claimed by two apps: "agents" and "runs".',
      );
    } finally {
      error.mockRestore();
    }
  });

  /* A claim is one top-level folder NAME: a path would never match a file's root segment, so the app would host nothing and nobody would be told. */
  it.each(['Agents/foo', 'Agents\\foo', '', ' Agents', '..'])('refuses a claim that is not one folder name: %j', (root) => {
    const bad: AppDef = { id: 'runs', label: 'Runs', path: '/runs', roots: [root], element: <div /> };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => renderShellAt('/workspace', [bad])).toThrow(
        `The root folder "${root}" claimed by the app "runs" must be a single top-level folder name.`,
      );
    } finally {
      error.mockRestore();
    }
  });

  it('opens a file in the claiming app when the claim names its root in another case', async () => {
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, [{ ...agentsApp, roots: ['agents', 'workflows'] }]);

    expect(await screen.findByTestId('agents-frame')).toBeInTheDocument();
    expect(screen.getByLabelText('active app')).toHaveTextContent('agents');
  });

  it('opens a path outside the knowledge base in Knowledge, even under a claimed name', async () => {
    const outside = 'other-repo/Agents/coder.agent';
    session.workspace = workspaceOn(outside, 'role: coder');
    renderShellAt(`/workspace/main/${outside}`, [agentsApp]);

    await waitFor(() => expect(screen.getByLabelText('active app')).toHaveTextContent('knowledge'));
    expect(screen.queryByTestId('agents-frame')).not.toBeInTheDocument();
  });
});
