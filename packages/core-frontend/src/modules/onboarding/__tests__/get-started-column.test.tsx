import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import { AuthContext } from '../../auth/state/auth.context';
import { authValue } from '../../library/__tests__/auth-harness';
import { AdminContext, type AdminContextValue } from '../../admin/state/admin.context';
import { WorkspaceContext } from '../../workspace/state/workspace.context';
import { makeWorkspaceFixture } from '../../workspace/__tests__/testFixtures';
import { GetStartedColumn } from '../components/GetStartedColumn';
import { InviteDialogProvider } from '../state/invite-dialog';
import { resetOnboardingForTests } from '../state/onboarding';
import { WELCOME_PATH } from '../paths';
import { WorkspaceApiError } from '../../workspace/services/workspace.api';
import type { AccountSummary } from '../../auth/services/account.api';
import type { PluginSummary } from '../../library/services/plugins.api';
import type { AgentConnection } from '../services/agent-connection.api';
import { FIRST_PAGE_PROMPT, chatGptPromptUrl, claudePromptUrl } from '../first-page-prompt';
import type { StarterPacksAnswer } from '../services/starter-packs.api';
import { SearchPalette } from '../../toolbar/components/SearchPalette';
import { COMMAND_MENU_SHORTCUT_LABEL } from '../../toolbar/commands/command-menu';
import { AGENT_RECHECK_MS } from '../state/agent-connection';
import { notePluginCreated } from '../../library/state/plugins-revision';

/**
 * The "Get set up" column: every tick is derived from state the app already
 * has, the admin-only steps stay out of a member's list, and the column gets
 * out of the way — on the welcome page, when narrow, when done, when closed.
 */

const { listAccountsMock, listPluginsMock, openWorkspacePathMock, fetchAgentConnectionMock, authFetchMock } =
  vi.hoisted(() => ({
    listAccountsMock: vi.fn<() => Promise<AccountSummary[]>>(),
    listPluginsMock: vi.fn<() => Promise<PluginSummary[]>>(),
    openWorkspacePathMock: vi.fn<(path: string, options?: { edit?: boolean }) => void>(),
    fetchAgentConnectionMock: vi.fn<() => Promise<AgentConnection>>(),
    // The onboarding write (`markDone`) is the only thing that reaches it.
    authFetchMock: vi.fn(async () => ({ ok: true, status: 200 }) as Response),
  }));

vi.mock('../../../lib/api', () => ({ authFetch: authFetchMock }));
vi.mock('../services/agent-connection.api', () => ({ fetchAgentConnection: fetchAgentConnectionMock }));
const { fetchStarterPacksMock } = vi.hoisted(() => ({
  fetchStarterPacksMock: vi.fn<() => Promise<StarterPacksAnswer>>(),
}));
vi.mock('../services/starter-packs.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/starter-packs.api')>()),
  fetchStarterPacks: fetchStarterPacksMock,
}));
vi.mock('../../auth/services/account.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/services/account.api')>()),
  listAccounts: listAccountsMock,
}));
vi.mock('../../library/services/library.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../library/services/library.api')>()),
  listSkills: vi.fn(async () => []),
}));
vi.mock('../../secrets-vault/services/tool-secrets.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../secrets-vault/services/tool-secrets.api')>()),
  listToolSecrets: vi.fn(async () => []),
}));
vi.mock('../../library/services/plugins.api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../library/services/plugins.api')>()),
  listPlugins: listPluginsMock,
}));
// The real hook needs the git context for its branch; the column only ever
// asks it to open a workspace path, which is the call these tests assert.
vi.mock('../../workspace/routing/kb-routes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace/routing/kb-routes')>()),
  useFileNav: () => ({
    openFile: vi.fn(),
    openLink: vi.fn(),
    openWorkspacePath: openWorkspacePathMock,
    closeFile: vi.fn(),
  }),
}));

const KB = 'kb';
const GUIDE = `${KB}/KnowledgeBase/How to get started.md`;

/** A workspace tree holding exactly `files` (workspace-relative paths). */
function treeOf(files: string[]): FileTreeEntry {
  const root: FileTreeEntry = { name: '', relativePath: '', type: 'directory', children: [] };
  for (const file of files) {
    const parts = file.split('/');
    let node = root;
    parts.forEach((name, i) => {
      const relativePath = parts.slice(0, i + 1).join('/');
      const isFile = i === parts.length - 1;
      let child = node.children!.find((c) => c.name === name);
      if (!child) {
        child = isFile
          ? { name, relativePath, type: 'file' }
          : { name, relativePath, type: 'directory', children: [] };
        node.children!.push(child);
      }
      node = child;
    });
  }
  return root;
}

const STARTER_TREE = [GUIDE, `${KB}/KnowledgeBase/.gitkeep`, `${KB}/Plugins/.gitkeep`];

