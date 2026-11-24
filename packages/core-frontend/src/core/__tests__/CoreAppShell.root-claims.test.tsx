import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { WorkspaceContextValue } from '../../modules/workspace';
import type { GitContextValue } from '../../modules/git';
import { makeShellWorkspace } from './workspaceFixture';
import { toggleSidebar } from '../../modules/layout';
import { CoreAppShell } from '../CoreAppShell';
import { KnowledgeSurface } from '../KnowledgeSurface';
import { makeRegistry, useActiveAppId, type AppDef, type FileRendererDef, type PaneDef } from '../registry';

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
  return makeShellWorkspace({
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

/*
 * The same app with screens of its own beside its folders: its navigation
 * above them in the sidebar, and a page where the location is not a file.
 * One element each, as the surface asks.
 */
const SCREENS_NAV = (
  <nav aria-label="Agents">
    <a href="/agents/runs">Runs</a>
  </nav>
);
const SCREENS_PAGE = <h1>The workflows page</h1>;
function AgentsScreens() {
  const onFile = useLocation().pathname.startsWith('/workspace/');
  return <KnowledgeSurface roots={['Agents', 'Workflows']} nav={SCREENS_NAV} page={onFile ? undefined : SCREENS_PAGE} />;
}
const screensApp: AppDef = {
  ...agentsApp,
  element: (
    <div data-testid="agents-frame">
      <AgentsScreens />
    </div>
  ),
};
/** The app handing the surface what React renders as nothing, for `nav`, `page` or both. */
function appPassing(props: { nav?: ReactNode; page?: ReactNode }): AppDef {
  return {
    ...agentsApp,
    element: (
      <div data-testid="agents-frame">
        <KnowledgeSurface roots={['Agents', 'Workflows']} {...props} />
      </div>
    ),
  };
}
/** A pane a distribution registers beside the viewer, as the chat is. */
const chatPane: PaneDef = { id: 'chat', order: 30, node: <div data-testid="chat-pane" />, collapsible: true };

function renderShellAt(url: string, apps: AppDef[], panes: PaneDef[] = []) {
  window.history.replaceState(null, '', url);
  return render(<CoreAppShell registry={makeRegistry({ apps, renderers: [agentRenderer], panes })} />);
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

describe('CoreAppShell: a claiming app with screens of its own', () => {
  /** The app's navigation stands above its folders, in the one sidebar. */
  function expectNavAboveFolders() {
    const nav = explorer().getByRole('navigation', { name: 'Agents' });
    // The folders have a heading of their own under the app's rows.
    const heading = explorer().getByText('Files');
    const folders = explorer().getByText('Workflows');
    expect(nav.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(folders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The heading stands in place of the rule a tree without app rows draws
    // over its folders (the cases passing `null` and `false` below see it drawn).
    expect(explorer().queryByTestId('file-explorer-folders-rule')).not.toBeInTheDocument();
    // And no second heading over nothing: nothing is pinned.
    expect(explorer().queryByText('Company Context')).not.toBeInTheDocument();
  }

  /** The row of the file whose tab is open. */
  const agentRow = () => screen.getByTestId('file-explorer-root').querySelector(`[data-tree-path="${AGENT}"]`);

  it('shows its page beside the one sidebar, without the panes built around a file', async () => {
    // A tab is still open behind the page, as after a visit to a file.
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt('/agents', [screensApp], [chatPane]);

    expect(await screen.findByRole('heading', { name: 'The workflows page' })).toBeInTheDocument();
    expect(screen.getByLabelText('active app')).toHaveTextContent('agents');
    expectNavAboveFolders();
    expect(screen.queryByTestId('agent-renderer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-pane')).not.toBeInTheDocument();
    // The open tab's row is not the current place while a page is on screen.
    expect(agentRow()).toHaveAttribute('aria-current', 'false');
  });

  it('keeps that sidebar when a file is on screen, with the viewer and the panes back', async () => {
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, [screensApp], [chatPane]);

    expect(await screen.findByTestId('agent-renderer')).toHaveTextContent('role: coder');
    expect(screen.getByLabelText('active app')).toHaveTextContent('agents');
    expectNavAboveFolders();
    expect(screen.queryByRole('heading', { name: 'The workflows page' })).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-pane')).toBeInTheDocument();
    expect(agentRow()).toHaveAttribute('aria-current', 'true');
  });

  describe('with a folder pinned', () => {
    const PINS = 'bevel-pinned-folders';
    const WORKFLOWS = `${KB}/Workflows`;
    afterEach(() => window.localStorage.removeItem(PINS));

    it.each([
      ['its page', '/agents', 'The workflows page'],
      ['a hosted file', `/workspace/main/${AGENT}`, null],
    ])('draws "Company Context" over the pins, between its navigation and "Files", at %s', async (_, url, pageHeading) => {
      window.localStorage.setItem(PINS, JSON.stringify([WORKFLOWS]));
      session.workspace = workspaceOn(AGENT, 'role: coder');
      renderShellAt(url, [screensApp]);
      if (pageHeading) await screen.findByRole('heading', { name: pageHeading });
      else await screen.findByTestId('agent-renderer');

      const nav = explorer().getByRole('navigation', { name: 'Agents' });
      const pinsHeading = explorer().getByText('Company Context');
      const filesHeading = explorer().getByText('Files');
      // The pinned row, then the same folder again in the tree under "Files".
      const [pinned, inTree] = Array.from(
        screen.getByTestId('file-explorer-root').querySelectorAll(`[data-tree-path="${WORKFLOWS}"]`),
      );
      const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      expect(follows(nav, pinsHeading)).toBe(true);
      expect(follows(pinsHeading, pinned)).toBe(true);
      expect(follows(pinned, filesHeading)).toBe(true);
      expect(follows(filesHeading, inTree)).toBe(true);
    });
  });
});

/*
 * `null` and `false` are how React code says "nothing here" (`cond && <Nav />`,
 * `onFile ? null : <Page />`). Each means the prop was not given.
 */
describe('CoreAppShell: a claiming app passing nothing as nav or page', () => {
  const PINS = 'bevel-pinned-folders';
  afterEach(() => window.localStorage.removeItem(PINS));

  /** The explorer's markup, mounted at a hosted file with one folder pinned. */
  async function explorerMarkup(app: AppDef): Promise<string> {
    window.localStorage.setItem(PINS, JSON.stringify([`${KB}/Agents`]));
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, [app]);
    await screen.findByTestId('agent-renderer');
    const markup = screen.getByTestId('file-explorer-root').innerHTML;
    cleanup();
    return markup;
  }

  it.each([
    ['null', null],
    ['false', false],
  ])('renders the explorer exactly as without nav when nav is %s', async (_, nav) => {
    const without = await explorerMarkup(agentsApp);

    session.workspace = workspaceOn(AGENT, 'role: coder');
    window.localStorage.setItem(PINS, JSON.stringify([`${KB}/Agents`]));
    renderShellAt(`/workspace/main/${AGENT}`, [appPassing({ nav })]);
    await screen.findByTestId('agent-renderer');

    // The headings of a tree with no app rows above it: "Company Context"
    // over the pins, the rule over the folders, and no "Files" heading.
    expect(explorer().getByText('Company Context')).toBeInTheDocument();
    expect(explorer().getByTestId('file-explorer-folders-rule')).toBeInTheDocument();
    expect(explorer().queryByText('Files')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-explorer-root').innerHTML).toBe(without);
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('keeps "Company Context" with nothing pinned when nav is %s', async (_, nav) => {
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, [appPassing({ nav })]);
    await screen.findByTestId('agent-renderer');

    expect(explorer().getByText('Company Context')).toBeInTheDocument();
    expect(explorer().getByTestId('file-explorer-folders-rule')).toBeInTheDocument();
    expect(explorer().queryByText('Files')).not.toBeInTheDocument();
  });

  it.each([
    ['null', null],
    ['false', false],
  ])('shows the viewer and the panes, as at a file, when page is %s', async (_, page) => {
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt(`/workspace/main/${AGENT}`, [appPassing({ nav: SCREENS_NAV, page })], [chatPane]);

    expect(await screen.findByTestId('agent-renderer')).toHaveTextContent('role: coder');
    expect(screen.getByTestId('chat-pane')).toBeInTheDocument();
    expect(
      screen.getByTestId('file-explorer-root').querySelector(`[data-tree-path="${AGENT}"]`),
    ).toHaveAttribute('aria-current', 'true');
  });
});

/*
 * Last in the file: the sidebar's breakpoint is module state, so a narrow
 * mount leaves it narrow for whatever mounts after it.
 */
describe('CoreAppShell: a claiming app with screens of its own, on a narrow screen', () => {
  const setViewportWidth = (width: number) =>
    (window as typeof window & { happyDOM: { setInnerWidth(value: number): void } }).happyDOM.setInnerWidth(width);
  afterEach(() => setViewportWidth(1400));

  it('makes the sidebar with the app’s navigation the drawer, opened by the sidebar button', async () => {
    setViewportWidth(375);
    session.workspace = workspaceOn(AGENT, 'role: coder');
    renderShellAt('/agents', [screensApp], [chatPane]);

    // The page has the screen: the phone layout, which gives it to the chat
    // pane, is not chosen for a page that is not a file.
    expect(await screen.findByRole('heading', { name: 'The workflows page' })).toBeInTheDocument();
    expect(screen.queryByTestId('chat-pane')).not.toBeInTheDocument();
    const sidebar = screen.getByTestId('file-explorer-root').closest('aside')!;
    expect(sidebar).toContainElement(screen.getByRole('navigation', { name: 'Agents', hidden: true }));
    // Closed, and out of reach, until asked for.
    expect(sidebar).toHaveAttribute('inert');

    // What the toolbar's sidebar button calls.
    act(() => toggleSidebar());
    expect(sidebar).not.toHaveAttribute('inert');
    expect(sidebar).toHaveAttribute('role', 'dialog');
    expect(sidebar).toHaveAttribute('aria-modal', 'true');
    expect(within(sidebar).getByRole('navigation', { name: 'Agents' })).toBeInTheDocument();
  });
});