function account(email: string, over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: email,
    email,
    name: email,
    hasPassword: false,
    isEnvAdmin: false,
    deactivatedAt: null,
    isSystem: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function plugin(folder: string): PluginSummary {
  return {
    name: folder.split('/').pop()!,
    folders: [folder],
    canRead: true,
    canWrite: true,
    isOwner: true,
    skillCount: 0,
    toolCount: 0,
    owners: { roles: [], users: [] },
    writers: { roles: [], users: [] },
    readers: { roles: [], users: [], restricted: false },
    hasRequested: false,
    requestNumber: null,
  };
}

function adminValue(isAdmin: boolean): AdminContextValue {
  return {
    isAdmin,
    isAdminLoading: false,
    unreadCount: 0,
    lastSeen: null,
    markSeen: () => {},
    refresh: () => {},
    rolesConfigCorrupted: false,
    rolesConfigErrors: [],
    runRolesRecovery: async () => {},
  };
}

function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

/** The router's `navigate`, handed out so a test can move the app around under the column. */
let navigateTo: NavigateFunction = () => {};
function NavigateHandle() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = navigate;
  }, [navigate]);
  return null;
}

function setViewportWidth(width: number): void {
  (window as typeof window & { happyDOM: { setInnerWidth(v: number): void } }).happyDOM.setInnerWidth(width);
}

type MountOptions = {
  admin?: boolean;
  onboardingDone?: boolean;
  /** The workspace's files; null while the tree has not loaded. */
  files?: string[] | null;
  openFilePath?: string | null;
  route?: string;
  createFile?: (relativePath: string, content?: string, options?: { ifAbsent?: boolean }) => Promise<void>;
  /** Mount the toolbar's command menu beside the column, as the app does. */
  withPalette?: boolean;
  /** The branch on screen; the default one (the test setup's) unless a test is about a draft. */
  workspaceBranch?: string | null;
};

/** The default branch the test setup pins: where a starter pack lands. */
const DEFAULT_BRANCH = 'target-company-state';

/** The column in every context it reads; `rerender` it to move the app's state under it. */
function columnUi({
  admin = false,
  onboardingDone = false,
  files = STARTER_TREE,
  openFilePath = null as string | null,
  route = '/workspace',
  createFile = async () => {},
  withPalette = false,
  workspaceBranch = DEFAULT_BRANCH,
}: MountOptions = {}) {
  const auth = authValue({ user: Object.assign(sessionUser, { onboardingDone }) });
  const ui = (
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        <AdminContext.Provider value={adminValue(admin)}>
          <WorkspaceContext.Provider
            value={makeWorkspaceFixture({
              kbDirName: KB,
              fileTree: files ? treeOf(files) : null,
              openFilePath,
              createFile,
              workspaceBranch,
            })}
          >
            <InviteDialogProvider>
              {withPalette && <SearchPalette compact />}
              <GetStartedColumn />
              <LocationProbe />
              <NavigateHandle />
            </InviteDialogProvider>
          </WorkspaceContext.Provider>
        </AdminContext.Provider>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return ui;
}

function mount(options: MountOptions = {}) {
  const ui = columnUi(options);
  return { ...render(ui), ui };
}

/** The checklist row titled `title`, or null when the column does not list it. */
function row(title: RegExp | string) {
  const column = screen.getByRole('complementary', { name: 'Get set up' });
  const heading = within(column).queryByText(title);
  return heading ? (heading.closest('li') as HTMLElement) : null;
}

const isDone = (title: RegExp | string) => within(row(title)!).queryByText('(done)') !== null;

/**
 * The signed-in user of the test at hand: ONE object per test, so what the
 * app keeps per signed-in user (the starter-pack answer) lives across a
 * rerender and never leaks into the next test, which signs in afresh.
 */
let sessionUser: { id: string; email: string; name: string; onboardingDone: boolean };

beforeEach(() => {
  resetOnboardingForTests();
  sessionUser = { id: 'u1', email: 'juan@bevel.software', name: 'Juan Viera', onboardingDone: false };
  fetchStarterPacksMock.mockReset().mockResolvedValue({ offered: false, chosen: null, packs: [], chosenPack: null });
  setViewportWidth(1400);
  listAccountsMock.mockReset().mockResolvedValue([account('juan@bevel.software')]);
  listPluginsMock.mockReset().mockResolvedValue([]);
  openWorkspacePathMock.mockReset();
  fetchAgentConnectionMock.mockReset().mockResolvedValue({ connected: false });
  authFetchMock.mockClear();
});

/** Calls to the onboarding write — the one `markDone` makes. */
const doneWrites = () =>
  authFetchMock.mock.calls.filter((c) => (c as unknown[])[0] === '/api/auth/onboarding-done').length;

describe('GetStartedColumn: what a member sees', () => {
  it('lists the five member steps, hides the admin-only ones, and asks the server nothing', () => {
    mount();
    expect(screen.getByText('1 of 5')).toBeInTheDocument();
    expect(row('Create your workspace')).not.toBeNull();
    expect(row('Connect your agent')).not.toBeNull();
    expect(row('Read “How to get started”')).not.toBeNull();
    expect(row('Write your first page')).not.toBeNull();
    expect(row(/^Find or do anything with/)).not.toBeNull();
    expect(row('Choose where your knowledge lives')).toBeNull();
    expect(row('Create a plugin for your team')).toBeNull();
    expect(row('Invite your team')).toBeNull();
    expect(listAccountsMock).not.toHaveBeenCalled();
    expect(listPluginsMock).not.toHaveBeenCalled();
  });

  it('ticks "Connect your agent" from the server onboarding flag', () => {
    mount({ onboardingDone: true });
    expect(isDone('Connect your agent')).toBe(true);
    expect(isDone('Create your workspace')).toBe(true);
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
  });

  it('sends "Connect" to the welcome page', async () => {
    mount();
    await userEvent.click(within(row('Connect your agent')!).getByRole('button', { name: 'Connect' }));
    expect(screen.getByTestId('pathname')).toHaveTextContent(WELCOME_PATH);
  });

  it('opens the starter guide and ticks it', async () => {
    mount();
    expect(isDone('Read “How to get started”')).toBe(false);
    await userEvent.click(within(row('Read “How to get started”')!).getByRole('button', { name: 'Open it' }));
    expect(openWorkspacePathMock).toHaveBeenCalledWith(GUIDE);
    expect(isDone('Read “How to get started”')).toBe(true);
  });

  it('ticks the guide when it is opened by any route, and remembers it', () => {
    const { unmount } = mount({ openFilePath: GUIDE });
    expect(isDone('Read “How to get started”')).toBe(true);
    unmount();
    mount();
    expect(isDone('Read “How to get started”')).toBe(true);
  });

  it('leaves the guide step out when the knowledge base has no such page', () => {
    mount({ files: [`${KB}/KnowledgeBase/.gitkeep`] });
    expect(row('Read “How to get started”')).toBeNull();
    expect(screen.getByText('1 of 4')).toBeInTheDocument();
  });

  it('ticks "Write your first page" only for content other than the starter page', async () => {
    const { unmount } = mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/access.md`] });
    await waitFor(() => expect(fetchStarterPacksMock).toHaveBeenCalled());
    expect(isDone('Write your first page')).toBe(false);
    expect(
      within(row('Write your first page')!).getByText(
        'Start one here, or drop files into the file tree.',
      ),
    ).toBeInTheDocument();
    unmount();
    mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/Product/Roadmap.md`] });
    // Ticked once the starter-pack answer is in (none chosen here).
    await waitFor(() => expect(isDone('Write your first page')).toBe(true));
  });

  it('"New page" creates Untitled.md in the Knowledge folder and opens it for editing', async () => {
    const createFile = vi.fn(async () => {});
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(createFile).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled.md`, '# Untitled\n\n', { ifAbsent: true });
    expect(openWorkspacePathMock).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled.md`, { edit: true });
  });

  it('"New page" takes the next free name when Untitled.md is taken', async () => {
    const createFile = vi.fn(async () => {});
    // Any page would already tick the step and hide the button, so what holds
    // the name here is an (otherwise empty) folder called `Untitled.md` and
    // `Untitled 2.md` — a name the tree has is taken, whatever it is.
    mount({
      createFile,
      files: [
        ...STARTER_TREE,
        `${KB}/KnowledgeBase/Untitled.md/.gitkeep`,
        `${KB}/KnowledgeBase/Untitled 2.md/.gitkeep`,
      ],
    });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(createFile).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled 3.md`, '# Untitled\n\n', { ifAbsent: true });
    expect(openWorkspacePathMock).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled 3.md`, { edit: true });
  });

  /**
   * The tree can be a moment behind: a page made elsewhere since it loaded
   * holds the name the column picked. The create is exclusive, so the
   * backend refuses (409) instead of replacing that page, and the column
   * moves on to the next name.
   */
  it('"New page" never overwrites: a name taken since the tree loaded moves on to the next', async () => {
    const taken = new Set([`${KB}/KnowledgeBase/Untitled.md`, `${KB}/KnowledgeBase/Untitled 2.md`]);
    const createFile = vi.fn(async (path: string) => {
      if (taken.has(path)) throw new WorkspaceApiError(409, `"${path}" already exists.`);
    });
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    await waitFor(() =>
      expect(openWorkspacePathMock).toHaveBeenCalledWith(`${KB}/KnowledgeBase/Untitled 3.md`, { edit: true }),
    );
    expect(createFile.mock.calls.map((c) => c[0])).toEqual([
      `${KB}/KnowledgeBase/Untitled.md`,
      `${KB}/KnowledgeBase/Untitled 2.md`,
      `${KB}/KnowledgeBase/Untitled 3.md`,
    ]);
    expect(within(row('Write your first page')!).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('"New page" gives up after a few taken names, and says so on the step', async () => {
    const createFile = vi.fn(async (path: string) => {
      throw new WorkspaceApiError(409, `"${path}" already exists.`);
    });
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(await within(row('Write your first page')!).findByRole('alert')).toHaveTextContent(
      `Couldn’t create the page: "${KB}/KnowledgeBase/Untitled 5.md" already exists.`,
    );
    expect(createFile).toHaveBeenCalledTimes(5);
    expect(openWorkspacePathMock).not.toHaveBeenCalled();
  });

  // Mid-switch, the URL names the destination branch while the workspace on
  // screen (and `createFile`) is still the branch being left; a page made in
  // that gap would land on the old branch and open on the new one, nowhere.
  it('"New page" creates nothing while the workspace on screen is not the branch the URL names', async () => {
    const createFile = vi.fn(async () => {});
    mount({ createFile, route: '/workspace/alice%2Fdraft' });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(await within(row('Write your first page')!).findByRole('alert')).toHaveTextContent(
      'Couldn’t create the page: the workspace is still loading.',
    );
    expect(createFile).not.toHaveBeenCalled();
    expect(openWorkspacePathMock).not.toHaveBeenCalled();
  });

  it('"New page" does not retry a refusal that is not about the name', async () => {
    const createFile = vi.fn(async () => {
      throw new WorkspaceApiError(403, 'You don’t have permission to write to "KnowledgeBase/Untitled.md".');
    });
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(await within(row('Write your first page')!).findByRole('alert')).toHaveTextContent(
      'You don’t have permission',
    );
    expect(createFile).toHaveBeenCalledTimes(1);
  });

  it('"New page" says "Creating…" while it works, and says why it failed on the step', async () => {
    let refuse!: (err: Error) => void;
    const createFile = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject;
        }),
    );
    mount({ createFile });
    await userEvent.click(within(row('Write your first page')!).getByRole('button', { name: 'New page' }));
    expect(within(row('Write your first page')!).getByRole('button', { name: 'Creating…' })).toBeDisabled();

    await act(async () => {
      refuse(new Error('You don’t have permission to write to "KnowledgeBase/Untitled.md".'));
    });
    expect(within(row('Write your first page')!).getByRole('alert')).toHaveTextContent(
      'Couldn’t create the page: You don’t have permission to write to "KnowledgeBase/Untitled.md".',
    );
    expect(within(row('Write your first page')!).getByRole('button', { name: 'New page' })).toBeEnabled();
    expect(openWorkspacePathMock).not.toHaveBeenCalled();
    expect(isDone('Write your first page')).toBe(false);
  });
});

/**
 * The agent-connection answer, asked once: it ticks "Connect your agent" for
 * someone who connected without ever opening the welcome page (and concludes
 * the onboarding for them), and it is what puts the one-click prompt on
 * "Write your first page".
 */
describe('GetStartedColumn: a connected agent', () => {
  it('ticks "Connect your agent" from the endpoint, and concludes the onboarding once', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    mount();
    await waitFor(() => expect(isDone('Connect your agent')).toBe(true));
    expect(doneWrites()).toBe(1);
    await act(async () => {});
    expect(doneWrites()).toBe(1);
  });

  it('asks once, not on a timer', async () => {
    vi.useFakeTimers();
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
      expect(isDone('Connect your agent')).toBe(false);
      expect(doneWrites()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Connecting somewhere else — another window, the External agent access
   * page — still ticks the list: it asks again when the person comes back to
   * the tab, though not more than once in a while.
   */
  it('asks again when you come back to the tab, at most once in a while', async () => {
    vi.useFakeTimers();
    try {
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
      // Straight back: too soon to ask again.
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);

      fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(AGENT_RECHECK_MS);
      });
      expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(1);
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchAgentConnectionMock).toHaveBeenCalledTimes(2);
      expect(isDone('Connect your agent')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not conclude again for an account the server already concluded', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    mount({ onboardingDone: true });
    await waitFor(() => expect(row('Write your first page')).not.toBeNull());
    await act(async () => {});
    expect(doneWrites()).toBe(0);
  });

  it('asks nothing once the column was closed', async () => {
    window.localStorage.setItem('bevel.onboarding.setupDismissed.juan@bevel.software', '1');
    mount();
    await act(async () => {});
    expect(fetchAgentConnectionMock).not.toHaveBeenCalled();
  });

  it('keeps the one-click prompt out of "Write your first page" until an agent is connected', async () => {
    mount();
    await act(async () => {});
    const page = row('Write your first page')!;
    expect(within(page).queryByRole('link', { name: 'Ask Claude to write it' })).not.toBeInTheDocument();
    expect(within(page).queryByRole('link', { name: 'Open in ChatGPT' })).not.toBeInTheDocument();
    expect(within(page).queryByRole('button', { name: 'Copy prompt' })).not.toBeInTheDocument();
    expect(within(page).getByRole('button', { name: 'New page' })).toBeInTheDocument();
    expect(within(page).getByText('Connect your agent and it can write pages for you.')).toBeInTheDocument();
  });

  it('offers "Ask Claude to write it" first once connected, keeping New page beside it', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    mount();
    const ask = await within(row('Write your first page')!).findByRole('link', { name: 'Ask Claude to write it' });
    expect(ask).toHaveAttribute('href', claudePromptUrl(FIRST_PAGE_PROMPT));
    expect(ask).toHaveAttribute('target', '_blank');
    expect(ask).toHaveAttribute('rel', 'noopener noreferrer');

    const page = row('Write your first page')!;
    const chatGpt = within(page).getByRole('link', { name: 'Open in ChatGPT' });
    expect(chatGpt).toHaveAttribute('href', chatGptPromptUrl(FIRST_PAGE_PROMPT));
    expect(chatGpt).toHaveAttribute('target', '_blank');
    expect(chatGpt).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(page).getByRole('button', { name: 'New page' })).toBeInTheDocument();
    expect(within(page).queryByText('Connect your agent and it can write pages for you.')).not.toBeInTheDocument();
  });

  /**
   * A team that chose a starter pack gets the pack's own request, and the
   * pack's pages — placeholders until someone fills one in — do not count as
   * the first page.
   */
  describe('after a starter pack', () => {
    const SALES_PAGES = [`${KB}/KnowledgeBase/Customers.md`, `${KB}/KnowledgeBase/Pricing.md`];
    const SALES_PROMPT = 'Using our Hexis knowledge base, fill in the Customers page.';
    const chosen = (starterPages: string[]): StarterPacksAnswer => ({
      offered: false,
      chosen: 'sales',
      packs: [],
      chosenPack: { id: 'sales', name: 'Sales', firstPagePrompt: `${SALES_PROMPT}\n`, starterPages },
    });

    it("asks the agent with the pack's prompt", async () => {
      fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
      fetchStarterPacksMock.mockResolvedValue(chosen(SALES_PAGES));
      mount({ files: [...STARTER_TREE, ...SALES_PAGES] });
      const page = row('Write your first page')!;
      await waitFor(() =>
        expect(within(page).getByRole('link', { name: 'Ask Claude to write it' })).toHaveAttribute(
          'href',
          claudePromptUrl(SALES_PROMPT),
        ),
      );
      expect(within(page).getByRole('link', { name: 'Open in ChatGPT' })).toHaveAttribute(
        'href',
        chatGptPromptUrl(SALES_PROMPT),
      );
    });

    it("leaves the step open while the pack's pages are untouched, and ticks it once one is filled in", async () => {
      fetchStarterPacksMock.mockResolvedValue(chosen(SALES_PAGES));
      const files = [...STARTER_TREE, ...SALES_PAGES];
      const { rerender } = mount({ files });
      await waitFor(() => expect(fetchStarterPacksMock).toHaveBeenCalledTimes(1));
      expect(isDone('Write your first page')).toBe(false);

      // Somebody fills in Customers: the tree is fetched again, and the
      // server no longer lists the page as a placeholder.
      fetchStarterPacksMock.mockResolvedValue(chosen([SALES_PAGES[1]!]));
      rerender(columnUi({ files }));
      await waitFor(() => expect(isDone('Write your first page')).toBe(true));
      expect(fetchStarterPacksMock).toHaveBeenCalledTimes(2);
    });

    it('keeps the generic prompt when the team skipped', async () => {
      fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
      fetchStarterPacksMock.mockResolvedValue({ offered: false, chosen: 'none', packs: [], chosenPack: null });
      mount();
      const ask = await within(row('Write your first page')!).findByRole('link', { name: 'Ask Claude to write it' });
      await waitFor(() => expect(fetchStarterPacksMock).toHaveBeenCalled());
      expect(ask).toHaveAttribute('href', claudePromptUrl(FIRST_PAGE_PROMPT));
    });

    it('does not tick the step before the answer is in: untouched pack pages are not a first page', async () => {
      let answer!: (a: StarterPacksAnswer) => void;
      fetchStarterPacksMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      mount({ files: [...STARTER_TREE, ...SALES_PAGES] });
      await waitFor(() => expect(fetchStarterPacksMock).toHaveBeenCalled());
      expect(isDone('Write your first page')).toBe(false);
      answer(chosen(SALES_PAGES));
      // Still open: both pages are placeholders. Filling one in would tick it.
      await act(async () => {});
      expect(isDone('Write your first page')).toBe(false);
    });

    it('reads the tree alone on a draft branch, where the default branch’s placeholders do not apply', async () => {
      fetchStarterPacksMock.mockResolvedValue(chosen(SALES_PAGES));
      mount({ files: [...STARTER_TREE, ...SALES_PAGES], workspaceBranch: 'alice/draft' });
      await waitFor(() => expect(fetchStarterPacksMock).toHaveBeenCalled());
      await waitFor(() => expect(isDone('Write your first page')).toBe(true));
    });

    it('asks again for a tree change that lands while the previous answer is still on its way', async () => {
      const resolvers: ((a: StarterPacksAnswer) => void)[] = [];
      fetchStarterPacksMock.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
      const files = [...STARTER_TREE, ...SALES_PAGES];
      const { rerender } = mount({ files });
      await waitFor(() => expect(resolvers).toHaveLength(1));
      resolvers[0]!(chosen(SALES_PAGES));
      await waitFor(() => expect(isDone('Write your first page')).toBe(false));

      // Two tree changes in a row: the first starts a request, the second
      // lands while it is out. One more request follows, and it is that one
      // which reports the page filled in.
      rerender(columnUi({ files: [...files] }));
      await waitFor(() => expect(resolvers).toHaveLength(2));
      rerender(columnUi({ files: [...files] }));
      resolvers[1]!(chosen(SALES_PAGES));
      await waitFor(() => expect(resolvers).toHaveLength(3));
      resolvers[2]!(chosen([SALES_PAGES[1]!]));
      await waitFor(() => expect(isDone('Write your first page')).toBe(true));
    });
  });

  it('leads with "Ask ChatGPT to write it" for a ChatGPT connection, Claude quiet beside Copy prompt', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'ChatGPT', kind: 'agent' });
    mount();
    const ask = await within(row('Write your first page')!).findByRole('link', { name: 'Ask ChatGPT to write it' });
    expect(ask).toHaveAttribute('href', chatGptPromptUrl(FIRST_PAGE_PROMPT));
    const page = row('Write your first page')!;
    expect(within(page).getByRole('link', { name: 'Open in Claude' })).toHaveAttribute(
      'href',
      claudePromptUrl(FIRST_PAGE_PROMPT),
    );
    expect(within(page).getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(within(page).queryByRole('link', { name: 'Ask Claude to write it' })).not.toBeInTheDocument();
    expect(within(page).queryByText(/Paste it into/)).not.toBeInTheDocument();
  });

  it('leads with Copy prompt for an agent no link opens, and says where to paste it', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude Code · local server on LAPTOP-1', kind: 'agent' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      mount();
      const copy = await within(row('Write your first page')!).findByRole('button', { name: 'Copy prompt' });
      const page = row('Write your first page')!;
      expect(within(page).getByText('Paste it into Claude Code.')).toBeInTheDocument();
      expect(within(page).getByRole('link', { name: 'Open in Claude' })).toBeInTheDocument();
      expect(within(page).getByRole('link', { name: 'Open in ChatGPT' })).toBeInTheDocument();
      expect(within(page).queryByRole('link', { name: /to write it/ })).not.toBeInTheDocument();
      expect(within(page).getByRole('button', { name: 'New page' })).toBeInTheDocument();
      await userEvent.click(copy);
      expect(writeText).toHaveBeenCalledWith(FIRST_PAGE_PROMPT);
      expect(within(row('Write your first page')!).getByRole('status')).toHaveTextContent('Prompt copied');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('leads with Copy prompt for a connection key, whatever its label says', async () => {
    // A key's label is free text: "ChatGPT CLI" names the key, not an app
    // that a chatgpt.com link would reach.
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'ChatGPT CLI', kind: 'key' });
    mount();
    const page = await waitFor(() => {
      const r = row('Write your first page')!;
      within(r).getByRole('button', { name: 'Copy prompt' });
      return r;
    });
    expect(within(page).queryByRole('link', { name: /to write it/ })).not.toBeInTheDocument();
    expect(within(page).getByText('Paste it into your agent.')).toBeInTheDocument();
  });

  it('says "your agent" when the connection has no name to offer', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Unnamed agent', kind: 'agent' });
    mount();
    expect(await within(row('Write your first page')!).findByText('Paste it into your agent.')).toBeInTheDocument();
  });

  it('copies the prompt and says so', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      mount();
      const copy = await within(row('Write your first page')!).findByRole('button', { name: 'Copy prompt' });
      await userEvent.click(copy);
      expect(writeText).toHaveBeenCalledWith(FIRST_PAGE_PROMPT);
      expect(within(row('Write your first page')!).getByRole('status')).toHaveTextContent('Prompt copied');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('ticks the page step by itself when the agent’s page lands, whoever wrote it', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/About us.md`] });
    await waitFor(() => expect(isDone('Connect your agent')).toBe(true));
    expect(isDone('Write your first page')).toBe(true);
    expect(screen.queryByRole('link', { name: 'Ask Claude to write it' })).not.toBeInTheDocument();
  });
});

describe('GetStartedColumn: what an admin sees', () => {
  it('lists all eight steps, storage already done', async () => {
    mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(screen.getByText('2 of 8')).toBeInTheDocument();
    expect(isDone('Choose where your knowledge lives')).toBe(true);
    expect(isDone('Create a plugin for your team')).toBe(false);
    expect(isDone('Invite your team')).toBe(false);
  });

  it('ticks the plugin step for a team plugin, not a personal shelf', async () => {
    listPluginsMock.mockResolvedValue([plugin('Plugins/personal-juan')]);
    const { unmount } = mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(isDone('Create a plugin for your team')).toBe(false);
    unmount();

    listPluginsMock.mockResolvedValue([plugin('Plugins/GTM')]);
    mount({ admin: true });
    await waitFor(() => expect(isDone('Create a plugin for your team')).toBe(true));
  });

  it('ticks the invite step for a second person, never for a system account', async () => {
    listAccountsMock.mockResolvedValue([
      account('juan@bevel.software'),
      account('recovery-bot@bevel.local', { isSystem: true }),
    ]);
    const { unmount } = mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(isDone('Invite your team')).toBe(false);
    unmount();

    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('ana@bevel.software')]);
    mount({ admin: true });
    await waitFor(() => expect(isDone('Invite your team')).toBe(true));
  });

  it('does not count a switched-off account as a teammate', async () => {
    listAccountsMock.mockResolvedValue([
      account('juan@bevel.software'),
      account('ana@bevel.software', { deactivatedAt: '2026-09-01T00:00:00Z' }),
    ]);
    mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(isDone('Invite your team')).toBe(false);
  });

  /**
   * The plugin question is asked on entering Skills & Tools and when this tab
   * creates a plugin — not on every move between Library pages.
   */
  it('asks for plugins again on entering Skills & Tools and on a plugin created, not on every Library page', async () => {
    mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    expect(listPluginsMock).toHaveBeenCalledTimes(1);

    await act(async () => navigateTo('/skills-and-tools'));
    await waitFor(() => expect(listPluginsMock).toHaveBeenCalledTimes(2));
    await act(async () => navigateTo('/skills-and-tools/owned'));
    await act(async () => navigateTo('/skills-and-tools/plugins/GTM'));
    expect(listPluginsMock).toHaveBeenCalledTimes(2);

    listPluginsMock.mockResolvedValue([plugin('Plugins/GTM')]);
    act(() => notePluginCreated());
    await waitFor(() => expect(isDone('Create a plugin for your team')).toBe(true));
    expect(listPluginsMock).toHaveBeenCalledTimes(3);

    // Found is final: leaving and coming back asks nothing more.
    await act(async () => navigateTo('/workspace'));
    await act(async () => navigateTo('/skills-and-tools'));
    expect(listPluginsMock).toHaveBeenCalledTimes(3);
  });

  it('opens the invite dialog from the invite step', async () => {
    mount({ admin: true });
    await screen.findByRole('complementary', { name: 'Get set up' });
    await userEvent.click(within(row('Invite your team')!).getByRole('button', { name: 'Invite people' }));
    expect(screen.getByRole('dialog', { name: 'Invite your team' })).toBeInTheDocument();
  });

});

/**
 * Finishing the list is a moment, not a disappearance: the column says
 * "You're set up" — when the last tick lands, or on arrival for a list that
 * was finished and never celebrated — and goes for good once that is closed.
 */
describe('GetStartedColumn: all done', () => {
  const WITH_PAGE = [...STARTER_TREE, `${KB}/KnowledgeBase/Notes.md`];
  const complete = () => screen.queryByRole('heading', { name: 'You’re set up' });

  // The command menu has been opened, by whatever route.
  beforeEach(() => {
    window.localStorage.setItem('bevel.onboarding.commandMenuOpened.juan@bevel.software', '1');
  });

  it('says "You’re set up" when the last step ticks, in place of the list', async () => {
    listPluginsMock.mockResolvedValue([plugin('Plugins/GTM')]);
    listAccountsMock.mockResolvedValue([account('juan@bevel.software'), account('ana@bevel.software')]);
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    const everythingBut = { admin: true, onboardingDone: true, openFilePath: GUIDE };
    // One step short, the settled column shows the seven it has...
    const { rerender } = mount(everythingBut);
    expect(await screen.findByText('7 of 8')).toBeInTheDocument();
    expect(complete()).toBeNull();
    // ...and the page landing in the tree finishes it.
    rerender(columnUi({ ...everythingBut, files: WITH_PAGE }));
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeInTheDocument();
    const column = screen.getByRole('complementary', { name: 'Get set up' });
    expect(within(column).getByRole('status')).toHaveTextContent(
      'Your agent can read and write your knowledge base, and your team can join you.',
    );
    expect(within(column).queryByRole('list')).not.toBeInTheDocument();
    expect(within(column).queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('celebrates a list finished elsewhere on arrival, and does not mention a team to a member', async () => {
    fetchAgentConnectionMock.mockResolvedValue({ connected: true, client: 'Claude', kind: 'agent' });
    mount({ onboardingDone: true, openFilePath: GUIDE, files: WITH_PAGE });
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeInTheDocument();
    expect(screen.getByText('Your agent can read and write your knowledge base.')).toBeInTheDocument();
    expect(screen.queryByText(/your team/)).not.toBeInTheDocument();
  });

  /**
   * "Connect your agent" also ticks when the onboarding was concluded with no
   * agent ever calling in (the pill's ×), so the line does not claim one.
   */
  it('claims no agent when none has connected', async () => {
    mount({ onboardingDone: true, openFilePath: GUIDE, files: WITH_PAGE });
    expect(await screen.findByRole('heading', { name: 'You’re set up' })).toBeInTheDocument();
    expect(screen.getByText('Your knowledge base is ready.')).toBeInTheDocument();
    expect(screen.queryByText(/Your agent can/)).not.toBeInTheDocument();
  });

  it('Close retires the column for good, and remembers it per account', async () => {
    const { unmount } = mount({ onboardingDone: true, openFilePath: GUIDE, files: WITH_PAGE });
    await userEvent.click(await screen.findByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('bevel.onboarding.setupCompleteClosed.juan@bevel.software')).toBe('1');
    unmount();
    // Not shown again — not even if a step comes undone later.
    fetchAgentConnectionMock.mockClear();
    mount({ onboardingDone: true, openFilePath: GUIDE });
    await act(async () => {});
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
    expect(fetchAgentConnectionMock).not.toHaveBeenCalled();
  });
});

/**
 * The command menu is taught by being opened: "Try it" opens it, and the
 * step ticks once it has been opened by any route — and stays ticked.
 */
describe('GetStartedColumn: the command menu', () => {
  const STEP = `Find or do anything with ${COMMAND_MENU_SHORTCUT_LABEL}`;

  it('is a step for everyone, named with this platform’s keys', async () => {
    mount();
    expect(row(STEP)).not.toBeNull();
    expect(isDone(STEP)).toBe(false);
    expect(
      within(row(STEP)!).getByText('Type what you want: a page, a skill, or an action like Invite people.'),
    ).toBeInTheDocument();
  });

  it('"Try it" opens the command menu, and that ticks the step', async () => {
    const user = userEvent.setup();
    mount({ withPalette: true });
    await user.click(within(row(STEP)!).getByRole('button', { name: 'Try it' }));
    expect(screen.getByRole('combobox', { name: 'Search or run a command' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(isDone(STEP)).toBe(true);
  });

  it('ticks when the menu is opened any other way, and remembers it per account', async () => {
    const user = userEvent.setup();
    const { unmount } = mount({ withPalette: true });
    await user.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox', { name: 'Search or run a command' })).toBeInTheDocument();
    expect(isDone(STEP)).toBe(true);
    expect(window.localStorage.getItem('bevel.onboarding.commandMenuOpened.juan@bevel.software')).toBe('1');
    unmount();
    mount();
    expect(isDone(STEP)).toBe(true);
  });
});

/**
 * The first-page step reads the file tree. Until the tree is in, the guide
 * looks absent and the first page unwritten, so the list waits for it rather
 * than showing a shorter, falsely open one.
 */
describe('GetStartedColumn: the file tree', () => {
  it('stays hidden until the tree has loaded', () => {
    const { rerender } = mount({ files: null });
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
    rerender(columnUi({}));
    expect(screen.getByRole('complementary', { name: 'Get set up' })).toBeInTheDocument();
    expect(row('Read “How to get started”')).not.toBeNull();
  });

  it('skips exactly `access.md`, the name the platform reserves — not another spelling', async () => {
    const { unmount } = mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/Sales/access.md`] });
    await waitFor(() => expect(fetchStarterPacksMock).toHaveBeenCalled());
    expect(isDone('Write your first page')).toBe(false);
    unmount();
    mount({ files: [...STARTER_TREE, `${KB}/KnowledgeBase/Sales/Access.md`] });
    await waitFor(() => expect(isDone('Write your first page')).toBe(true));
  });
});

describe('GetStartedColumn: getting out of the way', () => {
  it('stays dismissed once closed, across remounts', async () => {
    const { unmount } = mount();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss Get set up' }));
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('bevel.onboarding.setupDismissed.juan@bevel.software')).toBe('1');
    unmount();
    mount();
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  /**
   * The notes are per browser, so a tab already open hears another tab's
   * close through `storage` — not at its next reload.
   */
  it('goes when another tab closes it', () => {
    mount();
    expect(screen.getByRole('complementary', { name: 'Get set up' })).toBeInTheDocument();
    const key = 'bevel.onboarding.setupDismissed.juan@bevel.software';
    window.localStorage.setItem(key, '1');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1' }));
    });
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  it('ticks the guide when another tab opened it', () => {
    mount();
    expect(isDone('Read “How to get started”')).toBe(false);
    const key = 'bevel.onboarding.readGuide.juan@bevel.software';
    window.localStorage.setItem(key, '1');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: '1' }));
    });
    expect(isDone('Read “How to get started”')).toBe(true);
  });

  it('is not shown on the welcome page', () => {
    mount({ route: WELCOME_PATH });
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });

  it('is shown in an ordinary laptop window', () => {
    setViewportWidth(1000);
    mount();
    expect(screen.getByRole('complementary', { name: 'Get set up' })).toBeInTheDocument();
  });

  it('is not shown at or below 900px, where the sidebar turns into a drawer', () => {
    setViewportWidth(900);
    mount();
    expect(screen.queryByRole('complementary', { name: 'Get set up' })).not.toBeInTheDocument();
  });
});
